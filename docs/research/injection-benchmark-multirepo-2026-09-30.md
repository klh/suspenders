# Injection benchmark, multi-repo (2026-09-30)

Research note (W107). Extends the clean-room injection A/B (suspenders-only,
hub-distilled packets) to three repos where the injection packet is
**docs-derived** — built from each repo's own README/docs/architecture
comments, because the hub at :7795 has no rows for these repos. Deciding
question: does brief-injection still beat blind when the packet is not
hub-distilled?

Tiers: T1 = run output / file content read directly; UNVERIFIED = stated but
not independently confirmed.

## Summary

Injection generalized to 2 of 3 repos: on the two repos with a real
navigation problem (gaps, hojtaler) the packet cut duration ~30%, turns 9–16%,
input tokens 28–36%; on the small self-contained .NET tool
(tredebanken-v2 SchemaDocGenerator — one Program.cs file) injection **cost**
+27% duration and +19% input tokens with zero turns saved. That is the same
shape as the suspenders baseline's metrics cell (small surface, injection
loses) and its inverse (events cell: −52% turns). Docs-derived packets behave
like the hub-distilled ones: value scales with how much navigation there is to
skip.

## Method

- Harness: `/tmp/ab-bench/run2.ts` (parameterized descendant of the original
  `run.ts`). Per cell: fresh `file://` depth-1 clone, scrub list extended to
  CLAUDE.md, AGENTS.md, README.md, docs/, .qlty/, .claude/, NOTICE, **.fleet,
  .workgraph.jsonl, .github**, origin removed, HOME + CLAUDE_CONFIG_DIR
  isolated, env stripped of CLAUDE_*, permission system ON (`acceptEdits` +
  explicit allowlist: Read/Grep/Glob/Edit/Write, git status/diff/log, ls, plus
  the repo's own runner — bun for gaps, bash+python3+node for hojtaler, dotnet
  for tredebanken). Task template (identical both arms):
  "add a --json flag to the `<CMD>` command of the `<CLI>` script in this repo
  — it exists; match conventions; verify field-wise equivalence."
- Targets, all verified to exist and run BEFORE the brief was written (the
  events-task premise-bug rule): gaps `models` table (T1: ran it);
  hojtaler `hojtaler-debug` diagnostic dump (T1); tredebanken-v2
  `SchemaDocGenerator` run summary (T1: dotnet run + regenerate wrapper).
- Packets: ≤3KB each (1816/1790/1715 B), prose cards, one fact per line, file
  pointers, precedence clause ("task wins; note it in one line and adapt")
  prepended. Docs-derived only — no hub rows exist for these repos.
- Both arms of a pair run with identical task, allowlist and scrub; `claude -p`
  default model, `--output-format json`. n=1 per cell.

## Results (6 cells)

| Repo           | Arm      | Duration | Turns | In tok  | Out tok | Code ins             | Delivered |
| -------------- | -------- | -------- | ----- | ------- | ------- | -------------------- | --------- |
| gaps           | blind    | 772.7s   | 105   | 119,821 | 43,651  | 112 (+new test file) | yes       |
| gaps           | injected | 529.2s   | 88    | 76,988  | 30,170  | 28                   | yes       |
| hojtaler       | blind    | 650.1s   | 64    | 62,954  | 35,546  | 117                  | yes       |
| hojtaler       | injected | 452.9s   | 58    | 45,162  | 23,118  | 131                  | yes       |
| tredebanken-v2 | blind    | 211.8s   | 39    | 24,896  | 9,844   | 37                   | yes       |
| tredebanken-v2 | injected | 268.3s   | 39    | 29,539  | 13,056  | 37                   | yes       |

All six cells delivered real code (git diff insertions + a final report
describing the change, both checked) — none INVALID, all averaged in.

### Deltas (injected vs blind)

| Repo           | Duration | Turns  | In tok | Out tok |
| -------------- | -------- | ------ | ------ | ------- |
| gaps           | −31.5%   | −16.2% | −35.8% | −30.9%  |
| hojtaler       | −30.3%   | −9.4%  | −28.3% | −35.0%  |
| tredebanken-v2 | +26.7%   | ±0%    | +18.7% | +32.7%  |

## Cross-repo pattern vs the suspenders cells

Suspenders baseline numbers re-derived from the surviving run artifacts in
`/tmp/ab-bench/*.summary` (the coord facts `finding.injection-final` /
`finding.knowledge-ab-final` are corrupted — their stored value is the literal
string `--text`, an arg-parsing mishap at write time; deltas from 2026-09-30
19:33–20:02, version 1):

- events cell (big navigation surface): blind 829.5s / 79 turns / 97,419 in vs
  injected 532.2s / 38 turns / 72,756 in → duration −35.8%, **turns −51.9%**.
- metrics cell (small surface; artifact labels partly garbled — two summary
  pairs survive: blind 443.4s/34t/39,032in and 868.2s/67t/113,110in; injected
  633.4s/39t/81,294in and 660.7s/50t/70,343in) → injection neutral-to-negative.

Pattern across both studies: **injection pays ∝ navigation surface**. Large
multi-module repos (suspenders, gaps, hojtaler) buy ~30% wall-clock and
28–36% input tokens; small self-contained surfaces (coord metrics,
SchemaDocGenerator) pay a flat packet-reading tax with nothing to skip. The
docs-derived packets matched hub-distilled economics on the repos where the
docs were good (gaps docs/specs, hojtaler README) — the hub's distillation is
not the active ingredient; the pointers are.

Mechanism notes (T1, from final reports): the injected gaps agent used the
packet's pointers to find the pinned `models list --json` contract
(tests/whisper.test.ts:1029, docs/specs/CLI.md:553 — verified in source) and
resolved the briefing/task conflict via the precedence clause, shipping a
28-line routing fix; the blind agent independently found the same contract but
built a new bare-array emitter (112 lines). Same destination, 4× the code. The
hojtaler injected arm kept its text mode byte-identical and drove both views
from one section list — no drift by construction.

## Honesty section

1. **n=1 per cell.** Six cells total; no repeats; every delta above is one
   Bernoulli draw with model/scheduler variance unquantified. The suspenders
   baseline is equally n=1 (or n=2 with the garbled metrics labels).
2. **Packets are docs-derived, not hub-distilled.** The hub has no rows for
   these repos. That is the tested variable, but it also means packet quality
   is a function of each repo's documentation quality — gaps and hojtaler have
   strong docs; a repo with bad docs would test the doc-writer, not injection.
3. **Baseline provenance is degraded:** the two named coord facts are
   corrupted (value `--text`), so the suspenders comparison rests on surviving
   `.summary` artifacts, one of which has a label bug (both metrics summaries
   say `B/work2`).
4. **gaps premise nuance:** the task said "add a --json flag … it exists";
   `models list --json` already existed at HEAD (test-pinned), bare
   `models --json` did not. Both arms discovered this; both deliveries are
   legitimate readings. No cell invalidated.
5. **Target selection:** hojtaler's `speaker-card list` already prints JSON and
   its other tools are destructive, so the cell used `hojtaler-debug` (bash) —
   a template adaptation, disclosed. The tredebanken "command" is a single-run
   .NET tool, so its `--json` summary is a thinner feature than the other two.
6. **Static packet ≠ live hub.** The original side-A queried :7795 at run time;
   here the packet is frozen in the brief. Cache/curl costs are absent from
   this study's injected arm.
7. Run artifacts preserved under `/tmp/ab-bench/<repo>-<side>/` (brief.md,
   result.json, stderr.log, sandbox repo). /tmp is volatile.

## Verdict

**Yes — injection generalizes: docs-derived packets reproduce the hub-distilled
pattern (~30% cheaper on repos with navigation to skip) but inherit its
weakness too: on a small self-contained surface they are a pure tax (+27%
duration), so gate injection on repo size/task breadth, not on packet source.**
