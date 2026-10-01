// hooks/coord/bus.ts — bus lifecycle: emit/broadcast/poll/wait + lane state, inbox, pause/resume (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import {
	die,
	arg,
	db,
	green,
	dim,
	cyan,
	amber,
	scopeCovers,
	projectIdentity,
} from "./shared.ts";

export async function cmdEmit(rest: string[]): Promise<void> {
	const kind = rest[0];
	if (!kind)
		die(
			'usage: emit <kind> [--to sid] [--scope s] [--sha x] [--note "..."] [--field=value ...] [--as sid]',
		);
	const scope = arg("--scope");
	const sha = arg("--sha");
	const note = arg("--note");
	const source = arg("--as") ?? "unknown";
	const to = arg("--to");
	// arbitrary --key=value passthrough: the event IS the completion report
	// (e.g. --gate=pass --artifact=stale) — one source of truth, no retelling
	const extra: Record<string, string> = {};
	for (const t of rest.slice(1)) {
		const m = /^--([\w-]+)=(.+)$/.exec(t);
		if (m && !["scope", "sha", "note", "as", "to"].includes(m[1]))
			extra[m[1]] = m[2];
	}
	// project attribution: the bus is shared across projects — consumers filter
	// work.*/sha-bearing events by this (a sha only resolves in its own repo)
	const payload = JSON.stringify({
		project: projectIdentity(),
		...(sha ? { sha } : {}),
		...(note ? { note } : {}),
		...extra,
	});
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
	).run(Date.now(), source, kind, scope, payload, to);
	console.log(
		`${green("✓")} ${dim(`event queued #${(db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id} → ${to ? `@${to.slice(0, 8)}` : "bus"}`)}`,
	);
}

export async function cmdBroadcast(rest: string[]): Promise<void> {
	// fleet-wide rules notice: live lanes receive it in their inbox on the
	// next poll; future sessions get it injected once at SessionStart
	// (facts broadcast.latest + broadcast.seen.<sid> watermark)
	const note = arg("--note");
	if (!note) die('usage: broadcast --note "..." [--as sid]');
	const source = arg("--as") ?? "owner";
	const ts = Date.now();
	const bid = `b${ts}`;
	const targets = db
		.query("SELECT sid FROM sessions WHERE state = 'RUNNING' AND hb > ?")
		.all(Date.now() - 30 * 60_000) as { sid: string }[]; // include swept-but-alive lanes
	const insB = db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'BROADCAST', NULL, ?, ?)",
	);
	for (const t of targets)
		insB.run(ts, source, JSON.stringify({ id: bid, note }), t.sid);
	const upF = db.query(
		"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	);
	upF.run(`broadcast.${bid}`, note, ts);
	upF.run("broadcast.latest", JSON.stringify({ id: bid, ts, note }), ts);
	console.log(
		`${green("✓")} broadcast ${bid} → ${targets.length} live session(s) (inbox; they poll) — everyone else gets it at SessionStart`,
	);
}

export async function cmdPoll(rest: string[]): Promise<void> {
	const as = arg("--as");
	const scope = arg("--scope");
	const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
	const limit = Number(arg("--limit") ?? 50);
	const cur = as
		? (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null)
		: null;
	const since = cur?.event_id ?? 0;
	// fetch all past the cursor, filter in TS, THEN limit — a SQL LIMIT here
	// would cut off the newest matching events; and the cursor may only advance
	// to what was actually SHOWN, or filtered consumers silently lose events.
	// A consumer with --as sees broadcasts + anything directed at it.
	let rows = as
		? (db
				.query(
					"SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND (target IS NULL OR target = ?) ORDER BY id",
				)
				.all(since, as) as Ev[])
		: (db
				.query(
					"SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND target IS NULL ORDER BY id",
				)
				.all(since) as Ev[]);
	if (scope)
		rows = rows.filter(
			(r) =>
				r.scope &&
				(r.scope === scope ||
					scopeCovers(r.scope, scope) ||
					scopeCovers(scope, r.scope)),
		);
	if (kinds.length) rows = rows.filter((r) => kinds.includes(r.kind));
	rows = rows.slice(0, limit);
	for (const r of rows) {
		const { sha, note, ...restP } = r.payload
			? (JSON.parse(r.payload) as Record<string, string>)
			: {};
		const ago = Math.max(0, Math.round((Date.now() - r.ts) / 1000));
		const extra = Object.entries(restP)
			.map(([k, v]) => `${dim(`${k}=`)}${v}`)
			.join(" ");
		console.log(
			`  ${dim(`#${r.id}`)} ${dim(`${ago}s`.padStart(4))}  ${cyan(r.kind.padEnd(18))}${dim(r.source.slice(0, 8).padEnd(9))}${r.scope ? `${r.scope}  ` : ""}${sha ? green(`@${sha.slice(0, 8)}  `) : ""}${Object.keys(restP).length ? `${extra}  ` : ""}${note ? dim(`— ${note}`) : ""}`,
		);
	}
	const latest = rows.length ? Math.max(...rows.map((r) => r.id)) : since; // advance only past SHOWN events
	if (as && rows.length) {
		if (cur)
			db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(latest, as);
		else
			db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(
				as,
				latest,
			);
	}
	if (!rows.length) console.log(dim("(no new events)"));
}

export async function cmdWait(rest: string[]): Promise<void> {
	// adaptive long-poll: 250ms while events flow, backing off to 2s when
	// idle; resets to fast the moment anything arrives. Near-instant local
	// coordination without a broker daemon.
	const as =
		arg("--as") ??
		die("usage: wait --as <sid> [--scope s] [--kinds a,b] [--max-seconds 30]");
	const scope = arg("--scope");
	const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
	const deadline = Date.now() + Number(arg("--max-seconds") ?? 30) * 1000;
	let interval = 250;
	for (;;) {
		const cur =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		let rows = db
			.query(
				"SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND (target IS NULL OR target = ?) ORDER BY id",
			)
			.all(cur, as) as Ev[];
		if (scope)
			rows = rows.filter(
				(r) =>
					r.scope &&
					(r.scope === scope ||
						scopeCovers(r.scope, scope) ||
						scopeCovers(scope, r.scope)),
			);
		if (kinds.length) rows = rows.filter((r) => kinds.includes(r.kind));
		if (rows.length) {
			for (const r of rows) {
				const { sha, note, ...restP } = r.payload
					? (JSON.parse(r.payload) as Record<string, string>)
					: {};
				const extra = Object.entries(restP)
					.map(([k, v]) => `${dim(`${k}=`)}${v}`)
					.join(" ");
				console.log(
					`  ${dim(`#${r.id}`)} ${r.source.slice(0, 8)} ${cyan(r.kind)}${r.scope ? ` ${r.scope}` : ""}${sha ? green(`@${sha.slice(0, 8)}`) : ""}${Object.keys(restP).length ? `  ${extra}` : ""}${note ? dim(` — ${note}`) : ""}`,
				);
			}
			const shownMax = Math.max(...rows.map((r) => r.id));
			if (cur)
				db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(
					shownMax,
					as,
				);
			else
				db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(
					as,
					shownMax,
				);
			process.exit(0);
		}
		if (Date.now() > deadline) {
			console.log("(timeout, no events)");
			process.exit(0);
		}
		await new Promise((r) => setTimeout(r, interval));
		interval = Math.min(interval * 2, 2000); // back off while idle; resets by activity above
	}
}

export async function cmdState(rest: string[]): Promise<void> {
	// between-rounds check for a lane: canonical state + inbox + current HEAD
	const as = arg("--as") ?? die("usage: state --as <sid>");
	const st = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.state`) as { value: string } | null;
	const head = db
		.query("SELECT value FROM facts WHERE key = 'integration.head'")
		.get() as { value: string } | null;
	const ncur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const pending = db
		.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
		.get(as, ncur) as { n: number };
	console.log(
		`state=${st?.value ?? "RUNNING"}  inbox=${pending.n}  head=${head?.value ?? dim("unknown")}`,
	);
}

export async function cmdInbox(rest: string[]): Promise<void> {
	// directed events only; never advances the cursor unless --ack
	const as = arg("--as") ?? die("usage: inbox --as <sid> [--ack]");
	const ncur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const rows = db
		.query(
			"SELECT id, ts, source, kind, scope, payload FROM events WHERE target = ? AND id > ? ORDER BY id",
		)
		.all(as, ncur) as Ev[];
	for (const r of rows) {
		const { sha, note, ...restP } = r.payload
			? (JSON.parse(r.payload) as Record<string, string>)
			: {};
		const extra = Object.entries(restP)
			.map(([k, v]) => `${dim(`${k}=`)}${v}`)
			.join(" ");
		console.log(
			`  ${dim(`#${r.id}`)} ${cyan(r.kind)}${r.scope ? ` ${r.scope}` : ""}${sha ? green(`@${sha.slice(0, 8)}`) : ""}${Object.keys(restP).length ? `  ${extra}` : ""}${note ? dim(` — ${note}`) : ""}`,
		);
	}
	if (rest.includes("--ack")) {
		const latest = rows.length ? Math.max(...rows.map((r) => r.id)) : ncur;
		const c =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		if (latest > c) {
			if (c)
				db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(
					latest,
					as,
				);
			else
				db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(
					as,
					latest,
				);
		}
	}
	if (!rows.length) console.log(dim("(inbox empty)"));
}

export async function cmdPause(rest: string[]): Promise<void> {
	// cooperative preemption: PAUSE_REQUESTED is interrupt-class and goes out
	// immediately — the lane finishes its atomic edit, checkpoints, writes a
	// continuation capsule, marks PAUSED, then waits.
	const sid = rest[0];
	const reason = arg("--reason");
	if (!sid || !reason)
		die(
			'usage: pause <sid> --reason "why" [--scope s] [--intervention "what is coming"]',
		);
	const scope = arg("--scope");
	const intervention = arg("--intervention");
	const source = arg("--as") ?? "coordinator";
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'pause_requested', ?, ?, ?)",
	).run(
		Date.now(),
		source,
		scope,
		JSON.stringify({
			...(reason ? { reason } : {}),
			...(intervention ? { intervention } : {}),
		}),
		sid,
	);
	// canonical lane state: RUNNING → PAUSE_REQUESTED (→ PAUSED by the lane itself)
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.' || ? || '.state', 'PAUSE_REQUESTED', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = 'PAUSE_REQUESTED', source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(sid, source, Date.now());
	console.log(`${amber("⏸")} ${dim(`pause_requested → @${sid.slice(0, 8)}`)}`);
}

export async function cmdPaused(rest: string[]): Promise<void> {
	// the LANE's own transition: PAUSE_REQUESTED → PAUSED. Requires proof of a
	// safe boundary: checkpoint SHA (--sha) AND a written capsule. A model
	// cannot skip the restart context by accident.
	const as =
		arg("--as") ??
		die("usage: paused --as <sid> --sha <checkpoint-sha> [--step s]");
	const sha =
		arg("--sha") ??
		die("paused requires --sha <checkpoint-sha> — no checkpoint, no pause");
	const cap = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.capsule`) as { value: string } | null;
	if (!cap)
		die(
			"no continuation capsule — `coord capsule set` before pausing (restart context is mandatory)",
		);
	let capsule: { checkpoint?: string } = {};
	try {
		capsule = JSON.parse(cap.value) as { checkpoint?: string };
	} catch {}
	if (capsule.checkpoint !== sha)
		die(
			`capsule checkpoint (${capsule.checkpoint ?? "none"}) ≠ --sha ${sha} — write a fresh capsule for THIS checkpoint`,
		);
	const st = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.state`) as { value: string } | null;
	if (st?.value !== "PAUSE_REQUESTED")
		die(
			`lane state is ${st?.value ?? "RUNNING"}, not PAUSE_REQUESTED — nothing to acknowledge`,
		);
	db.query(
		"UPDATE facts SET value = 'PAUSED', source = ?, version = version + 1, ts = ? WHERE key = ?",
	).run(as, Date.now(), `lane.${as}.state`);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'paused', ?, ?, ?)",
	).run(
		Date.now(),
		as,
		arg("--scope"),
		JSON.stringify({ sha, ...(arg("--step") ? { step: arg("--step") } : {}) }),
		"coordinator",
	);
	console.log(
		`${amber("⏸")} ${dim(`PAUSED @${sha.slice(0, 8)} — capsule + checkpoint banked`)}`,
	);
}

export async function cmdResume(rest: string[]): Promise<void> {
	// in-band change landed: RESUME_READY carries the delta summary; clears the
	// pause fact. Refuses when the lane never reached PAUSED — never race a
	// working lane.
	const sid = rest[0];
	const onto = arg("--onto");
	if (!sid || !onto)
		die(
			'usage: resume <sid> --onto <sha> [--diff-from <pause-base>] [--note "delta summary"]',
		);
	const paused = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${sid}.state`) as { value: string } | null;
	if (paused?.value !== "PAUSED")
		die(
			`lane @${sid.slice(0, 8)} state is ${paused?.value ?? "RUNNING"} — resume requires PAUSED (never race a working lane)`,
		);
	const diffFrom = arg("--diff-from");
	let changed: string[] = [];
	if (diffFrom) {
		const d = Bun.spawnSync(
			["git", "diff", "--name-status", `${diffFrom}..${onto}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		changed = new TextDecoder()
			.decode(d.stdout)
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, 30)
			.map((l) => l.replace(/\t/g, " "));
	}
	const source = arg("--as") ?? "coordinator";
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'resume_ready', ?, ?, ?)",
	).run(
		Date.now(),
		source,
		arg("--scope"),
		JSON.stringify({
			onto,
			...(paused ? { pausedAt: paused.value } : {}),
			...(changed.length ? { changed } : {}),
			...(arg("--note") ? { note: arg("--note") } : {}),
		}),
		sid,
	);
	// PAUSED → RESUME_READY (the worker reconciles, then confirms via `resumed`)
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.' || ? || '.state', 'RESUME_READY', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = 'RESUME_READY', source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(sid, source, Date.now());
	console.log(
		`${green("↻")} ${dim(`resume_ready → @${sid.slice(0, 8)} onto ${onto.slice(0, 8)}${changed.length ? ` (${changed.length} files changed)` : ""}`)}`,
	);
}

export async function cmdResumed(rest: string[]): Promise<void> {
	// the worker's confirmation: RESUME_READY → RUNNING (worktree reconciled,
	// targeted tests green)
	const as = arg("--as") ?? die("usage: resumed --as <sid>");
	const st = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.state`) as { value: string } | null;
	if (st?.value !== "RESUME_READY")
		die(`lane state is ${st?.value ?? "RUNNING"} — nothing to resume-confirm`);
	db.query(
		"UPDATE facts SET value = 'RUNNING', source = ?, version = version + 1, ts = ? WHERE key = ?",
	).run(as, Date.now(), `lane.${as}.state`);
	console.log(
		`${green("▶")} ${dim(`RUNNING — @${as.slice(0, 8)} reconciled and re-uptaken`)}`,
	);
}

export async function cmdResumeSession(rest: string[]): Promise<void> {
	// ownership rebind for `claude -c` continuations: the runtime hands the
	// resumed session a fresh id — move ownership forward atomically so the
	// session wakes owning what it owned before (never re-derive from Markdown)
	const as = arg("--as");
	const from = arg("--from");
	if (!as || !from || as === from)
		die("usage: resume-session --as <new-sid> --from <old-sid>");
	const old = db
		.query("SELECT project, role, worktree FROM sessions WHERE sid = ?")
		.get(from) as
		| { project: string | null; role: string | null; worktree: string | null }
		| undefined;
	if (!old) die(`no known session: ${from} — nothing to rebind`);
	const proj = old.project ?? projectIdentity();
	const now = Date.now();
	let wMoved = 0;
	let cMoved = 0;
	let fMoved = 0;
	let eMoved = 0;
	db.transaction(() => {
		wMoved = db
			.query(
				"UPDATE work_items SET owner_sid = ?, updated_at = ? WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED')",
			)
			.run(as, now, proj, from).changes;
		cMoved = db
			.query(
				"INSERT INTO claims (sid, scope, intent, hot, ts, tp) SELECT ?, scope, intent, hot, ts, tp FROM claims WHERE sid = ? ON CONFLICT DO NOTHING",
			)
			.run(as, from).changes;
		db.query("DELETE FROM claims WHERE sid = ?").run(from);
		const facts = db
			.query("SELECT key FROM facts WHERE key LIKE ?")
			.all(`lane.${from}.%`) as { key: string }[];
		for (const f of facts) {
			const nk = f.key.replace(`lane.${from}.`, `lane.${as}.`);
			db.query(
				"INSERT INTO facts (key, value, source, version, ts) SELECT ?, value, source, version + 1, ? FROM facts WHERE key = ? ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
			).run(nk, now, f.key);
			db.query("DELETE FROM facts WHERE key = ?").run(f.key);
			fMoved++;
		}
		// unconsumed directed events follow the inbox: everything past the old
		// cursor re-targets the new sid, so pending messages aren't stranded
		const oldCur =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(from) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		eMoved = db
			.query("UPDATE events SET target = ? WHERE target = ? AND id > ?")
			.run(as, from, oldCur).changes;
		const cur = db
			.query("SELECT event_id FROM cursors WHERE sid = ?")
			.get(from) as { event_id: number } | null;
		if (cur && !db.query("SELECT 1 FROM cursors WHERE sid = ?").get(as))
			db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(
				as,
				cur.event_id,
			);
		db.query("UPDATE sessions SET state = 'CLOSED', hb = ? WHERE sid = ?").run(
			now,
			from,
		);
		db.query(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING') ON CONFLICT(sid) DO UPDATE SET project = excluded.project, role = excluded.role, parent_sid = excluded.parent_sid, worktree = excluded.worktree, hb = excluded.hb, state = 'RUNNING'",
		).run(as, proj, old.role ?? "worker", from, old.worktree, now, now);
	})();
	console.log(
		`✓ ${from.slice(0, 8)} → ${as.slice(0, 8)}  work:${wMoved} claims:${cMoved} facts:${fMoved} events:${eMoved} (cursor carried, ${from.slice(0, 8)} CLOSED)`,
	);
}
