// hooks/bin/store-api.ts — W92: the control plane's HTTP face. The SAME
// store ops, second transport (the knowledge-api.ts pattern): a consumer on
// another machine calls POST /events instead of importing govdb. Thin by
// design — zero logic that is not already in SqliteControlPlaneStore, so
// embedded and HTTP answers are identical by construction. Binds loopback
// unless SUSPENDERS_BIND says otherwise; optional bearer auth (store-
// tokens.json first key / SUSPENDERS_STORE_TOKEN) enforced on every route
// except /health — an unauthenticated server is the loopback posture, a
// token'd one can sit behind .local/Caddy for the fleet.
//   run: bun hooks/bin/store-api.ts [--port 7796]
//   POST /events            {source, kind, scope?, payload?, target?} → {id}
//   POST /events/get        {id}                                      → {row}
//   POST /events/query      {since?, kinds?, target?, source?, limit?} → {rows}
//   POST /inbox             {sid}   collect semantics (advance cursor) → {rows}
//   POST /facts/get         {key}                                      → {value}
//   POST /facts/set         {key, value, source}
//   POST /facts/delete      {key}
//   POST /facts/list        {prefix, sinceTs?}                         → {rows}
//   POST /claims/by-sid     {sid}                                      → {rows}
//   POST /sessions/upsert   {sid, project, parentSid, caps, transcriptPath}
//   POST /sessions/close    {sid}
//   POST /sessions/sweep    {}                                         → {n}
//   POST /work/owned        {project, sid}                             → {rows}
//   POST /work/closed-owners {project}                                 → {rows}
//   POST /work/ready        {project}                                  → {n}
//   POST /work/shape        {}                                         → {rows}
//   POST /kn/*              search|enqueue|promote|retire|note (W91 port)
//   GET  /health            no auth — the alive() probe target
import { SqliteControlPlaneStore } from "../lib/store-ports.ts";
import { readFileSync } from "node:fs";

const store = new SqliteControlPlaneStore(
	// import side effect: opens + migrates governor.db (the store owner)
	(await import("../lib/govdb.ts")).openGovernorDb(),
);
const port = Number(
	process.env.STORE_API_PORT ??
		(process.argv.includes("--port")
			? process.argv[process.argv.indexOf("--port") + 1]
			: 7796),
);
const BIND = process.env.SUSPENDERS_BIND ?? "127.0.0.1";
const TOKEN = (() => {
	if (process.env.SUSPENDERS_STORE_TOKEN)
		return process.env.SUSPENDERS_STORE_TOKEN;
	try {
		const keys = Object.keys(
			JSON.parse(
				readFileSync(
					`${process.env.HOME}/.claude/local-llm/store-tokens.json`,
					"utf8",
				),
			) as Record<string, unknown>,
		);
		return keys[0];
	} catch {
		return undefined;
	}
})();

const json = (data: unknown, status = 200): Response =>
	Response.json(data, { status });
const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim() ? v.trim() : null;

Bun.serve({
	port,
	hostname: BIND,
	// remote manners (#9): one port call per op, never chatty multi-trips
	async fetch(req) {
		const u = new URL(req.url);
		const path = u.pathname.replace(/\/$/, "") || "/";
		// token-configured → bearer required everywhere but /health;
		// unconfigured → open posture (loopback default bind)
		if (TOKEN && path !== "/health") {
			if ((req.headers.get("authorization") ?? "") !== `Bearer ${TOKEN}`)
				return json({ error: "unauthorized" }, 401);
		}
		const body =
			req.method === "POST"
				? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
				: {};
		try {
			return await route(req.method, path, body);
		} catch (e) {
			return json({ error: e instanceof Error ? e.message : String(e) }, 500);
		}
	},
});

async function route(
	method: string,
	path: string,
	b: Record<string, unknown>,
): Promise<Response> {
	if (method === "GET" && (path === "/" || path === "/health"))
		return json({
			ok: true,
			service: "suspenders-store-api",
		});
	// ---- events ----
	if (method === "POST" && path === "/events")
		return json({
			id: await store.emitEvent({
				source: str(b.source) ?? "http",
				kind: str(b.kind) ?? "",
				scope: str(b.scope),
				payload: typeof b.payload === "string" ? b.payload : null,
				target: str(b.target),
			}),
		});
	if (method === "POST" && path === "/events/get") {
		const id = num(b.id);
		if (!id) return json({ error: "id required" }, 400);
		return json({ row: await store.event(id) });
	}
	if (method === "POST" && path === "/events/query")
		return json({
			rows: await store.events({
				since: num(b.since) ?? undefined,
				kinds: Array.isArray(b.kinds) ? (b.kinds as string[]) : undefined,
				target: str(b.target),
				source: str(b.source),
				limit: num(b.limit) ?? undefined,
			}),
		});
	if (method === "POST" && path === "/inbox") {
		const sid = str(b.sid);
		if (!sid) return json({ error: "sid required" }, 400);
		return json({ rows: await store.collectInbox(sid) });
	}
	if (method === "POST" && path === "/inbox/count") {
		const sid = str(b.sid);
		if (!sid) return json({ error: "sid required" }, 400);
		return json({ n: await store.inboxCount(sid) });
	}
	// ---- facts ----
	if (method === "POST" && path === "/facts/get") {
		const key = str(b.key);
		if (!key) return json({ error: "key required" }, 400);
		return json({ value: await store.fact(key) });
	}
	if (method === "POST" && path === "/facts/set") {
		const key = str(b.key);
		if (!key || typeof b.value !== "string")
			return json({ error: "key, value required" }, 400);
		await store.factSet(key, b.value, str(b.source) ?? "store-api");
		return json({ ok: true });
	}
	if (method === "POST" && path === "/facts/delete") {
		const key = str(b.key);
		if (!key) return json({ error: "key required" }, 400);
		await store.factDelete(key);
		return json({ ok: true });
	}
	if (method === "POST" && path === "/facts/list")
		return json({
			rows: await store.factList(str(b.prefix) ?? "", num(b.sinceTs) ?? 0),
		});
	// ---- claims ----
	if (method === "POST" && path === "/claims/by-sid") {
		const sid = str(b.sid);
		if (!sid) return json({ error: "sid required" }, 400);
		return json({ rows: await store.claimsBySid(sid) });
	}
	// ---- sessions ----
	if (method === "POST" && path === "/sessions/upsert") {
		const sid = str(b.sid);
		const project = str(b.project);
		if (!sid || !project) return json({ error: "sid, project required" }, 400);
		await store.sessionUpsert({
			sid,
			project,
			parentSid: str(b.parentSid),
			caps: str(b.caps),
			transcriptPath: str(b.transcriptPath),
		});
		return json({ ok: true });
	}
	if (method === "POST" && path === "/sessions/close") {
		const sid = str(b.sid);
		if (!sid) return json({ error: "sid required" }, 400);
		await store.sessionClose(sid);
		return json({ ok: true });
	}
	if (method === "POST" && path === "/sessions/sweep")
		return json({ n: await store.sweepSessions() });
	// ---- work graph: read-only until the work-ops child migrates work.ts ----
	if (method === "POST" && path === "/work/owned") {
		const project = str(b.project);
		const sid = str(b.sid);
		if (!project || !sid) return json({ error: "project, sid required" }, 400);
		return json({ rows: await store.workOwned(project, sid) });
	}
	if (method === "POST" && path === "/work/closed-owners") {
		const project = str(b.project);
		if (!project) return json({ error: "project required" }, 400);
		return json({ rows: await store.workClosedOwners(project) });
	}
	if (method === "POST" && path === "/work/ready") {
		const project = str(b.project);
		if (!project) return json({ error: "project id required" }, 400);
		return json({ n: await store.workReadyCount(project) });
	}
	if (method === "POST" && path === "/work/shape")
		return json({ rows: await store.workShape() });
	// ---- knowledge (proxied to the W91 KnowledgeStore port) ----
	if (method === "POST" && path === "/kn/search")
		return json({
			hits: await store.knSearch({
				query: str(b.query) ?? "",
				limit: num(b.limit) ?? undefined,
				domain: str(b.domain),
				area: str(b.area),
			}),
		});
	if (method === "POST" && path === "/kn/enqueue")
		return json({
			queued: await store.knEnqueue({
				source: str(b.source) ?? "http",
				payload: typeof b.payload === "string" ? b.payload : "",
				domain: str(b.domain),
				area: str(b.area),
				codeOrigin: str(b.code_origin),
				originSid: str(b.origin_sid),
			}),
		});
	if (method === "POST" && path === "/kn/promote") {
		const id = num(b.id);
		if (!id) return json({ error: "id required" }, 400);
		return json({ promoted: await store.knPromote(id) });
	}
	if (method === "POST" && path === "/kn/retire") {
		const id = num(b.id);
		if (!id) return json({ error: "id required" }, 400);
		return json({
			retired: await store.knRetire(id, num(b.superseded_by)),
		});
	}
	if (method === "POST" && path === "/kn/note") {
		const id = num(b.id);
		const sid = str(b.sid);
		const what = str(b.what);
		if (!id || !sid || !what)
			return json({ error: "id, sid, what required" }, 400);
		const n = await store.knNote(id, sid, what);
		if (n < 0) return json({ error: "no such knowledge" }, 404);
		return json({ contributors: n });
	}
	return json({ error: `no route ${method} ${path}` }, 404);
}
