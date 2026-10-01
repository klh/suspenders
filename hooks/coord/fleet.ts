// hooks/coord/fleet.ts — fleet-wide reads: bootstrap, fleet, metrics, doctor-session, diff (W157 command modules).
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
	red,
	projectIdentity,
	CAPABILITIES,
	workTiming,
	tokenUsage,
	sweepStaleSessions,
	realpathSync,
	resolve,
} from "./shared.ts";
import type { Database } from "./shared.ts";

export async function cmdBootstrap(rest: string[]): Promise<void> {
	// the session-start ritual: identity + owned work + ready pool + inbox,
	// so no session reconstructs operational state from Markdown
	const as =
		arg("--as") ??
		die(
			"usage: bootstrap --as <sid> [--role r] [--parent sid] [--worktree w] [--caps shell,fs,...] [--actor id] [--tags json]",
		);
	// project identity is always derived (projectIdentity) — no --project
	// override, it would let sessions fragment the graph by hand
	const project = projectIdentity();
	const role = arg("--role") ?? "worker";
	// capability-aware dispatch (v2): --caps csv registers what this agent type
	// offers; lanes inherit the parent's capabilities unless overridden — a
	// NO-SHELL agent type can then never take shell-requiring work twice
	let caps: string | null = arg("--caps") ?? null;
	if (caps) {
		const bad = caps.split(",").filter((c) => !CAPABILITIES.includes(c.trim()));
		if (bad.length)
			die(
				`unknown capability: ${bad.join(",")} — vocabulary: ${CAPABILITIES.join(",")}`,
			);
		caps = caps
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean)
			.join(",");
	} else {
		const parentSid = arg("--parent");
		if (parentSid)
			caps =
				(
					db
						.query("SELECT capabilities FROM sessions WHERE sid = ?")
						.get(parentSid) as { capabilities: string | null } | null
				)?.capabilities ?? null;
	}
	// W127 usage attribution: actor = user/license id, tags = JSON ({team,
	// department, ...}). COALESCE on conflict keeps the first stamp across
	// re-bootstraps, same trust class as capabilities.
	const actor: string | null = arg("--actor") ?? null;
	let tags: string | null = arg("--tags") ?? null;
	if (tags) {
		try {
			tags = JSON.stringify(JSON.parse(tags));
		} catch {
			die("--tags must be valid JSON");
		}
	}
	// liveness sweeps read THIS host's transcript tree — a remote lane's view
	// would close live sessions it cannot see; sweeping stays a host concern
	if (db.local) sweepStaleSessions(db as Database);
	db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, actor, tags) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET project = excluded.project, role = excluded.role, hb = excluded.hb, capabilities = COALESCE(excluded.capabilities, sessions.capabilities), actor = COALESCE(excluded.actor, sessions.actor), tags = COALESCE(excluded.tags, sessions.tags)",
	).run(
		as,
		project,
		role,
		arg("--parent"),
		arg("--worktree") ?? null,
		Date.now(),
		Date.now(),
		caps,
		actor,
		tags,
	);
	const mine = db
		.query(
			"SELECT id, title, state FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED') ORDER BY id",
		)
		.all(project, as) as { id: string; title: string; state: string }[];
	const readyN = (
		db
			.query(
				"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
			)
			.get(project) as { n: number }
	).n;
	const ncur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const inbox = (
		db
			.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
			.get(as, ncur) as { n: number }
	).n;
	const head = (
		db
			.query("SELECT value FROM facts WHERE key = 'integration.head'")
			.get() as { value: string } | null
	)?.value;
	const pname =
		project
			.split("/")
			.pop()
			?.replace(/\.git$/, "") ||
		project.split("/").slice(-2, -1).pop() ||
		project;
	console.log(`SESSION ${as.slice(0, 8)}  project=${pname}  role=${role}`);
	console.log(
		`OWNED ${mine.length}${mine.length ? `: ${mine.map((w) => `${w.id} ${w.state}`).join(", ")}` : ""}  READY ${readyN}  INBOX ${inbox}${head ? `  head=${head.slice(0, 7)}` : ""}`,
	);
	for (const w of mine)
		console.log(`  ${cyan(w.id)} ${dim(w.state)} ${w.title.slice(0, 60)}`);
}

export async function cmdFleet(rest: string[]): Promise<void> {
	// one-line fleet projection for a terminal pane (the Desktop panel
	// projection lives in subagent-statusline.ts; the CLI inline rows are
	// harness-owned and ignore it)
	const crows = db
		.query("SELECT sid, intent FROM claims ORDER BY sid")
		.all() as { sid: string; intent: string | null }[];
	const lanes = [...new Set(crows.map((c) => c.sid))].sort();
	const states = db
		.query("SELECT key, value FROM facts WHERE key LIKE 'lane.%.state'")
		.all() as { key: string; value: string }[];
	const byKey = new Map(states.map((s) => [s.key, s.value]));
	const names = new Map<string, string>();
	for (const c of crows) {
		if (c.intent && !names.has(c.sid))
			names.set(
				c.sid,
				c.intent.length > 14 ? `${c.intent.slice(0, 13)}…` : c.intent,
			);
	}
	const head = (
		db
			.query("SELECT value FROM facts WHERE key = 'integration.head'")
			.get() as { value: string } | null
	)?.value;
	const parts = lanes.map((l) => {
		const st = byKey.get(`lane.${l.sid}.state`);
		const g =
			st === "PAUSE_REQUESTED"
				? amber("◐")
				: st === "PAUSED"
					? amber("⏸")
					: st === "RESUME_READY"
						? cyan("↻")
						: st === "BLOCKED"
							? red("⚠")
							: green("▶");
		return `${g} ${dim(names.get(l) ?? l.slice(0, 8))}`;
	});
	console.log(
		`${head ? `${dim(`@${head.slice(0, 7)}`)}  ` : ""}${parts.join("  ") || dim("(no claimed lanes)")}`,
	);
}

export async function cmdMetrics(rest: string[]): Promise<void> {
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
		const g = Bun.spawnSync(
			["git", "-C", projArgs[0], "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const dir =
			g.exitCode === 0 ? new TextDecoder().decode(g.stdout).trim() : "";
		project = dir
			? realpathSync(resolve(projArgs[0], dir))
			: realpathSync(projArgs[0]);
	}
	const name =
		project
			.split("/")
			.pop()
			?.replace(/\.git$/, "") ||
		project.split("/").slice(-2, -1).pop() ||
		project;
	const runs = db
		.query(
			"SELECT role, COUNT(*) AS n FROM sessions WHERE project = ? AND started_at >= ? GROUP BY role ORDER BY n DESC",
		)
		.all(project, cut) as { role: string; n: number }[];
	console.log(`METRICS ${name} (last ${days}d)`);
	console.log(
		`  runs: ${runs.reduce((a, r) => a + r.n, 0)}${runs.length ? ` (${runs.map((r) => `${r.n} ${r.role}`).join(", ")})` : ""}`,
	);
	// per-item wall/agent time — the W15 derivation, straight off the bus
	const timing = workTiming(db as Database, project, now).filter(
		(t) => t.lastEvent >= cut || (!t.done && !t.failed),
	);
	const doneItems = timing.filter((t) => t.done && t.firstClaim > 0); // lane work: claimed → done (auto-rollups excluded)
	const openN = timing.filter((t) => !t.done && !t.failed).length;
	const med = (xs: number[]): number =>
		xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
	const fmt = (ms: number): string => {
		if (!ms) return "—";
		const m = Math.round(ms / 60_000);
		return m >= 60
			? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
			: `${m}m`;
	};
	console.log(
		`  items: ${doneItems.length} done, ${openN} open — median done item: wall ${fmt(med(doneItems.map((t) => t.wallMs)))}, agent ${fmt(med(doneItems.map((t) => t.agentMs)))}`,
	);
	// W24 — usage per task: windowed transcript tokens per item. Approximation —
	// attribution is by claim-window overlap in time, not causality (a session
	// working several items serially shares its transcript across windows).
	const tokens = tokenUsage(db as Database, project, now);
	const shown = [...timing].sort((a, b) => b.wallMs - a.wallMs).slice(0, 8);
	const fmtTok = (n: number): string =>
		n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${Math.round(n / 1e3)}k`
				: `${n}`;
	let sumIn = 0;
	let sumOut = 0;
	let tokN = 0;
	for (const t of shown) {
		const k = tokens.get(t.work);
		if (k) {
			tokN++;
			sumIn += k.in + k.cacheR + k.cacheC;
			sumOut += k.out;
		}
		const tok = k ? fmtTok(k.in + k.out + k.cacheR + k.cacheC) : "-";
		console.log(
			`    ${cyan(t.work.padEnd(8))} wall ${fmt(t.wallMs).padStart(6)}  agent ${fmt(t.agentMs).padStart(6)}  tok ${tok.padStart(6)}  ${t.claims} claim${t.claims === 1 ? "" : "s"}${t.failed ? red(" FAILED") : t.done ? "" : amber(" open")}`,
		);
	}
	if (shown.length)
		console.log(
			`  tokens (approx, window-attributed): in ${tokN ? fmtTok(sumIn) : "-"} · out ${tokN ? fmtTok(sumOut) : "-"} across ${shown.length} shown items`,
		);
	// dwell: PAUSED windows are evented (paused → resume_ready); WAIT_RATE /
	// WAIT_DED leave no event trail, so ongoing dwell = now − lane.<sid>.state
	// fact ts (the only state history facts keep is their own last ts).
	const dwell: Record<string, { ms: number; n: number; ongoing: number }> = {};
	const pausedBy: Record<string, number> = {};
	for (const e of db
		.query(
			"SELECT ts, source, kind, target FROM events WHERE kind IN ('pause_requested','paused','resume_ready') AND ts >= ? ORDER BY ts, id",
		)
		.all(cut) as {
		ts: number;
		source: string;
		kind: string;
		target: string | null;
	}[]) {
		if (e.kind === "paused") pausedBy[e.source] = e.ts;
		else if (
			e.kind === "resume_ready" &&
			e.target &&
			pausedBy[e.target] != null
		) {
			if (!dwell.PAUSED) dwell.PAUSED = { ms: 0, n: 0, ongoing: 0 };
			const b = dwell.PAUSED;
			b.ms += Math.max(0, e.ts - pausedBy[e.target]);
			b.n++;
			delete pausedBy[e.target];
		}
	}
	for (const f of db
		.query(
			"SELECT value, ts FROM facts WHERE key LIKE 'lane.%.state' AND value IN ('WAIT_RATE','WAIT_DED','PAUSED')",
		)
		.all() as { value: string; ts: number }[]) {
		if (!dwell[f.value]) dwell[f.value] = { ms: 0, n: 0, ongoing: 0 };
		const b = dwell[f.value];
		b.ongoing += Math.max(0, now - f.ts);
	}
	const dwellLine = Object.entries(dwell)
		.filter(([, b]) => b.ms || b.ongoing)
		.map(
			([k, b]) =>
				`${k}${b.ms ? ` ${fmt(b.ms)}${b.n ? ` (${b.n} win)` : ""}` : ""}${b.ongoing ? ` +${fmt(b.ongoing)} ongoing` : ""}`,
		)
		.join(" · ");
	if (dwellLine) console.log(`  dwell: ${dwellLine}`);
	// friction: conflicts, rework (items claimed >1× — repairs/reclaims), fails
	const conflicts = (
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'conflict' AND ts >= ? AND json_extract(payload, '$.project') = ?",
			)
			.get(cut, project) as { n: number }
	).n;
	const failedQ =
		"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.failed' AND ts >= ? AND json_extract(payload, '$.project') = ?";
	const failed = (db.query(failedQ).get(cut, project) as { n: number }).n;
	const rework = timing.filter((t) => t.claims > 1).length;
	console.log(
		`  friction: ${conflicts} conflict event${conflicts === 1 ? "" : "s"}, ${rework} re-claimed item${rework === 1 ? "" : "s"}, ${failed} failed`,
	);
	// self-serve: consults the plane resolved without spending a human's context
	const selfServe = db
		.query(
			"SELECT state, COUNT(*) AS n FROM consults WHERE project = ? AND answered_at >= ? AND state IN ('KB','LESSON') GROUP BY state",
		)
		.all(project, cut) as {
		state: string;
		n: number;
	}[];
	const kbN = selfServe.find((s) => s.state === "KB")?.n ?? 0;
	const lessonN = selfServe.find((s) => s.state === "LESSON")?.n ?? 0;
	console.log(
		`  self-serve: ${kbN} kb + ${lessonN} lesson answer${lessonN === 1 ? "" : "s"} (no expert round-trip)`,
	);
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
}

export async function cmdDoctorSession(rest: string[]): Promise<void> {
	// rebind integrity: NO live coordination state may point at a closed
	// predecessor — everything here should be zero after resume-session
	const sid = rest[0];
	if (!sid) die("usage: doctor-session <sid>");
	const s = db
		.query("SELECT project, parent_sid FROM sessions WHERE sid = ?")
		.get(sid) as
		| { project: string | null; parent_sid: string | null }
		| undefined;
	if (!s) die(`no session: ${sid}`);
	const issues: string[] = [];
	const old = s.parent_sid;
	if (old) {
		const w = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED')",
				)
				.get(s.project, old) as { n: number }
		).n;
		if (w) issues.push(`${w} work items still owned by ${old.slice(0, 8)}`);
		const c = (
			db.query("SELECT COUNT(*) AS n FROM claims WHERE sid = ?").get(old) as {
				n: number;
			}
		).n;
		if (c) issues.push(`${c} claims still on ${old.slice(0, 8)}`);
		const ncur =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		const e = (
			db
				.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
				.get(old, ncur) as { n: number }
		).n;
		if (e)
			issues.push(
				`${e} unconsumed events still addressed to ${old.slice(0, 8)}`,
			);
		const f = (
			db
				.query("SELECT COUNT(*) AS n FROM facts WHERE key LIKE ?")
				.get(`lane.${old}.%`) as { n: number }
		).n;
		if (f) issues.push(`${f} lane facts still keyed ${old.slice(0, 8)}`);
	}
	console.log(
		issues.length
			? `RESIDUE ${sid.slice(0, 8)}: ${issues.join("; ")}`
			: `✓ ${sid.slice(0, 8)} clean${old ? ` (lineage ${old.slice(0, 8)})` : ""}`,
	);
}

export async function cmdDiff(rest: string[]): Promise<void> {
	// W33 — the row-image read model: sessions/claims/locks/facts/work_items
	// mutate in place; the `deltas` trigger log is what makes "what actually
	// changed between two points" answerable. --since takes a deltas seq, an
	// events id (e<N> — or a bare number unknown to deltas), and resolves it
	// to the nearest strictly-later seq by ts. Terse per-table lines;
	// --json for machines.
	if (
		!db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deltas'",
			)
			.get()
	)
		die(
			"no delta log in governor.db — open the DB once via openGovernorDb() to install the v5 triggers",
		);
	const sinceArg = arg("--since");
	const tbl = arg("--table");
	const last = Math.max(1, Number(arg("--last") ?? 50));
	const wantJson = rest.includes("--json");
	const resolveSince = (s: string): { from: number; label: string } => {
		const byEvent = (id: number): { from: number; label: string } => {
			const ev = db.query("SELECT ts FROM events WHERE id = ?").get(id) as
				| { ts: number }
				| undefined;
			if (!ev) die(`--since: no event #${id}`);
			// strictly later: a delta written in the event's own ms is history
			const nxt = db
				.query("SELECT seq FROM deltas WHERE ts > ? ORDER BY ts, seq LIMIT 1")
				.get(ev.ts) as { seq: number } | undefined;
			return {
				from: nxt ? nxt.seq - 1 : Number.MAX_SAFE_INTEGER,
				label: `event #${id}`,
			};
		};
		const evM = /^e(?:v)?(\d+)$/i.exec(s);
		if (evM) return byEvent(Number(evM[1]));
		if (!/^\d+$/.test(s))
			die(`bad --since ${s} — want a deltas seq or an event id (42 or e42)`);
		const n = Number(s);
		if (db.query("SELECT 1 FROM deltas WHERE seq = ?").get(n))
			return { from: n, label: `seq ${n}` };
		return byEvent(n); // unknown to deltas → try the bus
	};
	const { from, label } =
		sinceArg == null ? { from: 0, label: "start" } : resolveSince(sinceArg);
	const where = tbl ? "seq > ? AND tbl = ?" : "seq > ?";
	const params: (number | string)[] = tbl ? [from, tbl] : [from];
	const tot = db
		.query(
			`SELECT COUNT(*) AS n, COUNT(DISTINCT tbl) AS t FROM deltas WHERE ${where}`,
		)
		.get(...params) as {
		n: number;
		t: number;
	};
	const rows = (
		db
			.query(
				`SELECT seq, ts, tbl, op, pk, before, after FROM deltas WHERE ${where} ORDER BY seq DESC LIMIT ?`,
			)
			.all(...params, last) as DeltaRow[]
	).reverse();
	// terse rendering: table  pk  op-glyph  changed-fields ("old→new"; a null
	// old prints as "field new"). Timeish fields (_at/ts/hb) render as HH:MM.
	const short = (s: string): string =>
		s.length > 24 ? `${s.slice(0, 23)}…` : s;
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
		const changed = Object.keys(ao).filter(
			(k) => JSON.stringify(bo[k]) !== JSON.stringify(ao[k]),
		);
		return (
			changed
				.slice(0, 4)
				.map((k) => {
					const o = bo[k];
					const n = ao[k];
					if (TIMEISH.test(k) && typeof n === "number" && n > 1e12)
						return `${k} ${typeof o === "number" && o > 1e12 ? `${hhmm(o)}→` : ""}${hhmm(n)}`;
					return o == null ? `${k} ${val(n)}` : `${k} ${val(o)}→${val(n)}`;
				})
				.join(", ") + (changed.length > 4 ? ` +${changed.length - 4} more` : "")
		);
	};
	// pk display: sids truncate to the house 8-char style; work-item pks carry
	// an absolute project path — collapse to …<repo>/<id>
	const pkShow = (t: string, pk: string): string => {
		if (t === "sessions") return `${pk.slice(0, 8)}…`;
		if (t === "work_items" && pk.includes("/")) {
			const i = pk.lastIndexOf("/");
			return `…${pk
				.slice(0, i)
				.split("/")
				.pop()
				?.replace(/\.git$/, "")}/${pk.slice(i + 1)}`;
		}
		return short(pk);
	};
	const glyph = (op: string): string =>
		op === "insert" ? green("+") : op === "delete" ? red("-") : cyan("~");
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
				changes: rows.map((r) => ({
					seq: r.seq,
					ts: r.ts,
					tbl: r.tbl,
					op: r.op,
					pk: r.pk,
					before: img(r.before),
					after: img(r.after),
				})),
			}),
		);
	} else {
		for (const r of rows)
			console.log(
				`${r.tbl.padEnd(11)} ${dim(pkShow(r.tbl, r.pk))} ${glyph(r.op)} ${detail(r.before, r.after)}`.trimEnd(),
			);
		console.log(
			dim(
				`${tot.n} change${tot.n === 1 ? "" : "s"} across ${tot.t} table${tot.t === 1 ? "" : "s"}${sinceArg != null ? ` since ${label}` : ""}${rows.length < tot.n ? ` — last ${rows.length} shown` : ""}`,
			),
		);
	}
}
