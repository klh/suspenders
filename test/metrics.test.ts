// metrics.test.ts — W15 (workTiming derivation) and W3 (coord metrics)
// against a temp-HOME governor.db, same recipe as monitor.test.ts: seeding,
// timing, and CLI runs happen in bun subprocesses so the parent test process
// never opens the real governor.db.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(tmpdir(), "claude-metrics-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const runIn = (code: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

const query = (sql: string): unknown[] =>
	JSON.parse(runIn(`const { openGovernorDb } = await import(${JSON.stringify(GOVDB)}); console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(sql)}).all()));`));

// the project identity `coord metrics <repo>` resolves for this repo
const gitDir = new TextDecoder().decode(Bun.spawnSync(["git", "-C", process.cwd(), "rev-parse", "--git-common-dir"], { stdout: "pipe" }).stdout).trim();
const PROJECT = realpathSync(resolve(process.cwd(), gitDir || "."));

// seed one week of realistic bus traffic, then read W15 timings back — all in
// one subprocess so nowMs is deterministic across the seeded events
const seedAndTime = (): { now: number; timing: { work: string; wallMs: number; agentMs: number; claims: number; releases: number; done: boolean; failed: boolean }[] } =>
	JSON.parse(
		runIn(`
const { openGovernorDb, workTiming } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const P = ${JSON.stringify(PROJECT)};
const now = Date.now();
const M = 60000;
const T = (m) => now - m * M;
const ins = (sql) => db.query(sql);
const ev = (kind, ts, source, scope, payload, target) => ins("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)").run(ts, source, kind, scope, payload, target);
const w = (work, extra) => JSON.stringify({ work, project: P, ...extra });
ins("INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES (?, ?, ?, ?, ?, ?, ?)").run("coord-1", P, "coordinator", null, T(120), now, "RUNNING");
ins("INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES (?, ?, ?, ?, ?, ?, ?)").run("lane-1", P, "worker", "p", T(120), now, "RUNNING");
ins("INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES (?, ?, ?, ?, ?, ?, ?)").run("lane-2", P, "worker", "p", T(120), now, "RUNNING");
ev("work.claimed", T(50), "work", "src/x", w("W1", { by: "lane-1" }), null);
ev("work.done", T(10), "work", "src/x", w("W1", { sha: "abc" }), null);
ev("work.claimed", T(40), "work", "src/x", w("W2", { by: "lane-2" }), null);
ev("work.released", T(30), "work", "src/x", w("W2", { by: "lane-2" }), null);
ev("work.claimed", T(20), "work", "src/x", w("W2", { by: "lane-2" }), null);
ev("work.done", T(5), "work", "src/x", w("W2", { sha: "def" }), null);
ev("work.claimed", T(15), "work", "src/x", w("W3", { by: "lane-2" }), null);
ev("work.done", T(8), "work", "src/x", w("W4", { auto: "all required children complete" }), null);
ev("conflict", T(60), "lane-1", "src/y", JSON.stringify({ project: P, note: "src/y merge" }), null);
ev("pause_requested", T(60), "coordinator", null, JSON.stringify({ reason: "wave" }), "lane-2");
ev("paused", T(55), "lane-2", null, JSON.stringify({ sha: "aaa" }), "coordinator");
ev("resume_ready", T(35), "coordinator", null, JSON.stringify({ onto: "bbb" }), "lane-2");
ins("INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, ?, ?)").run("lane.lane-2.state", "WAIT_RATE", "lane-2", 7, T(10));
console.log(JSON.stringify({ now, timing: workTiming(db, P, now) }));
db.close();`),
	);

const M = 60_000;

describe("W15 — workTiming derives wall vs agent time from bus events", () => {
	const { timing } = seedAndTime();
	const byId = new Map(timing.map((t) => [t.work, t]));

	test("single claim →done: wall = agent = claim→done span", () => {
		const w1 = byId.get("W1");
		expect(w1?.done).toBe(true);
		expect(w1?.claims).toBe(1);
		expect(w1?.wallMs).toBe(40 * M);
		expect(w1?.agentMs).toBe(40 * M);
	});

	test("serialized multi-claims: wall stays first-claim→done, agent sums segments", () => {
		const w2 = byId.get("W2");
		expect(w2?.claims).toBe(2);
		expect(w2?.wallMs).toBe(35 * M);
		expect(w2?.agentMs).toBe(25 * M); // 10m + 15m, the 10m release gap is wall-only
	});

	test("open item: agent counts up to now, never done", () => {
		const w3 = byId.get("W3");
		expect(w3?.done).toBe(false);
		expect(w3?.claims).toBe(1);
		expect(w3?.wallMs).toBe(15 * M);
		expect(w3?.agentMs).toBe(15 * M);
	});

	test("never-claimed auto-rollup: no wall time — no claim→done interval exists", () => {
		const w4 = byId.get("W4");
		expect(w4?.done).toBe(true);
		expect(w4?.claims).toBe(0);
		expect(w4?.wallMs).toBe(0);
	});
});

describe("W3 — coord metrics", () => {
	const p = Bun.spawnSync(["bun", COORD, "metrics", process.cwd(), "--days", "7"], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = new TextDecoder().decode(p.stdout);

	test("exits 0 and prints the terse table", () => {
		expect(p.exitCode).toBe(0);
		expect(out).toContain("METRICS suspenders (last 7d)");
		expect(out).toContain("runs: 3 (2 worker, 1 coordinator)");
		expect(out).toContain("items: 2 done, 1 open — median done item: wall 40m, agent 40m");
		expect(out).toContain("2 claims");
	});

	test("dwell: evented PAUSED window + ongoing WAIT_RATE from the lane fact", () => {
		expect(out).toContain("dwell: PAUSED 20m (1 win) · WAIT_RATE +10m ongoing");
	});

	test("friction: conflict events, re-claims as rework, fails", () => {
		expect(out).toContain("1 conflict event");
		expect(out).toContain("1 re-claimed item");
		expect(out).toContain("0 failed");
	});

	test("writes the metrics.snapshot.<date> fact", () => {
		expect(out).toContain("snapshot → metrics.snapshot.");
		const rows = query(`SELECT value FROM facts WHERE key = 'metrics.snapshot.${new Date().toISOString().slice(0, 10)}'`);
		expect(rows.length).toBe(1);
		const snap = JSON.parse((rows[0] as { value: string }).value);
		expect(snap.runs).toBe(3);
		expect(snap.done).toBe(2);
		expect(snap.conflicts).toBe(1);
		expect(snap.medianWallMs).toBe(40 * M);
		expect(snap.dwell.PAUSED.ms).toBe(20 * M);
	});
});
