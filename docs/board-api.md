# Board API v3 — views, tasks, activity, setup, demo

Contract for the W21/W22 board tranche. Backend implements in `hooks/bin/fleet-board.ts`,
frontend consumes in `hooks/bin/fleet-board-html.ts`. All endpoints return JSON with
`ok: true` or `{ ok: false, error }`. Read endpoints need no write guard.

## Conventions

- `project` values are git-common-dir strings (`/path/repo/.git`). Every list endpoint
  accepts `?project=<full-path>`; the literal `all` (or omission) returns everything.
  Each response also carries `projects: string[]` — the distinct project list the UI
  needs to populate the global filter, sorted.
- Times are epoch ms; ages precomputed as `*_s` seconds.
- Labels: the UI never renders raw sids when a label exists — responses include both.

## Trust model (W172)

The board is a single-user surface with a loopback-first trust model. Three
rules (hooks/board/gate.ts):

- **Default bind is 127.0.0.1** — zero-config for the one human on the host.
  The launchd template ships loopback (`SUSPENDERS_BIND=__BIND__`, installer
  default 127.0.0.1).
- **LAN exposure** rides the klh-local Caddy PQ-TLS edge
  (`suspenders.local → 127.0.0.1:7799`); trust terminates at the proxy. For
  harder guarantees put client certificates on the Caddy vhost — the board
  stays out of the auth business (no-auth-code law: a shared secret is a
  gate, not an auth system).
- **Shared-secret gate**: `SUSPENDERS_BOARD_TOKEN` set → EVERY request
  (reads, writes, `/status`, `/metrics`) must carry
  `Authorization: Bearer <token>`, compared constant-time. A non-loopback
  `SUSPENDERS_BIND` without the token **refuses to start**.
- Write endpoints additionally keep the origin/host guard (`writeGuard`):
  same-origin for browsers, loopback or the exact non-wildcard bind name for
  non-browser clients — a wildcard bind (`0.0.0.0`, `::`) is never a trust
  anchor.

## GET /api/tasks?project=

`{ ok, projects, tasks: [...] }` — every work_item not SUPERSEDED/DONE-with-owner,
newest activity first:

```json
{
  "project": "/p/repo/.git", "id": "W7", "title": "…", "state": "READY|CLAIMED|RUNNING|BLOCKED|DONE|SHATTERED",
  "owner_sid": "…|null", "owner_label": "lane-name|null", "requires": "shell,git|null",
  "scope": "src/x|null", "parent_id": "W6|null", "age_s": 4210,
  "open_decisions": 1,
  "tail": { "text": "→ Bash: bun test test/", "ts": "2026-09-28T07:19:35.016Z" } | null,
  "unblocked_by": "W6|null"
}
```

`open_decisions` = OPEN decisions rows with `task_id = id`. `owner_label` = the owner's
newest claim intent, else session name, else null. `tail` = the claiming session's latest
assistant text or tool call, read from the last 32KB of its `sessions.transcript_path`
JSONL (null when the session has no transcript on this disk — remote or reaped).
`unblocked_by` = the id of the item whose completion freed this one (newest `work.ready`
bus event), non-null only while the item is still READY — the UI flags it ▶ startable.

## GET /api/task?project=&id=

Task detail for the drawer: `{ ok, projects, task: {…as above},
events: [{ id, ts_s… actually ts (ms), kind, source, note, sha|null }]` — the last 50
bus events whose `payload.work` or scope equals the item (checkpoint/landed/blocked/
work.* kinds included), newest first; and `decisions: [{ event_id, state, question,
answer_note|null }]` for the item. Missing id → 404 shape.

## GET /api/activity?project=&limit=

`{ ok, projects, events: [{ id, ts, kind, source, target|null, note, sha|null, project }] }`
— newest first, default limit 80, cap 300. Note/sha parsed from payload; BROADCAST
included (it is fleet news, not noise).

## GET /api/decisions (v3 addition)

Unchanged shape for the OPEN feed. With `&history=1`: also includes rows in state
`ANSWERED`, `ACKNOWLEDGED`, `CANCELLED`, each with `answer_note`, `answered_ts`,
`ack_ts` (null where unset). Default response stays OPEN-only so the existing UI
contract holds.

## GET /api/setup

`{ ok, checks: [{ id, label, ok: bool, detail, fix|null }] }` — advisory wiring
checks, never throw:

| id            | label                   | ok when                                                                                    | fix                           |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| db            | Control-plane database  | this process is serving it                                                                 | —                             |
| hooks-wired   | Hook gates wired        | `~/.claude/settings.json` references this install's `gate.ts` in PreToolUse                | `./install.sh --wire`         |
| session-start | Session injection wired | SessionStart hook references session-start.ts                                              | `./install.sh --wire`         |
| monitor-agent | Fleet monitor launchd   | `~/Library/LaunchAgents/com.suspenders.fleet-monitor.plist` exists                         | `./install.sh --with-launchd` |
| llm           | Advice LLM endpoint     | `GET $SUSPENDERS_LLM_URL/v1/models` (default `http://127.0.0.1:8901`) answers within 1.5 s | local LLM stack docs          |
| bind          | LAN binding             | informational: SUSPENDERS_BIND value                                                       | —                             |

## GET /api/executors

`{ ok, executors: [{ value, label, model, locality }] }` — dispatch targets for
the READY-card executor dropdown (W105): `claude` and `codex` first, then
belt's live openai endpoints as `llm:<machine>:<model or port>`. Registry
source: belt's `/api/remotes` at the resolveBelt chain (bearer token from
`~/.claude/local-llm/belt-tokens.json`), falling back to the
`remotes.ts check --json` CLI spawn; cached 60 s. `locality` is `local` for
LAN/loopback endpoints (private ip, `.local` mDNS name) and `remote` for
everything else — the routing doctrine's default (`glm-5.3-flash` via z.ai)
and the stock CLI model endpoints count as remote.

## POST /api/start

`{ project, id, agent? }` — `agent` is `claude` (default) | `codex` |
`llm:<machine>:<model or port>` (routes through belt's remotes router). On a
successful dispatch the board stamps the lane registry (W105): facts
`lane.<sid>.executor` / `lane.<sid>.model` / `lane.<sid>.locality` in
governor.db, read back on `/api/tasks` + `/api/data` for the MODEL badges.
Starts (dispatches) a lane on a READY work item by
spawning `fleet-loop.ts dispatch --repo <project minus a trailing /.git> --item <id>`
detached. Validation order — first failure wins:

| condition                               | status |
| --------------------------------------- | ------ |
| missing `project` or `id`               | 400    |
| demo board (`--demo`)                   | 409    |
| `claude` binary not on the board's PATH | 409    |
| unknown work item                       | 404    |
| item already claimed (`owner_sid` set)  | 409    |
| item not READY                          | 409    |
| project directory missing on disk       | 409    |

Success: `{ ok: true, item, sid }` — the lane sid is deterministic
(`autow<n>`); the actual CAS claim happens inside dispatch's `work take`, so a
racing claim loses cleanly (dispatch exits nonzero, nothing spawned). The
board never spawns from `--demo`.

## POST /api/ship (W64)

`{ project, id }` required. One-click ship from the task drawer's diff bar:
runs the repo's merge ladder for the item's `suspenders/<id>` branch and
merges it — `fleet-loop.ts ship --repo <repo> --branch suspenders/<id>
--ladder <from .fleet/ship.json>` spawned detached (the HTTP answer returns
while the ladder runs; ladders run tests — expect minutes). The UI polls
`/api/diff` until the branch retires, which is the shipped signal. Validation
order — first failure wins:

| condition                                                          | status |
| ------------------------------------------------------------------ | ------ |
| missing `project` or `id`                                          | 400    |
| demo board (`--demo`)                                              | 409    |
| unknown work item                                                  | 404    |
| project directory missing on disk                                  | 409    |
| branch `suspenders/<id>` does not exist                            | 404    |
| no `main`/`master` branch in the repo                              | 404    |
| branch not ahead of base (already merged)                          | 409    |
| a live lane owns the branch (`.fleet/lanes.json` pid alive)        | 409    |
| owning session still live (RUNNING + fresh hb or warm transcript)  | 409    |
| no ladder configured — `<repo>/.fleet/ship.json` missing/no ladder | 409    |

Success: `{ ok: true, item, branch, ladder }`. The ladder is owner config —
`<repo>/.fleet/ship.json` `{"ladder": "<cmd template with {branch}>"}` — and
REQUIRED: ship must never do a plain merge behind the repo's quality policy's
back. The merge goes through fleet-loop's shared `mergeOne` (MERGE_HEAD abort,
ladder timeout, FAIL tail, 3-strike park, retire), so board-shipped branches
obey the same discipline as loop merges; outcomes land in `<repo>/.fleet/loop.log`.

## GET /api/tail (W76)

Live lane tail for the drawer. `{ id }` resolves the owning lane via
`work_items.owner_sid`; reads the lane's stdout/stderr log
(`<repo>/.fleet/lane-<sid>.log` — fleet-loop's declared live-tail surface,
last 32KB) and the session transcript's 12 most recent assistant text/tool
blocks. Validation — first failure wins:

| condition               | status |
| ----------------------- | ------ |
| bad item id             | 404    |
| unknown work item       | 404    |
| item has no owning lane | 404    |

Success: `{ ok, id, sid, log: { size, mtime, truncated, text } | null,
transcript: { text, ts } | null, recent: [{ text, ts }…] }`. `log` is null
until the lane has written output; `recent` is newest-last. `claude -p`
buffers stdout until the run finishes — the transcript is what makes the
window live for a RUNNING claude lane; the log carries finished runs and
codex's streaming output. The UI prefers the log when non-empty, else the
transcript lines, else "(no lane output yet)".

## POST /api/message (W76)

`{ id, note }` required (note capped at 2000). Message-to-lane from the
board: a coord NOTE routed to the item's owning lane, emitted as the
published coordinator identity (fact `coordinator.sid`; fallback
`fleet-board` when the fact is unset). Same guards as /api/comment. First
failure wins:

| condition               | status |
| ----------------------- | ------ |
| missing `id` or `note`  | 400    |
| unknown work item       | 404    |
| item has no owning lane | 404    |

Success: `{ ok, to, as }` — `as` reports the identity the NOTE carried.

## Demo mode — `--demo` CLI flag

`fleet-board.ts --demo` seeds an idempotent demo partition before serving (skip when
the demo project already has items): project `<dbdir>/demo` — not a real repo — with
4 sessions (one waiting on a decision, one working, one paused, one zombie-fact), claim
intents for labels, 4 work items in mixed states, 2 OPEN + 2 ANSWERED decisions, a
dozen bus events. Purpose: README quickstart (`bun bin/fleet-board.ts --demo`) and the
product-page screenshot. Never seeds into real projects; `--demo` also prints the URL.

## Frontend owns

Tab shell (Decisions · Tasks · Lanes · Activity · Governor · Setup) driven by location.hash,
global project `<select>`, decision history (collapsed under OPEN), task drawer
(click a task row), lanes kanban (work items as cards in state columns, live
tails, ▶ start on unclaimed READY cards → POST /api/start; card click opens the
drawer directly), named state labels, a11y (buttons not divs, aria-live on toasts
and decision counter, focus-visible, ≥4.5:1 text contrast), no decorative controls.
