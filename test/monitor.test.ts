// monitor.test.ts — "Waiting for you" agent-health handling: an OPEN decision
// addressed to a lane exempts it from zombie alerts and sweeps; --fix releases
// its file locks (ownership-checked, path+sid) but never its work_items
// ownership, and resume is the normal claim path (nothing special-cased).
// Isolated temp HOME + repo (same recipe as governor-leases.test.ts).
// process.env is never mutated here — HOME goes to the spawned CLI only.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-monitor-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-monitorrepo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const bin = join(import.meta.dir, "..", "hooks", "bin");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const OLD = Date.now() - 2 * 60 * 60_000; // 2h stale: inside the 20min hb + 45min zombie windows

function run(args: string[] = []) {
	const p = Bun.spawnSync(["bun", join(bin, "monitor.ts"), ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

const WAIT_SID = "waiting-sess-aaaaaaaa";
const CTRL_SID = "ctrl-sess-bbbbbbbbb";

// the board's table, seeded exactly as the contract describes it — monitor
// must never CREATE it (table-missing = board never ran = nothing to exempt)
function seedBoard() {
	const db = new Database(DB);
	db.run("CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, project TEXT, task_id TEXT, asked_by TEXT, question TEXT, options TEXT, state TEXT NOT NULL DEFAULT 'OPEN', delivery TEXT, answer_note TEXT, answer_to TEXT, answer_token TEXT, created_ts INTEGER, answered_ts INTEGER, ack_ts INTEGER)");
	db.query("INSERT INTO decisions (project, asked_by, question, state, answer_to, created_ts) VALUES (?, 'human', 'ship or hold?', 'OPEN', ?, ?)").run(REPO, WAIT_SID, Date.now());
	db.close();
}
function staleTranscript(sid: string) {
	const p = join(HOME, ".claude", "projects", "t", `${sid}.jsonl`);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, '{"x":1}\n');
	utimesSync(p, OLD / 1000, OLD / 1000); // backdated → transcript signal reads stale
	return p;
}
function seedSession(sid: string) {
	const db = new Database(DB);
	db.query("INSERT OR REPLACE INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path) VALUES (?, ?, 'worker', NULL, NULL, ?, ?, 'RUNNING', NULL, ?)").run(sid, REPO, OLD, OLD, staleTranscript(sid));
	db.close();
}
function seedWork(id: string, owner: string) {
	const db = new Database(DB);
	db.query("INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, ?, ?, 'CLAIMED', ?, ?, ?)").run(REPO, id, `work ${id}`, owner, OLD, OLD);
	db.close();
}
function seedLock(path: string, sid: string) {
	const db = new Database(DB);
	db.query("INSERT OR REPLACE INTO locks (path, sid, tool, ts, tp, hash, seen) VALUES (?, ?, 'Write', ?, NULL, NULL, NULL)").run(path, sid, Date.now());
	db.close();
}
const one = (db: Database, sql: string, ...args: unknown[]) => db.query(sql).get(...args) as any;
const count = (db: Database, sql: string, ...args: unknown[]) => (db.query(sql).get(...args) as { n: number }).n;

// bootstrap schema the way production does: one monitor open in the temp HOME
// (openGovernorDb runs the migrations). Doubles as the table-missing case:
// no decisions table exists yet — must run clean, no exemption, no crash.
run();

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("waiting for you", () => {
	test("decisions table missing: clean run, no exemption, no crash", () => {
		const r = run();
		expect(r.code).toBe(0);
		expect(r.out).toContain("health clean");
		expect(r.out).not.toContain("WAITING");
		expect(r.err).not.toContain("no such table");
	});

	test("stale lane with an OPEN decision is WAITING, not zombie; same-staleness control IS zombie", () => {
		seedSession(WAIT_SID);
		seedSession(CTRL_SID);
		seedWork("W1", WAIT_SID);
		seedWork("C1", CTRL_SID);
		seedLock(join(REPO, "wait.txt"), WAIT_SID);
		seedLock(join(REPO, "ctrl.txt"), CTRL_SID);
		seedBoard();
		const r = run();
		// alert classes are distinct — WAITING on stdout, control zombie alerted
		expect(r.out).toContain("WAITING W1 (waiting-se WAITING for you (1 open decision))");
		expect(r.out).toContain("WAITING session waiting-");
		expect(r.out).toContain("ZOMBIE C1");
		expect(r.err).toContain("ctrl-ses"); // control tripped the stale-session issue
		expect(r.err).not.toContain("waiting-"); // waiting lane surfaces on stdout, never as an issue
		const d = new Database(DB, { readonly: true });
		expect(one(d, "SELECT value FROM facts WHERE key = 'waiting.W1'")).toEqual({ value: "waiting-se WAITING for you (1 open decision)" });
		expect(one(d, "SELECT value FROM facts WHERE key = 'zombie.W1'")).toBeNull(); // never zombie-flagged
		expect(count(d, "SELECT COUNT(*) AS n FROM locks WHERE sid = ?", WAIT_SID)).toBe(1); // read-only run releases nothing
		expect(count(d, "SELECT COUNT(*) AS n FROM locks WHERE sid = ?", CTRL_SID)).toBe(1);
		expect(count(d, "SELECT COUNT(*) AS n FROM events WHERE kind = 'alert' AND scope = 'C1'")).toBe(1);
		d.close();
	});

	test("--fix: waiting lane keeps session + work ownership, loses only its locks; control is swept", () => {
		const r = run(["--fix"]);
		expect(r.out).toContain("released lock"); // logged with path + owner
		expect(r.out).toContain("waiting-");
		expect(r.out).toContain("swept stale session ctrl-ses");
		const d = new Database(DB);
		// waiting lane: not terminated, still owns its work, decision untouched
		expect(one(d, "SELECT state FROM sessions WHERE sid = ?", WAIT_SID)).toEqual({ state: "RUNNING" });
		expect(one(d, "SELECT state, owner_sid FROM work_items WHERE project = ? AND id = 'W1'", REPO)).toEqual({ state: "CLAIMED", owner_sid: WAIT_SID });
		expect(one(d, "SELECT state, answer_to FROM decisions WHERE answer_to = ?", WAIT_SID)).toEqual({ state: "OPEN", answer_to: WAIT_SID });
		expect(count(d, "SELECT COUNT(*) AS n FROM locks WHERE sid = ?", WAIT_SID)).toBe(0);
		// control: swept as before, its (fresh) lock untouched — release is ownership-scoped
		expect(one(d, "SELECT state FROM sessions WHERE sid = ?", CTRL_SID)).toEqual({ state: "CLOSED" });
		expect(count(d, "SELECT COUNT(*) AS n FROM locks WHERE sid = ?", CTRL_SID)).toBe(1);
		d.close();
	});

	test("decision-gated item without an OPEN decision is surfaced; --fix emits the NEED_DECISION once", () => {
		const db0 = new Database(DB);
		db0.query("INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, 'W-DEC', 'W-DEC seam ruling (DECISION, no code)', 'READY', NULL, ?, ?)").run(REPO, OLD, OLD);
		db0.query("INSERT INTO facts (key, value, ts) VALUES ('coordinator.sid', 'coord-sess-cccccc', ?)").run(Date.now());
		db0.query("INSERT OR REPLACE INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path) VALUES ('coord-sess-cccccc', ?, 'coordinator', NULL, NULL, ?, ?, 'RUNNING', NULL, NULL)").run(REPO, OLD, OLD);
		db0.close();
		const r = run(); // read-only: alert only, no emission
		expect(r.err).toContain("W-DEC is decision-gated");
		const r2 = run(["--fix"]); // emits at the project coordinator, exactly once
		expect(r2.out).toContain("emitted NEED_DECISION for W-DEC");
		const d = new Database(DB, { readonly: true });
		const ev = one(d, "SELECT payload, target FROM events WHERE kind = 'NEED_DECISION' AND payload LIKE '%W-DEC%'") as { payload: string; target: string };
		expect(JSON.parse(ev.payload).work).toBe("W-DEC");
		expect(ev.target).toBe("coord-sess-cccccc");
		d.close();
		const r3 = run(); // idempotent: no re-alert, no re-emit
		expect(r3.err).not.toContain("W-DEC");
	});
	test("answered decision returns the lane to normal zombie rules", () => {
		const d0 = new Database(DB);
		d0.query("UPDATE decisions SET state = 'ANSWERED' WHERE answer_to = ?").run(WAIT_SID);
		d0.close();
		const r = run(["--fix"]);
		expect(r.out).toContain("ZOMBIE W1"); // same staleness, no longer exempt
		expect(r.out).toContain("swept stale session waiting-");
		const d = new Database(DB, { readonly: true });
		expect(one(d, "SELECT state FROM sessions WHERE sid = ?", WAIT_SID)).toEqual({ state: "CLOSED" });
		expect(one(d, "SELECT value FROM facts WHERE key = 'zombie.W1'").value).toContain("ZOMBIE");
		d.close();
	});
});

// ---- 5b dead letters + 5c drive-by fan-outs (ported from the .claude wave) ----
// Both checks dedupe via facts (6h TTL), so each test reseeds a fresh
// database: the monitor's own run bootstraps the schema, the test seeds rows
// directly (same recipe as above), then asserts on its run. Second temp HOME
// keeps the dedupe facts isolated from the "waiting for you" suite.
const HOME2 = mkdtempSync(join(tmpdir(), "suspenders-monitor-dead-"));
const DB2 = join(HOME2, ".cache", "claude-governor", "governor.db");
afterAll(() => rmSync(HOME2, { recursive: true, force: true }));

function run2(): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(bin, "monitor.ts")], { cwd: REPO, env: { ...process.env, HOME: HOME2 }, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}
// wipe state, then let the monitor itself recreate the schema
function fresh2() {
	rmSync(join(HOME2, ".cache"), { recursive: true, force: true });
	run2();
}
function seed2(fn: (db: Database) => void): void {
	const db = new Database(DB2);
	fn(db);
	db.close();
}
const NOW2 = Date.now();
const M2 = 60_000;
const LANE2 = "dead-lane-aaaaaaaa";
const PROJ2 = "/tmp/fake-proj2/.git";
const ev2 = (kind: string, minAgo: number, payload: unknown, target: string | null): unknown[] => [NOW2 - minAgo * M2, "test", kind, null, JSON.stringify(payload), target];
const insSession2 = (db: Database, sid: string, state: string) =>
	db.query("INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES (?, ?, 'worker', 'coord-parent', ?, ?, ?)").run(sid, PROJ2, NOW2 - 60 * M2, NOW2 - (state === "RUNNING" ? 0 : 30) * M2, state);
const insEvent2 = (db: Database, e: unknown[]) =>
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)").run(...(e as [number, string, string, null, string, string | null]));
const count2 = (db: Database, sql: string): number => (db.query(sql).get() as { n: number }).n;

describe("monitor 5b — dead letters", () => {
	test("old targeted event + RUNNING target + no cursor advance → alert + dedupe fact", () => {
		fresh2();
		seed2((db) => {
			insSession2(db, LANE2, "RUNNING");
			insEvent2(db, ev2("paused", 60, { sha: "abc" }, LANE2));
		});
		const r = run2();
		expect(r.err).toContain("dead letter");
		expect(r.code).toBe(1);
		const d = new Database(DB2, { readonly: true });
		expect(count2(d, "SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'deadletter.%'")).toBe(1);
		d.close();
	});

	test("dedupe: second run keeps one fact, re-alerts with (alerted …m ago)", () => {
		const r2 = run2();
		expect(r2.err).toContain("(alerted");
		const d = new Database(DB2, { readonly: true });
		expect(count2(d, "SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'deadletter.%'")).toBe(1);
		d.close();
	});

	test("cursor advanced past the event → clean", () => {
		fresh2();
		seed2((db) => {
			insSession2(db, LANE2, "RUNNING");
			insEvent2(db, ev2("paused", 60, { sha: "abc" }, LANE2));
			db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(LANE2, 1);
		});
		const r = run2();
		expect(r.code).toBe(0);
		expect(r.out).toContain("health clean");
	});

	test("CLOSED target → no alert", () => {
		fresh2();
		seed2((db) => {
			insSession2(db, LANE2, "CLOSED");
			insEvent2(db, ev2("paused", 60, { sha: "abc" }, LANE2));
		});
		const r = run2();
		expect(r.code).toBe(0);
		expect(r.out).toContain("health clean");
	});

	test("target waiting on an OPEN decision → exempt (expected-silent)", () => {
		fresh2();
		seed2((db) => {
			insSession2(db, LANE2, "RUNNING");
			insEvent2(db, ev2("paused", 60, { sha: "abc" }, LANE2));
			db.run("CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, project TEXT, task_id TEXT, asked_by TEXT, question TEXT, options TEXT, state TEXT NOT NULL DEFAULT 'OPEN', delivery TEXT, answer_note TEXT, answer_to TEXT, answer_token TEXT, created_ts INTEGER, answered_ts INTEGER, ack_ts INTEGER)");
			db.query("INSERT INTO decisions (project, task_id, asked_by, question, state, answer_to, created_ts) VALUES (?, 'W9', 'human', 'rule on this?', 'OPEN', ?, ?)").run(PROJ2, LANE2, NOW2);
		});
		const r = run2();
		expect(r.code).toBe(0);
		expect(r.out).toContain("health clean");
	});
});

describe("monitor 5c — drive-by fan-outs", () => {
	const added2 = (work: string, minAgo: number, extra: Record<string, unknown> = {}): unknown[] =>
		ev2("work.added", minAgo, { work, project: PROJ2, ...extra }, null);

	test("3 children in one split without plan ref → exactly one alert, fact written", () => {
		fresh2();
		seed2((db) => {
			insEvent2(db, added2("W90.1", 31));
			insEvent2(db, added2("W90.2", 31));
			insEvent2(db, added2("W90.3", 30));
		});
		const r = run2();
		expect(r.err.split("drive-by fan-out").length - 1).toBe(1);
		expect(r.err).toContain("W90");
		expect(r.code).toBe(1);
		const d = new Database(DB2, { readonly: true });
		expect(count2(d, "SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'driveby.%'")).toBe(1);
		d.close();
	});

	test("plan-referenced split (payload plan key) → clean", () => {
		fresh2();
		seed2((db) => {
			insEvent2(db, added2("W90.1", 31, { plan: "W80" }));
			insEvent2(db, added2("W90.2", 31, { plan: "W80" }));
			insEvent2(db, added2("W90.3", 30, { plan: "W80" }));
		});
		const r = run2();
		expect(r.code).toBe(0);
		expect(r.out).toContain("health clean");
	});

	test("2 children → not a fan-out", () => {
		fresh2();
		seed2((db) => {
			insEvent2(db, added2("W90.1", 31));
			insEvent2(db, added2("W90.2", 31));
		});
		const r = run2();
		expect(r.code).toBe(0);
	});

	test("same parent, children >1min apart → separate bursts, none >2 → clean", () => {
		fresh2();
		seed2((db) => {
			insEvent2(db, added2("W90.1", 61));
			insEvent2(db, added2("W90.2", 61));
			insEvent2(db, added2("W90.3", 5));
		});
		const r = run2();
		expect(r.code).toBe(0);
	});
});
