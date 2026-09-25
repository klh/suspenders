// fleet-board.ts — live control-plane dashboard. Read-only over governor.db
// except the decision endpoints (/api/decisions /api/answer /api/ack
// /api/advise) and
// the board-owned decisions table below. Serves a page that polls every
// second (WAL allows concurrent readers).
// Start from anywhere:  bun ~/.claude/bin/fleet-board.ts [--port 7799]
// then open http://127.0.0.1:<port> — dropdown lists every known session;
// focusing a session shows its project's TODO / IN-FLIGHT / DONE board,
// its claims, inbox, lane state, and the event tail.
import { openGovernorDb } from "../lib/govdb.ts";
import { HTML } from "./fleet-board-html.ts";

// sibling CLIs resolve relative to this file — the board is relocatable
const CLI = (f: string) => new URL(f, import.meta.url).pathname;

const db = openGovernorDb();
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 7799) || 7799;
const BIND = process.env.SUSPENDERS_BIND ?? "127.0.0.1";

// decision lifecycle (schema v2, board-owned `decisions` table), contract:
// docs/decisions-api.md. NEED% events must not vanish when the recipient acks
// their inbox — cursors track delivery, this table tracks the human decision.
// State machine: OPEN → ANSWERED → ACKNOWLEDGED; OPEN → CANCELLED (asking
// lane supersede/cancel of the linked work, or board dismiss with UI
// confirmation). answer_token rotates on every state change — clients echo
// it in POST /api/answer for idempotency + multi-tab/stale-view protection.
db.run(`CREATE TABLE IF NOT EXISTS decisions (
	event_id INTEGER PRIMARY KEY,
	target TEXT NOT NULL,
	asked_by TEXT,
	project TEXT,
	task_id TEXT,
	question TEXT,
	options TEXT,
	state TEXT NOT NULL DEFAULT 'OPEN',
	delivery TEXT NOT NULL DEFAULT 'DELIVERED',
	answer_note TEXT,
	answer_to TEXT,
	ack_ts INTEGER,
	answer_token TEXT,
	answered_at INTEGER,
	closed_at INTEGER,
	created_at INTEGER NOT NULL
)`);

// guarded ALTERs — board-owned table: add columns if missing, never drop.
// A fresh table already has everything; a v1 table gets the v2 columns.
const decCols = new Set((db.query("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name));
for (const [col, ddl] of Object.entries({
	asked_by: "TEXT",
	project: "TEXT",
	task_id: "TEXT",
	question: "TEXT",
	options: "TEXT",
	delivery: "TEXT",
	ack_ts: "INTEGER",
	answer_token: "TEXT",
})) {
	if (!decCols.has(col)) db.run(`ALTER TABLE decisions ADD COLUMN ${col} ${ddl}`);
}

// "dead" hb = the monitor's zombie threshold (same fact, same default)
const deadAfterMs = (): number =>
	Number((db.query("SELECT value FROM facts WHERE key = 'fleet.zombie_after_ms'").get() as { value: string } | null)?.value ?? 45 * 60_000);

const projOf = (sid: string): string | null =>
	(db.query("SELECT project FROM sessions WHERE sid = ?").get(sid) as { project: string | null } | null)?.project ?? null;

// delivery: DELIVERED once the target lane shows life or its cursor reads
// past the fork; FAILED when the session is unknown/dead and never picked
// the decision up (UI: "delivery failed — retry")
const targetAlive = (sid: string, now: number): boolean => {
	const s = db.query("SELECT hb FROM sessions WHERE sid = ?").get(sid) as { hb: number } | null;
	return !!s && now - s.hb <= deadAfterMs();
};
const pickedUp = (eventId: number, sid: string): boolean =>
	((db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as { event_id: number } | null)?.event_id ?? 0) >= eventId;

// payload.options → JSON array of {label, tradeoff}. Accepts a real array
// (TS emitters) or a JSON-encoded array string (coord emit --options=… makes
// every --field a string); bare strings keep their text, lose nothing.
function normOptions(v: unknown): string {
	if (typeof v === "string" && v.trimStart().startsWith("[")) {
		try {
			v = JSON.parse(v);
		} catch {}
	}
	if (!Array.isArray(v) || !v.length) return "";
	return JSON.stringify(
		v.slice(0, 8).map((o: any) =>
			typeof o === "string" ? { label: o, tradeoff: null } : { label: String(o?.label ?? ""), tradeoff: o?.tradeoff == null ? null : String(o.tradeoff) },
		),
	);
}

// enrichment straight off the (immutable) source event — task_id from
// payload.work ONLY, never guessed from the note text
function enrich(d: { event_id: number; target: string }, e: any): void {
	let p: any = {};
	try {
		p = e?.payload ? JSON.parse(e.payload) : {};
	} catch {}
	db.query("UPDATE decisions SET asked_by = ?, project = ?, task_id = COALESCE(task_id, ?), question = COALESCE(question, ?), options = COALESCE(options, ?) WHERE event_id = ?").run(
		String(e?.source ?? d.target),
		String(p.project ?? projOf(e?.source) ?? projOf(d.target) ?? ""),
		p.work != null ? String(p.work) : null,
		String(p.note ?? p.question ?? ""),
		normOptions(p.options),
		d.event_id,
	);
}

// sync: backfill new NEED% forks, then apply the best-effort transitions —
// delivery degradation, work supersede/cancel → CANCELLED, lane activity
// after an answer → ACKNOWLEDGED. Idempotent + monotonic; safe on every poll.
function syncDecisions(): void {
	const now = Date.now();
	// old DISMISSED rows keep their meaning under the v2 name (board dismiss = CANCELLED)
	db.run("UPDATE decisions SET state = 'CANCELLED' WHERE state = 'DISMISSED'");
	for (const r of db.query("SELECT event_id FROM decisions WHERE answer_token IS NULL").all() as { event_id: number }[])
		db.query("UPDATE decisions SET answer_token = ? WHERE event_id = ?").run(crypto.randomUUID(), r.event_id);
	// backfill: one row per NEED% event with a concrete target (dead-letter
	// alias targets included)
	for (const e of db
		.query("SELECT id, ts, source, target, payload FROM events WHERE kind LIKE 'NEED%' AND target IS NOT NULL AND id NOT IN (SELECT event_id FROM decisions) ORDER BY id")
		.all() as any[]) {
		db.query("INSERT OR IGNORE INTO decisions (event_id, target, state, delivery, created_at, answer_token) VALUES (?, ?, 'OPEN', ?, ?, ?)").run(
			e.id,
			e.target,
			targetAlive(e.target, now) || pickedUp(e.id, e.target) ? "DELIVERED" : "FAILED",
			e.ts,
			crypto.randomUUID(),
		);
		enrich({ event_id: e.id, target: e.target }, e);
	}
	// v1 rows: backfill the enrichment columns from the source event
	for (const d of db
		.query("SELECT event_id, target FROM decisions WHERE asked_by IS NULL OR project IS NULL OR question IS NULL")
		.all() as { event_id: number; target: string }[]) {
		enrich(d, db.query("SELECT source, payload FROM events WHERE id = ?").get(d.event_id));
	}
	// a decision addressed to a lane that died before pickup reads as FAILED
	// instead of silently waiting forever; cursor past the fork = picked up
	for (const d of db.query("SELECT event_id, target FROM decisions WHERE state = 'OPEN' AND delivery != 'FAILED'").all() as any[])
		if (!targetAlive(d.target, now) && !pickedUp(d.event_id, d.target)) db.query("UPDATE decisions SET delivery = 'FAILED' WHERE event_id = ?").run(d.event_id);
	// OPEN → CANCELLED: the asking lane superseded/cancelled the linked work
	for (const d of db
		.query(`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'OPEN' AND d.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e
			WHERE e.kind IN ('work.superseded','work.cancelled','work.supersede','work.cancel') AND json_extract(e.payload, '$.work') = d.task_id)`)
		.all() as { id: number }[])
		db.query("UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'").run(now, crypto.randomUUID(), d.id);
	// ANSWERED → ACKNOWLEDGED (best-effort heuristic, monotonic): the lane the
	// answer was addressed to produced a checkpoint/message after answered_ts —
	// it read the answer and moved on
	for (const d of db
		.query(`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'ANSWERED' AND d.answered_at IS NOT NULL AND d.answer_to IS NOT NULL AND EXISTS (SELECT 1 FROM events e
			WHERE e.source = d.answer_to AND e.ts >= d.answered_at AND e.kind IN ('checkpoint','landed','test_green','interface_changed','NOTE','resume_ready'))`)
		.all() as { id: number }[])
		db.query("UPDATE decisions SET state = 'ACKNOWLEDGED', ack_ts = ?, answer_token = ? WHERE event_id = ? AND state = 'ANSWERED'").run(now, crypto.randomUUID(), d.id);
}

const esc = (s: unknown): string =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// write endpoints are for the human at this board. Two paths:
//  • browser (Origin present): same-origin only — Origin host must equal the
//    Host header (CSRF protection). The nginx front only routes trusted
//    names (default_server 444), so a non-loopback Host here is the proxy.
//  • non-browser (no Origin — curl, hooks): Host must be loopback or the
//    configured bind (DNS-rebind protection).
function writeGuard(req: Request, url: URL): Response | null {
	const host = (req.headers.get("host") ?? "").toLowerCase().replace(/\.$/, "");
	if (req.headers.get("origin")) {
		let ohost = "";
		try {
			ohost = new URL(req.headers.get("origin") as string).host.toLowerCase().replace(/\.$/, "");
		} catch {
			return json({ ok: false, error: "bad origin" }, 403);
		}
		if (!host || ohost !== host) return json({ ok: false, error: "cross-origin request" }, 403);
		return null;
	}
	const hname = host.replace(/:\d+$/, "");
	const okHost =
		["localhost", "127.0.0.1", "::1", "[::1]", "[0:0:0:0:0:0:0:1]"].includes(hname) ||
		hname === BIND.toLowerCase() ||
		hname === `[${BIND.toLowerCase()}]`;
	if (!host || !okHost) return json({ ok: false, error: "untrusted host" }, 403);
	return null;
}

// JSON-body endpoints must declare application/json (a plain form POST from
// another site can't forge it cross-origin) and must parse.
async function readJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; resp: Response }> {
	const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (ct !== "application/json") return { ok: false, resp: json({ ok: false, error: "content-type must be application/json" }, 415) };
	try {
		return { ok: true, body: await req.json() };
	} catch {
		return { ok: false, resp: json({ ok: false, error: "malformed json body" }, 400) };
	}
}

// failure notes ride the work.failed event payload ($.work = item id) — the
// board shows why a lane died, not just that it died
const failNote = (id: string): string | null => {
	try {
		const r = db
			.query("SELECT payload FROM events WHERE kind = 'work.failed' AND json_extract(payload, '$.work') = ? ORDER BY id DESC LIMIT 1")
			.get(id) as { payload: string | null } | null;
		const note = r?.payload ? (JSON.parse(r.payload) as any).note : null;
		return note ? String(note).slice(0, 300) : null;
	} catch {
		return null;
	}
};

function ago(ts: number | null | undefined): number {
	return ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : -1;
}

function label(sid: string, role: string): string {
	const rows = db.query("SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4").all(sid) as { intent: string | null }[];
	const c = rows.find((r) => r.intent && !String(r.intent).startsWith("restored by monitor"));
	if (c?.intent) return String(c.intent).slice(0, 24);
	if (role === "coordinator") return "coordinator";
	return sid.slice(0, 8);
}

function sessions(): unknown[] {
	return db
		.query("SELECT sid, role, state, parent_sid, project, hb FROM sessions ORDER BY state, sid")
		.all()
		.map((s: any) => ({
			sid: s.sid,
			label: label(s.sid, s.role),
			role: s.role,
			state: s.state,
			parent: s.parent_sid,
			project: s.project,
			hbAgo: ago(s.hb),
		}));
}

function board(): Record<string, unknown>[] {
	const projects = db
		.query("SELECT DISTINCT project FROM work_items WHERE state NOT IN ('DONE','SUPERSEDED') OR state = 'DONE'")
		.all() as { project: string }[];
	return projects.map(({ project }) => {
		const items = db
			.query("SELECT id, state, owner_sid, title, priority, result_sha, requires, updated_at FROM work_items WHERE project = ? ORDER BY priority DESC, id")
			.all(project) as any[];
		const doneIds = new Set(items.filter((w) => w.state === "DONE").map((w) => w.id));
		const depRows = db
			.query("SELECT work_id, depends_on FROM work_deps WHERE project = ? AND depends_on NOT IN (SELECT id FROM work_items WHERE project = ? AND state = 'DONE')")
			.all(project, project) as any[];
		const blocked = new Set(depRows.map((r: any) => r.work_id));
		const openDeps: Record<string, string[]> = {};
		for (const r of depRows) (openDeps[r.work_id] ??= []).push(r.depends_on);
		const shape = (w: any) => ({
			id: w.id,
			state: w.state,
			owner: w.owner_sid,
			title: w.title,
			sha: w.result_sha,
			requires: w.requires,
			blocked: blocked.has(w.id),
			deps: openDeps[w.id] ?? null,
			note: w.state === "FAILED" ? failNote(w.id) : null,
			updatedAgo: ago(w.updated_at),
		});
		return {
			project,
			name: project.split("/").pop()?.replace(/\.git$/, "") || project.split("/").slice(-2, -1).pop() || project,
			doneN: doneIds.size,
			total: items.length,
			pct: items.length ? Math.round((doneIds.size / items.length) * 100) : 0,
			todo: items.filter((w) => w.state === "READY" && !blocked.has(w.id)).map(shape),
			gated: items.filter((w) => (w.state === "READY" && blocked.has(w.id)) || w.state === "BLOCKED" || w.state === "PAUSED").map(shape),
			inflight: items.filter((w) => w.state === "CLAIMED" || w.state === "RUNNING").map(shape),
			done: items.filter((w) => w.state === "DONE").slice(-30).reverse().map(shape),
			other: items.filter((w) => w.state === "FAILED" || w.state === "SUPERSEDED" || w.state === "ORPHANED" || w.state === "SHATTERED").map(shape),
		};
	});
}

function claims(): unknown[] {
	return db
		.query("SELECT sid, scope, intent, hot, ts FROM claims ORDER BY sid, scope")
		.all()
		.map((c: any) => ({ sid: c.sid, scope: c.scope, intent: c.intent, hot: !!c.hot, tsAgo: ago(c.ts) }));
}

function events(): unknown[] {
	return db
		.query("SELECT id, ts, source, kind, scope, payload, target FROM events ORDER BY id DESC LIMIT 50")
		.all()
		.map((e: any) => {
			let note = "";
			try {
				note = e.payload ? Object.entries(JSON.parse(e.payload)).map(([k, v]) => k + "=" + String(v).slice(0, 40)).join(" ") : "";
			} catch {
				note = "(malformed)";
			}
			return { id: e.id, tsAgo: ago(e.ts), source: e.source, kind: e.kind, scope: e.scope, target: e.target, note };
		});
}

function laneFacts(sid: string): Record<string, unknown> {
	const rows = db.query("SELECT key, value FROM facts WHERE key = ? OR key = ?").all("lane." + sid + ".state", "lane." + sid + ".capsule") as any[];
	const out: Record<string, unknown> = {};
	for (const r of rows) out[r.key.split(".").pop()!] = r.value;
	return out;
}

function inbox(sid: string): unknown[] {
	const cur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as { event_id: number } | null)?.event_id ?? 0;
	return db
		.query("SELECT id, ts, source, kind, payload FROM events WHERE target = ? AND id > ? ORDER BY id")
		.all(sid, cur)
		.map((e: any) => ({ id: e.id, tsAgo: ago(e.ts), source: e.source, kind: e.kind, note: e.payload }));
}

// records per docs/decisions-api.md — legacy column names (event_id/target/
// answered_at/created_at) surface under their contract names at the API.
// OPEN decisions first, then newest resolved; advice (hooks/bin/advise.ts,
// fact advice.<id> or advice.<id>.error) rides along so the card can show
// the recommendation — the LLM advises, the human decides.
function decisionRecords(): Record<string, unknown>[] {
	const rows = db
		.query(`SELECT d.*, w.title AS task_title FROM decisions d
			LEFT JOIN work_items w ON w.project = d.project AND w.id = d.task_id
			ORDER BY (d.state = 'OPEN') DESC, d.event_id DESC LIMIT 200`)
		.all() as any[];
	return rows.map((d) => {
		let options: { label: string; tradeoff?: string | null }[] = [];
		try {
			options = d.options ? JSON.parse(d.options) : [];
		} catch {}
		let advice: any;
		let adviceError: string | undefined;
		const a = db.query("SELECT value FROM facts WHERE key = ?").get("advice." + d.event_id) as { value: string } | null;
		if (a) {
			try {
				advice = JSON.parse(a.value);
			} catch {}
		} else {
			const err = db.query("SELECT value FROM facts WHERE key = ?").get(`advice.${d.event_id}.error`) as { value: string } | null;
			if (err) adviceError = err.value.slice(0, 200);
		}
		const role = (db.query("SELECT role FROM sessions WHERE sid = ?").get(d.target) as { role: string | null } | null)?.role ?? "worker";
		return {
			id: d.event_id,
			project: d.project || null,
			task_id: d.task_id,
			task_title: d.task_title ?? null,
			asked_by: d.asked_by || d.target,
			asked_by_label: label(d.asked_by || d.target, role),
			target: d.target,
			question: d.question ?? "",
			options,
			state: d.state,
			delivery: d.delivery || "DELIVERED",
			answer_note: d.answer_note,
			answer_to: d.answer_to,
			answer_token: d.answer_token,
			created_ts: d.created_at,
			answered_ts: d.answered_at,
			ack_ts: d.ack_ts,
			age_s: ago(d.created_at),
			advice,
			adviceError,
		};
	});
}

function decisionsPayload(): unknown {
	syncDecisions();
	const recs = decisionRecords();
	const open = recs.filter((r: any) => r.state === "OPEN");
	const byProject: Record<string, number> = {};
	for (const r of open as any[]) if (r.project) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
	return { ts: Date.now(), count: open.length, byProject, decisions: recs };
}

function payload(): unknown {
	syncDecisions();
	const ss = sessions();
	const labels: Record<string, string> = {};
	for (const s of ss as any[]) labels[s.sid] = s.label;
	for (const c of db.query("SELECT DISTINCT sid FROM claims").all() as { sid: string }[]) {
		if (!labels[c.sid]) labels[c.sid] = label(c.sid, "worker");
	}
	const zombies = (db.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'").all() as { key: string; value: string }[]).map((z) => ({
		item: z.key.slice("zombie.".length),
		// old monitor versions wrote a leading article — strip it at the boundary
		label: z.value.replace(/^an? /, ""),
	}));
	return {
		ts: Date.now(),
		sessions: ss,
		labels,
		projects: board(),
		claims: claims(),
		events: events(),
		// decisions live in /api/decisions now — this ts lets the UI mark the
		// decisions feed stale without the payload
		decisionsTs: Date.now(),
		zombies,
	};
}

function payloadFor(sid: string): unknown {
	const base = payload() as any;
	const s = base.sessions.find((x: any) => x.sid === sid);
	return {
		...base,
		focus: sid,
		focusProject: s?.project ?? null,
		inbox: inbox(sid),
		lane: laneFacts(sid),
	};
}



Bun.serve({
	port: PORT,
	hostname: BIND,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/api/data") {
			const sid = url.searchParams.get("session") ?? "";
			return json(sid ? payloadFor(sid) : payload());
		}
		if (url.pathname === "/api/decisions")
			// full decision records + counts — the decisions feed the UI polls
			return json(decisionsPayload());
		if (req.method === "POST" && url.pathname === "/api/answer") {
			// the board's single write: relay a human answer into the event bus.
			// Idempotency per docs/decisions-api.md: the client echoes the
			// answer_token it read — the same note on an already-answered fork
			// replays (200 {replay:true}); a stale token (another tab answered
			// or dismissed since) is 409 {error:"stale"}.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const id = Number(parsed.body?.id ?? parsed.body?.forEvent ?? 0);
			let to = String(parsed.body?.to ?? "");
			const note = String(parsed.body?.note ?? "").trim().slice(0, 2000);
			const token = String(parsed.body?.token ?? "");
			if (!id || !to || !note || !token) return json({ ok: false, error: "missing id, to, note or token" }, 400);
			syncDecisions();
			const row = db.query("SELECT state, answer_note, answer_token, answer_to FROM decisions WHERE event_id = ?").get(id) as any;
			// reject unknown ids instead of silently answering nothing
			if (!row) return json({ ok: false, error: "unknown decision id: " + id }, 404);
			if (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED")
				return row.answer_note === note ? json({ ok: true, replay: true, to: row.answer_to }) : json({ ok: false, error: "stale" }, 409);
			if (row.state !== "OPEN" || row.answer_token !== token) return json({ ok: false, error: "stale" }, 409);
			// accept full sids, unique prefixes, or live bus aliases (an identity
			// that has emitted before — e.g. a coordinator's chosen --as name)
			const exact = db.query("SELECT sid FROM sessions WHERE sid = ?").get(to) as { sid: string } | null;
			if (exact) to = exact.sid;
			else {
				const cands = db.query("SELECT sid FROM sessions WHERE sid LIKE ? || '%'").all(to) as { sid: string }[];
				if (cands.length === 1) to = cands[0]!.sid;
				else {
					const alias = !!db.query("SELECT 1 AS x FROM events WHERE source = ? LIMIT 1").get(to);
					if (!alias) return json({ ok: false, error: cands.length > 1 ? "ambiguous sid: " + to : "unknown target session: " + to }, 400);
				}
			}
			const p = Bun.spawnSync(["bun", CLI("coord.ts"), "emit", "ANSWER", "--to", to, "--note", note, "--as", "fleet-board"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = (p.stdout.toString() + " " + p.stderr.toString()).trim();
			if (p.exitCode !== 0) return json({ ok: false, output: out.slice(0, 400), to }, 500);
			// answered — lifecycle state, correlated to the fork's event id; the
			// WHERE clause guards a concurrent answer (raced → stale, another
			// tab got there first)
			const done = db
				.query("UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN' AND answer_token = ?")
				.run(note, to, Date.now(), crypto.randomUUID(), id, token);
			return Number(done.changes) === 0 ? json({ ok: false, error: "stale" }, 409) : json({ ok: true, output: out.slice(0, 400), to });
		}
		if (req.method === "POST" && url.pathname === "/api/ack") {
			// board dismiss = CANCELLED (the UI confirms before calling).
			// Idempotent; monotonic — never un-answers a decision.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const id = Number(parsed.body?.id ?? 0);
			if (!id) return json({ ok: false, error: "missing event id" }, 400);
			const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
			if (!ev) return json({ ok: false, error: "unknown event id: " + id }, 404);
			if (!ev.kind.startsWith("NEED")) return json({ ok: false, error: "not a decision event: " + id }, 400);
			syncDecisions();
			const row = db.query("SELECT state FROM decisions WHERE event_id = ?").get(id) as { state: string } | null;
			if (row && (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED")) return json({ ok: false, error: "already answered" }, 409);
			db.query("UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'").run(Date.now(), crypto.randomUUID(), id);
			return json({ ok: true });
		}
		if (req.method === "POST" && url.pathname === "/api/advise") {
			// fire hooks/bin/advise.ts detached — it writes fact advice.<id> when
			// the LLM answers; the 1s poll picks it up. Human decides after.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const id = Number(parsed.body?.id ?? 0);
			if (!id) return json({ ok: false, error: "missing event id" }, 400);
			const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
			if (!ev) return json({ ok: false, error: "unknown event id: " + id }, 404);
			if (!ev.kind.startsWith("NEED")) return json({ ok: false, error: "not a decision event: " + id }, 400);
			const child = Bun.spawn(["bun", CLI("advise.ts"), String(id)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			child.unref();
			return json({ ok: true, started: true });
		}
		if (url.pathname === "/")
			return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		return new Response("not found", { status: 404 });
	},
});
console.log(`fleet board → http://127.0.0.1:${PORT}  (governor.db, 1s poll; writes: /api/answer /api/ack /api/advise)`);

// best-effort Bonjour/mDNS: while the board runs, http://suspenders.local:PORT
// resolves from Bonjour-capable machines on the LAN. The name belongs to the
// dns-sd/avahi child — it vanishes when the board dies (auto-renames to
// suspenders-2.local on conflict). Skip silently when neither tool exists.
// SUSPENDERS_MDNS=0 opts out — on macOS the dns-sd registration claims the
// service host name and poisons .local resolution for the very name it advertises
if (process.env.SUSPENDERS_MDNS !== "0") {
	const mdnsCmd = process.platform === "darwin" ? ["dns-sd", "-R", "suspenders", "_http._tcp", ".", String(PORT)] : ["avahi-publish", "-s", "suspenders", "_http._tcp", String(PORT)];
try {
	const mdns = Bun.spawn(mdnsCmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const killMdns = () => {
		try {
			mdns.kill();
		} catch {}
	};
	process.on("exit", killMdns);
	// Bun's exit handlers don't fire on bare SIGTERM/SIGINT — without these,
	// orphaned dns-sd children accumulate and fight over the service name
	process.on("SIGTERM", () => {
		killMdns();
		process.exit(0);
	});
	process.on("SIGINT", () => {
		killMdns();
		process.exit(0);
	});
	console.log(`mDNS service "suspenders" registered (Bonjour discovery) — local URL http://127.0.0.1:${PORT}`);
	} catch {
		// no mDNS tooling — loopback URL still works
	}
}
