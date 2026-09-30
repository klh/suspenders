// hooks/lib/store-ports.ts — W92: the control-plane store's ports. The
// colocation-free seam over governor.db: consumers consume INTERFACES, never
// the DB file. Local = special case of distributed (owner directive
// 2026-09-30) — the embedded SQLite adapter answers when no store server
// runs (colocated dev box, CI), the HTTP adapter answers when
// resolveStore() finds one. Both adapters answer IDENTICALLY (the parity
// test proves it), so a consumer cannot tell which transport it got.
//
//   ControlPlaneStore — events / facts / claims / sessions / work-read /
//     knowledge. The port GROWS WITH NEED: each consumer subsystem migrates
//     by adding its ops here (children of W92 migrate coord, work, board,
//     monitor, gates). One method per consumer op — remote manners: never
//     chatty multi-round-trip handlers (W91 #9).
//   makeStore() — plain switch at consumer startup, no plugin framework.
//   resolveStore() — the W91 #9a chain (env → operator config → .local name
//     → same-box dev default → null): SUSPENDERS_STORE_URL env →
//     ~/.claude/local-llm/store.json → store.local:7796 → 127.0.0.1:7796.
//
// OWNERSHIP (enforced by the files gate's govdb-import rule, W92): the ONLY
// modules allowed to import openGovernorDb are govdb.ts itself (schema
// owner), this file (embedded adapter), bin/store-api.ts (HTTP face), and
// lib/knowledge-ports.ts (W91 knowledge owner). Everything else consumes
// the port.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { openGovernorDb, sweepStaleSessions } from "./govdb.ts";
import { SqliteKnowledgeStore, enqueueKnowledge } from "./knowledge-ports.ts";

// ---- shared row types (wire == embedded shape, JSON-safe) ----
export interface BusEvent {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
	target: string | null;
}
export interface FactRow {
	key: string;
	value: string | null;
	source: string | null;
	version: number;
	ts: number;
}
export interface ClaimRow {
	sid: string;
	scope: string;
	intent: string | null;
	hot: number;
	ts: number;
	tp: string | null;
}
export interface SessionUpsert {
	sid: string;
	project: string;
	parentSid: string | null;
	caps: string | null;
	transcriptPath: string | null;
}
export interface WorkRow {
	id: string;
	title: string;
	state: string;
}
export interface EventQuery {
	since?: number;
	kinds?: string[];
	target?: string | null;
	source?: string | null;
	limit?: number;
}

// ---- THE port ----
export interface ControlPlaneStore {
	// events (the bus): emit, read, directed inbox
	emitEvent(e: {
		source: string;
		kind: string;
		scope?: string | null;
		payload?: string | null;
		target?: string | null;
	}): Promise<number>;
	event(id: number): Promise<BusEvent | null>;
	events(q?: EventQuery): Promise<BusEvent[]>;
	collectInbox(sid: string): Promise<BusEvent[]>;
	// non-consuming inbox depth (session-start's counter — collectInbox
	// would advance the cursor)
	inboxCount(sid: string): Promise<number>;
	// facts: canonical key→value rows
	fact(key: string): Promise<string | null>;
	factSet(key: string, value: string, source: string): Promise<void>;
	factDelete(key: string): Promise<void>;
	factList(prefix: string, sinceTs?: number): Promise<FactRow[]>;
	// claims (governor claim ledger)
	claimsBySid(sid: string): Promise<ClaimRow[]>;
	// sessions (registry + liveness sweep)
	sessionUpsert(s: SessionUpsert): Promise<void>;
	sessionClose(sid: string): Promise<void>;
	sweepSessions(): Promise<number>;
	// work graph: read-only until the work-ops child migrates work.ts
	workOwned(project: string, sid: string): Promise<WorkRow[]>;
	workClosedOwners(project: string): Promise<string[]>;
	workReadyCount(project: string): Promise<number>;
	workShape(): Promise<{ state: string; n: number }[]>;
	// knowledge: proxied to the W91 KnowledgeStore port in BOTH transports
	knSearch(q: {
		query: string;
		limit?: number;
		domain?: string | null;
		area?: string | null;
	}): Promise<unknown[]>;
	knEnqueue(job: {
		source: string;
		payload: string;
		domain?: string | null;
		area?: string | null;
		codeOrigin?: string | null;
		originSid?: string | null;
	}): Promise<number>;
	knPromote(id: number): Promise<boolean>;
	knRetire(id: number, supersededBy: number | null): Promise<boolean>;
	knNote(id: number, sid: string, what: string): Promise<number>;
	close(): void;
}

// ─── embedded adapter: governor.db (SQLite/WAL) — a store-owner module ───
// shares the ONE connection shape with the HTTP face; business logic lives
// HERE so both transports answer identically (parity by construction).
export class SqliteControlPlaneStore implements ControlPlaneStore {
	private kn: SqliteKnowledgeStore;

	constructor(private db: Database) {
		// the W91 knowledge store shares THIS connection — one SQLite handle
		// for the whole embedded control plane
		this.kn = new SqliteKnowledgeStore(db);
	}

	async emitEvent(e: {
		source: string;
		kind: string;
		scope?: string | null;
		payload?: string | null;
		target?: string | null;
	}): Promise<number> {
		const r = this.db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				Date.now(),
				e.source,
				e.kind,
				e.scope ?? null,
				e.payload ?? null,
				e.target ?? null,
			);
		return Number(r.lastInsertRowid);
	}

	async event(id: number): Promise<BusEvent | null> {
		return (
			(this.db
				.query(
					"SELECT id, ts, source, kind, scope, payload, target FROM events WHERE id = ?",
				)
				.get(id) as BusEvent | undefined) ?? null
		);
	}

	async events(q: EventQuery = {}): Promise<BusEvent[]> {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (q.since != null) {
			where.push("id > ?");
			args.push(q.since);
		}
		if (q.kinds?.length) {
			where.push(`kind IN (${q.kinds.map(() => "?").join(",")})`);
			args.push(...q.kinds);
		}
		if (q.target != null) {
			where.push("target = ?");
			args.push(q.target);
		}
		if (q.source != null) {
			where.push("source = ?");
			args.push(q.source);
		}
		// newest first, hard cap so a busy bus cannot flood a remote caller
		return this.db
			.query(
				`SELECT id, ts, source, kind, scope, payload, target FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
			)
			.all(...args, Math.min(q.limit ?? 200, 1000)) as BusEvent[];
	}

	async collectInbox(sid: string): Promise<BusEvent[]> {
		// coord inbox --ack semantics: unread directed rows past the cursor,
		// cursor advances to the newest delivered id (transactional)
		const cur = this.cursor(sid);
		const rows = this.db
			.query(
				"SELECT id, ts, source, kind, scope, payload, target FROM events WHERE target = ? AND id > ? ORDER BY id",
			)
			.all(sid, cur) as BusEvent[];
		if (rows.length) this.cursorSet(sid, rows[rows.length - 1].id);
		return rows;
	}

	async inboxCount(sid: string): Promise<number> {
		return (
			this.db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > (SELECT COALESCE(MAX(event_id), 0) FROM cursors WHERE sid = ?)",
				)
				.get(sid, sid) as { n: number }
		).n;
	}

	private cursor(sid: string): number {
		return (
			(
				this.db
					.query("SELECT event_id FROM cursors WHERE sid = ?")
					.get(sid) as { event_id: number } | null
			)?.event_id ?? 0
		);
	}

	private cursorSet(sid: string, eventId: number): void {
		this.db
			.query(
				"INSERT INTO cursors (sid, event_id) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET event_id = excluded.event_id",
			)
			.run(sid, eventId);
	}

	async fact(key: string): Promise<string | null> {
		return (
			(
				this.db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
					value: string | null;
				} | null
			)?.value ?? null
		);
	}

	async factSet(key: string, value: string, source: string): Promise<void> {
		this.db
			.query(
				"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
			)
			.run(key, value, source, Date.now());
	}

	async factDelete(key: string): Promise<void> {
		this.db.query("DELETE FROM facts WHERE key = ?").run(key);
	}

	async factList(prefix: string, sinceTs = 0): Promise<FactRow[]> {
		return this.db
			.query(
				"SELECT key, value, source, version, ts FROM facts WHERE key LIKE ? || '%' AND ts > ? ORDER BY ts",
			)
			.all(prefix, sinceTs) as FactRow[];
	}

	async claimsBySid(sid: string): Promise<ClaimRow[]> {
		return this.db
			.query(
				"SELECT sid, scope, intent, hot, ts, tp FROM claims WHERE sid = ? ORDER BY ts DESC LIMIT 5",
			)
			.all(sid) as ClaimRow[];
	}

	async sessionUpsert(s: SessionUpsert): Promise<void> {
		// the session-start UPSERT: lane registration with resumable shape
		this.db
			.query(
				"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path) VALUES (?, ?, 'worker', ?, NULL, ?, ?, 'RUNNING', ?, ?) ON CONFLICT(sid) DO UPDATE SET project = excluded.project, parent_sid = excluded.parent_sid, hb = excluded.hb, state = 'RUNNING', capabilities = COALESCE(excluded.capabilities, sessions.capabilities), transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path)",
			)
			.run(
				s.sid,
				s.project,
				s.parentSid,
				Date.now(),
				Date.now(),
				s.caps,
				s.transcriptPath,
			);
	}

	async sessionClose(sid: string): Promise<void> {
		this.db
			.query("UPDATE sessions SET state = 'CLOSED', hb = ? WHERE sid = ?")
			.run(Date.now(), sid);
	}

	async sweepSessions(): Promise<number> {
		return sweepStaleSessions(this.db);
	}

	async workOwned(project: string, sid: string): Promise<WorkRow[]> {
		return this.db
			.query(
				"SELECT id, title, state FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED') ORDER BY id",
			)
			.all(project, sid) as WorkRow[];
	}

	async workClosedOwners(project: string): Promise<string[]> {
		return (
			this.db
				.query(
					"SELECT s.sid FROM sessions s WHERE s.project = ? AND s.state = 'CLOSED' AND EXISTS(SELECT 1 FROM work_items w WHERE w.owner_sid = s.sid AND w.project = s.project AND w.state NOT IN ('DONE','SUPERSEDED','FAILED'))",
				)
				.all(project) as { sid: string }[]
		).map((r) => r.sid);
	}

	async workReadyCount(project: string): Promise<number> {
		return (
			this.db
				.query(
					"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
				)
				.get(project) as { n: number }
		).n;
	}

	async workShape(): Promise<{ state: string; n: number }[]> {
		return this.db
			.query(
				"SELECT state, COUNT(*) AS n FROM work_items WHERE state IN ('READY','CLAIMED','RUNNING','BLOCKED','DONE') GROUP BY state",
			)
			.all() as { state: string; n: number }[];
	}

	async knSearch(q: {
		query: string;
		limit?: number;
		domain?: string | null;
		area?: string | null;
	}): Promise<unknown[]> {
		return this.kn.search({
			...q,
			domain: q.domain ?? null,
			area: q.area ?? null,
		});
	}

	async knEnqueue(job: {
		source: string;
		payload: string;
		domain?: string | null;
		area?: string | null;
		codeOrigin?: string | null;
		originSid?: string | null;
	}): Promise<number> {
		return enqueueKnowledge({
			source: job.source,
			payload: job.payload,
			domain: job.domain ?? null,
			area: job.area ?? null,
			codeOrigin: job.codeOrigin ?? null,
			originSid: job.originSid ?? null,
		});
	}

	async knPromote(id: number): Promise<boolean> {
		return this.kn.promote(id);
	}

	async knRetire(id: number, supersededBy: number | null): Promise<boolean> {
		return this.kn.retire(id, supersededBy);
	}

	async knNote(id: number, sid: string, what: string): Promise<number> {
		return this.kn.note(id, sid, what);
	}

	close(): void {
		this.db.close();
	}
}

// ─── HTTP adapter: same port, second transport ───
export interface StoreLocation {
	url: string;
	token?: string;
	via: string;
}

// thin: one POST per op, wire shape = embedded row types (parity)
export class HttpControlPlaneStore implements ControlPlaneStore {
	constructor(private loc: StoreLocation) {}

	private async call<T>(path: string, body?: unknown): Promise<T> {
		const r = await fetch(`${this.loc.url}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.loc.token
					? { authorization: `Bearer ${this.loc.token}` }
					: {}),
			},
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!r.ok) throw new Error(`store-api ${r.status}: ${await r.text()}`);
		return (await r.json()) as T;
	}

	async emitEvent(e: {
		source: string;
		kind: string;
		scope?: string | null;
		payload?: string | null;
		target?: string | null;
	}): Promise<number> {
		return (await this.call<{ id: number }>("/events", e)).id;
	}

	async event(id: number): Promise<BusEvent | null> {
		return (await this.call<{ row: BusEvent | null }>("/events/get", { id }))
			.row;
	}

	async events(q: EventQuery = {}): Promise<BusEvent[]> {
		return (await this.call<{ rows: BusEvent[] }>("/events/query", q)).rows;
	}

	async inboxCount(sid: string): Promise<number> {
		return (await this.call<{ n: number }>("/inbox/count", { sid })).n;
	}

	async collectInbox(sid: string): Promise<BusEvent[]> {
		return (await this.call<{ rows: BusEvent[] }>("/inbox", { sid })).rows;
	}

	async fact(key: string): Promise<string | null> {
		return (await this.call<{ value: string | null }>("/facts/get", { key }))
			.value;
	}

	async factSet(key: string, value: string, source: string): Promise<void> {
		await this.call("/facts/set", { key, value, source });
	}

	async factDelete(key: string): Promise<void> {
		await this.call("/facts/delete", { key });
	}

	async factList(prefix: string, sinceTs = 0): Promise<FactRow[]> {
		return (
			await this.call<{ rows: FactRow[] }>("/facts/list", { prefix, sinceTs })
		).rows;
	}

	async claimsBySid(sid: string): Promise<ClaimRow[]> {
		return (await this.call<{ rows: ClaimRow[] }>("/claims/by-sid", { sid }))
			.rows;
	}

	async sessionUpsert(s: SessionUpsert): Promise<void> {
		await this.call("/sessions/upsert", s);
	}

	async sessionClose(sid: string): Promise<void> {
		await this.call("/sessions/close", { sid });
	}

	async sweepSessions(): Promise<number> {
		return (await this.call<{ n: number }>("/sessions/sweep")).n;
	}

	async workOwned(project: string, sid: string): Promise<WorkRow[]> {
		return (
			await this.call<{ rows: WorkRow[] }>("/work/owned", { project, sid })
		).rows;
	}

	async workClosedOwners(project: string): Promise<string[]> {
		return (
			await this.call<{ rows: string[] }>("/work/closed-owners", { project })
		).rows;
	}

	async workReadyCount(project: string): Promise<number> {
		return (await this.call<{ n: number }>("/work/ready", { project })).n;
	}

	async workShape(): Promise<{ state: string; n: number }[]> {
		const r = await this.call<{ rows: { state: string; n: number }[] }>(
			"/work/shape",
		);
		return r.rows;
	}

	async knSearch(q: {
		query: string;
		limit?: number;
		domain?: string | null;
		area?: string | null;
	}): Promise<unknown[]> {
		return (await this.call<{ hits: unknown[] }>("/kn/search", q)).hits;
	}

	async knEnqueue(job: {
		source: string;
		payload: string;
		domain?: string | null;
		area?: string | null;
		codeOrigin?: string | null;
		originSid?: string | null;
	}): Promise<number> {
		return (await this.call<{ queued: number }>("/kn/enqueue", job)).queued;
	}

	async knPromote(id: number): Promise<boolean> {
		return (await this.call<{ promoted: boolean }>("/kn/promote", { id }))
			.promoted;
	}

	async knRetire(id: number, supersededBy: number | null): Promise<boolean> {
		const r = await this.call<{ retired: boolean }>("/kn/retire", {
			id,
			supersededBy,
		});
		return r.retired;
	}

	async knNote(id: number, sid: string, what: string): Promise<number> {
		const r = await this.call<{ contributors: number }>("/kn/note", {
			id,
			sid,
			what,
		});
		return r.contributors;
	}

	close(): void {} // stateless — nothing to release
}

// ─── resolution: the W91 #9a chain for the store API ───
// env → operator config → .local name → same-box dev default → null.
// "A server that answers AT ALL counts as present" (the belt-locate rule) —
// we are locating a host, not a route.
function storeTokenFromFile(): string | undefined {
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
}

// a server that answers AT ALL counts as present (even a 404) — locating a
// host, not a route (the belt-locate alive() pattern). Short timeout: this
// chain runs on EVERY hook invocation — a down server must cost ~ms (a
// loopback connect-refused is instant; a dead .local name must not stall).
async function alive(base: string): Promise<boolean> {
	try {
		await fetch(`${base.replace(/\/$/, "")}/health`, {
			signal: AbortSignal.timeout(600),
		});
		return true;
	} catch {}
	return false;
}

export async function resolveStore(): Promise<StoreLocation | null> {
	// 1. explicit env override
	const envUrl = process.env.SUSPENDERS_STORE_URL;
	if (envUrl)
		return {
			url: envUrl.replace(/\/$/, ""),
			token: process.env.SUSPENDERS_STORE_TOKEN ?? storeTokenFromFile(),
			via: "env",
		};
	// 2. operator-pinned config (mode 600, secrets never in a repo)
	try {
		const cfg = JSON.parse(
			readFileSync(`${process.env.HOME}/.claude/local-llm/store.json`, "utf8"),
		) as { url?: string; token?: string };
		if (cfg.url)
			return {
				url: cfg.url.replace(/\/$/, ""),
				token: cfg.token ?? storeTokenFromFile(),
				via: "config store.json",
			};
	} catch {}
	const token = storeTokenFromFile();
	// 3. same-box dev default FIRST: a down loopback server costs ~1ms (RST),
	//    while a dead .local name can stall mDNS — hooks call this chain on
	//    every invocation, so the fast probe goes first. .local (klh-local/
	//    Caddy registry, mDNS browse) follows for the LAN case: no local
	//    server, but the fleet's store answers on its .local name.
	const def = "http://127.0.0.1:7796";
	if (await alive(def)) return { url: def, token, via: "localhost default" };
	// .local candidates race in parallel — one 600ms budget total, never a
	// serial mDNS stall (hooks resolve on EVERY invocation)
	const local = await Promise.any(
		["http://store.local:7796", "http://store.local"].map(async (c) =>
			(await alive(c)) ? c : Promise.reject(new Error("down")),
		),
	).catch(() => null);
	if (local) return { url: local, token, via: "dns store.local" };
	return null; // no store server — callers get the embedded adapter
}

// ─── config seam: plain switch at consumer startup, no plugin framework ───
// resolveStore() finds a server → HTTP adapter; none → embedded SQLite.
// Both answer identically; the consumer cannot tell, and never imports
// govdb. SUSPENDERS_STORE_EMBEDDED=1 forces the embedded adapter (tests,
// gate-hot-path callers that refuse a network hop).
export async function makeStore(): Promise<ControlPlaneStore> {
	if (process.env.SUSPENDERS_STORE_EMBEDDED === "1")
		return new SqliteControlPlaneStore(openGovernorDb());
	const loc = await resolveStore();
	if (loc) return new HttpControlPlaneStore(loc);
	return new SqliteControlPlaneStore(openGovernorDb());
}
