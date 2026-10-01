// hooks/board/routes-suggest.ts — W163 composer suggest: POST /api/suggest
// (route module, W157 pattern). The local minimal model expands a terse
// draft into a brief-shaped prompt — read-only, zero work-graph writes.
import { DEMO } from "./context.ts";
import { json, writeGuard, readJson } from "./helpers.ts";
import { SUGGEST, suggest } from "./suggest.ts";

export async function handleSuggest(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method !== "POST" || url.pathname !== "/api/suggest") return null;
	const guard = writeGuard(req, url);
	if (guard) return guard;
	if (DEMO)
		return json({ ok: false, error: "demo board — no real lanes" }, 409);
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.resp;
	const project = String(parsed.body?.project ?? "");
	const draft = String(parsed.body?.draft ?? "")
		.trim()
		.slice(0, SUGGEST.DRAFT_MAX);
	if (!project) return json({ ok: false, error: "missing project" }, 400);
	if (draft.length < SUGGEST.DRAFT_MIN)
		return json(
			{ ok: false, error: `draft too short (min ${SUGGEST.DRAFT_MIN} chars)` },
			400,
		);
	const r = await suggest(project, draft);
	return json(r.body, r.status);
}
