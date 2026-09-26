// coord.ts — the coordination event bus over governor.db: agents share state
// BY REFERENCE (short structured events + canonical facts), never by retelling
// it in prose. Direct SendMessage stays reserved for interrupts.
//
// usage:
//   bun ~/.claude/bin/coord.ts emit <kind> [--scope s] [--sha x] [--note "..."] [--as sid]
//   bun ~/.claude/bin/coord.ts poll [--as sid] [--scope s] [--kinds a,b] [--limit n]
//   bun ~/.claude/bin/coord.ts wait --as sid [--scope s] [--kinds a,b] [--max-seconds 30]
//        (adaptive long-poll: 250ms fast path, backs off to 2s when idle)
//   bun ~/.claude/bin/coord.ts metrics [project] [--days N]
//   bun ~/.claude/bin/coord.ts fact set <key> <value> [--source s]
//   bun ~/.claude/bin/coord.ts fact get <key> / fact list
//   bun ~/.claude/bin/coord.ts diff [--since <seq|event-id>] [--last N] [--table t] [--json]
//        (row-image delta log: what changed in sessions/claims/locks/facts/
//         work_items between two points — events/cursors are the bus's own trail)
//
// event kinds (doctrine): checkpoint | landed | interface_changed | test_red |
//   test_green | conflict | blocked | decision | dependency_changed
// poll with --as auto-advances that agent's cursor: communication cost scales
// with NEW information, never with history.
import { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { openGovernorDb, projectIdentity, CAPABILITIES, workTiming, pruneDeltas } from "../lib/govdb.ts";
import { resolve } from "node:path";

interface Ev {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
}

// one row-image change from the deltas trigger log (govdb.ts v5 migration)
interface DeltaRow {
	seq: number;
	ts: number;
	tbl: string;
	op: string;
	pk: string;
	before: string | null;
	after: string | null;
}

const die = (m: string): never => {
	console.error(`coord: ${m}`);
	process.exit(2);
};

const db: Database = openGovernorDb();
const [cmd, ...rest] = process.argv.slice(2);
// --help anywhere wins before any parsing that could create state
if (rest.includes("--help") || rest.includes("-h")) {
	console.log("coord — control plane. emit | poll | wait | fact | bootstrap | state | inbox | capsule | pause | paused | resume | resumed | resume-session | doctor-session | who-knows | consult | consult-reply | consults | kb | lease-release | gc | fleet | metrics | diff");
	process.exit(0);
}
const arg = (name: string): string | null => {
	const i = rest.indexOf(name);
	return i >= 0 ? (rest[i + 1] ?? null) : null;
};

// output polish — quiet ANSI, disabled when piped or NO_COLOR
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint =
	(code: string) =>
	(s: string): string =>
		tty ? `\x1b[${code}m${s}\x1b[0m` : s;

// consult knowledge base lookup: FTS5 OR-rank fetches candidates, then a JS
// term-overlap score (shared significant terms / question terms) gates the
// hit — ≥0.6 overlap AND ≥2 shared terms. Pure AND breaks on rephrasing
// (every added function word kills it), pure OR over-matches. A miss returns
// null; an FTS syntax edge is a miss, never a crash.
function kbLookup(question: string): { id: number; problem: string; solution: string; answered_by: string; hits: number } | null {
	const terms = [...new Set(question.toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length > 2))];
	if (!terms.length) return null;
	try {
		const cands = db
			.query(
				`SELECT k.id, k.problem, k.solution, k.answered_by, k.hits FROM consult_kb_fts f
				 JOIN consult_kb k ON k.id = f.rowid WHERE consult_kb_fts MATCH ? ORDER BY rank LIMIT 5`,
			)
			.all(terms.map((t) => `"${t}"`).join(" OR ")) as { id: number; problem: string; solution: string; answered_by: string; hits: number }[];
		let best: (typeof cands)[number] & { overlap: number } | null = null;
		for (const c of cands) {
			const pt = new Set(c.problem.toLowerCase().split(/[^a-z0-9_.-]+/));
			const shared = terms.filter((t) => pt.has(t));
			const overlap = shared.length / terms.length;
			if (shared.length >= 2 && overlap >= 0.6 && (!best || overlap > best.overlap)) best = { ...c, overlap };
		}
		return best;
	} catch {
		return null;
	}
}
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const amber = paint("33");
const red = paint("31");

if (cmd === "emit") {
	const kind = rest[0];
	if (!kind) die('usage: emit <kind> [--to sid] [--scope s] [--sha x] [--note "..."] [--field=value ...] [--as sid]');
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
		if (m && !["scope", "sha", "note", "as", "to"].includes(m[1])) extra[m[1]] = m[2];
	}
	// project attribution: the bus is shared across projects — consumers filter
	// work.*/sha-bearing events by this (a sha only resolves in its own repo)
	const payload = JSON.stringify({ project: projectIdentity(), ...(sha ? { sha } : {}), ...(note ? { note } : {}), ...extra });
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)").run(
		Date.now(),
		source,
		kind,
		scope,
		payload,
		to,
	);
	console.log(`${green("✓")} ${dim(`event queued #${(db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id} → ${to ? `@${to.slice(0, 8)}` : "bus"}`)}`);
} else if (cmd === "broadcast") {
	// fleet-wide rules notice: live lanes receive it in their inbox on the
	// next poll; future sessions get it injected once at SessionStart
	// (facts broadcast.latest + broadcast.seen.<sid> watermark)
	const note = arg("--note");
	if (!note) die('usage: broadcast --note "..." [--as sid]');
	const source = arg("--as") ?? "owner";
	const ts = Date.now();
	const bid = `b${ts}`;
	const targets = (db
		.query("SELECT sid, state, hb FROM sessions WHERE state = 'RUNNING' OR hb > '' || (strftime('%s', 'now') * 1000 - 86400000)")
		.all() as { sid: string; state: string; hb: number }[])
		.filter((t) => t.state === "RUNNING" || Date.now() - t.hb < 86_400_000); // include swept-but-alive lanes
	const insB = db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'BROADCAST', NULL, ?, ?)");
	for (const t of targets) insB.run(ts, source, JSON.stringify({ id: bid, note }), t.sid);
	const upF = db.query("INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts");
	upF.run(`broadcast.${bid}`, note, ts);
	upF.run("broadcast.latest", JSON.stringify({ id: bid, ts, note }), ts);
	console.log(`${green("✓")} broadcast ${bid} → ${targets.length} running session(s) + SessionStart tail for future ones`);
} else if (cmd === "lease-release") {
	// explicit handover: a session done with a file releases it now instead of
	// pinning it for its remaining TTL. Owner-predicated — only the caller's
	// own rows; taking a foreign lease is monitor --fix / arbitration work.
	const paths = rest.filter((r) => !r.startsWith("--"));
	const as = arg("--as");
	if (!paths.length || !as) die("usage: lease-release <path...> --as <sid>");
	const del = db.query("DELETE FROM locks WHERE path = ? AND sid = ?");
	let n = 0;
	for (const p of paths) {
		let P = p;
		try {
			P = realpathSync(p); // the gate stores canonical paths
		} catch {}
		n += del.run(P, as).changes;
	}
	console.log(`${green("✓")} lease-release: ${n} lock(s) released`);
} else if (cmd === "state") {
	// between-rounds check for a lane: canonical state + inbox + current HEAD
	const as = arg("--as") ?? die("usage: state --as <sid>");
	const st = db.query("SELECT value FROM facts WHERE key = ?").get(`lane.${as}.state`) as { value: string } | null;
	const head = db.query("SELECT value FROM facts WHERE key = 'integration.head'").get() as { value: string } | null;
	const ncur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as { event_id: number } | null)?.event_id ?? 0;
	const pending = db.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?").get(as, ncur) as { n: number };
	console.log(
		`state=${st?.value ?? "RUNNING"}  inbox=${pending.n}  head=${head?.value ?? dim("unknown")}`,
	);
} else if (cmd === "inbox") {
	// directed events only; never advances the cursor unless --ack
	const as = arg("--as") ?? die("usage: inbox --as <sid> [--ack]");
	const ncur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as { event_id: number } | null)?.event_id ?? 0;
	const rows = db
		.query("SELECT id, ts, source, kind, scope, payload FROM events WHERE target = ? AND id > ? ORDER BY id")
		.all(as, ncur) as Ev[];
	for (const r of rows) {
		const { sha, note, ...restP } = r.payload ? (JSON.parse(r.payload) as Record<string, string>) : {};
		const extra = Object.entries(restP)
			.map(([k, v]) => `${dim(`${k}=`)}${v}`)
			.join(" ");
		console.log(
			`  ${dim(`#${r.id}`)} ${cyan(r.kind)}${r.scope ? ` ${r.scope}` : ""}${sha ? green(`@${sha.slice(0, 8)}`) : ""}${Object.keys(restP).length ? `  ${extra}` : ""}${note ? dim(` — ${note}`) : ""}`,
		);
	}
	if (rest.includes("--ack")) {
		const latest = rows.length ? Math.max(...rows.map((r) => r.id)) : ncur;
		const c = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as { event_id: number } | null)?.event_id ?? 0;
		if (latest > c) {
			if (c) db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(latest, as);
			else db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(as, latest);
		}
	}
	if (!rows.length) console.log(dim("(inbox empty)"));
} else if (cmd === "pause") {
	// cooperative preemption: PAUSE_REQUESTED is interrupt-class and goes out
	// immediately — the lane finishes its atomic edit, checkpoints, writes a
	// continuation capsule, marks PAUSED, then waits.
	const sid = rest[0];
	const reason = arg("--reason");
	if (!sid || !reason) die('usage: pause <sid> --reason "why" [--scope s] [--intervention "what is coming"]');
	const scope = arg("--scope");
	const intervention = arg("--intervention");
	const source = arg("--as") ?? "coordinator";
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'pause_requested', ?, ?, ?)").run(
		Date.now(),
		source,
		scope,
		JSON.stringify({ ...(reason ? { reason } : {}), ...(intervention ? { intervention } : {}) }),
		sid,
	);
	// canonical lane state: RUNNING → PAUSE_REQUESTED (→ PAUSED by the lane itself)
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.' || ? || '.state', 'PAUSE_REQUESTED', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = 'PAUSE_REQUESTED', source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(sid, source, Date.now());
	console.log(`${amber("⏸")} ${dim(`pause_requested → @${sid.slice(0, 8)}`)}`);
} else if (cmd === "paused") {
	// the LANE's own transition: PAUSE_REQUESTED → PAUSED. Requires proof of a
	// safe boundary: checkpoint SHA (--sha) AND a written capsule. A model
	// cannot skip the restart context by accident.
	const as = arg("--as") ?? die("usage: paused --as <sid> --sha <checkpoint-sha> [--step s]");
	const sha = arg("--sha") ?? die("paused requires --sha <checkpoint-sha> — no checkpoint, no pause");
	const cap = db.query("SELECT value FROM facts WHERE key = ?").get(`lane.${as}.capsule`) as { value: string } | null;
	if (!cap) die("no continuation capsule — `coord capsule set` before pausing (restart context is mandatory)");
	let capsule: { checkpoint?: string } = {};
	try {
		capsule = JSON.parse(cap.value) as { checkpoint?: string };
	} catch {}
	if (capsule.checkpoint !== sha)
		die(`capsule checkpoint (${capsule.checkpoint ?? "none"}) ≠ --sha ${sha} — write a fresh capsule for THIS checkpoint`);
	const st = db.query("SELECT value FROM facts WHERE key = ?").get(`lane.${as}.state`) as { value: string } | null;
	if (st?.value !== "PAUSE_REQUESTED") die(`lane state is ${st?.value ?? "RUNNING"}, not PAUSE_REQUESTED — nothing to acknowledge`);
	db.query("UPDATE facts SET value = 'PAUSED', source = ?, version = version + 1, ts = ? WHERE key = ?").run(
		as,
		Date.now(),
		`lane.${as}.state`,
	);
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'paused', ?, ?, ?)").run(
		Date.now(),
		as,
		arg("--scope"),
		JSON.stringify({ sha, ...(arg("--step") ? { step: arg("--step") } : {}) }),
		"coordinator",
	);
	console.log(`${amber("⏸")} ${dim(`PAUSED @${sha.slice(0, 8)} — capsule + checkpoint banked`)}`);
} else if (cmd === "resume") {
	// in-band change landed: RESUME_READY carries the delta summary; clears the
	// pause fact. Refuses when the lane never reached PAUSED — never race a
	// working lane.
	const sid = rest[0];
	const onto = arg("--onto");
	if (!sid || !onto) die("usage: resume <sid> --onto <sha> [--diff-from <pause-base>] [--note \"delta summary\"]");
	const paused = db.query("SELECT value FROM facts WHERE key = ?").get(`lane.${sid}.state`) as { value: string } | null;
	if (paused?.value !== "PAUSED")
		die(`lane @${sid.slice(0, 8)} state is ${paused?.value ?? "RUNNING"} — resume requires PAUSED (never race a working lane)`);
	const diffFrom = arg("--diff-from");
	let changed: string[] = [];
	if (diffFrom) {
		const d = Bun.spawnSync(["git", "diff", "--name-status", `${diffFrom}..${onto}`], { stdout: "pipe", stderr: "pipe" });
		changed = new TextDecoder()
			.decode(d.stdout)
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, 30)
			.map((l) => l.replace(/\t/g, " "));
	}
	const source = arg("--as") ?? "coordinator";
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'resume_ready', ?, ?, ?)").run(
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
	console.log(`${green("↻")} ${dim(`resume_ready → @${sid.slice(0, 8)} onto ${onto.slice(0, 8)}${changed.length ? ` (${changed.length} files changed)` : ""}`)}`);
} else if (cmd === "resumed") {
	// the worker's confirmation: RESUME_READY → RUNNING (worktree reconciled,
	// targeted tests green)
	const as = arg("--as") ?? die("usage: resumed --as <sid>");
	const st = db.query("SELECT value FROM facts WHERE key = ?").get(`lane.${as}.state`) as { value: string } | null;
	if (st?.value !== "RESUME_READY") die(`lane state is ${st?.value ?? "RUNNING"} — nothing to resume-confirm`);
	db.query("UPDATE facts SET value = 'RUNNING', source = ?, version = version + 1, ts = ? WHERE key = ?").run(
		as,
		Date.now(),
		`lane.${as}.state`,
	);
	console.log(`${green("▶")} ${dim(`RUNNING — @${as.slice(0, 8)} reconciled and re-uptaken`)}`);
} else if (cmd === "capsule") {
	// continuation capsule: the minimum restart packet (checkpoint/step/next/assumptions)
	const as = arg("--as") ?? rest[0];
	if (!as || rest[0] === "get") {
		const cap = db.query("SELECT value FROM facts WHERE key = ?").get(`lane.${as ?? ""}.capsule`) as { value: string } | null;
		console.log(cap?.value ?? dim("(no capsule)"));
	} else {
		const extra: Record<string, string> = {};
		for (const t of process.argv.slice(2)) {
			const m = /^--([\w-]+)=(.+)$/.exec(t);
			if (m && !["as"].includes(m[1])) extra[m[1]] = m[2];
		}
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, ts = excluded.ts",
		).run(`lane.${as}.capsule`, JSON.stringify({ ...extra, ts: Date.now() }), arg("--as") ?? as, Date.now());
		console.log(`${green("✓")} ${dim(`capsule stored for @${as.slice(0, 8)}`)}`);
	}
} else if (cmd === "poll") {
	const as = arg("--as");
	const scope = arg("--scope");
	const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
	const limit = Number(arg("--limit") ?? 50);
	const cur = as ? (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as { event_id: number } | null) : null;
	const since = cur?.event_id ?? 0;
	// fetch all past the cursor, filter in TS, THEN limit — a SQL LIMIT here
	// would cut off the newest matching events; and the cursor may only advance
	// to what was actually SHOWN, or filtered consumers silently lose events.
	// A consumer with --as sees broadcasts + anything directed at it.
	let rows = as
		? (db.query("SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND (target IS NULL OR target = ?) ORDER BY id").all(since, as) as Ev[])
		: (db.query("SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND target IS NULL ORDER BY id").all(since) as Ev[]);
	if (scope) rows = rows.filter((r) => r.scope && (r.scope === scope || scopeCovers(r.scope, scope) || scopeCovers(scope, r.scope)));
	if (kinds.length) rows = rows.filter((r) => kinds.includes(r.kind));
	rows = rows.slice(0, limit);
	for (const r of rows) {
		const { sha, note, ...restP } = r.payload ? (JSON.parse(r.payload) as Record<string, string>) : {};
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
		if (cur) db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(latest, as);
		else db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(as, latest);
	}
	if (!rows.length) console.log(dim("(no new events)"));
	} else if (cmd === "wait") {
		// adaptive long-poll: 250ms while events flow, backing off to 2s when
		// idle; resets to fast the moment anything arrives. Near-instant local
		// coordination without a broker daemon.
		const as = arg("--as") ?? die("usage: wait --as <sid> [--scope s] [--kinds a,b] [--max-seconds 30]");
		const scope = arg("--scope");
		const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
		const deadline = Date.now() + Number(arg("--max-seconds") ?? 30) * 1000;
		let interval = 250;
		for (;;) {
			const cur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as { event_id: number } | null)?.event_id ?? 0;
			let rows = db
				.query("SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND (target IS NULL OR target = ?) ORDER BY id")
				.all(cur, as) as Ev[];
			if (scope) rows = rows.filter((r) => r.scope && (r.scope === scope || scopeCovers(r.scope, scope) || scopeCovers(scope, r.scope)));
			if (kinds.length) rows = rows.filter((r) => kinds.includes(r.kind));
			if (rows.length) {
				for (const r of rows) {
					const { sha, note, ...restP } = r.payload ? (JSON.parse(r.payload) as Record<string, string>) : {};
					const extra = Object.entries(restP)
						.map(([k, v]) => `${dim(`${k}=`)}${v}`)
						.join(" ");
					console.log(
						`  ${dim(`#${r.id}`)} ${r.source.slice(0, 8)} ${cyan(r.kind)}${r.scope ? ` ${r.scope}` : ""}${sha ? green(`@${sha.slice(0, 8)}`) : ""}${Object.keys(restP).length ? `  ${extra}` : ""}${note ? dim(` — ${note}`) : ""}`,
					);
				}
				const shownMax = Math.max(...rows.map((r) => r.id));
				if (cur) db.query("UPDATE cursors SET event_id = ? WHERE sid = ?").run(shownMax, as);
				else db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(as, shownMax);
				process.exit(0);
			}
			if (Date.now() > deadline) {
				console.log("(timeout, no events)");
				process.exit(0);
			}
			await new Promise((r) => setTimeout(r, interval));
			interval = Math.min(interval * 2, 2000); // back off while idle; resets by activity above
		}
} else if (cmd === "fact") {
	const sub = rest[0];
	if (sub === "set") {
		const key = rest[1];
		const value = rest[2];
		if (!key || value === undefined) die("usage: fact set <key> <value> [--source s]");
		const src = arg("--source") ?? "coord";
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		).run(key, value, src, Date.now());
		console.log(`fact ${key} = ${value}`);
	} else if (sub === "get") {
		const r = db.query("SELECT value, version, ts FROM facts WHERE key = ?").get(rest[1] ?? "") as
			| { value: string; version: number; ts: number }
			| undefined;
		console.log(r ? `${r.value} (v${r.version})` : "(unset)");
	} else if (sub === "list") {
		const rows = db.query("SELECT key, value, version, ts FROM facts ORDER BY key").all() as {
			key: string; value: string; version: number; ts: number;
		}[];
		console.log(rows.length ? rows.map((r) => `${r.key} = ${r.value}  (v${r.version})`).join("\n") : "(no facts)");
	} else die("usage: fact set <key> <value> | fact get <key> | fact list");
} else if (cmd === "bootstrap") {
	// the session-start ritual: identity + owned work + ready pool + inbox,
	// so no session reconstructs operational state from Markdown
	const as = arg("--as") ?? die("usage: bootstrap --as <sid> [--role r] [--parent sid] [--worktree w] [--caps shell,fs,...]");
	// project identity is always derived (projectIdentity) — no --project
	// override, it would let sessions fragment the graph by hand
	let project = projectIdentity();
	const role = arg("--role") ?? "worker";
	// capability-aware dispatch (v2): --caps csv registers what this agent type
	// offers; lanes inherit the parent's capabilities unless overridden — a
	// NO-SHELL agent type can then never take shell-requiring work twice
	let caps: string | null = arg("--caps") ?? null;
	if (caps) {
		const bad = caps.split(",").filter((c) => !CAPABILITIES.includes(c.trim()));
		if (bad.length) die(`unknown capability: ${bad.join(",")} — vocabulary: ${CAPABILITIES.join(",")}`);
		caps = caps.split(",").map((c) => c.trim()).filter(Boolean).join(",");
	} else {
		const parentSid = arg("--parent");
		if (parentSid) caps = (db.query("SELECT capabilities FROM sessions WHERE sid = ?").get(parentSid) as { capabilities: string | null } | null)?.capabilities ?? null;
	}
	sweepStaleSessions();
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?) ON CONFLICT(sid) DO UPDATE SET project = excluded.project, role = excluded.role, hb = excluded.hb, capabilities = COALESCE(excluded.capabilities, sessions.capabilities)",
	).run(as, project, role, arg("--parent"), arg("--worktree") ?? null, Date.now(), Date.now(), caps);
	const mine = db.query("SELECT id, title, state FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED') ORDER BY id").all(project, as) as { id: string; title: string; state: string }[];
	const readyN = (db.query("SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'").get(project) as { n: number }).n;
	const ncur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as { event_id: number } | null)?.event_id ?? 0;
	const inbox = (db.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?").get(as, ncur) as { n: number }).n;
	const head = (db.query("SELECT value FROM facts WHERE key = 'integration.head'").get() as { value: string } | null)?.value;
	const pname = project.split("/").pop()?.replace(/\.git$/, "") || project.split("/").slice(-2, -1).pop() || project;
	console.log(`SESSION ${as.slice(0, 8)}  project=${pname}  role=${role}`);
	console.log(`OWNED ${mine.length}${mine.length ? `: ${mine.map((w) => `${w.id} ${w.state}`).join(", ")}` : ""}  READY ${readyN}  INBOX ${inbox}${head ? `  head=${head.slice(0, 7)}` : ""}`);
	for (const w of mine) console.log(`  ${cyan(w.id)} ${dim(w.state)} ${w.title.slice(0, 60)}`);
} else if (cmd === "fleet") {
	// one-line fleet projection for a terminal pane (the Desktop panel
	// projection lives in subagent-statusline.ts; the CLI inline rows are
	// harness-owned and ignore it)
	const crows = db.query("SELECT sid, intent FROM claims ORDER BY sid").all() as { sid: string; intent: string | null }[];
	const lanes = [...new Set(crows.map((c) => c.sid))].sort();
	const states = db.query("SELECT key, value FROM facts WHERE key LIKE 'lane.%.state'").all() as { key: string; value: string }[];
	const byKey = new Map(states.map((s) => [s.key, s.value]));
	const names = new Map<string, string>();
	for (const c of crows) {
		if (c.intent && !names.has(c.sid)) names.set(c.sid, c.intent.length > 14 ? `${c.intent.slice(0, 13)}…` : c.intent);
	}
	const head = (db.query("SELECT value FROM facts WHERE key = 'integration.head'").get() as { value: string } | null)?.value;
	const parts = lanes.map((l) => {
		const st = byKey.get(`lane.${l.sid}.state`);
		const g =
			st === "PAUSE_REQUESTED" ? amber("◐") : st === "PAUSED" ? amber("⏸") : st === "RESUME_READY" ? cyan("↻") : st === "BLOCKED" ? red("⚠") : green("▶");
		return `${g} ${dim(names.get(l) ?? l.slice(0, 8))}`;
	});
	console.log(`${head ? `${dim(`@${head.slice(0, 7)}`)}  ` : ""}${parts.join("  ") || dim("(no claimed lanes)")}`);
} else if (cmd === "metrics") {
	// W3 — control-plane metrics: did the fleet actually move fast? Runs per
	// role, per-item wall vs agent time (W15 derivation in govdb.ts), lane
	// dwell in WAIT_RATE / WAIT_DED / PAUSED, conflicts, repairs. Terse table
	// + a facts snapshot fact (metrics.snapshot.<date>) for trend diffing.
	const known = new Set(["--days"]);
	const projArgs: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		projArgs.push(rest[i]);
	}
	const now = Date.now();
	const days = Number(arg("--days") ?? 7);
	const cut = now - days * 86_400_000;
	let project = projectIdentity();
	if (projArgs[0]) {
		const g = Bun.spawnSync(["git", "-C", projArgs[0], "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
		const dir = g.exitCode === 0 ? new TextDecoder().decode(g.stdout).trim() : "";
		project = dir ? realpathSync(resolve(projArgs[0], dir)) : realpathSync(projArgs[0]);
	}
	const name = project.split("/").pop()?.replace(/\.git$/, "") || project.split("/").slice(-2, -1).pop() || project;
	const runs = db.query("SELECT role, COUNT(*) AS n FROM sessions WHERE project = ? AND started_at >= ? GROUP BY role ORDER BY n DESC").all(project, cut) as { role: string; n: number }[];
	console.log(`METRICS ${name} (last ${days}d)`);
	console.log(`  runs: ${runs.reduce((a, r) => a + r.n, 0)}${runs.length ? ` (${runs.map((r) => `${r.n} ${r.role}`).join(", ")})` : ""}`);
	// per-item wall/agent time — the W15 derivation, straight off the bus
	const timing = workTiming(db, project, now).filter((t) => t.lastEvent >= cut || (!t.done && !t.failed));
	const doneItems = timing.filter((t) => t.done && t.firstClaim > 0); // lane work: claimed → done (auto-rollups excluded)
	const openN = timing.filter((t) => !t.done && !t.failed).length;
	const med = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
	const fmt = (ms: number): string => {
		if (!ms) return "—";
		const m = Math.round(ms / 60_000);
		return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
	};
	console.log(`  items: ${doneItems.length} done, ${openN} open — median done item: wall ${fmt(med(doneItems.map((t) => t.wallMs)))}, agent ${fmt(med(doneItems.map((t) => t.agentMs)))}`);
	for (const t of [...timing].sort((a, b) => b.wallMs - a.wallMs).slice(0, 8))
		console.log(`    ${cyan(t.work.padEnd(8))} wall ${fmt(t.wallMs).padStart(6)}  agent ${fmt(t.agentMs).padStart(6)}  ${t.claims} claim${t.claims === 1 ? "" : "s"}${t.failed ? red(" FAILED") : t.done ? "" : amber(" open")}`);
	// dwell: PAUSED windows are evented (paused → resume_ready); WAIT_RATE /
	// WAIT_DED leave no event trail, so ongoing dwell = now − lane.<sid>.state
	// fact ts (the only state history facts keep is their own last ts).
	const dwell: Record<string, { ms: number; n: number; ongoing: number }> = {};
	let pausedBy: Record<string, number> = {};
	for (const e of db.query("SELECT ts, source, kind, target FROM events WHERE kind IN ('pause_requested','paused','resume_ready') AND ts >= ? ORDER BY ts, id").all(cut) as { ts: number; source: string; kind: string; target: string | null }[]) {
		if (e.kind === "paused") pausedBy[e.source] = e.ts;
		else if (e.kind === "resume_ready" && e.target && pausedBy[e.target] != null) {
			const b = (dwell.PAUSED ??= { ms: 0, n: 0, ongoing: 0 });
			b.ms += Math.max(0, e.ts - pausedBy[e.target]);
			b.n++;
			delete pausedBy[e.target];
		}
	}
	for (const f of db.query("SELECT value, ts FROM facts WHERE key LIKE 'lane.%.state' AND value IN ('WAIT_RATE','WAIT_DED','PAUSED')").all() as { value: string; ts: number }[]) {
		const b = (dwell[f.value] ??= { ms: 0, n: 0, ongoing: 0 });
		b.ongoing += Math.max(0, now - f.ts);
	}
	const dwellLine = Object.entries(dwell)
		.filter(([, b]) => b.ms || b.ongoing)
		.map(([k, b]) => `${k}${b.ms ? ` ${fmt(b.ms)}${b.n ? ` (${b.n} win)` : ""}` : ""}${b.ongoing ? ` +${fmt(b.ongoing)} ongoing` : ""}`)
		.join(" · ");
	if (dwellLine) console.log(`  dwell: ${dwellLine}`);
	// friction: conflicts, rework (items claimed >1× — repairs/reclaims), fails
	const conflicts = (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'conflict' AND ts >= ? AND json_extract(payload, '$.project') = ?").get(cut, project) as { n: number }).n;
	const failedQ = "SELECT COUNT(*) AS n FROM events WHERE kind = 'work.failed' AND ts >= ? AND json_extract(payload, '$.project') = ?";
	const failed = (db.query(failedQ).get(cut, project) as { n: number }).n;
	const rework = timing.filter((t) => t.claims > 1).length;
	console.log(`  friction: ${conflicts} conflict event${conflicts === 1 ? "" : "s"}, ${rework} re-claimed item${rework === 1 ? "" : "s"}, ${failed} failed`);
	// snapshot fact for trend diffing across waves
	const snap = {
		ts: now,
		days,
		project,
		runs: runs.reduce((a, r) => a + r.n, 0),
		byRole: Object.fromEntries(runs.map((r) => [r.role, r.n])),
		done: doneItems.length,
		open: openN,
		medianWallMs: med(doneItems.map((t) => t.wallMs)),
		medianAgentMs: med(doneItems.map((t) => t.agentMs)),
		dwell,
		conflicts,
		rework,
		failed,
	};
	const snapKey = `metrics.snapshot.${new Date(now).toISOString().slice(0, 10)}`;
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'coord', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(snapKey, JSON.stringify(snap), now);
	console.log(`  ${dim(`snapshot → ${snapKey}`)}`);
} else if (cmd === "resume-session") {
	// ownership rebind for `claude -c` continuations: the runtime hands the
	// resumed session a fresh id — move ownership forward atomically so the
	// session wakes owning what it owned before (never re-derive from Markdown)
	const as = arg("--as");
	const from = arg("--from");
	if (!as || !from || as === from) die("usage: resume-session --as <new-sid> --from <old-sid>");
	const old = db.query("SELECT project, role, worktree FROM sessions WHERE sid = ?").get(from) as { project: string | null; role: string | null; worktree: string | null } | undefined;
	if (!old) die(`no known session: ${from} — nothing to rebind`);
	const proj = old.project ?? projectIdentity();
	const now = Date.now();
	let wMoved = 0;
	let cMoved = 0;
	let fMoved = 0;
	let eMoved = 0;
	db.transaction(() => {
		wMoved = db.query("UPDATE work_items SET owner_sid = ?, updated_at = ? WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED')").run(as, now, proj, from).changes;
		cMoved = db.query("INSERT INTO claims (sid, scope, intent, hot, ts, tp) SELECT ?, scope, intent, hot, ts, tp FROM claims WHERE sid = ? ON CONFLICT DO NOTHING").run(as, from).changes;
		db.query("DELETE FROM claims WHERE sid = ?").run(from);
		const facts = db.query("SELECT key FROM facts WHERE key LIKE ?").all(`lane.${from}.%`) as { key: string }[];
		for (const f of facts) {
			const nk = f.key.replace(`lane.${from}.`, `lane.${as}.`);
			db.query("INSERT INTO facts (key, value, source, version, ts) SELECT ?, value, source, version + 1, ? FROM facts WHERE key = ? ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts").run(nk, now, f.key);
			db.query("DELETE FROM facts WHERE key = ?").run(f.key);
			fMoved++;
		}
		// unconsumed directed events follow the inbox: everything past the old
		// cursor re-targets the new sid, so pending messages aren't stranded
		const oldCur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(from) as { event_id: number } | null)?.event_id ?? 0;
		eMoved = db.query("UPDATE events SET target = ? WHERE target = ? AND id > ?").run(as, from, oldCur).changes;
		const cur = db.query("SELECT event_id FROM cursors WHERE sid = ?").get(from) as { event_id: number } | null;
		if (cur && !db.query("SELECT 1 FROM cursors WHERE sid = ?").get(as)) db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(as, cur.event_id);
		db.query("UPDATE sessions SET state = 'CLOSED', hb = ? WHERE sid = ?").run(now, from);
		db.query(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING') ON CONFLICT(sid) DO UPDATE SET project = excluded.project, role = excluded.role, parent_sid = excluded.parent_sid, worktree = excluded.worktree, hb = excluded.hb, state = 'RUNNING'",
		).run(as, proj, old.role ?? "worker", from, old.worktree, now, now);
	})();
	console.log(`✓ ${from.slice(0, 8)} → ${as.slice(0, 8)}  work:${wMoved} claims:${cMoved} facts:${fMoved} events:${eMoved} (cursor carried, ${from.slice(0, 8)} CLOSED)`);
} else if (cmd === "who-knows") {
	// contextual expertise: who recently TOUCHED this beats nominal strength
	const scope = arg("--scope");
	const known = new Set(["--scope"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	const q = pos.join(" ");
	if (!q && !scope) die('usage: who-knows "query words" [--scope src/x]');
	const rows = rankExperts(projectIdentity(), q, scope).slice(0, 5);
	console.log(rows.map((r) => `${r.sid.slice(0, 8)}  ${r.score.toFixed(2)}  ${dim(r.hint)}`).join("\n") || dim("(no ranked session — nobody live has touched this)"));
} else if (cmd === "consult") {
	// a question, not work: no claims, no ownership change, no lane state.
	// Fleet-internal transport (event bus); cross-session questions go via
	// native @session messaging with who-knows for discovery.
	const as = arg("--as");
	const scope = arg("--scope");
	const known = new Set(["--as", "--scope", "--best", "--no-kb"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	let expert: string | null = null;
	let question: string;
	if (rest.includes("--best")) {
		question = pos.join(" ");
		const best = rankExperts(projectIdentity(), question, scope, as)[0];
		if (!best) die("no ranked expert — nobody live has touched this");
		expert = best.sid;
	} else {
		expert = pos[0] ?? null;
		question = pos.slice(1).join(" ");
	}
	if (!as) die("consult requires --as <asker-sid>");
	if (!expert || !question) die('usage: consult [--best] "<question>" | consult <sid> <question> [--scope s] --as <asker>');
	if (!db.query("SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING'").get(expert, projectIdentity())) die(`${expert.slice(0, 8)} is not a live session in this project`);
	// knowledge first: an answered consult already in the store answers this
	// without spending an expert round-trip (--no-kb forces live routing)
	const kbHit = rest.includes("--no-kb") ? null : kbLookup(question);
	if (kbHit) {
		const r = db
			.query("INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, answer, created_at, answered_at) VALUES (?, ?, ?, ?, ?, 'KB', ?, ?, ?)")
			.run(projectIdentity(), as, kbHit.answered_by, question, scope, kbHit.solution, Date.now(), Date.now());
		const cid = `C${r.lastInsertRowid}`;
		const expertLive = !!db.query("SELECT 1 FROM sessions WHERE sid = ? AND state = 'RUNNING'").get(kbHit.answered_by);
		db.query("UPDATE consult_kb SET hits = hits + 1, last_hit_at = ? WHERE id = ?").run(Date.now(), kbHit.id);
		db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', ?, ?, ?)").run(
			Date.now(),
			as,
			scope,
			JSON.stringify({ consult: cid, state: "KB", answer: kbHit.solution, kb: { id: kbHit.id, solved_by: kbHit.answered_by, expert_live: expertLive } }),
			as,
		);
		console.log(
			`${green("✓")} ${cyan(cid)} answered from the knowledge base ${dim(`(learned from ${kbHit.answered_by.slice(0, 8)}${expertLive ? ", still live" : ""}, ${kbHit.hits} prior hits) — --no-kb routes to a human`)}`,
		);
	} else {
		const r = db.query("INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)").run(projectIdentity(), as, expert, question, scope, Date.now());
		const cid = `C${r.lastInsertRowid}`;
		db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', ?, ?, ?)").run(Date.now(), as, scope, JSON.stringify({ consult: cid, q: question }), expert);
		console.log(`CONSULT ${cyan(cid)} ${dim("→")} ${expert.slice(0, 8)}`);
	}
} else if (cmd === "consult-reply") {
	const as = arg("--as");
	const known = new Set(["--as", "--decline"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	const decline = rest.includes("--decline");
	const cid = pos[0];
	const text = pos.slice(1).join(" ");
	if (!cid || (!text && !decline) || !as) die('usage: consult-reply <C##> "<answer>" [--decline] --as <expert-sid>');
	const c = db.query("SELECT * FROM consults WHERE id = ? AND project = ?").get(Number(String(cid).replace(/^C/i, "")), projectIdentity()) as { id: number; asker_sid: string; expert_sid: string; state: string } | undefined;
	if (!c) die(`no such consult: ${cid}`);
	if (c.expert_sid !== as) die(`${cid} is addressed to ${String(c.expert_sid).slice(0, 8)}, not you`);
	if (c.state !== "OPEN") die(`${cid} is ${c.state}`);
	const st = decline ? "DECLINED" : "ANSWERED";
	db.query("UPDATE consults SET state = ?, answer = ?, answered_at = ? WHERE id = ?").run(st, decline ? null : text, Date.now(), c.id);
	// harvest: every human answer becomes fleet knowledge — the next asker
	// with the same question resolves without the round-trip
	if (!decline) {
		const kr = db
			.query("INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(c.question, text, projectIdentity(), c.asker_sid, as, c.id, Date.now());
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(kr.lastInsertRowid, c.question);
	}
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', NULL, ?, ?)").run(Date.now(), as, JSON.stringify({ consult: cid, state: st, answer: decline ? null : text }), c.asker_sid);
	console.log(`${st} ${cyan(String(cid))} ${dim("→")} ${String(c.asker_sid).slice(0, 8)}`);
} else if (cmd === "consults") {
	// my consult queue: OPEN questions addressed to me + my recent threads
	const as = arg("--as");
	if (!as) die("usage: consults --as <sid>");
	const rows = db.query("SELECT id, asker_sid, question, state, answer FROM consults WHERE project = ? AND (expert_sid = ? OR asker_sid = ?) ORDER BY id DESC LIMIT 20").all(projectIdentity(), as, as) as { id: number; asker_sid: string; question: string; state: string; answer: string | null }[];
	console.log(
		rows
			.map((r) => {
				const cid = `C${r.id}`;
				if (r.state === "OPEN") return `${red("?")} ${cyan(cid)} ← ${dim(`from ${String(r.asker_sid).slice(0, 8)}`)} ${r.question.slice(0, 60)}`;
				return `${green("✓")} ${cyan(cid)} → ${dim(`asked ${String(r.asker_sid).slice(0, 8)}`)} ${String(r.answer ?? "").slice(0, 60)}`;
			})
			.join("\n") || dim("(no consults)"),
	);
} else if (cmd === "kb") {
	// the fleet's shared memory: what consults have already answered
	const sub = rest[0];
	if (sub === "stats") {
		const tot = (db.query("SELECT COUNT(*) AS n FROM consult_kb").get() as { n: number }).n;
		const hits = (db.query("SELECT COALESCE(SUM(hits), 0) AS n FROM consult_kb").get() as { n: number }).n;
		const byState = db.query("SELECT state, COUNT(*) AS n FROM consults GROUP BY state").all() as { state: string; n: number }[];
		const lat = db.query("SELECT answered_at - created_at AS ms FROM consults WHERE state = 'ANSWERED' AND answered_at IS NOT NULL ORDER BY ms").all() as { ms: number }[];
		const median = lat.length ? lat[Math.floor(lat.length / 2)].ms : 0;
		const s = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
		console.log(`kb: ${tot} solutions · ${hits} repeat questions auto-answered · consults: ${s("OPEN")} open, ${s("ANSWERED")} human, ${s("KB")} via kb, ${s("DECLINED")} declined`);
		if (median && hits) console.log(dim(`median human answer ${Math.round(median / 60000)}min — est. ${Math.round((hits * median) / 60000)}min of round-trips skipped (hits × median)`));
	} else if (sub === "search") {
		const q = rest.slice(1).join(" ");
		if (!q) die('usage: kb search "<query words>" | kb list | kb stats');
		const hit = kbLookup(q);
		if (!hit) {
			console.log(dim("(no kb match)"));
			process.exitCode = 1;
		} else console.log(`${cyan(`kb#${hit.id}`)} ${dim(`learned from ${String(hit.answered_by).slice(0, 8)}, ${hit.hits} hits`)}\n  Q: ${hit.problem}\n  A: ${hit.solution}`);
	} else if (sub === "list") {
		const rows = db.query("SELECT id, problem, solution, answered_by, hits, created_at FROM consult_kb ORDER BY id DESC LIMIT 20").all() as {
			id: number; problem: string; solution: string; answered_by: string; hits: number;
		}[];
		console.log(rows.map((r) => `${cyan(`kb#${r.id}`)} ${dim(String(r.answered_by).slice(0, 8))} ${r.problem.slice(0, 50)} ${dim("→")} ${r.solution.slice(0, 50)}`).join("\n") || dim("(kb empty — answers land here via consult-reply)"));
	} else die('usage: kb stats | kb list | kb search "<query words>"');
} else if (cmd === "doctor-session") {
	// rebind integrity: NO live coordination state may point at a closed
	// predecessor — everything here should be zero after resume-session
	const sid = rest[0];
	if (!sid) die("usage: doctor-session <sid>");
	const s = db.query("SELECT project, parent_sid FROM sessions WHERE sid = ?").get(sid) as { project: string | null; parent_sid: string | null } | undefined;
	if (!s) die(`no session: ${sid}`);
	const issues: string[] = [];
	const old = s.parent_sid;
	if (old) {
		const w = (db.query("SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED')").get(s.project, old) as { n: number }).n;
		if (w) issues.push(`${w} work items still owned by ${old.slice(0, 8)}`);
		const c = (db.query("SELECT COUNT(*) AS n FROM claims WHERE sid = ?").get(old) as { n: number }).n;
		if (c) issues.push(`${c} claims still on ${old.slice(0, 8)}`);
		const ncur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as { event_id: number } | null)?.event_id ?? 0;
		const e = (db.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?").get(old, ncur) as { n: number }).n;
		if (e) issues.push(`${e} unconsumed events still addressed to ${old.slice(0, 8)}`);
		const f = (db.query("SELECT COUNT(*) AS n FROM facts WHERE key LIKE ?").get(`lane.${old}.%`) as { n: number }).n;
		if (f) issues.push(`${f} lane facts still keyed ${old.slice(0, 8)}`);
	}
	console.log(issues.length ? `RESIDUE ${sid.slice(0, 8)}: ${issues.join("; ")}` : `✓ ${sid.slice(0, 8)} clean${old ? ` (lineage ${old.slice(0, 8)})` : ""}`);
} else if (cmd === "diff") {
	// W33 — the row-image read model: sessions/claims/locks/facts/work_items
	// mutate in place; the `deltas` trigger log is what makes "what actually
	// changed between two points" answerable. --since takes a deltas seq, an
	// events id (e<N> — or a bare number unknown to deltas), and resolves it
	// to the nearest strictly-later seq by ts. Terse per-table lines;
	// --json for machines.
	if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deltas'").get())
		die("no delta log in governor.db — open the DB once via openGovernorDb() to install the v5 triggers");
	const sinceArg = arg("--since");
	const tbl = arg("--table");
	const last = Math.max(1, Number(arg("--last") ?? 50));
	const wantJson = rest.includes("--json");
	const resolveSince = (s: string): { from: number; label: string } => {
		const byEvent = (id: number): { from: number; label: string } => {
			const ev = db.query("SELECT ts FROM events WHERE id = ?").get(id) as { ts: number } | undefined;
			if (!ev) die(`--since: no event #${id}`);
			// strictly later: a delta written in the event's own ms is history
			const nxt = db.query("SELECT seq FROM deltas WHERE ts > ? ORDER BY ts, seq LIMIT 1").get(ev.ts) as
				| { seq: number }
				| undefined;
			return { from: nxt ? nxt.seq - 1 : Number.MAX_SAFE_INTEGER, label: `event #${id}` };
		};
		const evM = /^e(?:v)?(\d+)$/i.exec(s);
		if (evM) return byEvent(Number(evM[1]));
		if (!/^\d+$/.test(s)) die(`bad --since ${s} — want a deltas seq or an event id (42 or e42)`);
		const n = Number(s);
		if (db.query("SELECT 1 FROM deltas WHERE seq = ?").get(n)) return { from: n, label: `seq ${n}` };
		return byEvent(n); // unknown to deltas → try the bus
	};
	const { from, label } = sinceArg == null ? { from: 0, label: "start" } : resolveSince(sinceArg);
	const where = tbl ? "seq > ? AND tbl = ?" : "seq > ?";
	const params: (number | string)[] = tbl ? [from, tbl] : [from];
	const tot = db.query(`SELECT COUNT(*) AS n, COUNT(DISTINCT tbl) AS t FROM deltas WHERE ${where}`).get(...params) as {
		n: number;
		t: number;
	};
	const rows = (db
		.query(`SELECT seq, ts, tbl, op, pk, before, after FROM deltas WHERE ${where} ORDER BY seq DESC LIMIT ?`)
		.all(...params, last) as DeltaRow[]).reverse();
	// terse rendering: table  pk  op-glyph  changed-fields ("old→new"; a null
	// old prints as "field new"). Timeish fields (_at/ts/hb) render as HH:MM.
	const short = (s: string): string => (s.length > 24 ? `${s.slice(0, 23)}…` : s);
	const hhmm = (ms: number): string => {
		const d = new Date(ms);
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	};
	const val = (v: unknown): string => {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		return !s ? "null" : s.length > 24 ? `${s.slice(0, 23)}…` : s;
	};
	const TIMEISH = /(_at$|^ts$|^hb$)/;
	const detail = (b: string | null, a: string | null): string => {
		if (!b || !a) return "";
		let bo: Record<string, unknown>;
		let ao: Record<string, unknown>;
		try {
			bo = JSON.parse(b);
			ao = JSON.parse(a);
		} catch {
			return "";
		}
		const changed = Object.keys(ao).filter((k) => JSON.stringify(bo[k]) !== JSON.stringify(ao[k]));
		return (
			changed.slice(0, 4).map((k) => {
				const o = bo[k];
				const n = ao[k];
				if (TIMEISH.test(k) && typeof n === "number" && n > 1e12)
					return `${k} ${typeof o === "number" && o > 1e12 ? `${hhmm(o)}→` : ""}${hhmm(n)}`;
				return o == null ? `${k} ${val(n)}` : `${k} ${val(o)}→${val(n)}`;
			}).join(", ") + (changed.length > 4 ? ` +${changed.length - 4} more` : "")
		);
	};
	// pk display: sids truncate to the house 8-char style; work-item pks carry
	// an absolute project path — collapse to …<repo>/<id>
	const pkShow = (t: string, pk: string): string => {
		if (t === "sessions") return `${pk.slice(0, 8)}…`;
		if (t === "work_items" && pk.includes("/")) {
			const i = pk.lastIndexOf("/");
			return `…${pk.slice(0, i).split("/").pop()?.replace(/\.git$/, "")}/${pk.slice(i + 1)}`;
		}
		return short(pk);
	};
	const glyph = (op: string): string => (op === "insert" ? green("+") : op === "delete" ? red("-") : cyan("~"));
	const img = (s: string | null): unknown => {
		try {
			return s == null ? null : JSON.parse(s);
		} catch {
			return s;
		}
	};
	if (wantJson) {
		console.log(
			JSON.stringify({
				since: label,
				total: tot.n,
				tables: tot.t,
				shown: rows.length,
				changes: rows.map((r) => ({ seq: r.seq, ts: r.ts, tbl: r.tbl, op: r.op, pk: r.pk, before: img(r.before), after: img(r.after) })),
			}),
		);
	} else {
		for (const r of rows)
			console.log(`${r.tbl.padEnd(11)} ${dim(pkShow(r.tbl, r.pk))} ${glyph(r.op)} ${detail(r.before, r.after)}`.trimEnd());
		console.log(
			dim(
				`${tot.n} change${tot.n === 1 ? "" : "s"} across ${tot.t} table${tot.t === 1 ? "" : "s"}${sinceArg != null ? ` since ${label}` : ""}${rows.length < tot.n ? ` — last ${rows.length} shown` : ""}`,
			),
		);
	}
} else if (cmd === "gc") {
	// retention: events + closed sessions + their cursors age out; terminal
	// work items are the ledger and are NEVER auto-deleted
	const days = Number(arg("--days") ?? 30);
	const cut = Date.now() - days * 86_400_000;
	const e = db.query("DELETE FROM events WHERE ts < ?").run(cut).changes;
	const s = db.query("DELETE FROM sessions WHERE state = 'CLOSED' AND hb < ?").run(cut).changes;
	const c = db.query("DELETE FROM cursors WHERE sid NOT IN (SELECT sid FROM sessions)").run().changes;
	const f = db.query("DELETE FROM facts WHERE key LIKE 'lane.%' AND ts < ?").run(cut).changes;
	// consults: open questions expire after 1h; closed threads age out
	const x = db.query("UPDATE consults SET state = 'EXPIRED', answered_at = ? WHERE state = 'OPEN' AND created_at < ?").run(Date.now(), Date.now() - 3_600_000).changes;
	const cd = db.query("DELETE FROM consults WHERE state IN ('ANSWERED','DECLINED','EXPIRED') AND answered_at < ? AND answered_at IS NOT NULL").run(cut).changes;
	const sw = sweepStaleSessions();
	const lk = db.query("DELETE FROM locks WHERE ts < ?").run(Date.now() - 15 * 60_000).changes;
	const d = pruneDeltas(db, days * 86_400_000);
	console.log(`gc: ${e} events, ${s} closed sessions, ${sw} stale RUNNING sessions swept, ${lk} expired locks, ${c} stale cursors, ${f} lane facts, ${x} consults expired, ${cd} consult threads pruned, ${d} deltas (>${days}d; work ledger untouched)`);
} else {
	die("unknown command — try emit | poll | wait | fact | bootstrap | state | inbox | capsule | pause | paused | resume | resumed | resume-session | doctor-session | who-knows | consult | consult-reply | consults | kb | lease-release | gc | fleet | metrics | diff");
}

function scopeCovers(a: string, b: string): boolean {
	if (a === b) return true;
	const pa = a.replace(/\/\*\*?$/, "");
	const pb = b.replace(/\/\*\*?$/, "");
	return pa !== a && (b.startsWith(`${pa}/`) || b === pa);
}

// liveness sweep: RUNNING + heartbeat stale + NO live transcript = a process
// that died without SessionEnd. hb alone is not evidence — it only updates on
// bootstrap — but an active session writes its transcript continuously, so
// transcript-dead is the real signal for TOP-LEVEL sessions. LANES (parented
// rows) have no transcript of their own, so they close only after 24h stale —
// their real liveness design is backlog W9. Swept sessions keep owned work.
function sweepStaleSessions(maxIdleMs = 20 * 60_000): number {
	const now = Date.now();
	let n = 0;
	const rows = db.query("SELECT sid FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NULL AND hb < ?").all(now - maxIdleMs) as { sid: string }[];
	for (const r of rows) {
		if (liveTranscript(r.sid)) continue;
		db.query("UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'").run(r.sid);
		n++;
	}
	const lanes = db.query("SELECT sid FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NOT NULL AND hb < ?").all(now - 24 * 3_600_000) as { sid: string }[];
	for (const r of lanes) {
		db.query("UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'").run(r.sid);
		n++;
	}
	return n;
}

function liveTranscript(sid: string): boolean {
	const floor = Date.now() - 15 * 60_000;
	try {
		const glob = new Bun.Glob(`**/*${sid}*.jsonl`);
		for (const rel of glob.scanSync({ cwd: `${process.env.HOME}/.claude/projects`, onlyFiles: true })) {
			const f = `${process.env.HOME}/.claude/projects/${rel}`;
			try {
				if (statSync(f).mtimeMs > floor) return true;
			} catch {}
		}
	} catch {}
	return false;
}

// contextual expertise ranking for who-knows / consult --best. Score =
// claims 40% / recent DONE work 25% / recent scope touches 20% / role 10% /
// heartbeat recency 5%. Only live sessions in the project.
function rankExperts(project: string, q: string, scope: string | null, excludeSid?: string): { sid: string; score: number; hint: string }[] {
	const toks = [...new Set([...(scope ?? "").split(/[^a-z0-9_.]+/), ...q.toLowerCase().split(/[^a-z0-9_.]+/)].filter((t) => t.length > 2))];
	const now = Date.now();
	const live = db.query("SELECT sid, role, hb FROM sessions WHERE project = ? AND state = 'RUNNING'").all(project) as { sid: string; role: string; hb: number }[];
	const hits = (hay: string): number => toks.reduce((n, t) => n + (hay.toLowerCase().includes(t) ? 1 : 0), 0);
	const rows: { sid: string; score: number; hint: string }[] = [];
	for (const s of live) {
		if (excludeSid && s.sid === excludeSid) continue;
		const claims = db.query("SELECT scope, intent FROM claims WHERE sid = ?").all(s.sid) as { scope: string; intent: string | null }[];
		let claimN = 0;
		let hint = "";
		for (const c of claims) {
			let m = hits(`${c.scope} ${c.intent ?? ""}`);
			if (scope && scopeCovers(c.scope, scope)) m = Math.max(m, 3);
			if (m > claimN) {
				claimN = m;
				hint = c.intent ?? c.scope;
			}
		}
		const done = db.query("SELECT title FROM work_items WHERE project = ? AND owner_sid = ? AND state = 'DONE' AND updated_at > ?").all(project, s.sid, now - 6 * 3_600_000) as { title: string }[];
		let workN = 0;
		for (const d of done) {
			const m = hits(d.title);
			if (m > workN) {
				workN = m;
				hint = hint || d.title;
			}
		}
		const touches = db.query("SELECT scope FROM events WHERE source = ? AND ts > ? AND scope IS NOT NULL").all(s.sid, now - 6 * 3_600_000) as { scope: string | null }[];
		const touchN = touches.reduce((n, t) => Math.max(n, hits(t.scope ?? "")), 0);
		const roleN = s.role === "coordinator" ? 1 : 0;
		const rec = Math.max(0, 1 - (now - s.hb) / (30 * 60_000));
		const score = 0.4 * Math.min(1, claimN / 3) + 0.25 * Math.min(1, workN / 2) + 0.2 * Math.min(1, touchN / 2) + 0.1 * roleN + 0.05 * rec;
		if (score > 0.02) rows.push({ sid: s.sid, score, hint: hint.slice(0, 50) });
	}
	return rows.sort((a, b) => b.score - a.score);
}
