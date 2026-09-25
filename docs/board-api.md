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

## GET /api/tasks?project=

`{ ok, projects, tasks: [...] }` — every work_item not SUPERSEDED/DONE-with-owner,
newest activity first:

```json
{
  "project": "/p/repo/.git", "id": "W7", "title": "…", "state": "READY|CLAIMED|RUNNING|BLOCKED|DONE|SHATTERED",
  "owner_sid": "…|null", "owner_label": "lane-name|null", "requires": "shell,git|null",
  "scope": "src/x|null", "parent_id": "W6|null", "age_s": 4210,
  "open_decisions": 1
}
```

`open_decisions` = OPEN decisions rows with `task_id = id`. `owner_label` = the owner's
newest claim intent, else session name, else null.

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

| id | label | ok when | fix |
|---|---|---|---|
| db | Control-plane database | this process is serving it | — |
| hooks-wired | Hook gates wired | `~/.claude/settings.json` references this install's `gate.ts` in PreToolUse | `./install.sh --wire` |
| session-start | Session injection wired | SessionStart hook references session-start.ts | `./install.sh --wire` |
| monitor-agent | Fleet monitor launchd | `~/Library/LaunchAgents/com.suspenders.fleet-monitor.plist` exists | `./install.sh --with-launchd` |
| llm | Advice LLM endpoint | `GET $SUSPENDERS_LLM_URL/v1/models` (default `http://127.0.0.1:8901`) answers within 1.5 s | local LLM stack docs |
| bind | LAN binding | informational: SUSPENDERS_BIND value | — |

## Demo mode — `--demo` CLI flag

`fleet-board.ts --demo` seeds an idempotent demo partition before serving (skip when
the demo project already has items): project `<dbdir>/demo` — not a real repo — with
4 sessions (one waiting on a decision, one working, one paused, one zombie-fact), claim
intents for labels, 4 work items in mixed states, 2 OPEN + 2 ANSWERED decisions, a
dozen bus events. Purpose: README quickstart (`bun bin/fleet-board.ts --demo`) and the
product-page screenshot. Never seeds into real projects; `--demo` also prints the URL.

## Frontend owns

Tab shell (Decisions · Tasks · Activity · Governor · Setup) driven by location.hash,
global project `<select>`, decision history (collapsed under OPEN), task drawer
(click a task row), named state labels, a11y (buttons not divs, aria-live on toasts
and decision counter, focus-visible, ≥4.5:1 text contrast), no decorative controls.
