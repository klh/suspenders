// hooks/board/routes-orch.ts — W57 orchestrate endpoints (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { CLI, DEMO } from "./context.ts";
import { json, writeGuard, readJson } from "./helpers.ts";
import { board } from "./data.ts";
import { ORCH, orchestrate, orchRegister } from "./orch.ts";

export async function handleOrch(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/orchestrate") {
		// W57 — propose only: an LLM round-trip, zero work-graph writes.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const goal = String(parsed.body?.goal ?? "")
			.trim()
			.slice(0, ORCH.GOAL_MAX);
		if (!project || !goal)
			return json({ ok: false, error: "missing project or goal" }, 400);
		const r = await orchestrate(project, goal);
		return json(r.body, r.status);
	}
	if (req.method === "POST" && url.pathname === "/api/orchestrate/register") {
		// W57 — the one click: register the proposal as a plan item + a
		// plan-gated split via the work CLI in the target repo.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const title = String(parsed.body?.title ?? "")
			.trim()
			.slice(0, ORCH.TITLE_MAX);
		const raw = Array.isArray(parsed.body?.children)
			? (parsed.body.children as unknown[])
			: [];
		const kids = raw
			.map((c) =>
				typeof c === "string"
					? c.trim().slice(0, ORCH.TITLE_MAX)
					: typeof (c as { title?: unknown })?.title === "string"
						? String((c as { title?: unknown }).title)
								.trim()
								.slice(0, ORCH.TITLE_MAX)
						: "",
			)
			.filter((t) => t.length > 0);
		if (!project) return json({ ok: false, error: "missing project" }, 400);
		if (!title) return json({ ok: false, error: "missing title" }, 400);
		if (kids.length < ORCH.MIN_CHILDREN || kids.length > ORCH.MAX_CHILDREN)
			return json({ ok: false, error: "children must number 2..8" }, 400);
		const r = orchRegister(project, title, kids);
		return json(r.body, r.status);
	}
	// ── W147 console (NEW paths only; existing routes untouched) ──
	return null;
}
