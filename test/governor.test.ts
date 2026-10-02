// test/governor.test.ts — W187: the governor counts live lanes from the
// GRAPH (claims × alive pids), reads pressure from route_audit 429s + short
// claim segments, and steps the cap: down 1 per pressure event (cooldown
// between steps), up 1 per clean 10-min window, floor 2, ceiling = the base
// --target. Every step lands on the bus as governor.step.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEATH_WINDOW_MS,
	FLOOR,
	countLiveGraphClaims,
	emitStep,
	laneDeaths,
	loadState,
	nextStep,
	read429,
	runGovernor,
	saveState,
} from "../scripts/lib/governor.ts";

const NOW = 1_800_000_000_000; // fixed clock — every test is deterministic
const MIN = 60_000;

// scratch DB: the three tables the governor reads, nothing else
const scratchDb = (): Database => {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'READY', owner_sid TEXT, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL, error_code TEXT)",
	);
	db.run(
		"CREATE TABLE claims (sid TEXT NOT NULL, scope TEXT NOT NULL, intent TEXT, hot INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, tp TEXT, PRIMARY KEY (sid, scope))",
	);
	return db;
};
const PROJ = "proj";
const claim = (db: Database, id: string, sid: string): void => {
	db.query(
		"INSERT INTO work_items (project, id, state, owner_sid) VALUES (?, ?, 'CLAIMED', ?)",
	).run(PROJ, id, sid);
};
const event = (db: Database, ts: number, kind: string, work: string): void => {
	db.query("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run(
		ts,
		kind,
		JSON.stringify({ work }),
	);
};
const route = (db: Database, ts: number, code: string | null): void => {
	db.query(
		"INSERT INTO route_audit (rid, ts, error_code) VALUES (?, ?, ?)",
	).run(`r${ts}-${Math.random()}`, ts, code);
};

describe("W187 counter — graph claims × alive pids", () => {
	test("distinct sids with alive pids; zombies and unregistered claims do not count", () => {
		const db = scratchDb();
		claim(db, "W1", "s1"); // alive pid
		claim(db, "W2", "s2"); // dead pid — zombie claim
		claim(db, "W3", "s1"); // same lane, second claim = ONE live lane
		claim(db, "W4", "s3"); // no registry entry = zombie claim
		const lanes = [
			{ sid: "s1", pid: 111 },
			{ sid: "s2", pid: 999_999_999 },
		];
		const got = countLiveGraphClaims(
			db,
			PROJ,
			lanes,
			(pid) => pid !== 999_999_999,
		);
		expect(got).toEqual({ live: 1, claims: 4 });
	});
	test("empty graph → 0/0", () => {
		const db = scratchDb();
		expect(countLiveGraphClaims(db, PROJ, [])).toEqual({ live: 0, claims: 0 });
	});
	test("coord-claim liveness: a claim whose lane is unregistered still counts", () => {
		const db = scratchDb();
		claim(db, "W1", "s9"); // no registry entry — but a current coord claim
		expect(
			countLiveGraphClaims(db, PROJ, [], (pid) => pid !== 0, new Set(["s9"])),
		).toEqual({ live: 1, claims: 1 });
	});
});

describe("W187 429 window — belt/route_audit", () => {
	test("hits vs total inside the window; old rows excluded", () => {
		const db = scratchDb();
		for (let i = 0; i < 9; i++) route(db, NOW - i * 1000, null);
		route(db, NOW - 1000, "429");
		route(db, NOW - 2000, "429");
		route(db, NOW - 3000, "upstream_5xx");
		route(db, NOW - 2 * DEATH_WINDOW_MS - 60_000, "429");
		const got = read429(db, DEATH_WINDOW_MS, NOW);
		expect(got).toEqual({ total: 12, hits: 2 });
	});
});

describe("W187 lane deaths — short claim segments", () => {
	test("release/fail within 10min of claim and inside the window counts", () => {
		const db = scratchDb();
		event(db, NOW - 8 * MIN, "work.claimed", "w1");
		event(db, NOW - 2 * MIN, "work.released", "w1");
		event(db, NOW - 30 * MIN, "work.claimed", "w2");
		event(db, NOW - 1 * MIN, "work.done", "w2");
		event(db, NOW - 40 * MIN, "work.claimed", "w3");
		event(db, NOW - 35 * MIN, "work.released", "w3");
		event(db, NOW - 30 * MIN, "work.claimed", "w4");
		event(db, NOW - 29 * MIN, "work.failed", "w4"); // fail, but outside window
		event(db, NOW - 3 * MIN, "work.claimed", "w5");
		event(db, NOW - 5 * MIN, "work.claimed", "w6");
		event(db, NOW - 4 * MIN, "work.failed", "w6");
		expect(laneDeaths(db, NOW)).toBe(2);
	});
});

describe("W187 step machine — down", () => {
	test("death pressure steps down 1 with a reason", () => {
		const st = loadState("/tmp/w187/nope.json", 8);
		const r = nextStep(
			st,
			{ live: 3, deaths: 1, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r.step?.dir).toBe("down");
		expect(r.step?.from).toBe(8);
		expect(r.step?.to).toBe(7);
		expect(r.step?.reason).toContain("lane death");
	});
	test("cooldown absorbs the next pressure event", () => {
		const st = loadState("/tmp/w187/nope.json", 8);
		const r1 = nextStep(
			st,
			{ live: 3, deaths: 2, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r1.step).not.toBeNull();
		const r2 = nextStep(
			r1.state,
			{ live: 3, deaths: 2, r429: { total: 0, hits: 0 } },
			8,
			NOW + 1000,
		);
		expect(r2.step).toBeNull();
	});
});

describe("W187 step machine — floor and 429 burst", () => {
	test("floor 2 absorbs pressure without stepping", () => {
		const st: GovernorState = {
			effective: FLOOR,
			lastStepAt: 0,
			cleanSince: 0,
			history: [],
		};
		const r = nextStep(
			st,
			{ live: 9, deaths: 3, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r.step).toBeNull();
		expect(r.state.effective).toBe(FLOOR);
		expect(r.state.cleanSince).toBe(NOW);
	});
	test("429 burst steps down; a single hit does not", () => {
		const st = loadState("/tmp/w187/nope.json", 8);
		const burst = nextStep(
			st,
			{ live: 3, deaths: 0, r429: { total: 10, hits: 3 } },
			8,
			NOW,
		);
		expect(burst.step?.dir).toBe("down");
		expect(burst.step?.reason).toContain("429 burst");
		const lone = nextStep(
			st,
			{ live: 3, deaths: 0, r429: { total: 10, hits: 1 } },
			8,
			NOW,
		);
		expect(lone.step).toBeNull();
	});
});

describe("W187 step machine — up", () => {
	const st = (over: Partial<GovernorState>): GovernorState => ({
		effective: 3,
		lastStepAt: NOW - 11 * MIN,
		cleanSince: NOW - 11 * MIN,
		history: [],
		...over,
	});
	test("a full clean window steps up 1", () => {
		const r = nextStep(
			st({}),
			{ live: 3, deaths: 0, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r.step?.dir).toBe("up");
		expect(r.step?.from).toBe(3);
		expect(r.step?.to).toBe(4);
		expect(r.step?.reason).toContain("clean");
	});
	test("window not elapsed → no step", () => {
		const r = nextStep(
			st({ cleanSince: NOW - 5 * MIN }),
			{ live: 3, deaths: 0, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r.step).toBeNull();
	});
	test("ceiling = base: no step at the policy cap", () => {
		const r = nextStep(
			st({ effective: 8 }),
			{ live: 3, deaths: 0, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r.step).toBeNull();
	});
	test("pressure restarts the clean clock — no climb while hurting", () => {
		const r = nextStep(
			st({ effective: FLOOR }),
			{ live: 9, deaths: 1, r429: { total: 0, hits: 0 } },
			8,
			NOW,
		);
		expect(r.step).toBeNull();
		expect(r.state.cleanSince).toBe(NOW);
	});
});

describe("W187 runGovernor — cycle evaluation", () => {
	test("pressure steps down, persists state, emits the board event", () => {
		const db = scratchDb();
		event(db, NOW - 3 * MIN, "work.claimed", "w1");
		event(db, NOW - 1 * MIN, "work.released", "w1");
		const sp = join(tmpdir(), `w187-gov-${Date.now()}`, "backpressure.json");
		const r = runGovernor({
			db,
			project: PROJ,
			baseTarget: 8,
			lanes: [],
			statePath: sp,
			nowMs: NOW,
		});
		expect(r.cap).toBe(7);
		expect(r.step?.dir).toBe("down");
		const st = JSON.parse(readFileSync(sp, "utf8")) as GovernorState;
		expect(st.effective).toBe(7);
		const ev = db
			.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'governor.step'")
			.get() as { c: number };
		expect(ev.c).toBe(1);
	});
	test("readOnly observes the cap, steps nothing, writes nothing", () => {
		const db = scratchDb();
		const sp = join(tmpdir(), `w187-ro-${Date.now()}`, "backpressure.json");
		const r = runGovernor({
			db,
			project: PROJ,
			baseTarget: 5,
			lanes: [],
			statePath: sp,
			readOnly: true,
			nowMs: NOW,
		});
		expect(r.cap).toBe(5);
		expect(existsSync(sp)).toBe(false);
	});
});
describe("W187 state + bus event", () => {
	test("state round-trips; corrupt JSON falls back to fresh", async () => {
		const p = "/tmp/w187/state-test.json";
		saveState(p, {
			effective: 5,
			lastStepAt: 42,
			cleanSince: 43,
			history: [],
		});
		expect(loadState(p, 8).effective).toBe(5);
		await Bun.write(p, "{broken");
		expect(loadState(p, 8).effective).toBe(8);
	});
	test("emitStep lands a governor.step row on the bus", () => {
		const db = scratchDb();
		emitStep(db, PROJ, {
			at: NOW,
			dir: "down",
			from: 8,
			to: 7,
			reason: "test",
		});
		const row = db
			.query("SELECT payload FROM events WHERE kind = 'governor.step'")
			.get() as { payload: string } | null;
		expect(row).not.toBeNull();
		const parsed = JSON.parse(row.payload) as { note: string };
		expect(parsed.note).toContain("down 8→7");
	});
});
