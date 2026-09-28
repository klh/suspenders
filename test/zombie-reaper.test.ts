// test/zombie-reaper.test.ts — W62: the monitor's zombie reaper. A lane
// verifiably ZOMBIE (two-signal rule) for longer than
// fleet.zombie_reclaim_after_ms (default 7 DAYS) is auto-reclaimed to READY
// via the manual `work reclaim` verb's own code path (spawned work.ts —
// claim release, work.released event, mirror export included), audited with
// one line (id, owner sid, age) on the monitor's output. NEVER cross-project
// (work_items.project must equal the monitor's projectIdentity()); lanes
// with an OPEN decision (WAITING) or in PAUSED/WAIT_RATE are expected-silent
// and never reclaimed.
//
// Isolation recipe as monitor.test.ts: temp HOME (fresh governor.db) + temp
// repo as monitor cwd. projectIdentity() falls back to realpath(cwd) (the
// .git dir here is a bare mkdir), and on macOS /tmp is a symlink to
// /private/tmp — so the tests seed work_items.project with realpathSync(REPO)
// to match what the monitor computes.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	utimesSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-zreap-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-zreap-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const PROJECT = realpathSync(REPO); // what the monitor's projectIdentity() resolves to
const env = { ...process.env, HOME };
const bin = join(import.meta.dir, "..", "hooks", "bin");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const NOW = Date.now();
const OLD = NOW - 2 * 60 * 60_000; // 2h stale — inside the 20min hb + 45min zombie windows
const DAY = 24 * 3_600_000;

function run(args: string[] = []) {
	const p = Bun.spawnSync(["bun", join(bin, "monitor.ts"), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

const ZSID = "zreap-zombie-sid-01";
const WSID = "zreap-waiting-sid01";
const PSID = "zreap-paused-sid01";
const FSID = "zreap-foreign-sid01";

// bootstrap schema the way production does: one monitor open in the temp HOME
// (openGovernorDb runs the migrations)
run();

function seedSession(sid: string, state = "RUNNING") {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path) VALUES (?, ?, 'worker', NULL, NULL, ?, ?, ?, NULL, ?)",
	).run(sid, REPO, OLD, OLD, state, staleTranscript(sid));
	db.close();
}

function staleTranscript(sid: string) {
	const p = join(HOME, ".claude", "projects", "t", `${sid}.jsonl`);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, '{"x":1}\n');
	utimesSync(p, OLD / 1000, OLD / 1000); // backdated → both liveness signals stale
	return p;
}

function seedWork(id: string, owner: string, project = PROJECT) {
	const db = new Database(DB);
	db.query(
		"INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, ?, ?, 'CLAIMED', ?, ?, ?)",
	).run(project, id, `reap ${id}`, owner, OLD, OLD);
	db.close();
}

function seedDecisionFor(sid: string) {
	const db = new Database(DB);
	db.run(
		"CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, project TEXT, task_id TEXT, asked_by TEXT, question TEXT, options TEXT, state TEXT NOT NULL DEFAULT 'OPEN', delivery TEXT, answer_note TEXT, answer_to TEXT, answer_token TEXT, created_ts INTEGER, answered_ts INTEGER, ack_ts INTEGER)",
	);
	db.query(
		"INSERT INTO decisions (project, asked_by, question, state, answer_to, created_ts) VALUES (?, 'human', 'proceed?', 'OPEN', ?, ?)",
	).run(REPO, sid, NOW);
	db.close();
}

function seedFact(key: string, value: string, ts: number) {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'test', 1, ?)",
	).run(key, value, ts);
	db.close();
}

const one = (
	db: Database,
	sql: string,
	...args: unknown[]
): Record<string, unknown> | undefined =>
	(db.query(sql).get(...args) as Record<string, unknown> | null) ?? undefined;
const rowCount = (db: Database, sql: string, ...args: unknown[]): number =>
	(db.query(sql).get(...args) as { n: number }).n;

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("zombie reaper (W62)", () => {
	test("young zombie is flagged but not reclaimed; the 7d clock arms", () => {
		seedSession(ZSID);
		seedWork("W1", ZSID);
		const r = run();
		expect(r.out).toContain("ZOMBIE W1"); // classified (two-signal: hb + transcript)
		expect(r.out).not.toContain("reclaimed zombie W1");
		const d = new Database(DB, { readonly: true });
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = ? AND id = 'W1'",
				PROJECT,
			),
		).toEqual({
			state: "CLAIMED",
		});
		expect(
			one(d, "SELECT ts FROM facts WHERE key = ?", "zombie.since.W1")?.ts,
		).toBeGreaterThan(NOW - 60_000);
		d.close();
	});

	test("WAITING zombie (OPEN decision) is never reclaimed, never clock-armed", () => {
		seedSession(WSID);
		seedWork("W2", WSID);
		seedDecisionFor(WSID);
		const r = run();
		expect(r.out).toContain("WAITING W2");
		expect(r.out).not.toContain("ZOMBIE W2");
		const d = new Database(DB, { readonly: true });
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = ? AND id = 'W2'",
				PROJECT,
			),
		).toEqual({
			state: "CLAIMED",
		});
		expect(
			one(d, "SELECT key FROM facts WHERE key = ?", "zombie.since.W2"),
		).toBeUndefined();
		d.close();
	});

	test("PAUSED zombie-old is expected-silent: no classification, no reclaim, no clock", () => {
		seedSession(PSID, "PAUSED");
		seedWork("W3", PSID);
		seedFact("fleet.zombie_reclaim_after_ms", "1000", NOW); // would reclaim instantly if ever classified
		const r = run();
		expect(r.out).not.toContain("ZOMBIE W3");
		expect(r.out).not.toContain("reclaimed zombie W3");
		const d = new Database(DB, { readonly: true });
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = ? AND id = 'W3'",
				PROJECT,
			),
		).toEqual({
			state: "CLAIMED",
		});
		d.close();
	});

	test("cross-project zombie is alerted but NEVER reclaimed", () => {
		seedSession(FSID);
		seedWork("W4", FSID, "/foreign/repo/.git");
		const r = run();
		expect(r.out).toContain("ZOMBIE W4");
		expect(r.out).not.toContain("reclaimed zombie W4");
		const d = new Database(DB, { readonly: true });
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = '/foreign/repo/.git' AND id = 'W4'",
			),
		).toEqual({
			state: "CLAIMED",
		});
		d.close();
	});

	test("old zombie is reclaimed to READY via the work reclaim code path, with an audit line", () => {
		seedFact("fleet.zombie_reclaim_after_ms", "1000", NOW); // 1s window — W1's zombie age far exceeds it
		const db0 = new Database(DB);
		db0
			.query("UPDATE facts SET ts = ? WHERE key = ?")
			.run(NOW - 8 * DAY, "zombie.since.W1");
		db0.close();
		const r = run(["--fix"]);
		expect(r.out).toMatch(
			/reclaimed zombie W1 \(owner zreap-zomb, zombie 8\.0d\) → READY/,
		);
		const d = new Database(DB, { readonly: true });
		expect(
			one(
				d,
				"SELECT state, owner_sid FROM work_items WHERE project = ? AND id = 'W1'",
				PROJECT,
			),
		).toEqual({
			state: "READY",
			owner_sid: null,
		});
		expect(
			one(d, "SELECT key FROM facts WHERE key = ?", "zombie.since.W1"),
		).toBeUndefined(); // clock cleared
		expect(
			rowCount(
				d,
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.released' AND json_extract(payload, '$.work') = 'W1'",
			),
		).toBe(1); // the verb's own event (id lives in the payload, not scope)
		// exemptions hold even past the window
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = ? AND id = 'W2'",
				PROJECT,
			),
		).toEqual({ state: "CLAIMED" });
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = ? AND id = 'W3'",
				PROJECT,
			),
		).toEqual({ state: "CLAIMED" });
		expect(
			one(
				d,
				"SELECT state FROM work_items WHERE project = '/foreign/repo/.git' AND id = 'W4'",
			),
		).toEqual({ state: "CLAIMED" });
		d.close();
	});
});
