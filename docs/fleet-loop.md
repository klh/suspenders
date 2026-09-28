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

| Concern       | Rule                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ladder        | `--ladder` template, `{branch}` substituted, run via `sh -c` in the repo dir. Owner config — same trust class as a Makefile. `exit 0` = merged; anything else = FAIL.                                  |
| FAIL lines    | Always carry the ladder's last 3 output lines. A reasonless FAIL is a bug (the pnpm-ENOENT cascade of 2026-09-28 was invisible for an hour).                                                           |
| 3-strike park | A branch failing the ladder 3× is renamed under `parked/` (out of the merge glob) and logged `PARKED … needs a repair lane`. No eternal retry storms.                                                  |
| Retire        | Merged branches lose their worktree + branch on sight. Guarded: a branch a LIVE lane still owns (`.fleet/lanes.json` pid) is never touched; unremovable branches log honest `RETIRE-BLOCKED`.          |
| Watchdog      | In `watch` mode every cycle runs as a killable `--once` child with a hard timer (`--cycle-timeout`, default 15 min). A hung cycle dies at the watchdog; the loop continues. Never spawnSync unbounded. |
| Merge state   | A cycle never starts with leftover `MERGE_HEAD` — it aborts. Failed ladders are aborted too. Never `reset --hard` a shared checkout.                                                                   |

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
