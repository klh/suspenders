// store-server.ts — W92 control-plane store server: governor.db as a loopback
// HTTP API. Local is the special case of distributed (owner doctrine): lanes
// on other machines bind via openStore() (GOVERNOR_STORE_URL / ${REG}/store.url)
// and hit these routes instead of the file; on the store host nothing changes.
// W156: the identity plane rides the SAME listener, served beside /rpc —
// POST /identity speaks the identical statement protocol against identity.db
// (openIdentity()'s HTTP binding), and /auth/* runs on the identity file too.
//
// wire:  GET  /health    → { ok, store, user_version, identity_user_version }
//        POST /rpc       → { mode, sql, params } statement RPC (control plane)
//        POST /identity  → the same protocol against identity.db (W156)
//        /auth/*         issue / refresh / revoke / whoami (auth-server.ts)
//
// auth:  loopback bind only + optional shared token (GOVERNOR_STORE_TOKEN;
//        requests must then carry x-governor-token). Statement-shaped by
//        design: the port executes the exact SQL the CLIs run today, which is
//        what keeps CLI output byte-compatible. Requests serialize per plane
//        so INSERT → last_insert_rowid() never interleaves.
//
// run:   bun hooks/bin/store-server.ts [--port 7794]
//        (port: --port > GOVERNOR_STORE_PORT > 7794; 7791 belt, 7795
//        knowledge-api, 7799 board — 7794 was free)
import {
	openGovernorDb,
	knowledgeSqlViolation,
	type GovernorStore,
	type IdentityStore,
} from "../lib/govdb.ts";
import { openIdentityDb, identitySqlViolation } from "../lib/identity-db.ts";
import { handleAuthRoutes } from "../lib/auth-server.ts";
import { servicemon } from "../lib/servicemon.ts";

const PORT =
	Number(process.argv[process.argv.indexOf("--port") + 1] ?? "") ||
	Number(process.env.GOVERNOR_STORE_PORT ?? 7794) ||
	7794;
const TOKEN = process.env.GOVERNOR_STORE_TOKEN ?? "";

// W125 — shared /status + /metrics (lib/servicemon.ts). /health stays for
// compat. tokens_total is NOT served here: the store sees no token usage, and
// omitting the family honestly beats faking zeros.
const sm = servicemon({ service: "store-server", port: PORT });

// two plane connections + one tx connection each (WAL keeps outside reads
// flowing, outside writes wait on busy_timeout — a remote tx window is a few
// serialized round trips, well inside the 2s budget). /rpc execs against the
// governor pair, /identity + /auth/* against the identity pair.
const db = openGovernorDb() as unknown as GovernorStore;
const txDb = openGovernorDb() as unknown as GovernorStore;
const idb = openIdentityDb() as unknown as IdentityStore;
const txIdb = openIdentityDb() as unknown as IdentityStore;
const TX_IDLE_MS = 10_000;

// one serialization chain PER PLANE — different SQLite files, so governor and
// identity statements need not serialize against each other; within a plane,
// INSERT → last_insert_rowid() must never interleave.
const perPlaneSerial = (): (<T>(fn: () => T) => Promise<T>) => {
	let chain: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => T): Promise<T> => {
		const p = chain.then(fn);
		chain = p.catch(() => {});
		return p;
	};
};
const serialGov = perPlaneSerial();
const serialIdb = perPlaneSerial();

// a plane's open-transaction cell — private to its route closure
type TxCell = { v: { id: string; last: number } | null };

// tx-tag protocol internals, one op each — small complete units so each
// emission stays verifiable (the chunk discipline exists for this).
const rollIdle = (cell: TxCell, txConn: GovernorStore): void => {
	if (!cell.v || Date.now() - cell.v.last <= TX_IDLE_MS) return;
	try {
		txConn.run("ROLLBACK");
	} catch {}
	cell.v = null;
};

const beginOp = (
	txid: string | null,
	cell: TxCell,
	txConn: GovernorStore,
): Response => {
	if (cell.v) return Response.json({ err: "transaction already open" });
	txConn.run("BEGIN IMMEDIATE");
	cell.v = { id: txid ?? "?", last: Date.now() };
	return Response.json({ ok: true });
};

const endOp = (
	op: "commit" | "rollback",
	txid: string | null,
	cell: TxCell,
	txConn: GovernorStore,
): Response => {
	if (!cell.v || cell.v.id !== (txid ?? "?"))
		return Response.json({ err: "no such transaction" });
	cell.v = null;
	try {
		txConn.run(op === "commit" ? "COMMIT" : "ROLLBACK");
		return Response.json({ ok: true });
	} catch (e) {
		try {
			txConn.run("ROLLBACK");
		} catch {}
		return Response.json({ err: `${op} failed: ${String(e)}` });
	}
};

const txOp = (
	op: string,
	txid: string | null,
	cell: TxCell,
	txConn: GovernorStore,
): Response => {
	rollIdle(cell, txConn);
	if (op === "begin") return beginOp(txid, cell, txConn);
	if (op === "commit" || op === "rollback")
		return endOp(op, txid, cell, txConn);
	return Response.json({ err: "no such tx op" });
};

// one statement-plane route: guards → tx ops → serialized exec. /rpc and
// /identity ride this factory against their plane's connections (W156: one
// protocol, two files, byte-identical semantics with the old /rpc body).
const statementRoute =
	(
		conn: GovernorStore,
		txConn: GovernorStore,
		serial: <T>(fn: () => T) => Promise<T>,
		rejects: {
			hit: (sql: string) => string | null;
			err: (hit: string) => string;
		}[],
		cell: TxCell,
	) =>
	async (req: Request): Promise<Response> => {
		if (req.method !== "POST")
			return new Response("not found", { status: 404 });
		// the ONE shared loopback token gates both statement planes (W156:
		// /identity rides the same gate as /rpc)
		if (TOKEN && req.headers.get("x-governor-token") !== TOKEN)
			return new Response("forbidden", { status: 403 });
		const body = (await req.json().catch(() => null)) as {
			mode?: string;
			sql?: string;
			params?: unknown[];
			txid?: string | null;
		} | null;
		const modeOk = ["get", "all", "run", "tx"].includes(body?.mode ?? "");
		if (!body?.sql || !modeOk || !Array.isArray(body.params ?? []))
			return new Response("bad request", { status: 400 });
		for (const reject of rejects) {
			const hit = reject.hit(body.sql);
			if (hit) return Response.json({ err: reject.err(hit) });
		}
		if (body.mode === "tx")
			return serial(() => txOp(body.sql, body.txid ?? null, cell, txConn));
		const payload = {
			mode: body.mode as "get" | "all" | "run",
			sql: body.sql,
			params: body.params ?? [],
			txid: body.txid ?? null,
		};
		return serial(() => {
			rollIdle(cell, txConn);
			const t = cell.v;
			if (t) {
				if (!payload.txid)
					return Response.json({ err: "a transaction is open — retry" });
				if (payload.txid !== t.id)
					return Response.json({ err: "no such transaction" });
				t.last = Date.now();
				return Response.json(
					exec(payload.mode, payload.sql, payload.params, txConn),
				);
			}
			return Response.json(
				exec(payload.mode, payload.sql, payload.params, conn),
			);
		});
	};

// W92 exec: one statement against one connection — identical response shapes
// as before the W156 refactor (get → {row}, all → {rows}, run → counts).
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

// /rpc guard messages keep the W166 wire text byte-identical; identity gets
// the analogous one (same shape, its own port named).
const kbOnRpc = (hit: string): string =>
	`knowledge statements are rejected on the control-plane store ('${hit}' is not resident in governor.db) — bind the knowledge port (makeStore())`;
const idOnRpc = (hit: string): string =>
	`identity statements are rejected on the control-plane store ('${hit}' is not resident in governor.db) — bind the identity port (openIdentity())`;
const kbOnIdb = (hit: string): string =>
	`knowledge statements are rejected on the identity port ('${hit}' is not resident in identity.db) — bind the knowledge port (makeStore())`;

const rpcRoute = statementRoute(
	db,
	txDb,
	serialGov,
	[
		{ hit: knowledgeSqlViolation, err: kbOnRpc },
		{ hit: identitySqlViolation, err: idOnRpc },
	],
	{ v: null },
);
const identityRoute = statementRoute(
	idb,
	txIdb,
	serialIdb,
	[{ hit: knowledgeSqlViolation, err: kbOnIdb }],
	{ v: null },
);

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
				identity_user_version: (
					idb.query("PRAGMA user_version").get() as { user_version: number }
				).user_version,
			});
		// W149/W156 — the identity surface rides the identity connection now:
		// /auth/* serializes on the identity chain, beside /identity.
		if (url.pathname.startsWith("/auth/"))
			return serialIdb(() =>
				handleAuthRoutes(req, url, {
					store: idb,
				}),
			);
		if (url.pathname === "/rpc") return rpcRoute(req);
		if (url.pathname === "/identity") return identityRoute(req);
		return new Response("not found", { status: 404 });
	},
};

// W125 — the observability wrap: /status + /metrics ride the SAME fetch via
// lib/servicemon.ts; the route body above stays untouched.
Bun.serve(sm.wrapped(base));

console.log(
	`governor store on 127.0.0.1:${PORT} (${TOKEN ? "token" : "open, loopback-only"})`,
);
