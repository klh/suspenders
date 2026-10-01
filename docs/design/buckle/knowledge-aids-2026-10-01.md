# buckle plan: knowledge performance aids (W137)

Date: 2026-10-01 · Lane: w137-aids · Status: designed, zero production
code. PLANNING lane — buckle itself is W133's; this doc specifies the
aids layer that rides it. Companion inputs: the W131 router sketch
(`docs/design/belt-native-router-2026-10-01.md`), W127's usage layer
(`hooks/bin/usage-harvest.ts` + `usage_rollup`), W125 servicemon, the
knowledge API (hooks/bin/knowledge-api.ts, :7795), trust + pointer
mechanics (hooks/lib/knowledge.ts), the standing rule
(hooks/rules/fleet-knowledge.md), and the research base
(docs/research/compression-cache-econ-2026-10-01.md,
representation-injection-2026-10-01.md).

## 0. Mission

The fleet's measured position: context is 51.9% of modeled spend
cache-aware (W111); a ≤3KB packet injected at entry cut total tokens
−33% and time −24% (injection-final); provider cache reads cost 0.1x
input (W118/W120, T1); pull-style mid-work hub queries are
neutral-to-negative (injection-final) and cost +45% tokens on
doc-covered ground (W94 A/B, per the standing rule's skip clause).

The aids are four mechanisms that convert those measurements into
belt-callable behavior: push knowledge at dispatch (`preseed`), make
the pushed bytes hit provider KV caches (`cache-align`), shrink the
pushed bytes deterministically (`compress`), and measure every push
(`metering`). Belt stays the policy point (which aids a lane may
have); buckle is the enforcement point (builds, verifies, caps,
logs). No new daemon: the aids are buckle endpoints + belt policy,
sharing suspenders' knowledge store via :7795.

## 1. The measured base

Every design decision below rides one of these numbers.

| Claim                                    | Number                                        | Fact / source                       |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------- |
| Entry injection beats blind exploration  | −33% tok, −25% turns, −24% time               | finding.injection-final (v2)        |
| Pull-style hub queries mid-work          | neutral-to-negative                           | finding.injection-final (v2)        |
| Hub queries on doc-covered ground        | +45% tokens                                   | W94 A/B (standing rule skip clause) |
| Packet value rides pointer density       | docs packets beat hub-distilled               | finding.w113-hub-vs-docs            |
| Packets tax small repos                  | +7.6% hub / +26.7% docs vs blind              | finding.w113-hub-vs-docs            |
| Pointer rows exist, mechanically derived | source_ref + file-content sha256              | finding.w112-pointer-rows           |
| Extraction compression holds quality     | 96% @ 3x (355M, 0.4s, 2.1GB)                  | finding.w118-compression            |
| Stable-prefix caching                    | reads 0.1x; every +10pts cached ≈ −4.7% total | W118/W120 + Anthropic docs (T1)     |
| Packet size precedent                    | ≤3KB (measured 1715–2673 B packets)           | W107/W113 packet builds             |
| Context share of spend                   | 51.9% cache-aware; lanes 61.2% worst          | finding.w111-context-share          |

The precedence clause is mandatory in every packet (the injection
arm-C refusal artifact). No aid may emit knowledge without it.

## 2. Division of labor

    dispatcher (owner / fleet-loop)
        │  lane brief carries: aids: preseed=gaps cache-align
        ▼
    belt — policy point
        │  parses the aids stanza, gates it against routing-policy.yaml
        │  (aids block), calls buckle, splices the packet into the
        │  dispatch prompt after the stable prefix
        ▼
    buckle — enforcement point (:4101 shadow → :4100)
        │  POST /aids/preseed: :7795 search → trust filter →
        │  doc-covered skip → render → ≤3KB cap → packet cache
        │  logs every decision to the aid ledger
        ▼
    knowledge API :7795 — the only knowledge dependency
        (POST /search {query, domain, repo} → cards + hits with trust)

Attribution rides what W127 already built, with no request mutation:
aid events carry sid + work_item; token outcomes join via
sessions(sid → actor) into usage_rollup (hourly buckets, per model).
Coarse but honest; per-packet request headers are deliberately NOT
added — nothing mutates a request to attribute an aid.

## 3. Aid catalog

Each aid: what, fires when, measured basis, cost, off-switch.

### 3a. `preseed` — context preseeding (PUSH)

**What.** A pointer-only knowledge packet, built by buckle at dispatch
time, spliced into the lane brief after the stable prefix.

**Fires when.** The brief declares `preseed=<domain>` and belt policy
allows the domain; skipped honestly otherwise.

**Build pipeline** (all buckle-side, one endpoint):

1. POST :7795 /search with the domain (optional focus terms: see §4),
   `limit: 50`, and `repo: <lane worktree root>` — the API already
   resolves trust relative to the caller's root (knowledge-api.ts
   `str(body.repo) ?? API_ROOT`).
2. Keep `state === "active"` AND `trust === "verified"` rows ONLY.
   Candidate, retired, unverified, and drift rows never enter a
   packet — poisoning guard, enforced mechanically, not by prompt.
3. Docs-covered skip: run the substitution test
   (`substitutionCheck`, COVERED_MIN 0.75) of each surviving row's
   fact against the lane repo's docs corpus (`loadDocs`). A row the
   repo's own docs already teach is dropped (W94: the agent would pay
   hub AND files). If ≥70% of candidate rows drop, emit NO packet and
   log `skip_reason: doc-covered` — this doubles as the W113
   small-repo tax gate and the Self-Route-style "say no" router.
4. Render byte-stable cards, sorted by row id, capped ≤3KB by
   dropping highest ids first. Header carries counts + packet id
   only; NO timestamps, NO age values inside the packet (the W120
   prefix-kill failure mode). Card shape:

   ```text
   [fleet preseed · domain gaps · 5 rows · packet 9f3a21]
   <KNOWLEDGE_PRECEDENCE, verbatim, once>
   k#214 · gates: post-files gate lives in this repo [active · verified]
     <fact, ≤ 2 lines>
     source: hooks/gates/files.ts
   k#87 · ...
     ...
     source: docs/coordination-protocol.md
   ```

5. `packet_id` = sha256 of the packet bytes (short prefix). Cache key
   = (domain, focus, repo-root-hash, TTL window). Rebuild on TTL
   expiry, member drift, or candidate-set change. Reuse re-verifies
   member hashes before serving (cheap sha256 over a few files).

**Measured basis.** injection-final (−33% tok at entry), W113
(pointer density is the carrier — cards keep file paths verbatim),
W112 (pointer rows with sha256 already exist).

**Cost.** ~500–750 tokens per injected lane (≤3KB). Build cost:
local FTS query + a few sha256s, ms-scale. Fan-out burst risk is
bounded by lesson.fanout-rate-budget (cap ~6 concurrent lanes).

**Off-switch.** Omit the aid in the brief; `aids: off` (§4); belt
policy `aids.preseed` allowlist; buckle config kill-switch. Four
layers, tersest wins. A buckle outage must never block a dispatch —
belt proceeds blind on timeout (hard 2s) or 5xx and logs
`aid_skipped` (aids are garnish, not dependency).

### 3b. `cache-align` — prefix-cache alignment

**What.** Layout doctrine so packets + system prompts ride provider
prompt caches (reads 0.1x) and the local MLX KV persistence.

**Fires when.** Declared `cache-align` (or belt policy default-on).
For cloud this is opt-in request layout; for local it is KV
precompute orchestration.

**Cloud (Anthropic-dialect).** Canonical block order:
tools → system(static fleet preamble) → shared fleet packet cards →
per-lane brief. One `cache_control` breakpoint after the shared
cards (breakpoints cost nothing, up to 4 — W120 T1). Applied ONLY on
declared requests; otherwise buckle passes bodies verbatim (the W131
transport philosophy stands: no silent rewriting).

**Local (MLX resident fleet).** `mlx_lm.cache_prompt
--prompt-cache-file` persists the packet-prefix KV per resident
model (W120 T1: the flag + `--kv-bits` quantization exist in
mlx-lm). Orchestration rides the llm-keepwarm pattern: launchd
one-shot pass on the keepwarm cadence, precompute once per
(packet_id, resident model), invalidate on packet_id change. Caveat
(W120 T2): file-based KV is valid only per exact model weights.

**Measured basis.** Anthropic cached reads 0.1x, exact-prefix
matching (W120 T1); every +10 points of cached context share ≈ −4.7%
of total spend (W118 steal #2); shared-prefix throughput 1.67–3.58x
(PagedAttention, T1). Lanes are the worst context-share class at
61.2% (W111) — the direct target.

**Cost.** Near-zero token cost — pure layout. Real risk is
misplacement: a breakpoint inside volatile content makes every
request a cache write (1.25x) instead of a read (0.1x). The primary
metric is per-lane cache_read share from usage_rollup's `cache_r`
column (W127 already harvests it).

**Off-switch.** Omit; `aids: off`; policy default-off per lane class;
buckle kill-switch. Local KV precompute has its own launchd label —
unload it to stop.

### 3c. `compress` — deterministic packet compression (optional)

**What.** LLMLingua-2-class extraction (96% quality @ 3x; 355M
classifier, 0.4s, 2.1GB — W118 T1) on packet PROSE above a
threshold. File pointers stay verbatim (W112/W118 steal #1: compress
only the architecture/operational layer — exactly what W113 showed
loses to pointers).

**Fires when.** Packet prose (non-pointer lines) exceeds ~1.5KB AND a
compressor is reachable. Deterministic, run at PACKET BUILD only —
never per-request (per-request mutation = 0% exact-prefix hit rate;
this is the W118 tension, resolved by build-time-only compression).

**Serving options** (in probe order):

1. Probe: the :8902 extract specialist via a local chat call — zero
   new infra, quality unproven for extraction-style deletion.
2. If ROI positive: dedicated small extractor (355M-class) hosted on
   the swarm, offline preprocessing at packet build.

**Honest economics** (why this is optional, last). Cached reads cost
0.1x — compression saves ~10x less than raw-token math when traffic
is cache-hit-dominated. ROI is strongest on cache-miss traffic:
first turn of a lane, lanes on models without KV persistence, and
the local fleet before cache_prompt lands. The brief's own bar
stands: measure whether the compression call costs less than it
saves — with metering (§3d) supplying the measured rates, and the
0.1x rate applied to saved tokens in the ROI math.

**Off-switch.** Default-off everywhere; policy key
`aids.compress: {maxProseBytes, on: false}`; omission in the brief.

### 3d. `metering` — the aid ledger (cross-cutting, build first)

**What.** Every aid decision logs one event; dashboards compute aid
ROI; unfounded aids retire on data (the W113 lesson — hub-distilled
packets lost to docs packets — institutionalized as a retirement
rule, not a memory).

**Event shape** (buckle-local WAL sqlite, metrics.db precedent):

```json
{
  "ts": 1790849824198,
  "aid": "preseed",
  "decision": "injected | skipped | rebuilt",
  "skip_reason": "doc-covered | no-verified-rows | policy | outage",
  "domain": "gaps",
  "repo_fp": "<sha256 of repo root path — never the path>",
  "sid": "w137-aids",
  "work_item": "W137",
  "packet_id": "9f3a21",
  "rows": {
    "total": 12,
    "verified": 5,
    "skipped_doc_covered": 4,
    "skipped_unverified": 3
  },
  "tok_injected": 612,
  "est_tok_saved": null,
  "basis": "finding.injection-final@v2"
}
```

**ROI honesty rule.** `est_tok_saved` is NULL at event time. Savings
estimates come from paired A/B cells (aid on vs aid off, same work
item shape), stored as facts (`finding.aids.<aid>.roi`), applied at
dashboard time with the basis cited. n=1 cells are the fleet
precedent (injection-final is n=1 directional). No per-request
fabrication.

**Surfaces.** Raw events stay buckle-local; an hourly rollup lands
in govdb `aid_rollup` (§6) so the W127 board panel (/api/usage) can
show aid ROI, and servicemon /metrics carries live per-aid counters
(injected_total, skipped_total by reason, tok_injected_total).

**Measured basis.** W125 servicemon doctrine (omit honestly, never
fake zeros); W127 ledger shape; injection-final's metrics method.

**Cost.** One insert per decision. Negligible.

**Off-switch.** None — metering is the condition of the other aids
existing. An aid that cannot log does not fire.

## 4. Belt surface: how a lane brief declares aids

### Grammar

```text
aids: preseed=gaps cache-align
aids: preseed=gaps:work-graph,fleet-loop cache-align
aids: off
```

Two-line long forms normalize to the same stanza:

```text
preseed: gaps
cache-align: true
```

Rules: keys are {preseed, cache-align, compress, off}; unknown keys
are ignored and logged (forward-compatible); `off` wins over all;
`preseed` value is `<domain>[:<focus-term>...]` — focus terms
narrow the :7795 query (FTS OR-terms under the domain filter) when a
work item touches a known slice of a big domain.

### Flow

1. Dispatcher assembles the brief; belt parses the aids stanza.
2. Belt gates the stanza against its policy (routing-policy.yaml
   gains an `aids:` block — see below). Policy wins over declaration:
   a lane may REQUEST what policy forbids; the result is a skip with
   `skip_reason: policy`, not an error.
3. Belt calls buckle POST /aids/preseed {domain, focus?, repo_root,
   sid, work_item} with a hard 2s timeout.
4. On `injected`: belt splices the packet after the stable prefix —
   static system prompt, then shared packet cards, then the
   per-lane brief (the §3b block order starts HERE, at the brief).
5. Buckle logs the aid event; the lane runs; usage-harvest (W127)
   attributes tokens per actor into usage_rollup; the ROI join is
   aid_events(sid, work_item) ⋈ usage_rollup(actor, hour).

### Policy (belt yaml, unchanged mechanics)

```yaml
aids:
  preseed:
    default: off
    domains: [gaps, suspenders, coordination]
  cache-align:
    default: on
  compress:
    default: off
    max_prose_bytes: 1536
```

Belt remains the policy point: operators edit YAML, never code (the
same resolution order as today's policy file: env → runtime copy →
committed default). Buckle remains the enforcement point: it
validates, verifies, caps, logs, and refuses unknown domains with an
honest 4xx. Neither surface ever trusts the other's prose.

## 5. Failure modes

| Failure                      | Guard                                                                                             | Basis                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| Stale packets                | TTL + per-reuse hash re-verify; drift rows dropped, never served happy                            | W103 trust mechanics        |
| Cache poisoning              | Build-time filter: `state=active` AND `trust=verified` ONLY; candidate/unverified/drift excluded  | W103; brief requirement     |
| Doc-covered double-spend     | substitutionCheck vs lane docs corpus; covered rows dropped; ≥70% covered → aid skips with reason | W94 +45%; W113 tax          |
| Packet bloat                 | ≤3KB hard cap, deterministic drop order, no timestamps inside cards                               | W107/W113; W120             |
| Timestamp churn kills prefix | Byte-stable renderer distinct from proseCards (no age/day values)                                 | W120 prefix-kill failure    |
| Small-repo tax               | Doc-covered gate doubles as the "say no" router; skips logged                                     | W113 +7.6–26.7%             |
| Buckle outage mid-dispatch   | Best-effort: belt proceeds blind on 2s timeout / 5xx, logs `aid_skipped`                          | honest degradation doctrine |
| Metering fiction             | est saved is A/B-derived at dashboard time; events carry the basis fact key                       | injection-final honesty     |
| Cache-write storms           | packet_id change = intentional miss; TTL sized so rebuilds are rare; MLX KV invalidated on change | W118/W120 cache econ        |
| Precedence omission          | The clause is part of the packet header, not an optional line                                     | injection arm-C refusal     |

## 6. Build order, effort, and the W132 boundary

Sizes per the W131 convention: S ≤ ~150 LOC, M ~150–400, L > 400.

| #   | Piece                                                                        | Lives in                | Size |
| --- | ---------------------------------------------------------------------------- | ----------------------- | ---- |
| 1   | Metering skeleton: aid_events store + servicemon counters                    | buckle                  | S    |
| 2   | /aids/preseed: :7795 search → trust filter → doc-covered skip → render → cap | buckle                  | M    |
| 3   | Brief grammar (aids stanza) + policy yaml aids block + packet splice         | belt                    | S    |
| 4   | Packet cache (domain, focus, repo-hash, TTL) + drift re-verify               | buckle                  | S    |
| 5   | govdb `aid_rollup` table + deltas triggers + board /api/usage ROI panel      | suspenders (W132-class) | S–M  |
| 6   | cache-align cloud: opt-in breakpoint normalization                           | buckle                  | S–M  |
| 7   | cache-align local: mlx_lm.cache_prompt orchestration (keepwarm pattern)      | belt/swarm              | M    |
| 8   | A/B ROI harness: paired cells, roi facts refresh                             | belt                    | M    |
| 9   | compress probe: :8902 extract-specialist quality probe                       | buckle                  | S    |
| 10  | compress full: dedicated 355M-class extractor + offline build integration    | buckle                  | L    |

Build order: 1 → 2 → 3 → 4 → 5 → 6 → 8 → 9 → 10-if-measured →
7-if-local-cache-miss-share-is-high. Metering first so every later
aid lands measured. 5 is the only suspenders-side item and the only
one touching govdb schema.

### The W132 boundary

**Needs govdb (a W132-class schema lane):** one table.

```sql
CREATE TABLE IF NOT EXISTS aid_rollup (
  hour_bucket INTEGER NOT NULL,
  aid TEXT NOT NULL,
  domain TEXT NOT NULL,
  model_group TEXT NOT NULL,
  injected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  tok_injected INTEGER NOT NULL DEFAULT 0,
  est_tok_saved INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, aid, domain, model_group)
);
```

Declared in govdb.ts so the deltas triggers audit it for free (the
W131 schema-ownership note). usage_rollup (v7) is reused as-is for
token outcomes — no change to it.

**Buckle-local (no govdb involvement):** the packet cache (memory +
disk), the raw aid_events log, the rendered packet bytes, the
packet_id algebra, and the compression probe. If buckle dies, the
aids die with it and nothing else notices — the control plane keeps
running (aids are garnish, not dependency).

## 7. Honest limits

- Everything quantitative rides n=1-directional cells
  (injection-final, W113). The A/B harness (piece 8) exists to turn
  directional into rolling; until then, ROI numbers on dashboards
  must cite their cell.
- The 70% doc-covered skip threshold is a design default, not a
  measurement; COVERED_MIN 0.75 is the mechanical constant it leans
  on. Tune from metering, not vibes.
- `est_tok_saved` on dashboards is a model, labeled as one. The
  honest immediate metric is tokens injected + cache_read share per
  lane, both already harvested (W127).
- Provider cache behavior beyond the T1-verified Anthropic figures
  (other providers' prefixes, MLX cache_prompt persistence across
  restarts) is UNVERIFIED for our pool — the shadow week (W131's
  harness) is where those get pinned before cache-align defaults on.
- Compress is specified but deliberately unbuilt until metering
  proves packet prose dominates and cache-miss share is high. The
  expected-value math (0.1x reads) says it usually will not — the
  aid exists so the measurement, not the folklore, decides.
