# decisions contract — board v2.5 (2026-09-25, owner directive)

Authoritative interface between the decision lifecycle (fleet-board.ts), the
UI (fleet-board-html.ts), and the agent health layer (monitor.ts). If code
and this document disagree, fix the code or amend this file in the same commit.

## Decision record (SQLite, board-owned `decisions` table)

| column        | meaning                                                      |
|---------------|--------------------------------------------------------------|
| id            | INTEGER — the source NEED% event id (globally unique)        |
| project       | TEXT — project identity of the asking lane                   |
| task_id       | TEXT — work_items.id from payload.work, else NULL (never guessed from free text) |
| asked_by      | TEXT — sid of the asking lane                                |
| question      | TEXT — payload.note (plain language, shown verbatim)         |
| options       | TEXT — JSON array of {label, tradeoff} from payload.options, else [] |
| state         | TEXT — OPEN \| ANSWERED \| ACKNOWLEDGED \| CANCELLED \| SUPERSEDED |
| delivery      | TEXT — DELIVERED \| FAILED (did the lane ack pickup; FAILED shows in UI as "delivery failed — retry") |
| answer_note   | TEXT — the human's answer                                    |
| answer_to     | TEXT — sid the answer was addressed to                       |
| answer_token  | TEXT — uuid rotated on every state change; POST /api/answer must carry the token the client read (multi-tab + stale protection) |
| created_ts / answered_ts / ack_ts | INTEGER ms epoch                          |

GET /api/decisions → { ts, decisions: [ …record + age_s, task_title (joined
from work_items when task_id set), asked_by_label ] }. Decision ids are
globally unambiguous (event id + project in the record).

## State machine

OPEN → ANSWERED (human sends; POST /api/answer idempotent: same token+note
replays return 200 {ok:true, replay:true}; stale token → 409 {error:"stale"})
OPEN → CANCELLED (asking lane supersede/cancel event; NOT by board dismiss)
ANSWERED → ACKNOWLEDGED (lane inbox sees the ANSWER and the lane's next
checkpoint/message references it — best-effort heuristic, monotonic)
Never: dismiss/ack of the NOTIFICATION resolves a decision. The board's
dismiss button on a card = CANCELLED and asks for confirmation.

## Agent health

A session with an OPEN decision addressed to it is "Waiting for you":
monitor.ts excludes it from zombie termination and alerts; `monitor --fix`
may release ITS file locks (ownership-checked, logged) so parallel work
proceeds; resume uses the normal claim/lease path. Board shows it in the
decisions section, not as a stalled agent.

## UI requirements (fleet-board-html.ts)

Persistent "Decisions needed" section above active work — never a popup.
Always one explicit state: loading / "N decisions need you" / confirmed none
("No pending decisions · checked Xs ago") / "decision feed unavailable —
last good update Xs ago" (fetch/render failure is NEVER rendered as zero).
Card: question, project · task · agent, why-required/what-blocks (task title
or "no linked task"), age (readable), options with tradeoffs (selectable ≠
submitting), recommendation (when a fact exists) with rationale + "use"
fills the field, custom answer field, explicit Send. Unresolved decisions
persist across reloads/restarts (server state is the truth). Badge with
pending count visible when collapsed. Toast once per NEW decision id — never
per poll. Global pending count shown when the view is project-filtered.

## Frontend reliability

No empty .catch(); validate status + payload shape; single in-flight poll
(per-grid: a finished response supersedes, stale ones dropped via ts
compare); on fetch failure keep last good data marked "stale"; drafts,
focus, scroll preserved across renders (keyed nodes); fetch timeouts
(AbortSignal.timeout(8000)) with inline retry buttons; answer errors render
inline on the card; option-select and submit are visually distinct;
"Advice me!" renamed "Get recommendation"; handlers read current data via
keyed lookups (no stale closures); no innerHTML with unescaped data;
decisions come from the decisions table — independent of the truncated
activity feed.

## Layout (dark theme kept)

1 Overall status + connection health (live/stale/error, last good ts)
2 Decisions needed
3 Active tasks + meaningful progress
4 Queued/blocked work (+ failures, waits)
5 Collapsible diagnostics: completed cards, claims (file → owner → waiting
  → lease), raw event stream
Compact fleet summary replaces the badge wall (expandable). Readable times
("4 minutes ago"); liveness ≠ heartbeat ≠ last meaningful progress. Monospace
only for ids/paths/technical; interface text in the UI font. No decorative
controls: Cost/Balanced/Speed etc. stay OUT until a routing subsystem exists.
