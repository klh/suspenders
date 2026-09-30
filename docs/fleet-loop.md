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
| Review        | Optional `--review '<cmd with {seed}>'` runs a fresh-context reviewer BEFORE each merge (W81). The loop composes the seed from the item objective, the branch diff, and a fresh `--review-tests` run — nothing else: commit messages and lane briefs never reach the reviewer. Nonzero exit or a final `VERDICT: FAIL` line is a strike (same counter and 3-strike park as the ladder). |


## Review — the fresh-context gate before the ladder (W81)

```bash
bun fleet-loop.ts once --repo <dir> --ladder '<cmd> {branch}' \
  --review 'claude -p "Read the review seed at {seed} and judge it. End with VERDICT: PASS or VERDICT: FAIL — <reason>."' \
  --review-tests 'bun test'
```

Before every merge attempt the loop writes
`.fleet/review-seed-<branch>.md` and substitutes its path for `{seed}`. The
seed holds exactly three inputs and nothing else:

1. **Item objective** — the Work Graph item's title/description/scope
   (branch `suspenders/W81` → item `W81`; `lane/autow123` → `W123`). No
   matching item → the seed says so, honestly.
2. **Diff** — `git diff` merge-base..branch, truncated at 2000 lines with a
   loud marker.
3. **Test output** — `--review-tests '<cmd with {branch}>'` run fresh by the
   loop in the repo checkout (the ladder's timeout applies); absent → the
   seed says no tests were gathered.

That is the whole point: a reviewer that can be told what to think by the
author's framing is not a reviewer, so commit messages, lane briefs, and
worker claims never reach it. The reviewer command is owner config (same
trust class as the ladder). It rejects with a nonzero exit or a final
`VERDICT: FAIL` line (final-line only — a FAIL quoted mid-output or echoed
from the seed's own instructions must not forge a rejection), and a
rejection is a ladder strike: `FAIL <branch> — review rejected …` in
loop.log, counted in merge-fails.json, parked at 3 like any ladder failure.
`--review-timeout` (default 5 min) watchdog-kills a hung reviewer; review
and ladder share one watch-mode cycle, so raise `--cycle-timeout` when both
are slow. The board's one-click ship picks the gate up from `ship.json`:

```json
{"ladder": "<cmd with {branch}>", "review": "<cmd with {seed}>", "review_tests": "<cmd with {branch}>"}
```

## dispatch — one item → claimed, worktree, briefed headless lane

```bash
bun fleet-loop.ts dispatch --repo <dir> --item Wn [--agent claude|codex]
```

## ship — one branch through the ladder now (W64)

```bash
bun fleet-loop.ts ship --repo <dir> --branch suspenders/<id> --ladder '<cmd> {branch}'
```

The board's one-click ship trigger (fleet-board `POST /api/ship`) resolves the
ladder from `<repo>/.fleet/ship.json` (`{"ladder": "<cmd template with
{branch}>"}` — owner config, same trust class as the Makefile) and spawns this
verb detached. It is a foreground single-shot of the cycle's merge step: same
MERGE_HEAD abort, ladder timeout, FAIL tail, 3-strike park, and retire
lifecycle. The branch need not match `--glob` — ship is explicit intent.

The fleet's own spawner (the coordinator's verb; gaps-style `--dispatch-cmd`
policy scripts can call it per-item instead of hand-rolling lane plumbing).
It claims the item (resume-tolerant: an existing claim by the same lane id
continues), reuses or creates the worktree at `.worktrees/<item>` (branch
read back from the worktree), writes `.fleet/brief-<sid>.md`, and spawns a
detached lane using the selected backend. The lane is recorded in
`lanes.json` with its pid and `agent` — the retire pid-guard and the `lanes`
verb cover the rest of its lifecycle. Dispatch refuses to start another
process while that lane's recorded pid is alive.

Each claim is stamped with an **origin** — `<hostname>:<agent>` via
`work take --origin` — recorded on the work item and shown on board cards.
That is the multi-machine seam: today every dispatch is this machine; when a
second coordinator joins, items already carry who ran them, where, and on
which backend, and the board renders it without schema changes.

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
- **Codex:** launches `codex exec --sandbox danger-full-access`, in the same
  trust class as Claude lanes. Dispatch sets `GIT_DIR` to the lane's private
  `.gitstore` and `GIT_WORK_TREE` to its workspace; main-repo objects are
  shared through Git alternates. The lane writes its own commits and pushes
  them; the coordinator does not commit on its behalf. A fresh workspace also
  gets the repo's gitignored build dirs (`node_modules`, `.venv`, `vendor`,
  `target`) symlinked in — same as `worktree.ts` create — so codex lanes skip
  reinstalls. Gates ride the codex hook adapter (W73): dispatch stamps
  `SUSPENDERS_SID` into the lane env and merges the five gate registrations
  into `~/.codex/hooks.json` (merge-not-clobber, `gate-wire-codex.ts --check`
  to inspect); unresolved lane identity fail-opens with a line in
  `~/.cache/claude-governor/codex-drift.jsonl`. A failed wire aborts
  dispatch — never a silent gate-less lane.

Both backends receive the same brief and must follow `AGENTS.md`, including
quality gates, commit/push, and the Work Graph completion protocol. The
`lanes` output includes the backend; older registry entries without an
`agent` field display as `claude`.

Lanes cannot push main (W70): the pre-bash push-guard denies any `git push`
that would move main on the remote — explicit refspecs (including deletes
and force forms), HEAD/current-branch pushes, bare pushes while sitting on
main, and `--all`/`--mirror` — from any session whose process tree resolves
to a `.fleet/lanes.json` entry via a ppid walk (`hooks/lib/fleetlane.ts`).
Merge to main is the ladder's job (board ship trigger / `fleet-loop ship`),
never a lane's.

Backend selection applies to `dispatch`. A policy script supplied through
`--dispatch-cmd` must pass `--agent codex` on its own dispatch calls if it
wants Codex lanes; the loop does not inject that flag into the script.

## Operations: dispatch through lane completion

Run coordinator commands from the parent checkout. Before dispatch, check
`bun hooks/bin/fleet-loop.ts lanes --repo <repo>` for an existing live lane.
After dispatch, inspect `.fleet/brief-<sid>.md`, `.fleet/lanes.json`, and
`.fleet/lane-<sid>.log` for the assigned item, branch, backend, pid, and
progress. A live pid proves liveness, not successful completion.

**Lane liveness (2026-09-28, autow57):** `claude -p` buffers stdout — the
lane log shows startup warnings and the FINAL result, nothing in between, so
log silence during a run is normal and proves nothing. To distinguish a
grinding lane from a stuck one, probe the session transcript:
`~/.claude/projects/<repo>--worktrees-<item>/<sid>.jsonl` grows in real time
while the lane works (the original autow57 had 2.7MB of active work when it
was killed on a log-silence misread). The `[claude-code:unrecognized_model]`
line appears in healthy lanes too (W79 completed with it) — non-fatal noise.

In the assigned workspace, verify `git rev-parse --verify HEAD`,
`git branch --show-current`, and `git status --short` before editing. A Codex
workspace uses a private Git store rather than a registered Git worktree;
do not stage `.gitstore/`. If HEAD is unborn or source files are absent,
resolve initialization before proceeding. The private store must be able
to read the parent objects before creating its branch and checking it out.
W69 encountered this initialization failure and required checkout recovery;
its completion is not evidence that fresh dispatch initialization works.

Both backends follow the same delivery sequence:

1. Read `AGENTS.md`, inventory the scope, and apply its split judgment.
2. Make the scoped change, run `qlty fmt` and `qlty check` on changed files,
   then run the relevant `bun test` suite. Record actual gate results.
3. Commit with the work-item title and push the assigned branch. Capture
   `git rev-parse HEAD` and verify the remote branch has that SHA.
4. Mark the item done with that SHA. For a private-store Codex workspace,
   run the command from the parent checkout with Git environment overrides
   removed so Work Graph resolves the original project:

   ```bash
   # Working directory: the parent checkout, not .worktrees/<item>.
   env -u GIT_DIR -u GIT_WORK_TREE bun ~/.claude/hooks/suspenders/bin/work.ts done Wn --sha <lane-head>
   env -u GIT_DIR -u GIT_WORK_TREE bun ~/.claude/hooks/suspenders/bin/work.ts show Wn
   ```

5. End with the `AGENTS.md` completion line. A commit, matching remote SHA,
   and Work Graph `DONE` record establish lane delivery; they do not prove
   that the merge ladder ran or that Codex hook enforcement matches Claude.

Use `loop.log` for merge/retire evidence. Investigate the last three ladder
output lines on `FAIL`; after three failures the branch is parked for repair.
Do not remove a live lane's workspace to force retirement.

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
