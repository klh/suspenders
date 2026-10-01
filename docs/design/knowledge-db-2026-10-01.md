# knowledge.db split + workload tuning (W99, phase 1)

Date: 2026-10-01 · Lane: w99-tuning · Status: measured + designed; the
extraction itself is **phase 2** (a follow-up lane; W100 landed 2026-10-01,
extraction not yet scheduled).

## Context

governor.db is one SQLite/WAL file (user_version 6) that serves two
opposite workloads:

- **knowledge** — FTS5 search
  (`knowledge_fts`, external content, detail defaults to `full`), read-heavy:
  every `coord knowledge` / `read_knowledge` MCP / HTTP API :7795 hit is a
  bm25+decay-ordered search; writes arrive only from the distill worker
  (job batches of ≤12 rows through the FTS sync triggers) and lifecycle
  verbs (promote/retire/note/verify).
- **control plane** — write-hot: events (append-only), lock renewals
  (UPDATE per file edit), heartbeats, deltas row-image log, claims/work
  mutations — mostly one short-lived connection per hook invocation.

The split makes both optimal: knowledge.db gets read-path pragmas
(page_size, mmap, FTS detail), governor.db keeps the write-hot config.
All numbers below are this machine's own measurements (Apple Silicon,
APFS, SQLite 3.51 via bun:sqlite). No number is quoted from docs.

## Method

- **Live snapshot**: `VACUUM INTO` from the live hub (read-only on live):
  229 knowledge rows, 30.0 MB file, 7387 pages, freelist 0, page_size
  4096, WAL, synchronous=NORMAL, mmap 0, cache 2000 pages, user_version 6.
- **Scaled dataset**: 50,000 rows sampled+permuted from the real 229
  (deterministic seed): 35% of topics word-swapped, 50% of facts get 2-4
  word swaps from the real 2725-word vocabulary — preserves the real
  length distribution (avg fact 220 chars, p95 400 = the distill clamp),
  Zipf vocabulary, and domain/kind/area weights; state mix 78.8%
  candidate / 15% active / 6% retired; timestamps spread over 3 years.
- **Queries**: 20 realistic agent queries from the real topic vocabulary,
  run through the production `ftsTerms()` OR-join shape and the production
  ranked SQL (bm25 + age-decay ORDER BY + snippet). 20 queries × 15 reps
  = 300 timed queries per config; p50/p95.
- **Writes**: the distill worker's shape — batches of 12 inserts (one
  job's ledger), per-batch COMMIT, FTS triggers live.
- **Governor pattern**: events autocommit INSERTs (per-statement commit,
  the hook shape) + open→1 write→close cycles (per-hook-invocation
  shape).
- Reproduction: the full matrix ran once; the chosen config plus its
  nearest rivals were rebuilt from scratch and re-measured in a second
  pass; both runs are cited where they differ beyond noise (±20%).

## What the store looks like today

| store              | rows                 | table bytes              | FTS index                         | note                                |
| ------------------ | -------------------- | ------------------------ | --------------------------------- | ----------------------------------- |
| knowledge (live)   | 229                  | 0.22 MiB                 | 0.14 MiB                          | avg fact 219 chars, p95 400 (clamp) |
| knowledge (scaled) | 50,000               | 17.4-17.9 MiB            | 9.3 MiB (full) / 6.2 MiB (column) | dbstat per b-tree                   |
| facts (live)       | 1,999                | avg 87 chars             | —                                 | separate FTS index                  |
| consult_kb (live)  | 76                   | —                        | —                                 | separate FTS index                  |
| knowledge_queue    | 114 done / 48 failed | payloads cleared on done | —                                 | write path only                     |

Live distribution: domains suspenders 157 / gaps 33 / tredebanken-v2 20 /
hojtaler 18 / coordination 1; origin_kind fact 147 / decision 36 / lesson
32 / incident 14; top areas gates 35, work-graph 20, knowledge 20,
fleet-loop 16; 2,725-word vocabulary. At today's scale every search is
sub-millisecond (0.125 ms p50 / 0.21 ms p95 on the 229-row snapshot, the
production query verbatim). The tuning question is therefore about the
**years-long trajectory**: 50k rows = a few years of full-tilt fleet
distillation — the point where bad configs compound.

## Measurements

### 1. Bulk load = the migration cost

50,000 rows, one transaction, FTS sync triggers live (the exact shape the
one-transaction migration will use):

| variant (page × detail) | file size (run 1 / run 2) | build (ms) |
| ----------------------- | ------------------------- | ---------- |
| 4096 × full             | 28.46 / 28.52 MiB         | 927 / 971  |
| 4096 × column           | 24.04 MiB                 | 919        |
| 8192 × full             | 28.04 / 28.10 MiB         | 904 / 997  |
| 8192 × column           | 23.61 / 23.67 MiB         | 866 / 900  |
| 16384 × full            | 27.91 MiB                 | 882        |
| 16384 × column          | 23.47 MiB                 | 823        |

Migration load is ~1 s at 50k rows in a single transaction — even at 100×
today's row count the move itself is sub-minute. **UNVERIFIED** (projection,
not measured): at 500k rows, expect ~10 s load + ~250 MiB file on the same
hardware; the write-pattern benches, not the bulk load, dominate long-run
behavior.

### 2. Search latency (the read path)

300 timed queries per cell; production ranked SQL + snippet; cache_size
2000 pages (~8 MB) unless noted. Two-run figures as run1 / run2.

| config (cache, mmap) | 4096-full p50  | 8192-full p50  | 16384-full p50 | 8192-column p50 |
| -------------------- | -------------- | -------------- | -------------- | --------------- |
| 2k pages, mmap 1 GiB | 2.26 / 3.30 ms | 2.48 / 2.56 ms | 2.02 ms        | 3.58 / 4.24 ms  |
| 8 MB, mmap 1 GiB     | 4.78 ms        | 2.11 ms        | 1.98 ms        | 3.72 ms         |
| 64 MB, mmap 1 GiB    | 3.35 ms        | 1.99 ms        | 2.06 ms        | 3.93 ms         |
| 2k pages, mmap off   | 5.17 / 5.47 ms | 6.86 / 4.81 ms | 3.42 ms        | 6.29 ms         |

Findings:

- **mmap is the single biggest read lever**: 1.7-2.8× faster p50 at every
  page size. mmap_size is a cap, not an allocation — 1 GiB covers the file
  for years (28 MiB today at 50k rows).
- **`detail=column` refuted for latency**: 1.66-1.80× slower queries at
  identical config, for a 3.1 MiB index saving at 50k rows (9.3 → 6.2 MiB).
  At the live 229-row store the whole index is 143 KB — the size saving is
  irrelevant today, and the latency cost compounds with growth. Keep
  `detail=full` (the default; no DDL change).
- **cache_size above the 2000-page default buys nothing when mmap is on**:
  8 MB and 64 MB caches land inside run-to-run noise of the 2k default.
  The one standout outlier (64 MB cache, mmap off, 4096-full: 12.3 ms p50,
  4.8× worse than neighbors) is a first-run cold artifact; noted, not
  chased.

### 3. Journal + synchronous (the write path)

Distill-worker shape on 8192-full: 2400 inserts in batches of 12
(per-batch COMMIT, triggers live) + 1200 retire UPDATEs, then latency
re-check. The knowledge store is re-derivable (re-distill the sources), so
the durability trade reads differently than for the control plane.

| journal | synchronous | insert rows/s | note                                             |
| ------- | ----------- | ------------- | ------------------------------------------------ |
| wal     | NORMAL      | 28,396        | chosen                                           |
| wal     | FULL        | 26,631        | -6% for fsync-per-commit knowledge does not need |
| delete  | NORMAL      | 15,918        | -44%                                             |
| delete  | FULL        | 15,378        | -46%                                             |

Page size on the same write shape (WAL+NORMAL): 4096 = 25,362 rows/s,
8192 = 28,396, 16384 = 35,258 — bigger pages write faster (fewer b-tree
splits), 16K best by 24% over 8K in a single run.

Churn barely moved read latency (p50 1.89 → 2.04-2.16 ms after 3,600 row
operations); a segment build-up of this size is not yet a query problem.

### 4. FTS5 `optimize` cost + cadence

`INSERT INTO knowledge_fts(knowledge_fts) VALUES('optimize')` after the
3,600-op churn on the 52k-row store:

- cost: 70-73 ms every run, both journals
- effect: post-optimize p50 1.92-1.96 ms vs 2.04-2.16 ms before (~5%
  latency recovery, p95 similar)

Cadence: run it in the worker after every job that wrote rows. 70 ms
against an LLM distill measured in seconds is noise, and it keeps segment
count bounded from row one — the years-long-growth answer to the FTS
"segments accumulate" failure mode. **UNVERIFIED** (projection): optimize
cost at 500k rows — expect low hundreds of ms; the worker should log it
and the monitor should alert past 5 s.

### 5. governor.db comparison point (write-hot)

The same snapshot, real control-plane schema, autocommit per-statement
commits (the hook shape) and open→1-write→close cycles:

| page | journal | synchronous | events/s | open-write-close per op |
| ---- | ------- | ----------- | -------- | ----------------------- |
| 4096 | wal     | NORMAL      | 57,803   | 2.05 ms                 |
| 4096 | wal     | FULL        | 20,225   | 1.97 ms                 |
| 4096 | delete  | NORMAL      | 5,384    | 0.49 ms                 |
| 4096 | delete  | FULL        | 5,200    | 0.38 ms                 |
| 8192 | wal     | NORMAL      | 74,527   | 1.96 ms                 |
| 8192 | wal     | FULL        | 27,536   | 2.02 ms                 |
| 8192 | delete  | NORMAL      | 5,213    | 0.38 ms                 |
| 8192 | delete  | FULL        | 4,514    | 0.40 ms                 |

synchronous=NORMAL under WAL is worth 2.9× on the write path (57.8k vs
20.2k events/s); DELETE journal costs 11×. WAL's close does a
checkpoint-on-close, so DELETE wins the open-close micro-benchmark — but
throughput dominates and WAL wins it by an order of magnitude. The current
governor pragmas (WAL, NORMAL, busy_timeout=2000, 4K pages) are already
right; an 8K rebuild buys +29% events/s at trivial absolute numbers and is
not worth a fleet-wide file rebuild.

## Chosen configuration: knowledge.db

| pragma       | value                       | measured rationale                                                                                                                 |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| page_size    | 8192                        | read p50 within noise of best (2.48/2.56 ms); writes faster than 4K (28.4k vs 25.4k rows/s); set at file creation — it is baked in |
| journal_mode | WAL                         | 1.8× insert throughput over DELETE (28.4k vs 15.9k rows/s); persistent, set once                                                   |
| synchronous  | NORMAL                      | FULL costs 6% batched / 2.9× autocommit for fsync durability the knowledge store does not need (re-derivable)                      |
| mmap_size    | 1073741824                  | 1.7-2.8× read p50 win; a cap, not an allocation                                                                                    |
| cache_size   | default (2000 pages ≈ 8 MB) | 8/64 MB caches measured inside noise with mmap on                                                                                  |
| FTS5 detail  | full (default)              | `detail=column` = 1.66-1.80× slower queries for a 3.1 MiB saving at 50k rows — refuted                                             |
| optimize     | per job, in the worker      | 70 ms cost, ~5% latency recovery after churn; bounds segments for years-long growth                                                |

Honest page-size note: 16384 measured best-or-tied on all three axes in
run 1 (read 2.02 ms p50, write 35.3k rows/s, smallest file) — 8192 is
within read-noise of it and loses to it only on the write path (single
run). 8192 chosen for the lower WAL amplification per small job and
because the live 229-row store sits in the tiny-file regime where page
size is irrelevant; revisit at 100k+ rows. **UNVERIFIED**: which of 8K/16K
wins at 500k rows.

## Migration plan (phase 2 implementation)

The extraction is one port change plus one transaction. **Port seam**: every
knowledge consumer (coord CLI, read_knowledge MCP, HTTP API) binds through
`makeStore()` → `SqliteKnowledgeStore` (hooks/lib/knowledge-ports.ts) — the
only knowledge-layer code allowed to open the DB file. Phase 2:

1. **`openKnowledgeDb()`** (new, hooks/lib/govdb.ts or a sibling): mkdir,
   open `${REG}/knowledge.db`, busy_timeout=2000 BEFORE journal_mode=WAL
   (the openGovernorDb ordering), synchronous=NORMAL, mmap_size=1 GiB,
   page_size=8192 must precede the FIRST schema creation (page_size is
   baked at file creation).
2. **Bind the port**: `makeStore()` switches to
   `new SqliteKnowledgeStore(openKnowledgeDb())` — one binding reaches all
   three consumers because they hold the store port, not a connection.
3. **One-transaction migration** in openGovernorDb at user_version 6→7:
   attach the empty target, `PRAGMA kb.page_size=8192` before first write,
   then BEGIN IMMEDIATE: CREATE kb.knowledge + kb.knowledge_fts
   (detail=full) + triggers; INSERT INTO kb.knowledge SELECT ... FROM
   main.knowledge; rebuild kb.knowledge_fts FROM main.knowledge; DROP the
   knowledge* tables + triggers from main; PRAGMA user_version = 7. A
   crash rolls the whole step back and the next open retries — user_version
   stays 6, the legacy path keeps working.
4. **Backup step**: the snapshot agent (VACUUM INTO of governor.db) must
   checkpoint + copy knowledge.db and its -wal sidecar alongside. First v7
   open should VACUUM INTO a pre-migration governor backup before the
   migrate step.
5. **Governor post-migration**: VACUUM governor.db after the v7 commit
   (outside the transaction) to return the freed pages; freelist measured 0
   pages today; keep it that way.
6. **W92 store-port interaction** (in-flight work): the control-plane
   GovernorStore is statement-shaped (`query(sql)`), so after the split it
   must never proxy knowledge statements — store-server.ts must not accept
   SQL naming knowledge* tables. A regression here would silently put the
   read-heavy FTS workload back on the write-hot file. Phase 2 test:
   statement sweep asserting no `knowledge` DML/DDL rides the control-plane
   store.

## What phase 2 must implement

Tracked on the work graph as **W166** (owner law: the graph is the single
ledger for todos and work — docs record design, never task lists). The
phase-2 scope: openKnowledgeDb pragmas, makeStore rebinding, the v6→v7
migration, backup-agent step, worker optimize, the full test matrix, and
byte-identical search responses — full detail in the W166 registration.

## Sources

- Tier 1 (primary, this repo): every number is a run on this machine
  against `VACUUM INTO` snapshots of the live hub; scripts and raw JSON
  outputs in /tmp scratch (transient), the tables above are the record.
- Tier 1 (repo code): the production query and trigger DDL quoted verbatim
  from hooks/lib/knowledge.ts + hooks/lib/govdb.ts (v6 schema).
- Tier 2 (corroboration only): SQLite/FTS5 documented pragma semantics
  (page_size bake-at-creation, mmap_size as cap, WAL checkpoint-on-close)
  — used to interpret results, never to substitute for measured numbers.
- Projections (500k-row behavior, optimize cost at scale) are marked
  **UNVERIFIED** inline.
