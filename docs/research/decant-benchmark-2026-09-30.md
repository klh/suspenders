# Decant benchmark — activity-classified spend for our fleet (2026-09-30, W111)

Tier marks: **T1** = source file read (this pass); **T2** = marketing/social claims,
treated as claims; **counted** = measured on our journals this pass (method below).
Companion to `token-patterns-journals-2026-09-30.md` (W109, same corpus and window)
and `dosu-knowledge-mechanism-2026-09-30.md` (W103 — retrieval-side mechanism).

## 0. Premise correction (read first)

The work item called decant "dosu's knowledge backend". Source says otherwise
(T1: github.com/dosu-ai/decant, Apache-2.0, TypeScript/Bun): decant is dosu's
**local-first log-analytics layer** — it ingests Claude Code/Codex/Gemini session
logs, stores them in a SQLite archive (`~/.decant/decant.db`, owner-only 0600,
FTS over prompts/tool args), and classifies token spend into four activity
buckets. It is the **measurement instrument** behind dosu's benchmark posts, not
the knowledge store. The knowledge backend (`read_knowledge` MCP server) remains
closed source; the W103 doc already traced its client contracts. This pass
therefore pivots: decant-as-reference = classification methodology + schema +
capture contracts, and part B replicates their benchmark shape on our journals.

## 1. What ran (counted, T1 method)

Own classifier (`/tmp/w111/classify.ts`, Bun, streaming line-by-line — same
big-file hygiene as W109) implementing decant's documented rules
(`docs/analytics-methodology.md`, `src/buckets.ts`, `src/cost.ts`):

- Corpus: all `~/.claude/projects/*klh-suspenders*` and `*klh-gaps*` transcripts
  (roots + lane worktrees, incl. `subagents/`), mtime >= 2026-09-23, entry
  timestamps filtered to the same 7d window as W109.
- 833 files, 723,919 lines (466,640 skipped as pre-window), 76,878 assistant
  API messages, 0 parse errors, 31 compaction markers detected. Layers: 345
  main-session files, 414 subagent, 74 lane.
- Buckets per decant: context (reads/searches/orchestration/unknown tools/
  read-only shell; tool-result bytes + user/other-agent content = the
  context-window volume basis), planning (thinking + todo/task tools), code
  (Edit/Write + mutating shell, conservative: unrecognized shell = code),
  communicating (visible text + AskUserQuestion).
- Cost shares mirror decant's shape: generation allocated from per-message
  usage (deduped per `message.id`, largest-output snapshot; output split across
  blocks by chars); input-side tokens allocated across the accumulated
  context-window volume (user-role content: tool results, user text, injected
  packets, plus a one-time seed for the journal-invisible system prompt).
  Pricing shape: input 1x, cache write 1.25x, cache read 0.1x, output 5x.

## 2. Headline: our context share vs Dosu's claim

| Bucket        | Ours (cost, cache-aware) | Ours (cost, standard-rate, no cache discount) | Dosu claim (T2, unverified)                           |
| ------------- | ------------------------ | --------------------------------------------- | ----------------------------------------------------- |
| **Context**   | **51.9%**                | **58.4%**                                     | 58% (GPT-6.1 Sol) / 40% (Sonnet 5.5) / 38% (Opus 5.5) |
| Planning      | 8.9%                     | 1.2%                                          | 3% / 27% / 25%                                        |
| Code          | 38.6%                    | 40.3%                                         | remainder                                             |
| Communicating | 0.6%                     | 0.1%                                          | remainder                                             |

**Our context share lands inside Dosu's claimed 38-58% band under both pricings**
— external validation that the fleet prescriptions (brief file-maps, read-once,
auto-clamp, pointer-grade store) target the dominant line item. Dosu's own
verified-shape corroboration from their earlier post (T1-fetched text): 67% of
modeled spend on planning+context combined, 26% code, 46% of spend before the
first edit, across 112 replayed sessions.

Modeled spend (sonnet-class rates with cache discounts, not invoices):
~$1.2k/7d across the sampled fleet — context ~$615, code ~$457, planning ~$105,
communicating ~$7.

### Per layer (cache-aware cost shares)

| Layer                | Context   | Planning | Code  | Communicating |
| -------------------- | --------- | -------- | ----- | ------------- |
| Main (orchestrators) | **57.7%** | 8.2%     | 33.5% | 0.6%          |
| Subagents            | 44.2%     | 9.6%     | 45.6% | 0.7%          |
| Lanes                | **61.2%** | 9.2%     | 29.0% | 1.9%          |

- Orchestrators sit exactly at Sol's claimed 58%; **lanes exceed Dosu's entire
  claimed band (61.2%)** — lane context burn is our worst line item.
- Planning generation is 59.4% of output tokens fleet-wide, but planning is only
  8.9% of cost: thinking produces no tool results, so it attracts almost no
  input-side cost. The fleet thinks enormously and communicates little (visible
  text = 4.2% of generation, 0.6% of cost).
- All-content volume view: thinking = 60.1% of every byte in the journals
  (inflated by `redacted_thinking` base64 `data` counted as thinking chars —
  caveat below); tool results + user content are the remaining 40%.

## 3. Method notes and caveats (affects comparability)

1. **Decant itself was not executed** — `bunx @dosu/decant` was denied by the
   permission system (npm-package execution). The classifier is re-implemented
   from their T1 methodology doc + source; no cross-check against decant's own
   output was possible. Directional, not calibrated.
2. **Input attribution basis is a modeling choice.** Decant states context-window
   volume = tool-result bytes + other-agent messages; model output is generation.
   I allocate each message's input tokens across the _user-role content_
   accumulated so far (tool results bucketed by their call's bucket, user text /
   injected packets / briefs = context). Alternative basis (including model
   output in the window) shifts context to ~33% and planning to ~31% — reported
   for completeness; the decant-faithful basis is the headline.
3. **First-message seed**: Claude Code journals omit the harness system prompt;
   a one-time context-class seed stands in for it (decant counts harness
   injections as context).
4. Compaction: 31 markers detected (W109 counted 90 with a wider marker net);
   the volume basis resets on marker — detection is heuristic, residual
   over-attribution possible.
5. Model mix: output weight fixed at 5x for all models (sonnet/opus/haiku are
   all 5x in decant's table; local/GLM lane models unknown — lanes may be
   mispriced).
6. `redacted_thinking.data` (base64) counted as thinking chars: inflates
   planning's share of the volume view and of output-token allocation where
   blocks are char-proportional.
7. Dosu's per-model numbers (58/40/38, 3/27/25, $0.45 vs $1.58, "5 tasks") are
   **owner-supplied T2 claims** — the post text I could fetch carried their
   earlier cal.diy benchmark instead (112 sessions; 67% planning+context; 26%
   code; 46% before first edit; CC $1.11 self-contained vs $4.96 cross-cutting).
   Cite per-model figures as claims, not findings.

## 4. Decant vs our hub — mechanism table

(decant = measurement layer; hub = W91 store + W103 contracts, governor.db
knowledge rows + facts_fts + distill worker + knowledge-mcp.)

| Axis           | decant (T1)                                                                                                                                       | Our hub (W91/W103)                                                                                                                                        | Verdict                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Store          | SQLite archive, frozen `schema.sql` v24 baseline; session/message/block rows; provenance fields (source_path, source_hash, mtime, schema_version) | governor.db knowledge rows + facts_fts (external-content FTS5), sortable axes, provenance (origin_sid, contributors), staleness, source_hash drift checks | Parity in spirit; decant freezes a baseline schema + migrations manifest, we converge via every-open rebuild         |
| Capture        | `sync` from log dirs, incremental with source_hash/mtime; parser-change reprocess checkpoint re-ingests once                                      | SessionEnd hooks -> queue -> distill worker (p-queue 1, retry x3, poison purge)                                                                           | Different objects (raw logs vs distilled facts); decant never trusts a model to summarize its archive — worth noting |
| Classification | 4 activity buckets, conservative rules (unknown tool -> context, unknown shell -> code), requestId dedup (largest-output snapshot)                | none — W109 counted events, not activity                                                                                                                  | **Gap: adopt as standing fleet meter**                                                                               |
| Retrieval      | FTS over prompts/tool args + SQL query API (OpenAPI 3.1 documented, local)                                                                        | facts_fts + knowledge-mcp prose cards + /search                                                                                                           | Hub is pointer-grade + substitution-contracted; decant is raw-log search — different jobs                            |
| Ranking        | none beyond SQL/FTS (recency/order)                                                                                                               | stale-ranks-down, hit count, trust line                                                                                                                   | Hub ahead for knowledge; decant doesn't pretend                                                                      |
| Trust          | operational, not epistemic: local-only, 0600 archive, no outbound calls; unauthenticated local API (their own caveat)                             | verified+active = permission-to-act; redactSecrets mechanical gate; pointer-grade source_hash                                                             | Hub has the harder problem and addresses it; decant sidesteps by never asserting                                     |
| Injection      | none — decant injects nothing anywhere                                                                                                            | standing rule + read_knowledge (W103), substitution contract on ingest                                                                                    | N/A — measurement vs memory                                                                                          |

## 5. Steal-list (concrete, buildable)

1. **Standing activity meter (highest value):** promote `/tmp/w111/classify.ts`
   to `scripts/token-activity.ts`, run weekly (launchd or fleet loop), publish
   context-share per lane to the board. Lanes at 61.2% context = direct
   feedback on brief quality. Decant proved the shape; we already have the data.
2. **requestId dedup contract:** keep the largest-output usage snapshot per
   `message.id` in any fleet token metering — W109's raw sums could double-count
   block-split messages.
3. **Orientation-vs-implementation axis:** split all metrics at first edit
   (decant: 46% of spend happens before the first edit). Cheap addition to the
   W109 scanner; tells whether our context burn is pre-work exploration or
   mid-task churn.
4. **Search-count normalization:** searches = Grep/Glob calls + rg/grep/find
   first-pipeline-stages; adopt as the standing metric for the rg-first habit.
5. **Conservative defaults as doctrine:** unknown tool -> context (don't
   overstate implementation), unknown shell -> code (don't understate cost).
   Symmetric conservatism; steal for any future classifier we ship.
6. **Pricing-shape metering:** input 1x / cache 1.25x+0.1x / output 5x for any
   fleet $ dashboard; decant's `docs/pricing.md` pattern (rates checked against
   official sources, re-reconciled every sync).
7. **Parser-change reprocess checkpoint:** decant re-ingests affected sources
   exactly once when the parser changes — the same pattern would let us evolve
   knowledge distillation prompts without orphaning queued items.

## 6. Queued (not run)

- **Gold injection cell** (decant-retrieved packet vs our-hub packet vs blind):
  /tmp/ab-bench is owned by the W107 docs-packet lane — queued per constraint.
  Note decant's archive is raw logs, so the decant arm would measure FTS-over-
  logs as a knowledge source; the dosu server would be the real rival, and it
  is closed.
- Empirical decant stand-up on a scratch port — denied (npm execution);
  methodology-level comparison above instead.

## 7. Could not verify

- Dosu's per-model benchmark numbers (T2 claims; see §3.7).
- Classifier calibration vs decant's own output (not executed).
- Whether decant's cost model weights buckets by model-specific pricing per
  session (their table implies yes; our replication uses sonnet-class 5x for
  all — lane-local models unpriced).
- Compaction-marker completeness (31 detected vs W109's 90).

## 8. Source register

| Source                                                           | Tier            | Establishes                                                                                                              |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| github.com/dosu-ai/decant `docs/analytics-methodology.md` (main) | T1              | Bucket definitions, shell/orchestration rules, generation/volume allocation, dedup, non-model records                    |
| `src/buckets.ts`, `src/schema.sql`, `src/cost.ts` (main)         | T1              | Classifier constants, SQLite schema v24, pricing shape (cache 0.1x/1.25x, output 5x, sonnet-5-5 $2/$10, opus-5-5 $4/$20) |
| README via github.com/dosu-ai/decant                             | T1              | Local-first archive, 0600, no outbound calls, CLI surface                                                                |
| Devin Stein LinkedIn (fetched 2026-09-30)                        | T2              | Prior benchmark: 112 sessions, 67% planning+context, 26% code, 46% pre-first-edit, $1.11/$4.96                           |
| Owner-supplied per-model figures                                 | T2 (unverified) | 58/40/38 context, 3/27/25 planning, $0.45 vs $1.58                                                                       |
| `/tmp/w111/classify.ts` over 833 journal files                   | counted         | All our numbers, §1-§2                                                                                                   |
| W109 + W103 docs (this repo)                                     | internal        | Corpus, prior findings, hub mechanism                                                                                    |
