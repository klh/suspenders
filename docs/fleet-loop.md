# fleet-loop — the merge/dispatch loop as fleet machinery

`hooks/bin/fleet-loop.ts` is the generic loop SHELL lifted from the gaps
project's `dk.threads.gaps-fleet-loop` daemon (W59, 2026-09-28). It runs two
kinds of automation on a cadence:

1. **merge** — every branch matching `--glob` that is ahead of `--main` goes
   through the repo's ladder (a child script you supply), then merges.
2. **dispatch** — optional. A second child script you supply refills the lane
   pool. Policy lives in the repo, not here.

```bash
bun fleet-loop.ts once  --repo <dir> --ladder '<cmd> {branch}' [--dispatch-cmd '<cmd>']
bun fleet-loop.ts watch --repo <dir> --ladder '<cmd> {branch}' [--every 120] [--cycle-timeout 15]
```

## The contract

| Concern       | Rule                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ladder        | `--ladder` template, `{branch}` substituted, run via `sh -c` in the repo dir. Owner config — same trust class as a Makefile. `exit 0` = merged; anything else = FAIL.                                                                                                                                               |
| FAIL lines    | Always carry the ladder's last 3 output lines. A reasonless FAIL is a bug (the pnpm-ENOENT cascade of 2026-09-28 was invisible for an hour).                                                                                                                                                                        |
| 3-strike park | A branch failing the ladder 3× is renamed under `parked/` (out of the merge glob) and logged `PARKED … needs a repair lane`. No eternal retry storms.                                                                                                                                                               |
| Retire        | Merged branches lose their worktree + branch on sight. Guarded: a branch a LIVE lane still owns (`.fleet/lanes.json` pid) is never touched; unremovable branches log honest `RETIRE-BLOCKED`.                                                                                                                       |
| Watchdog      | In `watch` mode every cycle runs as a killable `--once` child with a hard timer (`--cycle-timeout`, default 15 min). A hung cycle dies at the watchdog; the loop continues. Never spawnSync unbounded.                                                                                                              |
| Merge state   | A cycle never starts with leftover `MERGE_HEAD` — it aborts. Failed ladders are aborted too. Never `reset --hard` a shared checkout.                                                                                                                                                                                |
| Lane protocol | Every dispatched lane PLAN FIRST (inventory the impact surface, read qlty spec + target files), then SHATTER JUDGMENT: 2+ genuinely independent scopes → `work split <id> … --keep 1`, work only the kept child, end `SPLIT <id>`; the fleet refills the rest. Serial or small work proceeds to implement directly. |

## dispatch — one item → claimed, worktree, briefed headless lane

```bash
bun fleet-loop.ts dispatch --repo <dir> --item Wn [--agent claude|codex]
```

The fleet's own spawner (the coordinator's verb; gaps-style `--dispatch-cmd`
policy scripts can call it per-item instead of hand-rolling lane plumbing).
It claims the item (resume-tolerant: an existing claim by the same lane id
continues), reuses or creates the worktree at `.worktrees/<item>` (branch
read back from the worktree), writes `.fleet/brief-<sid>.md`, and spawns a
detached lane using the selected backend. The lane is recorded in
`lanes.json` with its pid and `agent` — the retire pid-guard and the `lanes`
verb cover the rest of its lifecycle. Dispatch refuses to start another
process while that lane's recorded pid is alive.

### Selecting the agent backend

`--agent` accepts `claude` (the default) or `codex`. The selected CLI must
be available on the dispatcher's `PATH`; an unknown backend or missing
binary fails dispatch.

```bash
# Default Claude lane; --agent claude is equivalent.
bun fleet-loop.ts dispatch --repo <dir> --item Wn

# Codex lane for the same work-item protocol.
bun fleet-loop.ts dispatch --repo <dir> --item Wn --agent codex

# Inspect lane liveness and backend.
bun fleet-loop.ts lanes --repo <dir>
```

- **Claude:** launches `claude -p` in `acceptEdits`, with the dispatcher's
  allowed-tool list for shell commands and Edit/Write.
- **Codex:** launches `codex exec -s workspace-write`, with network access
  enabled and additional writable roots for the repo and
  `~/.cache/claude-governor`. Dispatch sets `GIT_DIR` to the lane's private
  `.gitstore` and `GIT_WORK_TREE` to its worktree so lane commits can be
  written inside the sandbox; main-repo objects are shared through Git
  alternates.

Both backends receive the same brief and must follow `AGENTS.md`, including
quality gates, commit/push, and the Work Graph completion protocol. The
`lanes` output includes the backend; older registry entries without an
`agent` field display as `claude`.

Backend selection applies to `dispatch`. A policy script supplied through
`--dispatch-cmd` must pass `--agent codex` on its own dispatch calls if it
wants Codex lanes; the loop does not inject that flag into the script.

## Migrating a project onto it

A project (gaps is the first) replaces its bespoke daemon with a ~5-line
plist template (`hooks/launchd/com.suspenders.fleet-loop.plist`): point
`--repo` at the checkout and `--ladder` at the project's own ladder script.
The ladder stays project-local on purpose — qlty config, test runners, and
union rules are quality POLICY, not shell. What the fleet owns is the
watchdog, the cadence, the strike/park discipline, and the retire lifecycle.

State lives in `<repo>/.fleet/`: `loop.log` (append-only audit),
`merge-fails.json` (strike counters), `lanes.json` (live-lane registry with
pids — the pid guard's source).
