# Token patterns in the journals — 2026-09-30 (W109)

Scope: 293 transcripts in ~/.claude/projects (suspenders + gaps roots incl. subagents/, plus 78 lane-worktree dirs, 7-day window 09-23..09-30), scanned line-by-line with /tmp/w109/scan.ts (2-pass). Layers: 3 orchestrator mains (ba10d3c1 gaps 93.5k lines; 3bb4718c suspenders 22k lines; 53eb333b 30.9k lines), 290 subagents, 40 lane sessions sampled.

## Scorecard (T1 = counted in transcripts)

| Metric | Value (7d sampled) | Verdict |
| --- | --- | --- |
| Tool calls | main 13,854 · subagent 25,383 · lane 4,292 (sampled) | — |
| Tool error rate | main 6.6% · subagent 7.8% · **lane 15.1%** | lanes 2.3x worse |
| Edit-attributed errors | 1,932 (of 2,880 total) | 67% of all errors |
| Anchor-class failures | 490 | top Edit class |
| Bash exec errors | 1,396 | trial-and-error queries |
| Files read >=3x/session | 66 in ba10d3c1 alone (fleet-loop.ts x37) | working-set churn |
| Full-file reads (no offset/limit) | main 462 · subagent 796 · lane 154/430 | ~1,400 events |
| Tool results >60KB chars | 23 (max 122KB ~ 30k tokens) | oversized pulls |
| Auto-compacts | 90 | amnesia risk each |
| 429 / classifier rate-limit mentions | 86 | wall-clock sink |
| Cache hit rate (orchestrators) | 97-98% (cacheR 3.37B vs in 75M, ba10d3c1) | healthy |
| Gate denials (edit-enforce/content-gate) | 31 + printf-redirect denials (ba10d3c1:43974,48217) | working as intended |
| Control-plane fact writes lost | finding.knowledge-ab-1 / -final / injection-final all stored as literal "--text" (v1) | measurement loss |

## Patterns ranked by estimated waste/day

### 1. Edit churn: anchor failures + gate-correction cycles (~1.5-2M tokens/day)

Evidence (T1): 1,932 error results attributed to Edit calls, 490 anchor-class ("String to replace not found" / "unchanged" / "has not been read"), across 7d. Lane error rate 15.1%. Each failure typically costs a re-read of the target (8-15k tokens) plus 1-2 retry turns. 31 denials are the gate working; the rest is blind-anchor churn.

Root cause: edits composed from remembered state instead of a fresh anchor; >35-line inserts from memory (see memory: emission chunk-splice) then fail the gate and get retried.

Prescription (harness, fires PreToolUse): extend content-gate to verify the Edit anchor exists in the target file BEFORE applying; on miss, deny with the nearest matching 3-line context attached (auto-rg in the denial text). Turns a blind retry into one corrective turn. Also: systematic-debugging skill auto-invoke on 3rd failed edit to the same file (symptom-loop breaker).

### 2. Compact-amnesia cycle (~1.3M tokens/day + re-derivation cost)

Evidence (T1): 90 auto-compacts in the sampled window (46 in ba10d3c1 across its ~8-day run — one every ~4h). Each re-encodes the window; after each, facts get re-derived (T2 inference: re-read spikes coincide with post-compact regions in these sessions; not directly measured per-event).

Root cause: orchestrators hold exploration in context instead of spilling to disk; 400k window invites hoarding.

Prescription: before-compact checkpoint rule in orchestrator CLAUDE.md: keep a rolling STATE.md (or coord fact) with the file-map + decisions; hook: SessionStart/compact reminder nudge to re-read STATE.md first. Post-compact first action = read checkpoint, not re-explore.

### 3. Full-file and oversized reads (~0.4-0.8M tokens/day)

Evidence (T1): 1,412 reads with no offset/limit in the sample; 23 tool results >60KB chars (max 122KB = ~30k tokens: agent-ad2d756a698873550.jsonl:75, agent-aaf077ffe7b81c221.jsonl:52); agent-a15c6363 did 114 full reads in 122 tool calls (93% of its calls). Notably 497 ls/find-walk calls vs 6,345 rg-class calls — ls-walking is minor; oversized pulls are the real sink.

Root cause: default Read = whole file; jsonl/log/data files read like source; subagents inherit no size hint.

Prescription: (a) harness: auto-clamp tool_result at 40KB with head+tail elision + "use offset/limit" note; (b) CLAUDE.md rule: reads of .jsonl/.log/.json data files MUST pass limit/offset, prefer rg first; (c) subagent brief template: include target file line-counts so the agent ranges its reads.

### 4. Re-read storms — working-set discipline (~0.3-0.6M tokens/day)

Evidence (T1): ba10d3c1 re-read bin/fleet-loop.ts 37 times (scripts/fleet-loop.ts = 227 lines ~ 2.5k tokens -> ~90k tokens of pure re-pull); subagent coord.ts x6 (agent-acf9fedf), fleet-board.ts x8 (agent-a3c3bd8b52e287ecb).

Root cause: no session file-map; after gate denials or compacts the agent re-reads instead of trusting the earlier read; orchestrator loop re-reads its own config each iteration.

Prescription: read-once rule + notes-in-context: after reading a file, record the 3 load-bearing line anchors in the running plan; on re-read of the same path >2x, the hook nudges "already read this session — cite your notes or rg the specific anchor instead".

### 5. Exec-error trial-and-error (~0.3M tokens/day, and my own session did it twice)

Evidence (T1): 1,396 cmd/exec-error class (exit!=0, SQLITE_ERROR no such column, ENOENT). Concrete: my own queries this session hit "no such column: payload_json" then "no such column: kind" back-to-back before checking PRAGMA table_info — the exact schema-unverified pattern.

Root cause: querying/writing against assumed schema; no schema-peek step.

Prescription: cheap habit rule in CLAUDE.md: "first time touching a table/DB/API in a session: print schema (.schema/PRAGMA) first". One line, kills the class's biggest repeat offender.

### 6. Rate-limit stalls (429 + classifier) — wall-clock, not tokens

Evidence (T1): 86 mentions; cites: 3bb4718c.jsonl:17535 "API Error: Request rejected (429)", :19110 same, :10362/:18872 "Classifier rate-limited — its own model under load from the lanes".

Root cause: the orchestrator's turn classifier shares the same remote quota as the lanes it dispatches; self-competition.

Prescription: route the classifier to the local :8901-8903 stack (llm-routing doctrine) or cache verdicts per (tool, path-prefix); add jittered backoff.

### 7. Control-plane measurement loss (not tokens — knowledge)

Evidence (T1): governor.db facts finding.knowledge-ab-1 (set 2026-09-30T13:28), finding.knowledge-ab-final (14:48), finding.injection-final — all values are literally "--text" (v1); the CLI took the flag as the value. The A/B numbers are unrecoverable from the control plane.

Prescription: fix coord fact set arg-parse to accept --text; reject values matching /^--/ with a usage echo. Add a fact-set round-trip assert in the loop that wrote them.

## Layer verdict

Lanes waste most per unit of work (15.1% error rate vs 6.6% main) despite the smallest contexts; subagents in the middle (7.8%) with the biggest single reads. Dispatch brief median 2.6k chars (p90 3.6k) with no file-map, no line-anchors, no done-definition digest — brief quality is the lever: orchestrators that include explicit file paths + anchors in briefs show materially fewer exploration calls (main sessions: median 17 tools to first edit vs subagent 35).

## Keep doing

- Cache discipline is excellent: 97-98% hit rate on orchestrators — pacing is right.
- Gates fire pre-write and are cheap: only 31 denials/7d and they name the fix (edit-enforce printf-redirect denials include the rule text).
- rg-first habit is real: 6,345 rg-class vs 497 ls-walk calls.
- Fleet loop is shipping: loop.log shows steady MERGE/RETIRED cadence (autow367..377 on 09-30) — the W-above-100 lanes land.

## Method

Pass 1: size-ranked biggest-24 + systematic tail sample of 7d transcripts, per-file usage/tool/error accumulation (script kept at /tmp/w109/scan.ts logic, inline in session). Pass 2: layer rollup + error classification + cites on 3 mains + all 290 subagents + lanes. Pass 3: lane sample + rg cites + loop.log. All counts T1 (counted); per-event cost assumptions stated inline; waste/day = counted events x stated per-event cost / 7 days.
