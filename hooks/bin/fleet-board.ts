// fleet-board.ts — live control-plane dashboard. Read-only over governor.db
// except the decision endpoints (/api/decisions /api/answer /api/ack
// /api/advise) and
// the board-owned decisions table below. Serves a page that polls every
// second (WAL allows concurrent readers).
// Start from anywhere:  bun ~/.claude/bin/fleet-board.ts [--port 7799]
// then open http://127.0.0.1:<port> — dropdown lists every known session;
// focusing a session shows its project's TODO / IN-FLIGHT / DONE board,
// its claims, inbox, lane state, and the event tail.

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDecisionKind, openGovernorDb } from "../lib/govdb.ts";
import { HTML } from "./fleet-board-html.ts";

// sibling CLIs resolve relative to this file — the board is relocatable
const CLI = (f: string) => new URL(f, import.meta.url).pathname;

const db = openGovernorDb();
const PORT =
	Number(process.argv[process.argv.indexOf("--port") + 1] ?? 7799) || 7799;
const BIND = process.env.SUSPENDERS_BIND ?? "127.0.0.1";
const DEMO = process.argv.includes("--demo");
const REG_DIR = `${process.env.HOME}/.cache/claude-governor`;
// the setup LLM probe hits the endpoint ORIGIN (advise.ts spells the env var
// as a full chat-completions URL; the origin serves GET /v1/models for both)
const LLM_ORIGIN = (() => {
	try {
		return new URL(process.env.SUSPENDERS_LLM_URL ?? "http://127.0.0.1:8901")
			.origin;
	} catch {
		return "http://127.0.0.1:8901";
	}
})();
// this install's wiring scripts — the setup checks look for THEM in
// ~/.claude/settings.json, not just any suspenders install
const gatePath = new URL("../gate.ts", import.meta.url).pathname;
const sessionStartPath = new URL("../session-start.ts", import.meta.url)
	.pathname;

// GET /llms.txt — plain-text orientation for LLM agents (the llms.txt
// convention): what the control plane is and which endpoints this board
// serves. Static; kept factual with the routes below.
const LLMS_TXT = `# suspenders

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
- GET /api/diff       per-item branch diff for the drawer: repo + branch suspenders/<id> (worktree.ts naming), base = merge-base with main (fallback master); JSON {ok,id,branch,base,stat,diff}, patch tail-capped at 200KB
- GET /llms.txt       this file

## Write endpoints (human at the board; origin/host guarded)

- POST /api/answer    answer a decision fork (answer_token idempotency; stale token = 409)
- POST /api/ack       dismiss an open fork (state to CANCELLED, idempotent)
- POST /api/advise    fire the advice worker for a fork (async; lands as fact advice.<id>)
- POST /api/comment   route a review line-comment to a work item's owning lane (coord NOTE; id, file, line, note required — note capped at 2000)
- POST /api/start     start a lane on a READY work item (fleet-loop dispatch; project, id required — 409 when claimed, not READY, demo, or claude missing)
- POST /api/ship      one-click ship for a work item's suspenders/<id> branch: live-lane + owner-liveness guards, then the repo's .fleet/ship.json ladder runs detached via fleet-loop ship (409 without a configured ladder, on demo, or while a lane lives)

## Advice LLM

SUSPENDERS_LLM_URL points at an OpenAI-compatible chat endpoint used by the
advice worker (default http://127.0.0.1:8901 — belt's code specialist). If
the endpoint is unreachable, advice is marked unavailable and the fork stays
open for the human; nothing else on the board depends on it.

## Companion repos

- suspenders (this repo): https://github.com/klh/suspenders
- belt (the LLM fleet behind the advice endpoint): https://github.com/klh/belt
- klh-local (serves suspenders.local over the LAN): https://github.com/klh/local

a Threads thing — http://www.threads.dk`;

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
const decCols = new Set(
	(db.query("PRAGMA table_info(decisions)").all() as { name: string }[]).map(
		(c) => c.name,
	),
);
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
	if (!decCols.has(col))
		db.run(`ALTER TABLE decisions ADD COLUMN ${col} ${ddl}`);
}

// "dead" hb = the monitor's zombie threshold (same fact, same default)
const deadAfterMs = (): number =>
	Number(
		(
			db
				.query("SELECT value FROM facts WHERE key = 'fleet.zombie_after_ms'")
				.get() as { value: string } | null
		)?.value ?? 45 * 60_000,
	);

const projOf = (sid: string): string | null =>
	(
		db.query("SELECT project FROM sessions WHERE sid = ?").get(sid) as {
			project: string | null;
		} | null
	)?.project ?? null;

// delivery: DELIVERED once the target lane shows life or its cursor reads
// past the fork; FAILED when the session is unknown/dead and never picked
// the decision up (UI: "delivery failed — retry"). Coordinator role is alive
// unconditionally: coordinators sleep between waves (monitor exempts them
// from sweeps) — hb staleness there is not death (2026-09-25: the gaps
// coordinator idled ~8h waiting on work and the board declared its decision
// undeliverable).
const targetAlive = (sid: string, now: number): boolean => {
	const s = db
		.query("SELECT hb, role FROM sessions WHERE sid = ?")
		.get(sid) as { hb: number; role: string | null } | null;
	if (!s) return false;
	if (s.role === "coordinator") return true;
	// the published coordinator identity is authoritative (coord fact set
	// coordinator.sid) — a misrecorded role must not unpublish its liveness
	if (
		sid ===
		(
			db
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as { value: string } | null
		)?.value
	)
		return true;
	return now - s.hb <= deadAfterMs();
};
const pickedUp = (eventId: number, sid: string): boolean =>
	((
		db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
			event_id: number;
		} | null
	)?.event_id ?? 0) >= eventId;

// payload.options → JSON array of {label, tradeoff}. Accepts a real array
// (TS emitters) or a JSON-encoded array string (coord emit --options=… makes
// every --field a string); bare strings keep their text, lose nothing.
function normOptions(v: unknown): string {
	if (typeof v === "string" && v.trimStart().startsWith("[")) {
		try {
			v = JSON.parse(v);
		} catch {}
	}
	if (typeof v === "string") {
		// CLI ergonomics: --options="a | b" — a bare string splits into labels
		const labels = v.split(/\s*\|\s*/).filter(Boolean);
		if (labels.length > 1) v = labels;
	}
	if (!Array.isArray(v) || !v.length) return "";
	return JSON.stringify(
		v.slice(0, 8).map((o: any) =>
			typeof o === "string"
				? { label: o, tradeoff: null }
				: {
						label: String(o?.label ?? ""),
						tradeoff: o?.tradeoff == null ? null : String(o.tradeoff),
					},
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
	db.query(
		"UPDATE decisions SET asked_by = ?, project = ?, task_id = COALESCE(task_id, ?), question = COALESCE(question, ?), options = COALESCE(options, ?) WHERE event_id = ?",
	).run(
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
	for (const r of db
		.query("SELECT event_id FROM decisions WHERE answer_token IS NULL")
		.all() as { event_id: number }[])
		db.query("UPDATE decisions SET answer_token = ? WHERE event_id = ?").run(
			crypto.randomUUID(),
			r.event_id,
		);
	// backfill: one row per NEED% event with a concrete target (dead-letter
	// alias targets included). LIKE is case-insensitive for ASCII — this is
	// the accept set isDecisionKind() (hooks/lib/govdb.ts) mirrors exactly;
	// change them together.
	for (const e of db
		.query(
			"SELECT id, ts, source, target, payload FROM events WHERE kind LIKE 'NEED%' AND target IS NOT NULL AND id NOT IN (SELECT event_id FROM decisions) ORDER BY id",
		)
		.all() as any[]) {
		db.query(
			"INSERT OR IGNORE INTO decisions (event_id, target, state, delivery, created_at, answer_token) VALUES (?, ?, 'OPEN', ?, ?, ?)",
		).run(
			e.id,
			e.target,
			targetAlive(e.target, now) || pickedUp(e.id, e.target)
				? "DELIVERED"
				: "FAILED",
			e.ts,
			crypto.randomUUID(),
		);
		enrich({ event_id: e.id, target: e.target }, e);
	}
	// v1 rows: backfill the enrichment columns from the source event
	for (const d of db
		.query(
			"SELECT event_id, target FROM decisions WHERE asked_by IS NULL OR project IS NULL OR question IS NULL",
		)
		.all() as { event_id: number; target: string }[]) {
		enrich(
			d,
			db
				.query("SELECT source, payload FROM events WHERE id = ?")
				.get(d.event_id),
		);
	}
	// a decision addressed to a lane that died before pickup reads as FAILED
	// instead of silently waiting forever; cursor past the fork = picked up.
	// Truth-sync, not one-way degradation: a wrongly-FAILED row (target alive
	// all along — see targetAlive) repairs itself when the target shows life.
	for (const d of db
		.query("SELECT event_id, target FROM decisions WHERE state = 'OPEN'")
		.all() as any[])
		db.query("UPDATE decisions SET delivery = ? WHERE event_id = ?").run(
			targetAlive(d.target, now) || pickedUp(d.event_id, d.target)
				? "DELIVERED"
				: "FAILED",
			d.event_id,
		);
	// OPEN → CANCELLED: the asking lane superseded/cancelled the linked work
	for (const d of db
		.query(
			`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'OPEN' AND d.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e
			WHERE e.kind IN ('work.superseded','work.cancelled','work.supersede','work.cancel') AND json_extract(e.payload, '$.work') = d.task_id)`,
		)
		.all() as { id: number }[])
		db.query(
			"UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(now, crypto.randomUUID(), d.id);
	// ANSWERED → ACKNOWLEDGED (best-effort heuristic, monotonic): the lane the
	// answer was addressed to produced a checkpoint/message after answered_ts —
	// it read the answer and moved on
	for (const d of db
		.query(
			`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'ANSWERED' AND d.answered_at IS NOT NULL AND d.answer_to IS NOT NULL AND EXISTS (SELECT 1 FROM events e
			WHERE e.source = d.answer_to AND e.ts >= d.answered_at AND e.kind IN ('checkpoint','landed','test_green','interface_changed','NOTE','resume_ready'))`,
		)
		.all() as { id: number }[])
		db.query(
			"UPDATE decisions SET state = 'ACKNOWLEDGED', ack_ts = ?, answer_token = ? WHERE event_id = ? AND state = 'ANSWERED'",
		).run(now, crypto.randomUUID(), d.id);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// write endpoints are for the human at this board. Two paths:
//  • browser (Origin present): same-origin only — Origin host must equal the
//    Host header (CSRF protection). The nginx front only routes trusted
//    names (default_server 444), so a non-loopback Host here is the proxy.
//  • non-browser (no Origin — curl, hooks): Host must be loopback or the
//    configured bind (DNS-rebind protection).
function writeGuard(req: Request, _url: URL): Response | null {
	const host = (req.headers.get("host") ?? "").toLowerCase().replace(/\.$/, "");
	if (req.headers.get("origin")) {
		let ohost = "";
		try {
			ohost = new URL(req.headers.get("origin") as string).host
				.toLowerCase()
				.replace(/\.$/, "");
		} catch {
			return json({ ok: false, error: "bad origin" }, 403);
		}
		if (!host || ohost !== host)
			return json({ ok: false, error: "cross-origin request" }, 403);
		return null;
	}
	const hname = host.replace(/:\d+$/, "");
	const okHost =
		["localhost", "127.0.0.1", "::1", "[::1]", "[0:0:0:0:0:0:0:1]"].includes(
			hname,
		) ||
		hname === BIND.toLowerCase() ||
		hname === `[${BIND.toLowerCase()}]`;
	if (!host || !okHost)
		return json({ ok: false, error: "untrusted host" }, 403);
	return null;
}

// JSON-body endpoints must declare application/json (a plain form POST from
// another site can't forge it cross-origin) and must parse.
async function readJson(
	req: Request,
): Promise<{ ok: true; body: any } | { ok: false; resp: Response }> {
	const ct = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (ct !== "application/json")
		return {
			ok: false,
			resp: json(
				{ ok: false, error: "content-type must be application/json" },
				415,
			),
		};
	try {
		return { ok: true, body: await req.json() };
	} catch {
		return {
			ok: false,
			resp: json({ ok: false, error: "malformed json body" }, 400),
		};
	}
}

// failure notes ride the work.failed event payload ($.work = item id) — the
// board shows why a lane died, not just that it died
// W64 ship-trigger helpers — merging a lane branch is safe only when no live
// lane still owns it. Two registries: .fleet/lanes.json (dispatched lanes,
// pid-guard) and the sessions table (interactive lanes — hb updates only at
// bootstrap, so the transcript mtime is the liveness signal, per the zombie
// lesson); the ladder comes from <repo>/.fleet/ship.json (owner config).
const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const lanesOf = (repo: string): { pid: number; branch: string }[] => {
	try {
		return JSON.parse(readFileSync(`${repo}/.fleet/lanes.json`, "utf8")) as {
			pid: number;
			branch: string;
		}[];
	} catch {
		return [];
	}
};

// <repo>/.fleet/ship.json — the one-click ship trigger's owner config, same
// trust class as the loop's --ladder argv. Required: ship must never do a
// plain merge behind the repo's quality policy's back.
const readShipJson = (repo: string): { ladder?: string } => {
	try {
		return JSON.parse(readFileSync(`${repo}/.fleet/ship.json`, "utf8")) as {
			ladder?: string;
		};
	} catch {
		return {};
	}
};

// a transcript written within the last 15 minutes = live process
const transcriptWarm = (sid: string): boolean => {
	const floor = Date.now() - 15 * 60_000;
	const p = (
		db.query("SELECT transcript_path FROM sessions WHERE sid = ?").get(sid) as {
			transcript_path: string | null;
		} | null
	)?.transcript_path;
	if (p) {
		try {
			return statSync(p).mtimeMs > floor;
		} catch {}
	}
	try {
		const glob = new Bun.Glob(`**/*${sid}*.jsonl`);
		for (const rel of glob.scanSync({
			cwd: `${process.env.HOME}/.claude/projects`,
			onlyFiles: true,
		})) {
			try {
				if (
					statSync(`${process.env.HOME}/.claude/projects/${rel}`).mtimeMs >
					floor
				)
					return true;
			} catch {}
		}
	} catch {}
	return false;
};

// live = RUNNING row + (fresh hb or warm transcript); coordinators are exempt
// (they sleep between waves — same doctrine as targetAlive)
const sessionAlive = (sid: string): boolean => {
	const s = db
		.query("SELECT state, role, hb FROM sessions WHERE sid = ?")
		.get(sid) as { state: string; role: string | null; hb: number } | null;
	if (s?.state !== "RUNNING") return false;
	if (s.role === "coordinator") return true;
	if (
		sid ===
		(
			db
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as { value: string } | null
		)?.value
	)
		return true;
	if (Date.now() - s.hb <= deadAfterMs()) return true;
	return transcriptWarm(sid);
};

const failNote = (id: string): string | null => {
	try {
		const r = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.failed' AND json_extract(payload, '$.work') = ? ORDER BY id DESC LIMIT 1",
			)
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
	const rows = db
		.query(
			"SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4",
		)
		.all(sid) as { intent: string | null }[];
	const c = rows.find(
		(r) => r.intent && !String(r.intent).startsWith("restored by monitor"),
	);
	if (c?.intent) return String(c.intent).slice(0, 24);
	if (role === "coordinator") return "coordinator";
	return sid.slice(0, 8);
}

// every project the control plane knows — the UI's global filter options
function projectList(): string[] {
	return (
		db
			.query(
				"SELECT project AS p FROM work_items UNION SELECT project AS p FROM sessions WHERE project IS NOT NULL ORDER BY p",
			)
			.all() as { p: string }[]
	).map((r) => r.p);
}

// owner_label (docs/board-api.md): the owner's newest claim intent, else the
// session name, else null — the UI never renders a raw sid when a label exists
function ownerLabel(sid: string | null | undefined): string | null {
	if (!sid) return null;
	const rows = db
		.query(
			"SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4",
		)
		.all(sid) as { intent: string | null }[];
	const c = rows.find(
		(r) => r.intent && !String(r.intent).startsWith("restored by monitor"),
	);
	if (c?.intent) return String(c.intent).slice(0, 24);
	return db.query("SELECT 1 AS x FROM sessions WHERE sid = ?").get(sid)
		? sid
		: null;
}

const payloadOf = (raw: string | null): any => {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
};

const TAIL_BYTES = 32 * 1024;
const TAIL_MAX = 110;
function transcriptTail(
	sid: string | null | undefined,
): { text: string; ts: string | null } | null {
	if (!sid) return null;
	const row = db
		.query("SELECT transcript_path FROM sessions WHERE sid = ?")
		.get(sid) as { transcript_path: string | null } | null;
	const path = row?.transcript_path;
	if (!path || !existsSync(path) || !statSync(path).size) return null;
	const size = statSync(path).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const len = size - start;
	const buf = Buffer.alloc(len);
	try {
		const fd = openSync(path, "r");
		readSync(fd, buf, 0, len, start);
		closeSync(fd);
	} catch {
		return null;
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift(); // first line may be a partial record
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let j: any;
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = j?.message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let k = msg.content.length - 1; k >= 0; k--) {
			const b = msg.content[k];
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim())
				return {
					text: b.text.trim().replace(/\s+/g, " ").slice(0, TAIL_MAX),
					ts: j.timestamp ?? null,
				};
			if (b?.type === "tool_use" && b.name)
				return {
					text: `→ ${b.name}: ${String(
						b.input?.command ??
							b.input?.file_path ??
							b.input?.pattern ??
							b.input?.description ??
							"",
					)
						.replace(/\s+/g, " ")
						.slice(0, TAIL_MAX - 3)}`,
					ts: j.timestamp ?? null,
				};
		}
	}
	return null;
}

// done→ready auto-start (W50): newest work.ready event per item, keyed by
// project + work id — value is the unblocker's id (who completed the blocking
// item). A stale event never sticks: taskShape only flags items still READY.
function unblockedBy(): Map<string, string | null> {
	const m = new Map<string, string | null>();
	for (const r of db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.ready' ORDER BY id DESC LIMIT 500",
		)
		.all() as any[]) {
		const pl = payloadOf(r.payload);
		if (!pl?.work) continue;
		const key = `${String(pl.project ?? "")}\u0000${String(pl.work)}`;
		if (!m.has(key))
			m.set(key, pl.unblocked_by != null ? String(pl.unblocked_by) : null);
	}
	return m;
}

function taskShape(
	w: any,
	openDecisions: number,
	unblocked: Map<string, string | null> = new Map(),
): Record<string, unknown> {
	return {
		project: w.project,
		id: w.id,
		title: w.title,
		state: w.state,
		owner_sid: w.owner_sid ?? null,
		owner_label: ownerLabel(w.owner_sid),
		requires: w.requires ?? null,
		scope: w.scope ?? null,
		parent_id: w.parent_id ?? null,
		age_s: ago(w.updated_at),
		open_decisions: openDecisions,
		tail: transcriptTail(w.owner_sid),
		unblocked_by:
			w.state === "READY"
				? (unblocked.get(`${String(w.project)}\u0000${String(w.id)}`) ?? null)
				: null,
	};
}

// the tasks feed: everything not SUPERSEDED (or DONE still holding an owner —
// a stale claim, not a result), newest activity first, open forks counted
function tasks(p: string | null): unknown[] {
	const where =
		"state != 'SUPERSEDED' AND NOT (state = 'DONE' AND owner_sid IS NOT NULL)";
	const rows = (
		p && p !== "all"
			? db
					.query(
						`SELECT * FROM work_items WHERE project = ? AND ${where} ORDER BY updated_at DESC`,
					)
					.all(p)
			: db
					.query(
						`SELECT * FROM work_items WHERE ${where} ORDER BY updated_at DESC`,
					)
					.all()
	) as any[];
	const openByTask = new Map<string, number>();
	for (const r of db
		.query(
			"SELECT project, task_id, COUNT(*) AS n FROM decisions WHERE state = 'OPEN' AND task_id IS NOT NULL GROUP BY project, task_id",
		)
		.all() as {
		project: string;
		task_id: string;
		n: number;
	}[])
		openByTask.set(`${r.project}\u0000${r.task_id}`, r.n);
	const unblocked = unblockedBy();
	return rows.map((w) =>
		taskShape(w, openByTask.get(`${w.project}\u0000${w.id}`) ?? 0, unblocked),
	);
}

// the drawer's event feed: last 50 events tied to the item — payload.work
// match (project-stamped) or scope match, newest first
function workEvents(p: string, id: string): unknown[] {
	return db
		.query(
			`SELECT id, ts, source, kind, payload FROM events
			WHERE (json_extract(payload, '$.work') = ? AND json_extract(payload, '$.project') = ?)
				OR (scope = ? AND (json_extract(payload, '$.project') = ? OR json_extract(payload, '$.project') IS NULL))
			ORDER BY id DESC LIMIT 50`,
		)
		.all(id, p, id, p)
		.map((e: any) => {
			const pl = payloadOf(e.payload);
			return {
				id: e.id,
				ts: e.ts,
				kind: e.kind,
				source: e.source,
				note: pl.note != null ? String(pl.note) : null,
				sha: pl.sha != null ? String(pl.sha) : null,
			};
		});
}

// decisions linked to the item, any state — the drawer shows the full story
function taskDecisions(p: string, id: string): unknown[] {
	return (
		db
			.query(
				"SELECT event_id, state, question, answer_note FROM decisions WHERE project = ? AND task_id = ? ORDER BY event_id DESC",
			)
			.all(p, id) as any[]
	).map((d) => ({
		event_id: d.event_id,
		state: d.state,
		question: d.question ?? "",
		answer_note: d.answer_note ?? null,
	}));
}

// newest-first bus feed. note/sha ride the payload; project too (CLI emitters
// stamp it — the source session's project covers anything older)
function activity(p: string | null, limit: number): unknown[] {
	const evs = (
		p && p !== "all"
			? db
					.query(
						`SELECT id, ts, source, kind, payload, target FROM events
					WHERE json_extract(payload, '$.project') = ?
						OR (json_extract(payload, '$.project') IS NULL AND source IN (SELECT sid FROM sessions WHERE project = ?))
					ORDER BY id DESC LIMIT ?`,
					)
					.all(p, p, limit)
			: db
					.query(
						"SELECT id, ts, source, kind, payload, target FROM events ORDER BY id DESC LIMIT ?",
					)
					.all(limit)
	) as any[];
	return evs.map((e) => {
		const pl = payloadOf(e.payload);
		return {
			id: e.id,
			ts: e.ts,
			kind: e.kind,
			source: e.source,
			target: e.target ?? null,
			note: pl.note != null ? String(pl.note) : null,
			sha: pl.sha != null ? String(pl.sha) : null,
			project: pl.project ?? projOf(e.source) ?? null,
		};
	});
}

// advisory wiring checks — never throw; a failed check is information, not an
// error. settings.json hook commands may spell $HOME literally — expand before
// comparing against this install's script paths.
function settingsCommands(kind: string): string[] {
	try {
		const s = JSON.parse(
			readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8"),
		);
		return (s?.hooks?.[kind] ?? [])
			.flatMap((m: any) =>
				(m?.hooks ?? []).map((h: any) => String(h?.command ?? "")),
			)
			.map((c) => c.replaceAll("$HOME", process.env.HOME ?? "~"));
	} catch {
		return [];
	}
}

async function llmCheck(): Promise<{ ok: boolean; detail: string }> {
	try {
		const r = await fetch(`${LLM_ORIGIN}/v1/models`, {
			signal: AbortSignal.timeout(1500),
		});
		return {
			ok: r.ok,
			detail: r.ok
				? `${LLM_ORIGIN} answers`
				: `HTTP ${r.status} from ${LLM_ORIGIN}`,
		};
	} catch {
		return { ok: false, detail: `no answer from ${LLM_ORIGIN} within 1.5s` };
	}
}

async function setupChecks(): Promise<unknown[]> {
	const launchdPlist = `${process.env.HOME}/Library/LaunchAgents/com.suspenders.fleet-monitor.plist`;
	const llm = await llmCheck();
	// wired = a registered command runs the hook BY NAME — the install layout
	// varies (namespaced suspenders/ vs legacy hooks/), so a literal-path match
	// false-negatived every non-namespaced machine
	const hookOk = settingsCommands("PreToolUse").some((c) =>
		c.includes("gate.ts"),
	);
	const startOk = settingsCommands("SessionStart").some((c) =>
		c.includes("session-start.ts"),
	);
	let monitorOk = existsSync(launchdPlist);
	if (!monitorOk) {
		try {
			monitorOk = readdirSync(`${process.env.HOME}/Library/LaunchAgents`).some(
				(f) => /fleet-monitor/i.test(f),
			);
		} catch {} // no LaunchAgents dir — nothing installed
	}
	return [
		{
			id: "db",
			label: "Control-plane database",
			ok: true,
			detail: `${REG_DIR}/governor.db`,
			fix: null,
		},
		{
			id: "hooks-wired",
			label: "Hook gates wired",
			ok: hookOk,
			detail: hookOk
				? gatePath
				: `PreToolUse hooks in ~/.claude/settings.json do not reference ${gatePath}`,
			fix: hookOk ? null : "./install.sh --wire",
		},
		{
			id: "session-start",
			label: "Session injection wired",
			ok: startOk,
			detail: startOk
				? sessionStartPath
				: `SessionStart hooks in ~/.claude/settings.json do not reference ${sessionStartPath}`,
			fix: startOk ? null : "./install.sh --wire",
		},
		{
			id: "monitor-agent",
			label: "Fleet monitor launchd",
			ok: monitorOk,
			detail: monitorOk
				? "fleet-monitor agent installed"
				: "no *fleet-monitor* plist in ~/Library/LaunchAgents",
			fix: monitorOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "llm",
			label: "Advice LLM endpoint",
			ok: llm.ok,
			detail: llm.detail,
			fix: llm.ok ? null : "local LLM stack docs",
		},
		{ id: "bind", label: "LAN binding", ok: true, detail: BIND, fix: null },
	];
}

function sessions(): unknown[] {
	return db
		.query(
			"SELECT sid, role, state, parent_sid, project, hb FROM sessions ORDER BY state, sid",
		)
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
		.query(
			"SELECT DISTINCT project FROM work_items WHERE state NOT IN ('DONE','SUPERSEDED') OR state = 'DONE'",
		)
		.all() as { project: string }[];
	return projects.map(({ project }) => {
		const items = db
			.query(
				"SELECT id, state, owner_sid, title, priority, result_sha, requires, updated_at FROM work_items WHERE project = ? ORDER BY priority DESC, id",
			)
			.all(project) as any[];
		const doneIds = new Set(
			items.filter((w) => w.state === "DONE").map((w) => w.id),
		);
		const depRows = db
			.query(
				"SELECT work_id, depends_on FROM work_deps WHERE project = ? AND depends_on NOT IN (SELECT id FROM work_items WHERE project = ? AND state = 'DONE')",
			)
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
			name:
				project
					.split("/")
					.pop()
					?.replace(/\.git$/, "") ||
				project.split("/").slice(-2, -1).pop() ||
				project,
			doneN: doneIds.size,
			total: items.length,
			pct: items.length ? Math.round((doneIds.size / items.length) * 100) : 0,
			todo: items
				.filter((w) => w.state === "READY" && !blocked.has(w.id))
				.map(shape),
			gated: items
				.filter(
					(w) =>
						(w.state === "READY" && blocked.has(w.id)) ||
						w.state === "BLOCKED" ||
						w.state === "PAUSED",
				)
				.map(shape),
			inflight: items
				.filter((w) => w.state === "CLAIMED" || w.state === "RUNNING")
				.map(shape),
			done: items
				.filter((w) => w.state === "DONE")
				.slice(-30)
				.reverse()
				.map(shape),
			other: items
				.filter(
					(w) =>
						w.state === "FAILED" ||
						w.state === "SUPERSEDED" ||
						w.state === "ORPHANED" ||
						w.state === "SHATTERED",
				)
				.map(shape),
		};
	});
}

function claims(): unknown[] {
	return db
		.query("SELECT sid, scope, intent, hot, ts FROM claims ORDER BY sid, scope")
		.all()
		.map((c: any) => ({
			sid: c.sid,
			scope: c.scope,
			intent: c.intent,
			hot: !!c.hot,
			tsAgo: ago(c.ts),
		}));
}

function events(): unknown[] {
	return db
		.query(
			"SELECT id, ts, source, kind, scope, payload, target FROM events ORDER BY id DESC LIMIT 50",
		)
		.all()
		.map((e: any) => {
			let note = "";
			try {
				note = e.payload
					? Object.entries(JSON.parse(e.payload))
							.map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
							.join(" ")
					: "";
			} catch {
				note = "(malformed)";
			}
			return {
				id: e.id,
				tsAgo: ago(e.ts),
				source: e.source,
				kind: e.kind,
				scope: e.scope,
				target: e.target,
				note,
			};
		});
}

function laneFacts(sid: string): Record<string, unknown> {
	const rows = db
		.query("SELECT key, value FROM facts WHERE key = ? OR key = ?")
		.all(`lane.${sid}.state`, `lane.${sid}.capsule`) as any[];
	const out: Record<string, unknown> = {};
	for (const r of rows) out[r.key.split(".").pop()!] = r.value;
	return out;
}

function inbox(sid: string): unknown[] {
	const cur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	return db
		.query(
			"SELECT id, ts, source, kind, payload FROM events WHERE target = ? AND id > ? ORDER BY id",
		)
		.all(sid, cur)
		.map((e: any) => ({
			id: e.id,
			tsAgo: ago(e.ts),
			source: e.source,
			kind: e.kind,
			note: e.payload,
		}));
}

// records per docs/decisions-api.md — legacy column names (event_id/target/
// answered_at/created_at) surface under their contract names at the API.
// OPEN decisions first, then newest resolved; advice (hooks/bin/advise.ts,
// fact advice.<id> or advice.<id>.error) rides along so the card can show
// the recommendation — the LLM advises, the human decides.
function decisionRecords(): Record<string, unknown>[] {
	const rows = db
		.query(
			`SELECT d.*, w.title AS task_title FROM decisions d
			LEFT JOIN work_items w ON w.project = d.project AND w.id = d.task_id
			ORDER BY (d.state = 'OPEN') DESC, d.event_id DESC LIMIT 200`,
		)
		.all() as any[];
	return rows.map((d) => {
		let options: { label: string; tradeoff?: string | null }[] = [];
		try {
			options = d.options ? JSON.parse(d.options) : [];
		} catch {}
		let advice: any;
		let adviceError: string | undefined;
		const a = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`advice.${d.event_id}`) as { value: string } | null;
		if (a) {
			try {
				advice = JSON.parse(a.value);
			} catch {}
		} else {
			const err = db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`advice.${d.event_id}.error`) as { value: string } | null;
			if (err) adviceError = err.value.slice(0, 200);
		}
		const role =
			(
				db.query("SELECT role FROM sessions WHERE sid = ?").get(d.target) as {
					role: string | null;
				} | null
			)?.role ?? "worker";
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

function decisionsPayload(history: boolean): unknown {
	syncDecisions();
	const recs = decisionRecords();
	const open = recs.filter((r: any) => r.state === "OPEN");
	// the default feed stays OPEN-only; &history=1 adds the resolved rows
	// (ANSWERED / ACKNOWLEDGED / CANCELLED) for the collapsed history view
	const shown = history ? recs : open;
	const byProject: Record<string, number> = {};
	for (const r of open as any[])
		if (r.project) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
	return { ts: Date.now(), count: open.length, byProject, decisions: shown };
}

// W28 routing telemetry: today's llm.call events are the routing log;
// per-model token sums vs optional llm.budget.<model> facts are the budgets.
function llm(): unknown {
	const dayStart = new Date();
	dayStart.setHours(0, 0, 0, 0);
	const calls = (
		db
			.query(
				"SELECT id, ts, payload FROM events WHERE kind = 'llm.call' AND ts >= ? ORDER BY id DESC LIMIT 20",
			)
			.all(dayStart.getTime()) as {
			id: number;
			ts: number;
			payload: string;
		}[]
	).map((c) => ({ id: c.id, ts: c.ts, ...JSON.parse(c.payload) }));
	const rows = db
		.query(
			"SELECT json_extract(payload,'$.model') AS model, COUNT(*) AS calls, SUM(json_extract(payload,'$.tt')) AS tokens FROM events WHERE kind = 'llm.call' AND ts >= ? GROUP BY model ORDER BY tokens DESC",
		)
		.all(dayStart.getTime()) as {
		model: string | null;
		calls: number;
		tokens: number | null;
	}[];
	const budgets = new Map(
		(
			db
				.query("SELECT key, value FROM facts WHERE key LIKE 'llm.budget.%'")
				.all() as { key: string; value: string }[]
		).map((r) => [r.key.slice("llm.budget.".length), Number(r.value)]),
	);
	return {
		calls,
		usage: rows.map((r) => ({
			model: r.model ?? "(unknown)",
			calls: r.calls,
			tokens: r.tokens ?? 0,
			budget: budgets.get(r.model ?? "") ?? null,
		})),
	};
}

function payload(): unknown {
	syncDecisions();
	const ss = sessions();
	const labels: Record<string, string> = {};
	for (const s of ss as any[]) labels[s.sid] = s.label;
	for (const c of db.query("SELECT DISTINCT sid FROM claims").all() as {
		sid: string;
	}[]) {
		if (!labels[c.sid]) labels[c.sid] = label(c.sid, "worker");
	}
	const zombies = (
		db
			.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'")
			.all() as { key: string; value: string }[]
	).map((z) => ({
		item: z.key.slice("zombie.".length),
		// old monitor versions wrote a leading article — strip it at the boundary
		label: z.value.replace(/^an? /, ""),
	}));
	// consult diagnostics: where inter-agent latency hides; the kb answers
	// repeat questions without spending an expert round-trip
	const byState = db
		.query("SELECT state, COUNT(*) AS n FROM consults GROUP BY state")
		.all() as { state: string; n: number }[];
	const cs = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
	const kbRow = db
		.query(
			"SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM consult_kb",
		)
		.get() as { n: number; hits: number };
	const consults = {
		open: cs("OPEN"),
		human: cs("ANSWERED"),
		kb: cs("KB"),
		declined: cs("DECLINED"),
		kbSolutions: kbRow.n,
		kbHits: kbRow.hits,
	};
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
		consults,
		llm: llm(),
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

// --demo: seed an idempotent demo partition — project <dbdir>/demo, not a
// real repo — so the board shows a living fleet from a cold start (README
// quickstart, product screenshot). Never writes into real projects; skips
// entirely once the demo partition has work items.
function seedDemo(): void {
	const demo = `${REG_DIR}/demo`;
	const demoSids = ["demo-wait", "demo-work", "demo-pause", "demo-zomb"];
	// demo-seal (2026-09-27, owner): after the demo partition was wiped from
	// the real home, a stray --demo re-seeded it and its Bonjour registration
	// stole the suspenders.local name — the owner watched their real board
	// turn into the demo. Guard: once a home has EVER seeded demo (marker
	// file), seeding an EMPTY partition again requires SUSPENDERS_DEMO=1.
	// Existing partitions keep their idempotent heartbeat refresh.
	const hasDemo = !!db
		.query("SELECT 1 AS x FROM work_items WHERE project = ?")
		.get(demo);
	if (
		!hasDemo &&
		existsSync(`${REG_DIR}/.demo-sealed`) &&
		process.env.SUSPENDERS_DEMO !== "1"
	) {
		console.error(
			`fleet board: --demo refused — this home sealed demo seeding after a wipe (delete ${REG_DIR}/.demo-sealed or set SUSPENDERS_DEMO=1 to override)`,
		);
		process.exit(3);
	}
	if (hasDemo) {
		// re-runs keep the seeded fleet's heartbeats fresh without re-seeding
		db.query(
			`UPDATE sessions SET hb = ? WHERE sid IN (${demoSids.map(() => "?").join(",")})`,
		).run(Date.now(), ...demoSids);
		writeFileSync(`${REG_DIR}/.demo-sealed`, "");
		return;
	}
	const now = Date.now();
	const min = 60_000;
	// captured for the post-commit answer pass (declared out here — the try
	// block dies at COMMIT)
	let answeredForkA = 0;
	let answeredForkB = 0;
	db.run("BEGIN IMMEDIATE");
	try {
		for (const [sid, state, hbMin] of [
			["demo-wait", "RUNNING", 1],
			["demo-work", "RUNNING", 1],
			["demo-pause", "PAUSED", 12],
		] as const)
			db.query(
				"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'worker', ?, ?, ?)",
			).run(sid, demo, now - 6 * 60 * min, now - hbMin * min, state);
		db.query(
			"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES ('demo-zomb', ?, 'worker', ?, ?, 'RUNNING')",
		).run(demo, now - 8 * 60 * min, now - 180 * min);
		// claim intents — owner_label renders these instead of raw sids
		for (const [sid, intent] of [
			["demo-wait", "review lane"],
			["demo-work", "backend lane"],
			["demo-pause", "docs lane"],
		] as const)
			db.query(
				"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts) VALUES (?, ?, ?, 0, ?)",
			).run(sid, demo, intent, now);
		db.query(
			"INSERT OR REPLACE INTO work_sequences (project, next_id) VALUES (?, 5)",
		).run(demo);
		for (const [id, title, state, owner, ageMin] of [
			["W1", "demo: triage the advice queue", "READY", null, 240],
			["W2", "demo: export board data as CSV", "CLAIMED", "demo-work", 90],
			["W3", "demo: migrate the settings schema", "BLOCKED", null, 45],
			["W4", "demo: retire the legacy feed", "DONE", null, 150],
		] as const)
			db.query(
				"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'demo', ?, ?)",
			).run(
				demo,
				id,
				title,
				state,
				owner,
				now - ageMin * min,
				now - ageMin * min,
			);
		// a dozen bus events with realistic spacing. Every NEED% fork is a real
		// event so syncDecisions materializes it — no shortcut rows.
		let evTs = now - 150 * min;
		const ev = (
			kind: string,
			source: string,
			scope: string | null,
			payload: Record<string, unknown>,
			target: string | null,
		): number => {
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
			).run(
				evTs,
				source,
				kind,
				scope,
				JSON.stringify({ project: demo, ...payload }),
				target,
			);
			evTs += 2 * min;
			return (
				db.query("SELECT last_insert_rowid() AS id").get() as { id: number }
			).id;
		};
		ev(
			"NOTE",
			"demo-work",
			"W4",
			{ work: "W4", note: "legacy feed retired, readers cut over" },
			null,
		);
		ev(
			"landed",
			"demo-work",
			"W4",
			{ work: "W4", note: "feed off", sha: "b7d903a" },
			null,
		);
		ev(
			"work.started",
			"demo-work",
			"W2",
			{ work: "W2", note: "export scaffolding" },
			null,
		);
		ev(
			"checkpoint",
			"demo-work",
			"W2",
			{ work: "W2", note: "CSV writer + tests" },
			null,
		);
		ev(
			"checkpoint",
			"demo-work",
			"W2",
			{ work: "W2", note: "streaming for big exports" },
			null,
		);
		ev("test_green", "demo-work", "W2", { work: "W2", sha: "4f8c2e1" }, null);
		ev(
			"NEED_DECISION",
			"demo-wait",
			"W2",
			{ work: "W2", note: "ship the export behind a flag or straight?" },
			"demo-wait",
		);
		ev(
			"NEED_DECISION",
			"demo-work",
			"W3",
			{ work: "W3", note: "drop the cache layer or escalate the flaky tests?" },
			"demo-work",
		);
		answeredForkA = ev(
			"NEED_DECISION",
			"demo-pause",
			"W2",
			{ work: "W2", note: "keep the 1s board poll or back off to 5s?" },
			"demo-pause",
		);
		answeredForkB = ev(
			"NEED_DECISION",
			"demo-work",
			"W3",
			{ work: "W3", note: "schema migration before or after launch?" },
			"demo-work",
		);
		ev(
			"NOTE",
			"demo-pause",
			"W3",
			{ work: "W3", note: "waiting on the migration call" },
			null,
		);
		ev(
			"checkpoint",
			"demo-pause",
			"W3",
			{ work: "W3", note: "capsule banked before the pause" },
			null,
		);
		db.run("COMMIT");
	} catch (e) {
		db.run("ROLLBACK");
		throw e;
	}
	syncDecisions(); // materializes all four forks from the real NEED events
	// two of them the human already answered — answered_at = now so the
	// ACK heuristic can't re-fire on the (older) seeded events
	for (const [id, note, to] of [
		[answeredForkA, "1s is fine — the page is local", "demo-pause"],
		[answeredForkB, "after launch", "demo-work"],
	] as const)
		db.query(
			"UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(note, to, Date.now(), crypto.randomUUID(), id);
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, ts) VALUES ('zombie.W3', 'a demo lane ZOMBIE (hb 3h)', 'fleet-board --demo', ?)",
	).run(now);
	console.log(`demo seeded → ${demo}`);
}

if (DEMO) {
	seedDemo();
	writeFileSync(`${REG_DIR}/.demo-sealed`, ""); // any successful demo run seals this home against silent re-seeding after a wipe
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
			// full decision records + counts — the decisions feed the UI polls.
			// Default OPEN-only; &history=1 folds in the resolved rows
			return json(decisionsPayload(url.searchParams.get("history") === "1"));
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
				.get(p, id) as any;
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
		if (url.pathname === "/api/diff") {
			// W55 — per-item diff for the drawer: the lane branch vs its base.
			// Branch = suspenders/<id> (worktree.ts naming); base = merge-base
			// with main (fallback master). Read-only GET, argument-array git
			// only; the patch is tail-cap so a huge diff can't flood the board.
			const id = url.searchParams.get("id") ?? "";
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
				return json({ ok: false, error: "bad item id" }, 404);
			const w = db
				.query(
					"SELECT project FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
				)
				.get(id) as { project: string } | null;
			if (!w)
				return json({ ok: false, error: `unknown work item: ${id}` }, 404);
			const branch = `suspenders/${id}`;
			const git = (args: string[]): { out: string; code: number } => {
				const p = Bun.spawnSync(["/usr/bin/git", "-C", w.project, ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
				return { out: p.stdout.toString(), code: p.exitCode };
			};
			if (
				git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
					.code !== 0
			)
				return json(
					{ ok: false, error: `no branch ${branch} for item ${id}` },
					404,
				);
			const baseBranch = ["main", "master"].find(
				(b) =>
					git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).code ===
					0,
			);
			if (!baseBranch)
				return json(
					{ ok: false, error: `no main/master branch in ${w.project}` },
					404,
				);
			const base = git(["merge-base", baseBranch, branch]).out.trim();
			if (!base)
				return json(
					{ ok: false, error: `no common ancestor for ${branch}` },
					404,
				);
			const stat = git(["diff", "--stat", `${base}...${branch}`]).out;
			const full = git(["diff", `${base}...${branch}`]).out;
			const DIFF_CAP = 200 * 1024;
			const diff =
				full.length > DIFF_CAP
					? `[truncated — showing the last ${Math.round(DIFF_CAP / 1024)}KB of the patch]\n${full.slice(-DIFF_CAP)}`
					: full;
			return json({ ok: true, id, branch, base, stat, diff });
		}
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
			const note = String(parsed.body?.note ?? "")
				.trim()
				.slice(0, 2000);
			const token = String(parsed.body?.token ?? "");
			if (!id || !to || !note || !token)
				return json({ ok: false, error: "missing id, to, note or token" }, 400);
			syncDecisions();
			const row = db
				.query(
					"SELECT state, answer_note, answer_token, answer_to FROM decisions WHERE event_id = ?",
				)
				.get(id) as any;
			// reject unknown ids instead of silently answering nothing
			if (!row)
				return json({ ok: false, error: `unknown decision id: ${id}` }, 404);
			if (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED")
				return row.answer_note === note
					? json({ ok: true, replay: true, to: row.answer_to })
					: json({ ok: false, error: "stale" }, 409);
			if (row.state !== "OPEN" || row.answer_token !== token)
				return json({ ok: false, error: "stale" }, 409);
			// accept full sids, unique prefixes, or live bus aliases (an identity
			// that has emitted before — e.g. a coordinator's chosen --as name)
			const exact = db
				.query("SELECT sid FROM sessions WHERE sid = ?")
				.get(to) as { sid: string } | null;
			if (exact) to = exact.sid;
			else {
				const cands = db
					.query("SELECT sid FROM sessions WHERE sid LIKE ? || '%'")
					.all(to) as { sid: string }[];
				if (cands.length === 1) to = cands[0]?.sid;
				else {
					const alias = !!db
						.query("SELECT 1 AS x FROM events WHERE source = ? LIMIT 1")
						.get(to);
					if (!alias)
						return json(
							{
								ok: false,
								error:
									cands.length > 1
										? `ambiguous sid: ${to}`
										: `unknown target session: ${to}`,
							},
							400,
						);
				}
			}
			const p = Bun.spawnSync(
				[
					process.execPath,
					CLI("coord.ts"),
					"emit",
					"ANSWER",
					"--to",
					to,
					"--note",
					note,
					"--as",
					"fleet-board",
				],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
			if (p.exitCode !== 0)
				return json({ ok: false, output: out.slice(0, 400), to }, 500);
			// answered — lifecycle state, correlated to the fork's event id; the
			// WHERE clause guards a concurrent answer (raced → stale, another
			// tab got there first)
			const done = db
				.query(
					"UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN' AND answer_token = ?",
				)
				.run(note, to, Date.now(), crypto.randomUUID(), id, token);
			return Number(done.changes) === 0
				? json({ ok: false, error: "stale" }, 409)
				: json({ ok: true, output: out.slice(0, 400), to });
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
			const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as {
				kind: string;
			} | null;
			if (!ev)
				return json({ ok: false, error: `unknown event id: ${id}` }, 404);
			if (!isDecisionKind(ev.kind))
				return json({ ok: false, error: `not a decision event: ${id}` }, 400);
			syncDecisions();
			const row = db
				.query("SELECT state FROM decisions WHERE event_id = ?")
				.get(id) as { state: string } | null;
			if (row && (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED"))
				return json({ ok: false, error: "already answered" }, 409);
			db.query(
				"UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
			).run(Date.now(), crypto.randomUUID(), id);
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
			const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as {
				kind: string;
			} | null;
			if (!ev)
				return json({ ok: false, error: `unknown event id: ${id}` }, 404);
			if (!isDecisionKind(ev.kind))
				return json({ ok: false, error: `not a decision event: ${id}` }, 400);
			const child = Bun.spawn(
				[process.execPath, CLI("advise.ts"), String(id)],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			child.unref();
			return json({ ok: true, started: true });
		}
		if (req.method === "POST" && url.pathname === "/api/comment") {
			// W55 — review line-comments: route a board note to the item's
			// owning lane over the same coord path /api/answer uses. Mirrors
			// its guards (writeGuard + JSON-only body) and its emit shape
			// (spawnSync argument array, --as fleet-board). Unknown or
			// ownerless item = 404.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const id = String(parsed.body?.id ?? "");
			const file = String(parsed.body?.file ?? "")
				.trim()
				.slice(0, 500);
			const line = String(parsed.body?.line ?? "")
				.trim()
				.slice(0, 20);
			const note = String(parsed.body?.note ?? "")
				.trim()
				.slice(0, 2000);
			if (!id || !file || !line || !note)
				return json(
					{ ok: false, error: "missing id, file, line or note" },
					400,
				);
			const w = db
				.query(
					"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
				)
				.get(id) as { owner_sid: string | null } | null;
			if (!w)
				return json({ ok: false, error: `unknown work item: ${id}` }, 404);
			if (!w.owner_sid)
				return json(
					{ ok: false, error: `work item ${id} has no owning lane` },
					404,
				);
			const full = `review ${id} ${file}:${line} — ${note}`;
			const p = Bun.spawnSync(
				[
					process.execPath,
					CLI("coord.ts"),
					"emit",
					"NOTE",
					"--to",
					w.owner_sid,
					"--note",
					full,
					"--as",
					"fleet-board",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
			if (p.exitCode !== 0)
				return json(
					{ ok: false, output: out.slice(0, 400), to: w.owner_sid },
					500,
				);
			return json({ ok: true, to: w.owner_sid });
		}
		if (req.method === "POST" && url.pathname === "/api/start") {
			// W65 — start-on-READY: the board dispatches a fresh lane on a READY
			// item via fleet-loop's dispatch mode (CAS claim → worktree → briefed
			// headless claude). This endpoint only validates; the claim race
			// belongs to dispatch's work take. Detached spawn: the HTTP answer
			// returns while the lane boots.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const project = String(parsed.body?.project ?? "");
			const id = String(parsed.body?.id ?? "");
			if (!project || !id)
				return json({ ok: false, error: "missing project or id" }, 400);
			if (DEMO)
				return json({ ok: false, error: "demo board — no real lanes" }, 409);
			const claude = Bun.which("claude");
			if (!claude)
				return json(
					{ ok: false, error: "claude binary not found on the board's PATH" },
					409,
				);
			const w = db
				.query(
					"SELECT state, owner_sid, project FROM work_items WHERE project = ? AND id = ?",
				)
				.get(project, id) as {
				state: string;
				owner_sid: string | null;
				project: string;
			} | null;
			if (!w)
				return json(
					{ ok: false, error: `no work item ${id} in ${project}` },
					404,
				);
			if (w.owner_sid)
				return json(
					{ ok: false, error: `${id} already claimed by ${w.owner_sid}` },
					409,
				);
			if (w.state !== "READY")
				return json(
					{
						ok: false,
						error: `${id} is ${w.state} — only READY items start a lane`,
					},
					409,
				);
			const repo = w.project.replace(/\/\.git$/, "");
			if (!existsSync(repo))
				return json(
					{ ok: false, error: `project directory missing: ${repo}` },
					409,
				);
			const child = Bun.spawn(
				[
					process.execPath,
					CLI("fleet-loop.ts"),
					"dispatch",
					"--repo",
					repo,
					"--item",
					id,
				],
				{
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					// a launchd board can miss the user PATH — hand the lane's
					// `claude` spawn the dir we just resolved it from
					env: {
						...process.env,
						PATH: `${dirname(claude)}:${process.env.PATH ?? ""}`,
					},
				},
			);
			child.unref();
			return json({
				ok: true,
				item: id,
				sid: `autow${id.replace(/^W/, "").replace(/\./g, "")}`,
			});
		}
		if (req.method === "POST" && url.pathname === "/api/ship") {
			// W64 — one-click ship from the W55 diff drawer: run the repo's merge
			// ladder for ONE branch (suspenders/<id>). Guarded; ladder required.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const project = String(parsed.body?.project ?? "");
			const id = String(parsed.body?.id ?? "");
			if (!project || !id)
				return json({ ok: false, error: "missing project or id" }, 400);
			if (DEMO)
				return json({ ok: false, error: "demo board — no real lanes" }, 409);
			const w = db
				.query("SELECT project FROM work_items WHERE project = ? AND id = ?")
				.get(project, id) as { project: string } | null;
			if (!w)
				return json(
					{ ok: false, error: `no work item ${id} in ${project}` },
					404,
				);
			const repo = project.replace(/\/\.git$/, "");
			if (!existsSync(repo))
				return json(
					{ ok: false, error: `project directory missing: ${repo}` },
					409,
				);
			const branch = `suspenders/${id}`;
			const git = (args: string[]): { out: string; code: number } => {
				const p = Bun.spawnSync(["/usr/bin/git", "-C", repo, ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
				return { out: p.stdout.toString(), code: p.exitCode };
			};
			if (
				git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
					.code !== 0
			)
				return json(
					{ ok: false, error: `no branch ${branch} for item ${id}` },
					404,
				);
			const baseBranch = ["main", "master"].find(
				(b) =>
					git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).code ===
					0,
			);
			if (!baseBranch)
				return json(
					{ ok: false, error: `no main/master branch in ${repo}` },
					404,
				);
			const ahead = Number(
				git(["rev-list", "--count", `${baseBranch}..${branch}`]).out.trim() ||
					"0",
			);
			if (!Number.isFinite(ahead) || ahead <= 0)
				return json(
					{
						ok: false,
						error: `nothing to ship — ${branch} is already merged`,
					},
					409,
				);
			// never ship a branch a live lane still owns: the dispatched-lane pid
			// registry (.fleet/lanes.json) and the owning session's liveness both
			// veto — interactive lanes aren't in lanes.json, hence the second check
			const liveLane = lanesOf(repo).find(
				(l) => l.branch === branch && pidAlive(l.pid),
			);
			if (liveLane)
				return json(
					{
						ok: false,
						error: `a live lane (pid ${liveLane.pid}) still owns ${branch}`,
					},
					409,
				);
			const owner = db
				.query("SELECT owner_sid FROM work_items WHERE project = ? AND id = ?")
				.get(project, id) as { owner_sid: string | null } | null;
			if (owner?.owner_sid && sessionAlive(owner.owner_sid))
				return json(
					{
						ok: false,
						error: `owning session ${owner.owner_sid} is still live — ship after the lane finishes`,
					},
					409,
				);
			// the ladder is owner config in the repo — REQUIRED (a silent plain
			// merge would bypass the repo's quality policy)
			const ship = readShipJson(repo);
			if (!ship.ladder)
				return json(
					{
						ok: false,
						error: `no ladder configured — add ${repo}/.fleet/ship.json {"ladder":"<cmd template with {branch}>"}`,
					},
					409,
				);
			// detached child: HTTP answers while the ladder runs (ladders test — minutes)
			const child = Bun.spawn(
				[
					process.execPath,
					CLI("fleet-loop.ts"),
					"ship",
					"--repo",
					repo,
					"--branch",
					branch,
					"--ladder",
					ship.ladder,
				],
				{
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					// the ladder's own tools (bun/qlty/git) must resolve under launchd
					env: {
						...process.env,
						PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
					},
				},
			);
			child.unref();
			return json({ ok: true, item: id, branch, ladder: ship.ladder });
		}
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
	},
});
console.log(
	`fleet board → http://127.0.0.1:${PORT}  (governor.db, 1s poll; writes: /api/answer /api/ack /api/advise /api/comment /api/start /api/ship)`,
);

// best-effort Bonjour/mDNS: while the board runs, http://suspenders.local:PORT
// resolves from Bonjour-capable machines on the LAN. The name belongs to the
// dns-sd/avahi child — it vanishes when the board dies (auto-renames to
// suspenders-2.local on conflict). Skip silently when neither tool exists.
// SUSPENDERS_MDNS=0 opts out — on macOS the dns-sd registration claims the
// service host name and poisons .local resolution for the very name it advertises
// demo boards never announce themselves as suspenders.local unless forced —
// a screenshot board must not steal the name the real board owns
const isDemo = process.argv.includes("--demo");
if (
	process.env.SUSPENDERS_MDNS === "1" ||
	(process.env.SUSPENDERS_MDNS !== "0" && !isDemo)
) {
	const mdnsCmd =
		process.platform === "darwin"
			? ["dns-sd", "-R", "suspenders", "_http._tcp", ".", String(PORT)]
			: ["avahi-publish", "-s", "suspenders", "_http._tcp", String(PORT)];
	try {
		const mdns = Bun.spawn(mdnsCmd, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
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
		console.log(
			`mDNS service "suspenders" registered (Bonjour discovery) — local URL http://127.0.0.1:${PORT}`,
		);
	} catch {
		// no mDNS tooling — loopback URL still works
	}
}
