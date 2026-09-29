# Improvement register — agent-fleet research digest (2026-09-29)

Source digest: `docs/research/agent-fleet-research-2026-09-29.md` (four
parallel research tracks, ~130 searches/fetches, first-tier sourcing;
coordinator re-verified the load-bearing claims). This register maps every
ranked digest change to a concrete suspenders/fleet change, files the top
quick wins as work items, and implements one small win in the same pass.
Lane W80, 2026-09-29.

Current-state claims below were verified against this tree at `98cc10a`
(rg + read, 2026-09-29):

- `deny()` at `hooks/lib/hookio.ts:52` is the single chokepoint for all 17
  gate deny sites (bash, files, governor, codex adapter) — nothing persists
  denials: no audit file or table exists (rg `audit|denied|denials` across
  `hooks/lib` + `gate.ts` → 0 hits).
- The merge ladder's default is plain `git merge --no-ff`
  (`hooks/bin/fleet-loop.ts` `mergeOne`); merge-guard
  (`hooks/gates/bash.ts:335`) blocks foreign commits into a live merge and
  qlty gates verify code, but no agent reviewer reads the objective/diff
  before a branch lands.
- Work items carry scope/parent/priority only — no effort, tier, or model
  fields (rg `effort|budget|tier|model` in `hooks/lib/govdb.ts` → 0 hits).
- fleet-loop dispatch is per-repo policy (`--dispatch-cmd` template);
  nothing selects a model tier (rg `model|sonnet|haiku|opus` in
  `hooks/bin/fleet-loop.ts` → 0 hits).

## Register

| Digest change (rank)                                                        | Evidence (claim + source + tier)                                                                                                                                                                                                                                                                                                                                   | Concrete suspenders change                                                                                                                                                                                                                                                                 | Status                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| #1 + #5 — fresh-context review before every merge; sycophancy-proof critics | Coder-vs-reviewer with zero shared context caught ~2 bugs/PR, ~58% severe (Cognition, "Multi-Agents: What's Actually Working", Apr 2026, T1); task-objective verification is the largest measured MAST intervention, +15.6% (Cemri et al., arXiv 2503.13657, T1); debate under sycophancy underperforms single agents (Amazon MADS, arXiv 2509.23055, T1-abstract) | Merge ladder runs a headless reviewer (`claude -p`) seeded ONLY with the item objective + diff + test output — never the worker's transcript or framing; a FAIL counts as a ladder strike (park at 3)                                                                                      | Filed as W81                       |
| #2 — effort budgets in dispatch briefs                                      | Token usage alone explains 80% of multi-agent performance variance; effort budgets embedded in prompts after Anthropic's own 50-subagent runaway (Anthropic multi-agent post, Jun 2025, T1)                                                                                                                                                                        | Add an `effort` field to work items (govdb schema + `work add --effort` S/M/L) and render the budget into the dispatch brief                                                                                                                                                               | Filed as W82                       |
| #3 — role-tier model routing                                                | Haiku 4.5 = Sonnet-4-level coding at 1/3 cost, >2x speed (Anthropic model docs, T1); comparable artifacts at $2.33 cheap-tier vs ~$15 flagship (Agent Laboratory, EMN 2025, arXiv 2501.04227, T1s)                                                                                                                                                                 | Mechanical lanes (sweep, harvest, mechanical transforms) route to the cheap/fast tier; coordinator/planner/reviewer stay flagship; tier encoded per item; batch non-urgent lane work (batch = 50%, T1)                                                                                     | Filed as W83                       |
| #4 — smaller, more frequent merges                                          | "Merge conflicts are the #1 issue — not hallucinations, not wrong code"; continuous integration of agent branches beat end-of-branch batching (trigger.dev postmortem, Apr 2026, T1)                                                                                                                                                                               | Per-cycle merging already exists (fleet-loop merges every ahead branch each cycle); file the dispatcher-policy half: single-concern branches, DONE branches flow to the ladder every cycle instead of batching                                                                             | Filed as W84                       |
| #6 — cache + batch at the API layer                                         | Prompt-cache reads 0.1x, batch 50% (Anthropic pricing docs, T1)                                                                                                                                                                                                                                                                                                    | Deferred: provider-side caching already applies to shared prefixes through the CLI; explicit batching is dispatch policy, folded into the tier-routing item                                                                                                                                | Deferred → W83                     |
| #7 — blast-radius discipline for destructive ops                            | Root causes in both fleet incidents: inherited credentials + no approval stage; mitigations that worked: deterministic gates, per-task scoped identities, secrets the agent never sees, denied-call auditing (Replit agent postmortem, SaaStr, T1 first-party; Kiro/AWS 13h outage, Docker case study, T1 vendor)                                                  | Implemented slice: **denied-call audit** — every gate denial appends one JSONL line to `~/.cache/claude-governor/denied-calls.jsonl` at the `deny()` chokepoint, fire-and-forget; remaining scope (per-lane scoped credentials, two-person rule on AI-tagged destructive changes) deferred | Implemented in W80 (rest deferred) |

## Already right — no change filed

The digest's "what this fleet already does right" list maps 1:1 onto live
mechanics, so no rows: DB-enforced claims vs the METR honor-system failure
(HOLD/VETO without enforcement), merge-guard on live merges, plan-gated
shatters (decomposability predictor), one-writer leases (parallel-writes
anti-pattern), deterministic hook gates over prose, async inbox steering.
Listed so the register is complete against the digest; nothing to build.

## Implemented in this pass (W80)

Denied-call audit at the `deny()` chokepoint (`hooks/lib/hookio.ts`):

- Every gate denial — Claude and codex dialects alike — appends one JSONL
  line `{at, event, tool, cmd, path, cwd, reason}` to
  `~/.cache/claude-governor/denied-calls.jsonl` (same dir as the govdb
  registry and the motd).
- Fire-and-forget by construction: an append failure can never break the
  deny path it is auditing.
- Truncation caps: cmd 200 chars, path 300, reason 300.
- Sensitivity note: cmd snippets are truncated, not redacted — the audit
  inherits transcript-level sensitivity and is strictly a subset of what
  the session transcript already records on disk. The secrets gate's deny
  reasons are generic prose and never echo the matched secret (verified in
  `hooks/gates/bash.ts`), so the reason field is safe; the cmd field is
  the sensitive one.
- Test: `test/deny-audit.test.ts` — a real `pre-files` chain spawn with a
  > 40-line Write trips mutation-size and must produce exactly one parseable
  > audit line in an isolated `$HOME`; the allow path must produce none;
  > `auditDeny()` is pinned on truncation directly.
