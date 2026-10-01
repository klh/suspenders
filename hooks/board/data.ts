// hooks/board/data.ts — the /api data builders: tasks, board, claims, decisions, activity (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import {
	db,
	BIND,
	REG_DIR,
	LLM_ORIGIN,
	gatePath,
	sessionStartPath,
} from "./context.ts";
import { boardToken, isLoopbackBind } from "./gate.ts";
import {
	projOf,
	syncDecisions,
	failNote,
	ago,
	label,
	ownerLabel,
	payloadOf,
	transcriptTail,
	unblockedBy,
	laneModelOf,
} from "./lanes.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export function taskShape(
	w: WorkItemRow,
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
		...laneModelOf(w.owner_sid),
		unblocked_by:
			w.state === "READY"
				? (unblocked.get(`${String(w.project)}\u0000${String(w.id)}`) ?? null)
				: null,
	};
}

// the tasks feed: everything not SUPERSEDED (or DONE still holding an owner —
// a stale claim, not a result), newest activity first, open forks counted
export function tasks(p: string | null): unknown[] {
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
	) as WorkItemRow[];
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
export function workEvents(p: string, id: string): unknown[] {
	return (
		db
			.query(
				`SELECT id, ts, source, kind, payload FROM events
				WHERE (json_extract(payload, '$.work') = ? AND json_extract(payload, '$.project') = ?)
					OR (scope = ? AND (json_extract(payload, '$.project') = ? OR json_extract(payload, '$.project') IS NULL))
				ORDER BY id DESC LIMIT 50`,
			)
			.all(id, p, id, p) as EventRow[]
	).map((e) => {
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
export function taskDecisions(p: string, id: string): unknown[] {
	return (
		db
			.query(
				"SELECT event_id, state, question, answer_note FROM decisions WHERE project = ? AND task_id = ? ORDER BY event_id DESC",
			)
			.all(p, id) as {
			event_id: number;
			state: string;
			question: string | null;
			answer_note: string | null;
		}[]
	).map((d) => ({
		event_id: d.event_id,
		state: d.state,
		question: d.question ?? "",
		answer_note: d.answer_note ?? null,
	}));
}

// newest-first bus feed. note/sha ride the payload; project too (CLI emitters
// stamp it — the source session's project covers anything older)
export function activity(p: string | null, limit: number): unknown[] {
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
	) as EventRow[];
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
export function settingsCommands(kind: string): string[] {
	try {
		const s = JSON.parse(
			readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8"),
		) as {
			hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
		};
		return (s?.hooks?.[kind] ?? [])
			.flatMap((m) => (m?.hooks ?? []).map((h) => String(h?.command ?? "")))
			.map((c) => c.replaceAll("$HOME", process.env.HOME ?? "~"));
	} catch {
		return [];
	}
}

export async function llmCheck(): Promise<{ ok: boolean; detail: string }> {
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

export async function setupChecks(): Promise<unknown[]> {
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
		{
			id: "bind",
			label: "LAN binding",
			ok: true,
			detail: isLoopbackBind(BIND)
				? `${BIND} (loopback-only — LAN access rides the Caddy edge${boardToken() ? "; shared-secret gate ON" : ""})`
				: `${BIND}${boardToken() ? " (non-loopback, shared-secret gate ON)" : " (NON-LOOPBACK AND UNGATED — see the trust model in docs/board-api.md)"}`,
			fix: null,
		},
	];
}

// session registry row + the API view the /api/data feed serves
export interface SessionRow {
	sid: string;
	role: string | null;
	state: string;
	parent_sid: string | null;
	project: string | null;
	hb: number;
}

export interface SessionView {
	sid: string;
	label: string;
	role: string | null;
	state: string;
	parent: string | null;
	project: string | null;
	hbAgo: number;
	executor: string | null;
	model: string | null;
	locality: string | null;
}

export function sessions(): SessionView[] {
	return (
		db
			.query(
				"SELECT sid, role, state, parent_sid, project, hb FROM sessions ORDER BY state, sid",
			)
			.all() as SessionRow[]
	).map((s) => ({
		sid: s.sid,
		label: label(s.sid, s.role),
		role: s.role,
		state: s.state,
		parent: s.parent_sid,
		project: s.project,
		hbAgo: ago(s.hb),
		...laneModelOf(s.sid),
	}));
}

export function board(): Record<string, unknown>[] {
	const projects = db
		.query(
			"SELECT DISTINCT project FROM work_items WHERE state NOT IN ('DONE','SUPERSEDED') OR state = 'DONE'",
		)
		.all() as { project: string }[];
	return projects.map(({ project }) => {
		const items = db
			.query(
				"SELECT id, state, owner_sid, origin, title, priority, result_sha, requires, updated_at FROM work_items WHERE project = ? ORDER BY priority DESC, id",
			)
			.all(project) as WorkItemRow[];
		const doneIds = new Set(
			items.filter((w) => w.state === "DONE").map((w) => w.id),
		);
		const depRows = db
			.query(
				"SELECT work_id, depends_on FROM work_deps WHERE project = ? AND depends_on NOT IN (SELECT id FROM work_items WHERE project = ? AND state = 'DONE')",
			)
			.all(project, project) as { work_id: string; depends_on: string }[];
		const blocked = new Set(depRows.map((r) => r.work_id));
		const openDeps: Record<string, string[]> = {};
		for (const r of depRows) {
			const deps = openDeps[r.work_id] ?? [];
			deps.push(r.depends_on);
			openDeps[r.work_id] = deps;
		}
		const shape = (w: WorkItemRow) => ({
			id: w.id,
			state: w.state,
			owner: w.owner_sid,
			origin: w.origin,
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

export function claims(): unknown[] {
	return (
		db
			.query(
				"SELECT sid, scope, intent, hot, ts FROM claims ORDER BY sid, scope",
			)
			.all() as {
			sid: string;
			scope: string;
			intent: string | null;
			hot: number;
			ts: number;
		}[]
	).map((c) => ({
		sid: c.sid,
		scope: c.scope,
		intent: c.intent,
		hot: !!c.hot,
		tsAgo: ago(c.ts),
	}));
}

export function events(): unknown[] {
	return (
		db
			.query(
				"SELECT id, ts, source, kind, scope, payload, target FROM events ORDER BY id DESC LIMIT 50",
			)
			.all() as EventRow[]
	).map((e) => {
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

export function laneFacts(sid: string): Record<string, unknown> {
	const rows = db
		.query("SELECT key, value FROM facts WHERE key = ? OR key = ?")
		.all(`lane.${sid}.state`, `lane.${sid}.capsule`) as {
		key: string;
		value: string;
	}[];
	const out: Record<string, unknown> = {};
	for (const r of rows) {
		const short = r.key.split(".").pop();
		if (short) out[short] = r.value;
	}
	return out;
}

export function inbox(sid: string): unknown[] {
	const cur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	return (
		db
			.query(
				"SELECT id, ts, source, kind, payload FROM events WHERE target = ? AND id > ? ORDER BY id",
			)
			.all(sid, cur) as EventRow[]
	).map((e) => ({
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
export function decisionRecords(): Record<string, unknown>[] {
	const rows = db
		.query(
			`SELECT d.*, w.title AS task_title FROM decisions d
			LEFT JOIN work_items w ON w.project = d.project AND w.id = d.task_id
			ORDER BY (d.state = 'OPEN') DESC, d.event_id DESC LIMIT 200`,
		)
		.all() as {
		event_id: number;
		target: string;
		asked_by: string | null;
		project: string | null;
		task_id: string | null;
		question: string | null;
		options: string | null;
		state: string;
		delivery: string | null;
		answer_note: string | null;
		answer_to: string | null;
		answer_token: string | null;
		created_at: number;
		answered_at: number | null;
		ack_ts: number | null;
		task_title: string | null;
	}[];
	return rows.map((d) => {
		let options: { label: string; tradeoff?: string | null }[] = [];
		try {
			options = d.options ? JSON.parse(d.options) : [];
		} catch {}
		let advice: unknown;
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

export function decisionsPayload(history: boolean): unknown {
	syncDecisions();
	const recs = decisionRecords();
	const open = recs.filter((r) => r.state === "OPEN") as {
		project?: string | null;
	}[];
	// the default feed stays OPEN-only; &history=1 adds the resolved rows
	// (ANSWERED / ACKNOWLEDGED / CANCELLED) for the collapsed history view
	const shown = history ? recs : open;
	const byProject: Record<string, number> = {};
	for (const r of open)
		if (r.project) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
	return { ts: Date.now(), count: open.length, byProject, decisions: shown };
}

// W28 routing telemetry: today's llm.call events are the routing log;
// per-model token sums vs optional llm.budget.<model> facts are the budgets.
export function llm(): unknown {
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

export function payload() {
	syncDecisions();
	const ss = sessions();
	const labels: Record<string, string> = {};
	for (const s of ss) labels[s.sid] = s.label;
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

export function payloadFor(sid: string): unknown {
	const base = payload();
	const s = base.sessions.find((x) => x.sid === sid);
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
