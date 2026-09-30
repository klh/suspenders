import { makeStore, enqueueKnowledge } from "../lib/knowledge-ports.ts";
// knowledge-api.ts — W91 #9b: the knowledge port's HTTP face. The SAME store
// handlers, second transport: a consumer on another machine calls
// http://<knowledge-api>/search instead of importing the lib. Thin by design
// — zero logic that is not already in the KnowledgeStore port; resolveBelt-
// style resolution applies (env → config → .local name → dev default).
//   run: bun hooks/bin/knowledge-api.ts [--port 7795]
//   POST /search   {query, limit?, domain?, area?, origin_kind?, origin_system?}
//   POST /enqueue  {source, payload, domain?, area?, code_origin?, origin_sid?}
//   POST /promote  {id}
//   POST /retire   {id, superseded_by?}
//   POST /note     {id, sid, what}
//   GET  /verify[/<id>]
const store = makeStore();
const port = Number(
	process.env.KNOWLEDGE_API_PORT ??
		(process.argv.includes("--port")
			? process.argv[process.argv.indexOf("--port") + 1]
			: 7795),
);
const json = (data: unknown, status = 200): Response =>
	Response.json(data, { status });
const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim() ? v.trim() : null;

Bun.serve({
	port,
	// remote manners (#9): never assume co-location — every route is one port
	// call, no chatty multi-round-trip handlers
	async fetch(req) {
		const u = new URL(req.url);
		const path = u.pathname.replace(/\/$/, "") || "/";
		const body =
			req.method === "POST"
				? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
				: {};
		try {
			if (req.method === "POST" && path === "/search")
				return json({
					hits: await store.search({
						query: str(body.query) ?? "",
						limit: num(body.limit) ?? undefined,
						domain: str(body.domain),
						area: str(body.area),
						originKind: str(body.origin_kind),
						originSystem: str(body.origin_system),
					}),
				});
			if (req.method === "POST" && path === "/enqueue")
				return json({
					queued: await enqueueKnowledge({
						source: str(body.source) ?? "http",
						payload: str(body.payload) ?? "",
						domain: str(body.domain),
						area: str(body.area),
						codeOrigin: str(body.code_origin),
						originSid: str(body.origin_sid),
					}),
				});
			if (req.method === "POST" && path === "/promote") {
				const id = num(body.id);
				if (!id) return json({ error: "id required" }, 400);
				return json({ promoted: await store.promote(id) });
			}
			if (req.method === "POST" && path === "/retire") {
				const id = num(body.id);
				if (!id) return json({ error: "id required" }, 400);
				return json({
					retired: await store.retire(id, num(body.superseded_by)),
				});
			}
			if (req.method === "POST" && path === "/note") {
				const id = num(body.id);
				const sid = str(body.sid);
				const what = str(body.what);
				if (!id || !sid || !what)
					return json({ error: "id, sid, what required" }, 400);
				const n = await store.note(id, sid, what);
				if (n < 0) return json({ error: "no such knowledge" }, 404);
				return json({ contributors: n });
			}
			if (
				req.method === "GET" &&
				(path === "/verify" || path.startsWith("/verify/"))
			) {
				const id = path === "/verify" ? null : Number(path.split("/")[2]);
				return json({ rows: await store.verifyRows(id ?? null) });
			}
			return json({
				ok: true,
				service: "suspenders-knowledge-api",
				routes: [
					"/search",
					"/enqueue",
					"/promote",
					"/retire",
					"/note",
					"/verify",
				],
			});
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 500);
		}
	},
});
console.error(`suspenders-knowledge-api: port ${port}`);
