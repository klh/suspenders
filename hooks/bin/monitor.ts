// monitor.ts — control-plane health check. Read-only by default; --fix
// applies only SAFE, deterministic repairs. Exit 1 if issues remain.
//
// PRINCIPLE (learned 2026-09-24 the hard way): never auto-fix based on an
// identity we cannot resolve. Lane NAMES (visual-chain, bare-suite2…) have no
// transcript of their own — subagent transcripts are agent-<uuid>.jsonl — so
// transcript-liveness is only decidable for TOP-LEVEL session sids. Checks
// here are therefore ts-based or pure-DB; ownership liveness for lanes is a
// known blind spot (backlog W9), surfaced by `work orphaned` instead.
// usage: bun ~/.claude/bin/monitor.ts [--fix]
import { statSync } from "node:fs";
import { openGovernorDb } from "../lib/govdb.ts";

const db = openGovernorDb();
const now = Date.now();
const fix = process.argv.includes("--fix");
// published coordinator identity (coord fact set coordinator.sid) — the
// authority for coordinator exemptions, above the misrecordable role column
const coordinatorSid =
	(db.query("SELECT value FROM facts WHERE key = 'coordinator.sid'").get() as { value: string } | null)?.value ?? null;
const issues: string[] = [];
const fixed: string[] = [];

// 0. "waiting for you": lanes with an OPEN decision addressed to them —
// board-owned `decisions` table in this same governor.db, queried read-only
// (CREATE TABLE is the board's job; a missing table just means the board
// never ran — nothing to exempt). Waiting is an alert class of its own,
// distinct from ZOMBIE/SUSPECT/UNKNOWN, and never swept.
const waiting = new Map<string, number>();
try {
	for (const r of db.query("SELECT answer_to AS sid, COUNT(*) AS n FROM decisions WHERE state = 'OPEN' AND answer_to IS NOT NULL GROUP BY answer_to").all() as { sid: string; n: number }[])
		waiting.set(r.sid, r.n);
} catch {} // no decisions table yet

// 1. stale RUNNING sessions with dead transcripts (session sids ARE
// transcript filenames — decidable for TOP-LEVEL sessions only; lanes close
// at 24h, their real liveness is backlog W9)
for (const s of db.query("SELECT sid, role, hb FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NULL AND hb < ?").all(now - 20 * 60_000) as {
	sid: string; role: string; hb: number;
}[]) {
	let live = false;
	try {
		const glob = new Bun.Glob(`**/*${s.sid}*.jsonl`);
		for (const rel of glob.scanSync({ cwd: `${process.env.HOME}/.claude/projects`, onlyFiles: true })) {
			try {
				if (statSync(`${process.env.HOME}/.claude/projects/${rel}`).mtimeMs > now - 15 * 60_000) {
					live = true;
					break;
				}
			} catch {}
		}
	} catch {}
	if (!live) {
		if (waiting.has(s.sid)) {
			// waiting on a human, not dead — surfaced, never swept
			const n = waiting.get(s.sid) ?? 0;
			console.log(`WAITING session ${s.sid.slice(0, 8)} — ${n} open decision${n === 1 ? "" : "s"}, stale hb (not swept)`);
		} else if (s.role === "coordinator" || s.sid === coordinatorSid) {
			// the coordinator sleeps between waves — a stale hb is not death;
			// state stays RUNNING so broadcasts and bus targeting keep working
			console.log(`COORDINATOR ${s.sid.slice(0, 8)} hb stale — left RUNNING`);
		} else if (fix) {
			db.query("UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'").run(s.sid);
			fixed.push(`swept stale session ${s.sid.slice(0, 8)} → CLOSED`);
		} else issues.push(`session ${s.sid.slice(0, 8)} RUNNING, hb stale, transcript dead`);
	}
}

// 2. DONE items must not hold an owner (pure DB invariant)
for (const w of db.query("SELECT project, id, owner_sid FROM work_items WHERE state = 'DONE' AND owner_sid IS NOT NULL").all() as {
	project: string; id: string; owner_sid: string;
}[]) {
	issues.push(`${w.project.split("/").pop()?.replace(".git", "")}/${w.id} DONE but still owned by ${w.owner_sid.slice(0, 8)}`);
}

// 2b. decision-gated work items with no OPEN decision on the board — the
// NEED_DECISION was never emitted, or died with the lane that promised it
// (2026-09-25: W133 "ratify split or fold" sat in a session's chat for hours
// while the owner waited to rule; a chat ask is invisible to the board).
// Detector: title says DECISION. --fix emits the missing NEED_DECISION at
// the project coordinator (fact coordinator.sid).
let decisionGated: { project: string; id: string; title: string; owner_sid: string | null; scope: string | null }[] = [];
try {
	decisionGated = db
		.query(
			`SELECT project, id, title, owner_sid, scope FROM work_items
			 WHERE state IN ('READY','CLAIMED','RUNNING') AND title LIKE '%DECISION%'
			 AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = work_items.id AND d.state = 'OPEN')
			 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = 'NEED_DECISION' AND json_extract(e.payload, '$.work') = work_items.id)`,
		)
		.all() as typeof decisionGated;
} catch {} // no decisions table yet — board never ran, nothing to surface
for (const w of decisionGated) {
	const label = `${w.project.split("/").pop()?.replace(".git", "")}/${w.id} is decision-gated but has no OPEN decision on the board`;
	if (fix) {
		// coordinator.sid is a GLOBAL fact — emit only when the coordinator
		// serves this item's project; foreign-project items alert only (the
		// .claude frozen backlog W2/W3/W21 must not ride the gaps coordinator)
		const cproj = coordinatorSid
			? (db.query("SELECT project FROM sessions WHERE sid = ?").get(coordinatorSid) as { project: string | null } | null)?.project ?? null
			: null;
		if (coordinatorSid && cproj === w.project) {
			db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'monitor', 'NEED_DECISION', ?, ?, ?)").run(
				now,
				w.scope,
				JSON.stringify({ work: w.id, project: w.project, note: `${w.title} — surfaced by monitor: the NEED_DECISION for this item was never emitted` }),
				coordinatorSid,
			);
			fixed.push(`emitted NEED_DECISION for ${w.id} → project coordinator`);
		} else {
			issues.push(`${label} (no project coordinator to route the NEED_DECISION to)`);
		}
	} else {
		issues.push(label);
	}
}

// 3. expired locks (ts-based, safe to sweep)
for (const l of db.query("SELECT path, sid, ts FROM locks WHERE ts < ?").all(now - 15 * 60_000) as {
	path: string; sid: string; ts: number;
}[]) {
	if (fix) {
		db.query("DELETE FROM locks WHERE path = ? AND ts = ?").run(l.path, l.ts);
		fixed.push(`swept expired lock ${String(l.path).slice(0, 50)}`);
	} else issues.push(`expired lock ${String(l.path).slice(0, 50)} (${Math.round((now - l.ts) / 60_000)}m)`);
}

// 3b. --fix releases the file locks of waiting lanes so parallel work
// proceeds while the human decides — ownership-checked (path+sid must match
// a waiting lane), each release logged with path + owner. work_items
// ownership is never touched: resume goes through the normal claim path.
if (fix && waiting.size) {
	for (const l of db.query("SELECT path, sid FROM locks").all() as { path: string; sid: string }[]) {
		if (!waiting.has(l.sid)) continue;
		db.query("DELETE FROM locks WHERE path = ? AND sid = ?").run(l.path, l.sid);
		fixed.push(`released lock ${String(l.path).slice(0, 50)} (owner ${l.sid.slice(0, 8)} waiting for you)`);
	}
}

// 4. lane facts must stay inside the preemption state machine
for (const f of db.query("SELECT key, value FROM facts WHERE key LIKE 'lane.%.state'").all() as { key: string; value: string }[]) {
	if (!["RUNNING", "PAUSE_REQUESTED", "PAUSED", "RESUME_READY", "BLOCKED", "WAIT_RATE"].includes(f.value)) {
		issues.push(`lane fact ${f.key} = ${f.value} — outside state machine`);
	}
}

// 5. malformed event payloads
for (const e of db.query("SELECT id, payload FROM events ORDER BY id DESC LIMIT 20").all() as { id: number; payload: string | null }[]) {
	if (e.payload) {
		try {
			JSON.parse(e.payload);
		} catch {
			issues.push(`event #${e.id} has malformed payload`);
		}
	}
}

// 5b. dead letters: targeted events the addressee never consumed — event
// older than 30min, target session still RUNNING, cursor not advanced past
// it. Never auto-acked (--fix leaves cursors alone); deduped via fact
// deadletter.<event id> (6h), same recipe as the zombie check. Lanes with an
// OPEN decision are expected-silent — they wait on you, not on their inbox.
const dead = db
	.query(
		`SELECT e.id, e.ts, e.kind, e.target FROM events e
		 JOIN sessions s ON s.sid = e.target AND s.state = 'RUNNING'
		 LEFT JOIN cursors c ON c.sid = e.target
		 WHERE e.target IS NOT NULL AND e.ts < ? AND e.id > COALESCE(c.event_id, 0)
		 ORDER BY e.id`,
	)
	.all(now - 30 * 60_000) as { id: number; ts: number; kind: string; target: string }[];
for (const d of dead) {
	if (waiting.has(d.target)) continue; // waiting on you, not dead
	const fk = `deadletter.${d.id}`;
	const seen = db.query("SELECT ts FROM facts WHERE key = ?").get(fk) as { ts: number } | null;
	const age = Math.round((now - d.ts) / 60_000);
	const label = `dead letter #${d.id} ${d.kind} → ${d.target.slice(0, 10)} undrained ${age}m`;
	if (!seen || now - seen.ts > 6 * 3_600_000) {
		db.query("INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'monitor', 1, ?)").run(fk, label, now);
		issues.push(`${label} — cursor behind, never auto-acked`);
	} else issues.push(`${label} (alerted ${Math.round((now - seen.ts) / 60_000)}m ago)`);
}
// 5c. drive-by fan-outs (monitor half of W16): decomposition-class shatters
// are plan-gated — >2 children from one split with no plan-item reference in
// the work.added payloads is a drive-by. One alert per split burst (same
// parent, children added within one minute), deduped 6h like other checks.
const added = db
	.query("SELECT id, ts, payload FROM events WHERE kind = 'work.added' AND ts >= ? ORDER BY ts, id")
	.all(now - 24 * 3_600_000) as { id: number; ts: number; payload: string | null }[];
const bursts = new Map<string, { id: number; ts: number; plan: boolean }[]>();
for (const e of added) {
	let p: Record<string, unknown> = {};
	try {
		p = JSON.parse(e.payload ?? "{}");
	} catch {
		continue;
	}
	if (typeof p.work !== "string" || !p.work.includes(".")) continue; // roots aren't split children
	const key = `${String(p.project ?? "")}|${p.work.replace(/\.[^.]+$/, "")}`;
	const b = bursts.get(key) ?? [];
	const plan = Object.keys(p).some((k) => k.toLowerCase().startsWith("plan"));
	b.push({ id: e.id, ts: e.ts, plan });
	bursts.set(key, b);
}
for (const [key, kids] of bursts) {
	// cluster children of one parent into split bursts on a 1min gap
	kids.sort((a, b) => a.ts - b.ts);
	let cluster: { id: number; ts: number; plan: boolean }[] = [];
	const flush = (): void => {
		if (cluster.length > 2 && !cluster.some((k) => k.plan)) {
			const [project, parent] = key.split("|");
			const pname = project.split("/").pop()?.replace(".git", "") || project;
			const ids = cluster.map((k) => k.id).join(",");
			const label = `drive-by fan-out: ${pname}/${parent} split added ${cluster.length} children, no plan-item reference (#${ids})`;
			const fk = `driveby.${project}/${parent}`;
			const seen = db.query("SELECT ts FROM facts WHERE key = ?").get(fk) as { ts: number } | null;
			if (seen && now - seen.ts <= 6 * 3_600_000) {
				issues.push(`${label} (alerted ${Math.round((now - seen.ts) / 60_000)}m ago)`);
			} else {
				db.query("INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'monitor', 1, ?)").run(fk, label, now);
				issues.push(label);
			}
		}
		cluster = [];
	};
	for (const k of kids) {
		if (cluster.length && k.ts - cluster[cluster.length - 1].ts > 60_000) flush();
		cluster.push(k);
	}
	flush();
}

// 7. zombie lanes: CLAIMED items whose owner went silent — usage-limit
// deaths freeze subagents silently while the claim and the wall clock keep
// going (2026-09-24: 47 frozen, 6h blackout). THREE-STATE multi-signal rule
// (lookup failure is NEVER death):
//   ZOMBIE  = hb stale + transcript stale (2 independent signals)
//   SUSPECT = one signal stale, other UNKNOWN
//   UNKNOWN = telemetry missing — never claims death
// Threshold from fact fleet.zombie_after_ms (default 45min). WAIT_RATE /
// PAUSED sessions are expected-silent, never zombies. Remediation (reclaim
// + re-dispatch pointing at the frozen transcript) belongs to the canonical
// coordinator; alerts dedupe via fact zombie.<id> (6h).
const ZOMBIE_MS = Number(
	(db.query("SELECT value FROM facts WHERE key = 'fleet.zombie_after_ms'").get() as { value: string } | null)?.value ?? 45 * 60_000,
);
const zProjects = db.query("SELECT DISTINCT project FROM work_items WHERE state IN ('CLAIMED','RUNNING')").all() as { project: string }[];
for (const { project } of zProjects) {
	const claimed = db
		.query("SELECT id, owner_sid, title FROM work_items WHERE project = ? AND state IN ('CLAIMED','RUNNING') AND owner_sid IS NOT NULL")
		.all(project) as { id: string; owner_sid: string; title: string }[];
	for (const w of claimed) {
		if (waiting.has(w.owner_sid)) {
			// waiting for you — own alert class, never ZOMBIE/SUSPECT: the OPEN
			// decision addressed to this lane is why it's quiet. Fact goes to
			// waiting.<id> so the board renders it separately from zombie chips;
			// no reclaim, no alert event (reclaiming a lane that's waiting on
			// the human would be wrong).
			const n = waiting.get(w.owner_sid) ?? 0;
			const label = `${w.owner_sid.slice(0, 10)} WAITING for you (${n} open decision${n === 1 ? "" : "s"})`;
			const fk = `waiting.${w.id}`;
			const prev = db.query("SELECT value FROM facts WHERE key = ?").get(fk) as { value: string } | null;
			if (prev?.value !== label) fixed.push(`WAITING ${w.id} (${label})`);
			db.query("INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'monitor', 1, ?)").run(fk, label, now);
			continue;
		}
		const sess = db.query("SELECT state, hb, transcript_path FROM sessions WHERE sid = ?").get(w.owner_sid) as
			| { state: string; hb: number; transcript_path: null | string }
			| null;
		if (sess && ["PAUSED", "WAIT_RATE"].includes(sess.state)) continue; // expected-silent
		const signals: string[] = [];
		let known = 0;
		if (sess?.hb) {
			known++;
			if (now - sess.hb > ZOMBIE_MS) signals.push(`hb ${Math.round((now - sess.hb) / 60000)}min`);
			else signals.length = 0; // fresh hb outranks older transcript signal
		}
		if (sess?.transcript_path) {
			try {
				const age = now - statSync(sess.transcript_path).mtimeMs;
				known++;
				if (age > ZOMBIE_MS) signals.push(`transcript ${Math.round(age / 60000)}min`);
			} catch {
				// path recorded but unstat-able — telemetry gap, not death
			}
		}
		const verdict = signals.length >= 2 ? "ZOMBIE" : signals.length === 1 ? "SUSPECT" : known === 0 ? "UNKNOWN" : "ACTIVE";
		const label = `${w.owner_sid.slice(0, 10)} ${verdict}${signals.length ? ` (${signals.join(", ")})` : " (no telemetry)"}`;
		if (verdict === "ACTIVE") continue;
		const fk = `zombie.${w.id}`;
		const seen = db.query("SELECT ts FROM facts WHERE key = ?").get(fk) as { ts: number } | null;
		if (!seen || now - seen.ts > 6 * 3600_000) {
			db.query("INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'monitor', 1, ?)").run(fk, label, now);
			if (verdict === "ZOMBIE") {
				db.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'monitor', 'alert', ?, ?, (SELECT value FROM facts WHERE key = 'coordinator.sid'))",
				).run(now, w.id, JSON.stringify({ note: `ZOMBIE lane: ${label} — reclaim + re-dispatch pointing at its transcript` }));
			}
			fixed.push(`${verdict} ${w.id} (${label})`);
		} else if (verdict === "ZOMBIE") {
			issues.push(`zombie ${w.id}: ${label} (alerted ${Math.round((now - seen.ts) / 60000)}min ago)`);
		}
	}
}

// 6. FOCUS: workload surface per project — health-clean ≠ nothing to do
const projs = db.query("SELECT DISTINCT project FROM work_items WHERE state NOT IN ('DONE','SUPERSEDED') ORDER BY project").all() as { project: string }[];
for (const { project } of projs) {
	const name = project.split("/").pop()?.replace(".git", "") || project;
	const all = db.query("SELECT id, state, owner_sid, title FROM work_items WHERE project = ? AND state NOT IN ('DONE','SUPERSEDED') ORDER BY id").all(project) as {
		id: string; state: string; owner_sid: string | null; title: string;
	}[];
	const inflight = all.filter((w) => w.state === "CLAIMED" || w.state === "RUNNING");
	const ready = all.filter((w) => w.state === "READY");
	console.log(
		`FOCUS ${name}: ${inflight.length} in-flight, ${ready.length} ready/queued, ${all.length - inflight.length - ready.length} gated/other`,
	);
	for (const w of inflight) console.log(`  ▶ ${w.id} [${String(w.owner_sid).slice(0, 10)}] ${w.title.slice(0, 50)}`);
	for (const w of ready.slice(0, 6)) console.log(`  · ${w.id} ${w.title.slice(0, 55)}`);
	if (ready.length > 6) console.log(`  … +${ready.length - 6} more (work ready)`);
}

// 6b. consult diagnostics: where inter-agent latency hides (the kb answers
// repeat questions without spending an expert round-trip)
try {
	const byState = db.query("SELECT state, COUNT(*) AS n FROM consults GROUP BY state").all() as { state: string; n: number }[];
	const s = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
	const kbstats = db.query("SELECT COUNT(*) AS n2, COALESCE(SUM(hits), 0) AS n FROM consult_kb").get() as { n2: number; n: number };
	console.log(`CONSULTS ${s("OPEN")} open · ${s("ANSWERED")} human-answered · ${s("KB")} kb-answered · kb ${kbstats.n2} solutions, ${kbstats.n} hits`);
} catch {} // pre-v3 db — consult tracking not present yet

if (fixed.length) console.log(fixed.map((f) => `✓ ${f}`).join("\n"));
if (issues.length) {
	console.error(issues.map((i) => `⚠ ${i}`).join("\n"));
	process.exit(1);
}
console.log("health clean");
