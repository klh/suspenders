// hooks/board/lanes.ts — lane/session read helpers: liveness, transcripts, labels, filters (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { CLI, db } from "./context.ts";
import { laneExecFacts } from "./exec.ts";
import { json } from "./helpers.ts";
import {
	taskShape,
	activity,
	sessions,
	board,
	claims,
	events,
	payload,
} from "./data.ts";
import { isDecisionKind } from "../lib/govdb.ts";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";

export const deadAfterMs = (): number =>
	Number(
		(
			db
				.query("SELECT value FROM facts WHERE key = 'fleet.zombie_after_ms'")
				.get() as { value: string } | null
		)?.value ?? 45 * 60_000,
	);

export const projOf = (sid: string): string | null =>
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
export const targetAlive = (sid: string, now: number): boolean => {
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
export const pickedUp = (eventId: number, sid: string): boolean =>
	((
		db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
			event_id: number;
		} | null
	)?.event_id ?? 0) >= eventId;

// payload.options → JSON array of {label, tradeoff}. Accepts a real array
// (TS emitters) or a JSON-encoded array string (coord emit --options=… makes
// every --field a string); bare strings keep their text, lose nothing.
export function normOptions(v: unknown): string {
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
		v.slice(0, 8).map((o) =>
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
export function enrich(
	d: { event_id: number; target: string },
	e: { source?: string | null; payload?: string | null } | null | undefined,
): void {
	let p: Record<string, unknown> = {};
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
export function syncDecisions(): void {
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
		.all() as EventRow[]) {
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
				.get(d.event_id) as {
				source: string;
				payload: string | null;
			} | null,
		);
	}
	// a decision addressed to a lane that died before pickup reads as FAILED
	// instead of silently waiting forever; cursor past the fork = picked up.
	// Truth-sync, not one-way degradation: a wrongly-FAILED row (target alive
	// all along — see targetAlive) repairs itself when the target shows life.
	for (const d of db
		.query("SELECT event_id, target FROM decisions WHERE state = 'OPEN'")
		.all() as { event_id: number; target: string }[])
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

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export const lanesOf = (repo: string): { pid: number; branch: string }[] => {
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
export const readShipJson = (repo: string): { ladder?: string } => {
	try {
		return JSON.parse(readFileSync(`${repo}/.fleet/ship.json`, "utf8")) as {
			ladder?: string;
		};
	} catch {
		return {};
	}
};

// a transcript written within the last 15 minutes = live process
export const transcriptWarm = (sid: string): boolean => {
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
export const sessionAlive = (sid: string): boolean => {
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

export const failNote = (id: string): string | null => {
	try {
		const r = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.failed' AND json_extract(payload, '$.work') = ? ORDER BY id DESC LIMIT 1",
			)
			.get(id) as { payload: string | null } | null;
		const note = r?.payload
			? (JSON.parse(r.payload) as { note?: unknown }).note
			: null;
		return note ? String(note).slice(0, 300) : null;
	} catch {
		return null;
	}
};

export function ago(ts: number | null | undefined): number {
	return ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : -1;
}

export function label(sid: string, role: string): string {
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
export function projectList(): string[] {
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
export function ownerLabel(sid: string | null | undefined): string | null {
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

export const payloadOf = (raw: string | null): Record<string, unknown> => {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
};

export const TAIL_BYTES = 32 * 1024;
export const TAIL_MAX = 110;
export const LANE_TAIL_BYTES = 32 * 1024;
export function transcriptTail(
	sid: string | null | undefined,
): { text: string; ts: string | null } | null {
	return transcriptTailAll(sid, 1)[0] ?? null;
}
// newest-last list of the session's latest assistant text / tool blocks.
// max=1 reproduces the kanban-card tail contract (the single last block).
export function transcriptTailAll(
	sid: string | null | undefined,
	max: number,
): { text: string; ts: string | null }[] {
	if (!sid) return [];
	const row = db
		.query("SELECT transcript_path FROM sessions WHERE sid = ?")
		.get(sid) as { transcript_path: string | null } | null;
	const path = row?.transcript_path;
	if (!path || !existsSync(path) || !statSync(path).size) return [];
	const size = statSync(path).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const len = size - start;
	const buf = Buffer.alloc(len);
	try {
		const fd = openSync(path, "r");
		readSync(fd, buf, 0, len, start);
		closeSync(fd);
	} catch {
		return [];
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift(); // first line may be a partial record
	const out: { text: string; ts: string | null }[] = [];
	for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let j:
			| {
					timestamp?: string | null;
					message?: {
						role?: string;
						content?: {
							type?: string;
							text?: string;
							name?: string;
							input?: Record<string, unknown> | null;
						}[];
					};
			  }
			| undefined;
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = j?.message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let k = msg.content.length - 1; k >= 0 && out.length < max; k--) {
			const b = msg.content[k];
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim())
				out.push({
					text: b.text.trim().replace(/\s+/g, " ").slice(0, TAIL_MAX),
					ts: j.timestamp ?? null,
				});
			else if (b?.type === "tool_use" && b.name)
				out.push({
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
				});
		}
	}
	return out;
}

// done→ready auto-start (W50): newest work.ready event per item, keyed by
// project + work id — value is the unblocker's id (who completed the blocking
// item). A stale event never sticks: taskShape only flags items still READY.
export function unblockedBy(): Map<string, string | null> {
	const m = new Map<string, string | null>();
	for (const r of db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.ready' ORDER BY id DESC LIMIT 500",
		)
		.all() as { payload: string | null }[]) {
		const pl = payloadOf(r.payload);
		if (!pl?.work) continue;
		const key = `${String(pl.project ?? "")}\u0000${String(pl.work)}`;
		if (!m.has(key))
			m.set(key, pl.unblocked_by != null ? String(pl.unblocked_by) : null);
	}
	return m;
}

// W105 — the lane registry's executor/model/locality, stamped into facts at
// dispatch time (laneExecFacts, /api/start) and read back for any lane here.
export function laneModelOf(sid: string | null | undefined): {
	executor: string | null;
	model: string | null;
	locality: string | null;
} {
	if (!sid) return { executor: null, model: null, locality: null };
	const get = (k: string): string | null =>
		(
			db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`lane.${sid}.${k}`) as { value: string } | null
		)?.value ?? null;
	return {
		executor: get("executor"),
		model: get("model"),
		locality: get("locality"),
	};
}
