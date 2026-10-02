// hooks/board/routes-data.ts — read feeds: /api/data /api/decisions /api/tasks /api/task /api/activity /api/setup /api/executors (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { db } from "./context.ts";
import { executorCandidates } from "./belt.ts";
import { executorAllowed, readBoardSettings } from "../lib/board-config.ts";
import { json } from "./helpers.ts";
import { syncDecisions, projectList, unblockedBy } from "./lanes.ts";
import { decisionEvals } from "./decide-eval.ts";
import {
	taskShape,
	tasks,
	workEvents,
	taskDecisions,
	activity,
	setupChecks,
	decisionsPayload,
	payload,
	payloadFor,
} from "./data.ts";

export async function handleData(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/data") {
		const sid = url.searchParams.get("session") ?? "";
		return json(sid ? payloadFor(sid) : payload());
	}
	{
		// W217: the vendored Lit component bundle (offline — built artifact,
		// never CDN). Exact path only; anything else falls through.
		const vf = "/vendor/klh-components.js";
		if (url.pathname === vf) {
			const f = `${import.meta.dir}/../board-html/vendor/klh-components.js`;
			return new Response(Bun.file(f), {
				headers: { "content-type": "text/javascript; charset=utf-8" },
			});
		}
	}
	if (url.pathname === "/api/decisions")
		// full decision records + counts — the decisions feed the UI polls.
		// Default OPEN-only; &history=1 folds in the resolved rows
		return json(decisionsPayload(url.searchParams.get("history") === "1"));
	{
		// W217: evaluation history for one decision (the card's hydrate feed)
		const m = url.pathname.match(/^\/api\/decisions\/(\d+)\/evals$/);
		if (m)
			return json({
				ok: true,
				event_id: Number(m[1]),
				evals: decisionEvals(Number(m[1])),
			});
	}
	if (url.pathname === "/api/tasks") {
		// v3 tasks feed (docs/board-api.md) — every live work item, newest
		// activity first, with open fork counts and human owner labels
		syncDecisions(); // fork counts must reflect events the poll hasn't seen
		const p = url.searchParams.get("project");
		return json({ ok: true, projects: projectList(), tasks: tasks(p) });
	}
	if (url.pathname === "/api/task") {
		// detail drawer feed: the item, its bus events, its decisions
		syncDecisions();
		const p = url.searchParams.get("project") ?? "";
		const id = url.searchParams.get("id") ?? "";
		const w = db
			.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
			.get(p, id) as WorkItemRow | null;
		if (!w)
			return json(
				{
					ok: false,
					error: `no work item ${id || "(none)"} in ${p || "(no project)"}`,
				},
				404,
			);
		const openN = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM decisions WHERE state = 'OPEN' AND project = ? AND task_id = ?",
				)
				.get(p, id) as { n: number }
		).n;
		return json({
			ok: true,
			projects: projectList(),
			task: taskShape(w, openN, unblockedBy()),
			events: workEvents(p, id),
			decisions: taskDecisions(p, id),
		});
	}
	if (url.pathname === "/api/activity") {
		// newest-first bus feed; limit default 80, cap 300
		const p = url.searchParams.get("project");
		const limit = Math.min(
			Math.max(Number(url.searchParams.get("limit")) || 80, 1),
			300,
		);
		return json({
			ok: true,
			projects: projectList(),
			events: activity(p, limit),
		});
	}
	if (url.pathname === "/api/setup")
		// advisory wiring checks — each carries its own fix, never throws
		return json({ ok: true, checks: await setupChecks() });
	if (url.pathname === "/api/executors") {
		// dispatch dropdown feed: the local agents first, then belt's live
		// openai endpoints as llm:<machine>:<model or port> — failed
		// probes ride along (the owner may dispatch to a down target).
		// W105: every entry carries its model id + locality so the UI can
		// badge cards/lanes with WHERE the model actually runs.
		const s = readBoardSettings().settings;
		const executors = (await executorCandidates()).filter((e) =>
			executorAllowed(e.value, s),
		);
		return json({ ok: true, executors });
	}
	return null;
}
