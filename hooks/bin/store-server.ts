// store-server.ts — W92 control-plane store server: governor.db as a loopback
// HTTP API. Local is the special case of distributed (owner doctrine): lanes
// on other machines bind via openStore() (GOVERNOR_STORE_URL / ${REG}/store.url)
// and hit these routes instead of the file; on the store host nothing changes.
//
// wire:  GET  /health  → { ok, store, user_version }
//        POST /rpc     → { mode: "get"|"all"|"run", sql, params }
//                        ← { row } | { rows } | { changes, lastInsertRowid }
// auth:  loopback bind only + optional shared token (GOVERNOR_STORE_TOKEN;
//        requests must then carry x-governor-token). Statement-shaped by
//        design: the port executes the exact SQL the CLIs run today, which is
//        what keeps CLI output byte-compatible. Requests serialize on ONE
//        connection so INSERT → last_insert_rowid() never interleaves.
//
// run:   bun hooks/bin/store-server.ts [--port 7794]
//        (port: --port > GOVERNOR_STORE_PORT > 7794; 7791 belt, 7795
//        knowledge-api, 7799 board — 7794 was free)
import {
	openGovernorDb,
	knowledgeSqlViolation,
	type GovernorStore,
} from "../lib/govdb.ts";
import { handleAuthRoutes } from "../lib/auth-server.ts";
import { servicemon } from "../lib/servicemon.ts";
// W170 — federation phase 2 hub surfaces (work-delta receiver + lane view)
import {
	buildLaneView,
	DeltaBatchError,
	landWorkDeltas,
	renderLaneViewHtml,
} from "../lib/federation-hub.ts";
import { readCapped } from "../lib/federation.ts";

const PORT =
	Number(process.argv[process.argv.indexOf("--port") + 1] ?? "") ||
	Number(process.env.GOVERNOR_STORE_PORT ?? 7794) ||
	7794;
const TOKEN = process.env.GOVERNOR_STORE_TOKEN ?? "";

// W125 — shared /status + /metrics (lib/servicemon.ts). /health stays for
// compat. tokens_total is NOT served here: the store sees no token usage, and
// omitting the family honestly beats faking zeros.
const sm = servicemon({ service: "store-server", port: PORT });

// one connection for the whole server; /rpc requests serialize on it. A SECOND
// connection serves tagged transaction statements: WAL keeps outside reads
// flowing, outside writes wait on busy_timeout — a remote tx window is a few
// serialized round trips, well inside the 2s budget.
const db = openGovernorDb();
const txDb = openGovernorDb() as unknown as GovernorStore;
let tx: { id: string; last: number } | null = null;
const TX_IDLE_MS = 10_000;

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => T): Promise<T> => {
	const p = chain.then(fn);
	chain = p.catch(() => {});
	return p;
};

const exec = (
	mode: "get" | "all" | "run",
	sql: string,
	params: unknown[],
	conn: GovernorStore,
): Record<string, unknown> => {
	const st = conn.query(sql);
	if (mode === "get") return { row: st.get(...params) ?? null };
	if (mode === "all") return { rows: st.all(...params) };
	const r = st.run(...params);
	return {
		changes: r.changes,
		lastInsertRowid: Number(r.lastInsertRowid),
	};
};

// W170 — problem+json responses on the federation surfaces (RFC 9457 shape,
// stable code, no internals on 500). Shared by both fed routes.
function problemRes(
	status: number,
	title: string,
	detail: string,
	code: string,
): Response {
	return new Response(
		JSON.stringify({
			type: "about:blank",
			title,
			status,
			detail,
			code,
		}),
		{ status, headers: { "content-type": "application/problem+json" } },
	);
}

// W170 — POST /federation/work-delta: land one pushed batch (bounded,
// idempotent) and ack through_seq. problem+json errors; 500s never leak
// internals (http-citizenship).
async function handleWorkDelta(req: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await readCapped(req);
	} catch {
		return problemRes(
			400,
			"malformed or oversized batch body",
			"body must be JSON under the 64 KiB cap",
			"store.batch_invalid",
		);
	}
	return serial(() => {
		try {
			const r = landWorkDeltas(db as GovernorStore, body);
			return Response.json(
				{ applied: r.applied, skipped: r.skipped, through_seq: r.throughSeq },
				{ headers: { "cache-control": "no-store" } },
			);
		} catch (e) {
			const bad = e instanceof DeltaBatchError;
			return problemRes(
				bad ? 400 : 500,
				bad ? "invalid batch" : "landing failed",
				bad ? e.message : "landing failed",
				bad ? "store.batch_invalid" : "store.landing_failed",
			);
		}
	});
}

// W170 — GET /federation/lane-view: the cross-user/team work-log + lane
// view over fed_work_log. JSON (default) or ?format=html; strong ETag +
// If-None-Match → 304 per http-citizenship; no-store (credentialed plane).
async function handleLaneView(req: Request, url: URL): Promise<Response> {
	if (req.method !== "GET")
		return new Response(null, {
			status: 405,
			headers: { allow: "GET, OPTIONS" },
		});
	const view = await serial(() => buildLaneView(db as GovernorStore, {}));
	const html = url.searchParams.get("format") === "html";
	const body = html ? renderLaneViewHtml(view) : JSON.stringify(view);
	const etag = `"${Bun.CryptoHasher("sha1").update(body).digest("hex")}"`;
	const inm = req.headers.get("if-none-match");
	if (inm !== null && inm === etag)
		return new Response(null, {
			status: 304,
			headers: { etag, "cache-control": "no-store" },
		});
	return new Response(body, {
		status: 200,
		headers: {
			etag,
			"cache-control": "no-store",
			...(html
				? { "content-type": "text/html; charset=utf-8" }
				: { "content-type": "application/json" }),
		},
	});
}

const base = {
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/health")
			return Response.json({
				ok: true,
				store: "governor",
				user_version: (
					db.query("PRAGMA user_version").get() as { user_version: number }
				).user_version,
			});
		// W149 — the identity surface rides this server (it owns governor.db):
		// /auth/token, /auth/refresh, /auth/revoke, /auth/whoami. Serialized on
		// the same connection chain as /rpc so issuance transactions never
		// interleave with CLI statements.
		if (url.pathname.startsWith("/auth/"))
			return serial(() =>
				handleAuthRoutes(req, url, {
					store: db as unknown as GovernorStore,
				}),
			);
		// W170 — federation phase 2 hub surfaces. Same trust seam as /rpc:
		// loopback bind + optional shared token — the spoke presents the
		// enrollment credential (x-governor-token OR Bearer); it never
		// verifies anyone (capability-split law). problem+json errors per
		// http-citizenship.
		if (url.pathname.startsWith("/federation/")) {
			if (req.method === "OPTIONS")
				return new Response(null, {
					status: 204,
					headers: { allow: "GET, POST, OPTIONS" },
				});
			const fedAuthOk =
				TOKEN.length === 0 ||
				req.headers.get("x-governor-token") === TOKEN ||
				(req.headers.get("authorization") ?? "") === `Bearer ${TOKEN}`;
			if (!fedAuthOk)
				return new Response(
					JSON.stringify({
						type: "about:blank",
						title: "missing or invalid credentials",
						status: 401,
						detail:
							"present the shared spoke credential via x-governor-token or Authorization: Bearer",
						code: "store.auth_missing",
					}),
					{
						status: 401,
						headers: {
							"content-type": "application/problem+json",
							"www-authenticate": 'Bearer realm="store-server"',
						},
					},
				);
			if (url.pathname === "/federation/work-delta")
				return handleWorkDelta(req);
			if (url.pathname === "/federation/lane-view")
				return handleLaneView(req, url);
			return problemRes(
				404,
				"unknown federation surface",
				`${url.pathname} is not a federation surface`,
				"store.fed_not_found",
			);
		}
		if (req.method !== "POST" || url.pathname !== "/rpc")
			return new Response("not found", { status: 404 });
		if (TOKEN && req.headers.get("x-governor-token") !== TOKEN)
			return new Response("forbidden", { status: 403 });
		const body = (await req.json()) as {
			mode?: string;
			sql?: string;
			params?: unknown[];
			txid?: string | null;
		};
		const modeOk = ["get", "all", "run", "tx"].includes(body.mode ?? "");
		if (!body.sql || !modeOk || !Array.isArray(body.params ?? []))
			return new Response("bad request", { status: 400 });
		// W166 — structural rejection: knowledge lives in knowledge.db; a
		// knowledge statement must ride the knowledge port (makeStore), never
		// the control-plane store (the design's W92 interaction).
		const kbHit = knowledgeSqlViolation(body.sql);
		if (kbHit)
			return Response.json({
				err: `knowledge statements are rejected on the control-plane store ('${kbHit}' is not resident in governor.db) — bind the knowledge port (makeStore())`,
			});
		if (body.mode === "tx") {
			// op rides the sql field: begin | commit | rollback
			const op = body.sql;
			return serial(() => {
				if (tx && Date.now() - tx.last > TX_IDLE_MS) {
					try {
						txDb.run("ROLLBACK");
					} catch {}
					tx = null;
				}
				if (op === "begin") {
					if (tx) return Response.json({ err: "transaction already open" });
					txDb.run("BEGIN IMMEDIATE");
					tx = { id: body.txid ?? "?", last: Date.now() };
					return Response.json({ ok: true });
				}
				if (!tx || tx.id !== (body.txid ?? "?"))
					return Response.json({ err: "no such transaction" });
				tx = null;
				try {
					if (op === "commit") txDb.run("COMMIT");
					else txDb.run("ROLLBACK");
					return Response.json({ ok: true });
				} catch (e) {
					try {
						txDb.run("ROLLBACK");
					} catch {}
					return Response.json({ err: `${op} failed: ${String(e)}` });
				}
			});
		}
		const payload = {
			mode: body.mode as "get" | "all" | "run",
			sql: body.sql,
			params: body.params ?? [],
			txid: body.txid ?? null,
		};
		return serial(() => {
			if (tx && Date.now() - tx.last > TX_IDLE_MS) {
				try {
					txDb.run("ROLLBACK");
				} catch {}
				tx = null;
			}
			if (tx) {
				if (!payload.txid)
					return Response.json({ err: "a transaction is open — retry" });
				if (payload.txid !== tx.id)
					return Response.json({ err: "no such transaction" });
				tx.last = Date.now();
				return Response.json(
					exec(payload.mode, payload.sql, payload.params, txDb),
				);
			}
			return Response.json(
				exec(
					payload.mode,
					payload.sql,
					payload.params,
					db as unknown as GovernorStore,
				),
			);
		});
	},
};

// W125 — the observability wrap: /status + /metrics ride the SAME fetch via
// lib/servicemon.ts; the route body above stays untouched.
Bun.serve(sm.wrapped(base));

console.log(
	`governor store on 127.0.0.1:${PORT} (${TOKEN ? "token" : "open, loopback-only"})`,
);
