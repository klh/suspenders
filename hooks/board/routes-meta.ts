// hooks/board/routes-meta.ts — meta: /llms.txt (LLMS_TXT), / (the SPA page), 404 tail (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { HTML } from "../bin/fleet-board-html.ts";

export const LLMS_TXT = `# suspenders

suspenders is an agent control plane for fleets of coding-agent sessions. A
SQLite database (governor.db) is the single source of operational state: a
work graph with compare-and-swap claims, a coord event bus (events, facts,
cursors, inbox), decision forks with optional LLM advice, and this fleet
board as the human + machine-readable view.

Board: http://127.0.0.1:7799 (LAN: http://suspenders.local:7799 via klh-local's user-level Caddy)

## GET endpoints

- GET /               this board (HTML; polls /api/* every second)
- GET /api/data       full control-plane state: sessions, projects, claims, events, zombies, consults, llm usage; ?session=<sid> adds lane focus (inbox, lane facts)
- GET /api/decisions  decision forks; default OPEN only, ?history=1 adds resolved rows
- GET /api/tasks      every work item, newest activity first (?project=<path> or all)
- GET /api/task       one work item + its bus events + its decisions (?project=<path>&id=<id>)
- GET /api/activity   newest-first coord bus feed (?project=<path>&limit=<n>; default 80, cap 300)
- GET /api/setup      advisory wiring checks (hooks, monitor agent, advice LLM, bind)
- GET /api/executors  dispatch targets for the READY-card dropdown: claude, codex, then belt's live openai endpoints as llm:<machine>:<model or port> (belt's registry at the resolveBelt chain + CLI fallback, cached 60s; failed probes included; each entry carries its model id and a local/remote locality marker — W105)
- GET /api/diff       per-item branch diff for the drawer: repo + branch suspenders/<id> (worktree.ts naming), base = merge-base with main (fallback master); JSON {ok,id,branch,base,stat,diff}, patch tail-capped at 200KB
- GET /api/tail       live lane tail for the drawer: the owning lane's .fleet/lane-<sid>.log (last 32KB) + transcript recent lines; JSON {ok,id,sid,log,transcript,recent}
- GET /console        redirect to /console/belt (the klh console shell: belt | suspenders | local menu + settings gear + actor avatar)
- GET /console/belt   gateway view (read-only): resolved routing-policy.yaml (ladder, budgets), buckle upstreams pool, :4101/:4100 servicemon health, belt API reachability
- GET /console/local  Caddy-served .local services from the klh-local registry (static view)
- GET /console/settings   settings hub — one entry per feature (belt budgets, buckle ladder+cooldowns, suspenders board knobs); every write previews a diff + confirms
- GET /api/console/me avatar data: {ok, actor, tags, actors[], default_actor} — board host's latest session actor, "unassigned" until coord bootstrap --actor stamps one
- GET /llms.txt       this file

## Write endpoints (human at the board; origin/host guarded)

- POST /api/answer    answer a decision fork (answer_token idempotency; stale token = 409)
- POST /api/ack       dismiss an open fork (state to CANCELLED, idempotent)
- POST /api/advise    fire the advice worker for a fork (async; lands as fact advice.<id>)
- POST /api/comment   route a review line-comment to a work item's owning lane (coord NOTE; id, file, line, note required — note capped at 2000)
- POST /api/message   message a work item's owning lane as the coordinator (coord NOTE; id, note required — note capped at 2000)
- POST /api/start     start a lane on a READY work item (fleet-loop dispatch; project, id required — 409 when claimed, not a READY item, demo, or agent missing; agent=llm:machine:model routes through belt's remotes router instead: claim as the board lane, remotes.ts route the title+description, llm.result on the item thread, claim released)
- POST /api/ship      one-click ship for a work item's suspenders/<id> branch: live-lane + owner-liveness + merge-ladder guards, then the repo's .fleet/ship.json ladder runs detached via fleet-loop ship (409 without a configured ladder, on demo, while a lane lives, or while a daemon merge ladder is mid-flight)
- POST /api/orchestrate            LLM proposes a plan item + parallel children from a goal (project, goal required; read-only — nothing registers, 502 when no parseable plan comes back)
- POST /api/orchestrate/register   register a proposed plan as a plan-gated work split through the work CLI (project, title, children required; children 2..8; the plan item is the split parent — the AGENTS.md add-plan-then-split flow)
- POST /api/suggest   expand a terse composer draft into a brief-shaped prompt (the local minimal model reads the draft + running lanes; project, draft required — 502 when the model fails or answers junk)
- POST /console/settings/preview   settings diff preview (origin/host guarded; form-encoded feature+values; invalid config = rejected with the parser's error, nothing written)
- POST /console/settings/apply     settings apply (origin/host guarded; feature + values JSON + preview mtime; mtime guard rejects concurrent edits; atomic tmp+rename write to the allowlisted config path only)

## Advice LLM

SUSPENDERS_LLM_URL points at an OpenAI-compatible chat endpoint used by the
advice worker and the orchestrate box (default http://127.0.0.1:8901 —
belt's code specialist). If the endpoint is unreachable, advice is marked
unavailable and the fork stays open for the human; orchestrate answers 502
and nothing registers. Nothing else on the board depends on it.

## Companion repos

- suspenders (this repo): https://github.com/klh/suspenders
- belt (the LLM fleet behind the advice endpoint): https://github.com/klh/belt
- klh-local (serves suspenders.local over the LAN): https://github.com/klh/local

a Threads thing — http://www.threads.dk`;

export async function handleMeta(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/llms.txt")
		// static plain-text agent contract (see LLMS_TXT above)
		return new Response(LLMS_TXT, {
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	if (url.pathname === "/")
		return new Response(HTML, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	return new Response("not found", { status: 404 });
}
