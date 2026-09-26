// sweep.test.ts — the shared liveness sweep: hb-stale + transcript-dead
// top-level RUNNING rows close automatically; the coordinator (by fact or by
// role), sessions waiting on an open decision, and sessions with a freshly
// written transcript are exempt; parented lanes close at 24h. Broadcast
// targets only hb-fresh RUNNING sessions (honest count — the 102-row bug).
// Isolated temp HOME + repo, spawns the real CLI (consult-kb recipe).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-sweep-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-sweep-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// projectIdentity(), mirrored: git-common-dir from inside the temp repo —
// NOTE git walks UP through a scaffolded .git to the parent checkout, so
// the identity is the PARENT repo's .git; seeds must match it exactly
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		// resolve, not join: git prints an ABSOLUTE gitdir when the repo root is
		// above cwd (linked-worktree runs) — join would concatenate it into garbage
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
const TS = Date.now();
const STALE = TS - 3_600_000; // 1h — beyond the 20min hb window

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", coord, ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

type Seed = { parentSid?: string; hb: number; role?: string };
function seed(sid: string, s: Seed) {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state, parent_sid, role) VALUES (?, ?, ?, ?, 'RUNNING', ?, ?)",
	).run(sid, PROJ, s.hb, s.hb, s.parentSid ?? null, s.role ?? "worker");
	db.close();
}

function stateOf(sid: string): string | undefined {
	const db = new Database(DB, { readonly: true });
	const r = db.query("SELECT state FROM sessions WHERE sid = ?").get(sid) as { state: string } | undefined;
	db.close();
	return r?.state;
}

// bootstrap migrates the db (v5 schema incl. work tables) so seeds can run;
// every subsequent bootstrap/gc ALSO sweeps — each test asserts against a
// fresh CLI pass
run(["kb", "stats"]);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("liveness sweep", () => {
	test("dead top-level session closes; the bootstrapping session survives", () => {
		seed("dead-sess-aaaa0001", { hb: STALE });
		const r = run(["bootstrap", "--as", "boot-sess-00000001"]);
		expect(r.code).toBe(0);
		expect(stateOf("dead-sess-aaaa0001")).toBe("CLOSED");
		expect(stateOf("boot-sess-00000001")).toBe("RUNNING");
	});

	test("coordinator exemption: by role and by coordinator.sid fact", () => {
		seed("coord-role-bbbb0002", { hb: STALE, role: "coordinator" });
		seed("coord-fact-cccc0003", { hb: STALE });
		run(["fact", "set", "coordinator.sid", "coord-fact-cccc0003"]);
		run(["bootstrap", "--as", "boot-sess-00000002"]);
		expect(stateOf("coord-role-bbbb0002")).toBe("RUNNING");
		expect(stateOf("coord-fact-cccc0003")).toBe("RUNNING");
		run(["fact", "set", "coordinator.sid", "nobody-else-ffffffff"]); // re-point: the exemption follows the fact value
	});

	test("waiting-on-decision exemption", () => {
		seed("wait-sess-dddd0004", { hb: STALE });
		const db = new Database(DB);
		db.run("CREATE TABLE IF NOT EXISTS decisions (state TEXT, answer_to TEXT)"); // the board owns this table
		db.query("INSERT INTO decisions (state, answer_to) VALUES ('OPEN', 'wait-sess-dddd0004')").run();
		db.close();
		run(["bootstrap", "--as", "boot-sess-00000003"]);
		expect(stateOf("wait-sess-dddd0004")).toBe("RUNNING");
		// closing the decision lifts the exemption
		const db2 = new Database(DB);
		db2.query("UPDATE decisions SET state = 'ANSWERED'").run();
		db2.close();
		run(["bootstrap", "--as", "boot-sess-00000004"]);
		expect(stateOf("wait-sess-dddd0004")).toBe("CLOSED");
	});

	test("live transcript keeps a hb-stale session alive", () => {
		seed("live-sess-eeee0005", { hb: STALE });
		const tdir = join(HOME, ".claude", "projects", "proj");
		mkdirSync(tdir, { recursive: true });
		writeFileSync(join(tdir, "live-sess-eeee0005.jsonl"), "{}\n");
		utimesSync(join(tdir, "live-sess-eeee0005.jsonl"), new Date(), new Date()); // fresh mtime
		run(["bootstrap", "--as", "boot-sess-00000005"]);
		expect(stateOf("live-sess-eeee0005")).toBe("RUNNING");
	});

	test("parented lanes close at 24h, not 20min", () => {
		seed("lane-old-ffff0006", { hb: STALE, parentSid: "boot-sess-00000001" });
		seed("lane-young-aaaa0007", { hb: STALE, parentSid: "boot-sess-00000001" });
		// lane-old is 1h stale (would die if it were top-level), lane-young same —
		// both survive the 20min sweep, then age-gate kicks in at 24h
		run(["bootstrap", "--as", "boot-sess-00000006"]);
		expect(stateOf("lane-old-ffff0006")).toBe("RUNNING");
		expect(stateOf("lane-young-aaaa0007")).toBe("RUNNING");
		// artificially age both past the 24h lane gate and re-sweep
		const db = new Database(DB);
		db.query("UPDATE sessions SET hb = ?, started_at = ? WHERE sid IN ('lane-old-ffff0006', 'lane-young-aaaa0007')").run(TS - 25 * 3_600_000, TS - 25 * 3_600_000);
		db.close();
		run(["bootstrap", "--as", "boot-sess-00000007"]);
		expect(stateOf("lane-old-ffff0006")).toBe("CLOSED");
		expect(stateOf("lane-young-aaaa0007")).toBe("CLOSED");
	});
});

describe("broadcast targeting", () => {
	test("only hb-fresh RUNNING sessions are targeted (honest count)", () => {
		seed("fresh-sess-aaaa0008", { hb: TS });
		seed("stale-sess-bbbb0009", { hb: STALE });
		const dbw = new Database(DB);
		dbw.query(
			"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'CLOSED')",
		).run("closed-sess-cccc0010", PROJ, STALE, STALE);
		dbw.close();
		const r = run(["broadcast", "--note", "sweep test notice", "--as", "boot-sess-00000006"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("live session(s)");
		const db = new Database(DB, { readonly: true });
		const n = (sid: string) =>
			(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'BROADCAST' AND target = ?").get(sid) as { n: number }).n;
		expect(n("fresh-sess-aaaa0008")).toBe(1);
		expect(n("stale-sess-bbbb0009")).toBe(0);
		expect(n("closed-sess-cccc0010")).toBe(0);
		db.close();
	});
});
