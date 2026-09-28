# codex hook adapter — spec (W68, 2026-09-28)

> Status: SPEC — implementation is a follow-up work item, sequenced from
> this file. Source of truth: this file. If implementation diverges, this
> spec wins or gets amended.
> Sources: W66 docs-verified codex surface (docs/codex-portability.md,
> 2026-09-28) + W67 first-hand pilot (docs/fleet-loop.md §Selecting the
> agent backend; merge f3d3139). Codex CLI surface facts below remain
> **docs-tier until step 0 of the implementation re-verifies them live** —
> that re-verification is a precondition, not an afterthought.

## Problem

Claude lanes get the fleet's quality gates through Claude Code's hook
system (`settings.json` → `bun gate.ts <event>`). Codex lanes (W67 pilot)
run **gate-less**: no bash secret/lease gate, no file governor (leases /
area claims), no mutation-size cap, no ledger-marker gate, no post-write
qlty gate, no stop gate, no session bootstrap. Every codex lane is a blind
writer the plane cannot see. W66 priced this as the port's real cost and
allowed it "only for the pilot" — the pilot is over, so the gap is the
work: **enforce fleet gates on codex lanes without rewriting the gates.**

## Current seam

- `hooks/gate.ts` — THE single hook entrypoint; owns stdin + dispatch;
  gates live in `hooks/gates/*.ts`, contracts in `hooks/lib/hookio.ts`
  (THE one definition of allow/deny/ask/nudge/context/feedback).
- The gates themselves are already agent-agnostic: they consume
  `HookInput` (tool_name, tool_input, cwd, session_id, transcript_path)
  and speak only through hookio's helpers. The dialect is confined to the
  contract boundary — that boundary is where the adapter goes.
- Identity today: `laneId()` = `session_id` (+ `#<subagent>` from the
  transcript path). Codex hook payloads carry **no session_id** (W66:
  `thread.started` carries a thread id instead). Dispatch mints the fleet
  sid (`autow<n>`) and writes it to `lanes.json` + the work-graph claim,
  but no hook-visible channel carries it into a codex lane.

## Design

### Principle: dialect layer at the contract boundary, not a gate rewrite

Gates keep **zero** codex knowledge. The adapter owns two translations —
payload in, decision out — plus wiring. Dialect is bound at **wiring
time by argv**, not sniffed at runtime: Claude registrations stay
`bun gate.ts <event>`; codex wiring calls `bun gate.ts codex <event>`.
Explicit data flow, no magic, one switch in gate.ts.

### Payload normalization (codex → HookInput)

| codex payload (docs-tier, verify live)              | HookInput field                                   |
| --------------------------------------------------- | ------------------------------------------------- |
| thread/session id (`thread.started`, per-event ids) | `session_id`                                      |
| tool name (`shell` / `exec` / `apply_patch`)        | `tool_name`                                       |
| command array/string                                | `tool_input.command`                              |
| apply-patch file path + patch body                  | `tool_input.file_path`, `old_string`/`new_string` |
| working directory                                   | `cwd`                                             |

Tool-name and input-shape normalization matters for teeth, not
cosmetics: `bash.ts` inspects `tool_input.command`; `governor.ts` keys
leases on `file_path`. Codex edits files via `apply_patch`/shell, not
Edit/Write — if codex does not fire per-patch hooks (verify), the
fallback is command-level inspection in the normalized command string.

### Output translation (the teeth — translate precisely or lose them silently)

| Semantic      | Claude dialect                        | Codex dialect (docs-tier, verify live)                                   |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| allow         | stdout `{}` / exit 0                  | empty/approve control JSON                                               |
| deny          | `permissionDecision: "deny"` + reason | codex block/deny control JSON                                            |
| ask           | `permissionDecision: "ask"`           | if no equivalent: **deny** — degrade toward safety, never silently allow |
| nudge/context | `additionalContext`                   | codex context-injection schema, else stderr note (logged, non-blocking)  |
| feedback      | exit 2 + stderr                       | codex post-run feedback schema, else journal                             |

Degradation rule: **deny, never silently allow** on a missing decision
channel. This is distinct from the gates' fail-open doctrine — fail-open
covers a _dead registry_ (infrastructure), never a _missing block
channel_ (enforcement). Where codex cannot block, the adapter logs to the
drift journal so the gap is visible on the board, not silent.

### Identity bridging (the correctness invariant)

Every governor.db row written through the adapter must use the **fleet
sid** (`autow<n>`) as laneId — locks, claims, and sessions rows must line
up with `work take --as autow<n>`, `coord lease-release --as`, and coord
emissions. A synthetic thread-id-derived laneId would split lease
ownership from work ownership and break arbitration. Resolution order:

1. **`SUSPENDERS_SID` env** — dispatch sets it in the lane env; hooks
   inherit codex's env (verify). Primary.
2. **ppid-walk → lanes.json** — dispatch spawns codex via
   `sh -c exec`, so codex's pid IS the lanes.json pid; walking ancestors
   from the hook process to a lanes.json entry resolves the sid
   mechanically. Fallback.
3. **Unresolved → fail open + drift journal entry** — matching doctrine:
   an unresolved identity must not block edits, but it must be visible.

Session registration (the `session` gate analog): register the sid in
governor.db `sessions` with the codex thread id (or lane log path) as
`tp` so the zombie sweep's transcript-liveness rule
(lesson.zombie-session-hygiene) stays meaningful for non-claude
transcripts.

### Wiring: per-lane `-c` overrides, emitter as fallback

Dispatch already passes `-c` config overrides to `codex exec`. If codex
accepts hook wiring through `-c` (verify), dispatch injects the hook
commands per-lane — **zero global state**, config rides the existing
spawn block. Only if `-c` cannot express hooks does a TOML emitter
(`hooks/bin/gate-wire-codex.ts`, merge-not-clobber into
`~/.codex/config.toml`, `install.sh --wire` precedent) ship instead.
Claude's `settings.example.json` stays untouched.

Sandbox: governor.db writes already sit inside dispatch's writable roots
(`~/.cache/claude-governor`, added in W67 for the done protocol). If
hooks run inside the codex seatbelt (verify), reads of the hook prefix
(`~/.claude/hooks/suspenders`) must be confirmed allowed under
`workspace-write`; if hooks run outside it, no sandbox change is needed.

## Gate coverage after the adapter

| Gate (this repo)                                          | Claude event                          | Codex event (docs-tier, verify live)                    | Notes                                                                               |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pre-bash (secrets, leases, skills)                        | PreToolUse(Bash)                      | PreToolUse(shell/exec)                                  | command-shape normalization                                                         |
| pre-files chain (governor, mutation-size, ledger, config) | PreToolUse(Edit\|Write\|NotebookEdit) | PreToolUse(apply_patch) — else command-level inspection | the load-bearing chain: leases + claims                                             |
| post-files (syntax + qlty)                                | PostToolUse(Edit\|Write)              | PostToolUse(apply_patch)                                | feeds the seen-ring hash blessing                                                   |
| session (bootstrap + RULES)                               | SessionStart                          | SessionStart / thread.started                           | context injection if codex supports it; else the brief carries RULES (already true) |
| stop (claim-done)                                         | Stop                                  | Stop                                                    | sid resolution as above                                                             |
| SessionEnd accounting                                     | SessionEnd                            | **absent** (W66, unverified)                            | zombie sweep covers liveness via transcript mtime; no new machinery                 |

## Test plan

- **Unit (test/hook-adapter.test.ts):** payload-normalization golden
  files (codex payload in → HookInput out), output-translation table
  (every hookio helper × dialect), identity resolution (env → ppid walk
  → fail-open), emitter TOML golden file.
- **Live pilot probe:** dispatch a throwaway item to a codex lane and
  verify (1) a lease denial fires and names the right sid, (2) post-write
  qlty lands, (3) stop/bootstrap register in governor.db. The claude lane
  on the same item is the control.

## Implementation sequence

0. **Re-verify the installed codex surface live** (the standing W66 risk
   note): `codex exec --help`, hooks docs example, one throwaway sandbox
   probe of payload shapes + control JSON. Everything below consumes
   step 0's findings.
1. hookio dialect layer + tests (~0.5d)
2. gate.ts event/dialect dispatch + identity resolution (~0.5d)
3. dispatch: `SUSPENDERS_SID` + hook wiring via `-c` (or emitter
   fallback) (~0.5d)
4. Live pilot probe on a throwaway item (~0.5d)
5. Doc updates: fleet-loop.md backend section + this spec → DONE state
   (~0.25d)

~2.5–3d total — matches W66's estimate. Non-goals: belt Responses API
adapter (W66 step 4), statusline/skills parity for codex, wholesale
migration — claude stays the default backend; codex earns lanes by
passing the pilot probe with gates on.

## Open questions (resolve at step 0)

- Exact codex PreToolUse/PostToolUse/Stop payload schemas; does
  `SessionEnd` exist now?
- Does codex fire hooks per `apply_patch`, and with what input shape?
- Control-JSON schema for deny/block; is there an `ask` equivalent; can
  SessionStart inject context?
- Do hooks run inside or outside the seatbelt; do they inherit codex's
  env; timeout semantics on a slow gate?
- Can hooks be expressed via `-c` CLI overrides, or is config.toml
  required? Per-project config overlay?
- Is `thread.started` observable in `exec` (non-interactive) mode?
