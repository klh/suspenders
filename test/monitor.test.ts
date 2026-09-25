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
