// test/machines.test.ts — W176: the machine capability registry. Covered:
// register/list round-trip + upsert, heartbeat freshness + stale routing
// exclusion, roles ⊇ need routing (beefiest first), route --item through
// work_items.requires, the delta up-feed (machines rows land in the deltas
// log and coord diff tails them), and fleet-loop dispatch --machine
// (explicit pin + auto route) refusing honestly and stamping origin.
// Recipe: coord-diff.test.ts — temp HOME under the repo, CLI/govdb access
// only in bun subprocesses (the parent test process never opens the real DB).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const home = mkdtempSync(join(process.cwd(), ".machines-test-"));
const env = { ...process.env, HOME: home };

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(FL_REPO, { recursive: true, force: true });
});

const runIn = (code: string, cwd?: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

// every DB open re-runs the migration idempotently
const sql = <T>(statement: string, ...params: unknown[]): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all(${params.length ? JSON.stringify(params) : ""})));
`),
	);

const cli = (bin: string, args: string[], envExtra?: object) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		env: { ...env, ...envExtra },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

describe("machine registry", () => {
	test("register → list round-trip; upsert updates, never duplicates", () => {
		const r = cli("coord.ts", [
			"machine",
			"register",
			"beefy",
			"--roles",
			"shell,git,build",
			"--cpu",
			"16",
			"--ram",
			"64",
			"--gpu",
			"M3 Max",
			"--as",
			"lane1",
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("beefy registered");
		const r2 = cli("coord.ts", [
			"machine",
			"register",
			"beefy",
			"--roles",
			"shell,git,build,vision",
			"--cpu",
			"24",
			"--ram",
			"96",
		]);
		expect(r2.code).toBe(0);
		const rows = sql<{ name: string; cpu_cores: number; roles: string }>(
			"SELECT name, cpu_cores, roles FROM machines WHERE name = 'beefy'",
		);
		expect(rows.length).toBe(1);
		expect(rows[0].cpu_cores).toBe(24);
		expect(rows[0].roles).toBe("shell,git,build,vision");
	});

	test("heartbeat refreshes last_hb; unknown machine refused", () => {
		const before = sql<{ last_hb: number }>(
			"SELECT last_hb FROM machines WHERE name = 'beefy'",
		)[0].last_hb;
		const r = cli("coord.ts", ["machine", "heartbeat", "beefy"]);
		expect(r.code).toBe(0);
		const after = sql<{ last_hb: number }>(
			"SELECT last_hb FROM machines WHERE name = 'beefy'",
		)[0].last_hb;
		expect(after).toBeGreaterThanOrEqual(before);
		expect(cli("coord.ts", ["machine", "heartbeat", "ghost"]).code).toBe(2);
	});

	test("remove retires (soft) — stays listed, excluded from routing", () => {
		cli("coord.ts", [
			"machine",
			"register",
			"oldbox",
			"--roles",
			"build",
			"--cpu",
			"8",
			"--ram",
			"32",
		]);
		const r = cli("coord.ts", ["machine", "remove", "oldbox"]);
		expect(r.code).toBe(0);
		expect(
			sql<{ state: string }>(
				"SELECT state FROM machines WHERE name = 'oldbox'",
			)[0].state,
		).toBe("retired");
	});
});

describe("machine routing", () => {
	test("route --need picks the beefiest capable machine", () => {
		cli("coord.ts", [
			"machine",
			"register",
			"littlebox",
			"--roles",
			"build",
			"--cpu",
			"4",
			"--ram",
			"8",
		]);
		const r = cli("coord.ts", ["machine", "route", "--need", "build"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("beefy");
		expect(r.out).not.toContain("littlebox");
	});

	test("stale heartbeat machines are excluded from routing", () => {
		// backdate littlebox's hb past the 15-min freshness window
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
openGovernorDb().query("UPDATE machines SET last_hb = last_hb - 3600000 WHERE name = 'littlebox'").run();
`);
		const r = cli("coord.ts", ["machine", "route", "--need", "build"]);
		expect(r.out).toContain("beefy");
		expect(r.out).not.toContain("littlebox");
	});

	test("no capable machine → honest exit 2", () => {
		const r = cli("coord.ts", ["machine", "route", "--need", "browser"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("no active+fresh machine covers [browser]");
	});

	test("route --item resolves need through work_items.requires", () => {
		const added = cli("work.ts", [
			"add",
			"needs build muscle",
			"--requires",
			"build",
		]);
		expect(added.code).toBe(0);
		const id = added.out.match(/✓\s+(\S+)\s/)?.[1];
		expect(id).toBeTruthy();
		const r = cli("coord.ts", ["machine", "route", "--item", id]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("beefy");
	});
});

describe("delta up-feed", () => {
	test("registry writes land in the deltas log; coord diff tails them", () => {
		const deltas = sql<{ seq: number; tbl: string; op: string; pk: string }>(
			"SELECT seq, tbl, op, pk FROM deltas WHERE tbl = 'machines' ORDER BY seq",
		);
		// beefy: insert + upsert; oldbox: insert + retire update
		expect(
			deltas.filter((d) => d.pk === "beefy").length,
		).toBeGreaterThanOrEqual(2);
		expect(deltas.some((d) => d.pk === "oldbox" && d.op === "update")).toBe(
			true,
		);
		const diff = cli("coord.ts", [
			"diff",
			"--table",
			"machines",
			"--last",
			"50",
		]);
		expect(diff.code).toBe(0);
		expect(diff.out).toContain("machines");
	});
});

// dispatch needs a REAL repo (worktree ops) and the INSTALLED CLI path —
// fleet-loop invokes $HOME/.claude/hooks/suspenders/bin/*.ts (fleet-loop-dispatch
// .test.ts recipe). PATH scrub (no codex/claude) keeps dispatch honest-failing
// at the agent-binary check instead of spawning a lane.
import { mkdirSync, symlinkSync } from "node:fs";
const FL_REPO = mkdtempSync(join(process.cwd(), ".machines-fl-repo-"));
mkdirSync(join(home, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(home, ".claude", "hooks", "suspenders", "bin"), "dir");
const g = (args: string[]): void => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd: FL_REPO,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`,
		);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
import { writeFileSync } from "node:fs";
writeFileSync(join(FL_REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

const flCli = (args: string[]): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(
		[process.execPath, join(BIN, "fleet-loop.ts"), ...args],
		{
			cwd: FL_REPO,
			env: { ...env, PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

const workCli = (
	args: string[],
): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync([process.execPath, join(BIN, "work.ts"), ...args], {
		cwd: FL_REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

describe("fleet-loop dispatch --machine", () => {
	test("unknown machine refused before any spawn", () => {
		const r = flCli([
			"dispatch",
			"--repo",
			FL_REPO,
			"--item",
			"W1",
			"--machine",
			"ghost",
		]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("not in the registry");
	});

	test("--machine auto reads item.requires and refuses uncovered roles", () => {
		const added = workCli([
			"add",
			"flaky browser work",
			"--requires",
			"browser",
		]);
		expect(added.code).toBe(0);
		const id = added.out.match(/✓\s+(\S+)\s/)?.[1];
		expect(id).toBeTruthy();
		// beefy has no browser role — auto must refuse BEFORE the take
		const r = flCli([
			"dispatch",
			"--repo",
			FL_REPO,
			"--item",
			id,
			"--machine",
			"auto",
		]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("no active+fresh machine covers [browser]");
	});

	test("capable machine passes the gate; origin stamped from registry", () => {
		cli("coord.ts", [
			"machine",
			"register",
			"fleetbox",
			"--roles",
			"browser,shell,git",
			"--cpu",
			"32",
			"--ram",
			"128",
		]);
		// production: the lane session on the target machine bootstraps with
		// that machine's roles — seed the same way so work take's
		// requires ⊆ capabilities gate passes after machine routing
		runIn(
			`
const { openGovernorDb, projectIdentity } = await import(${JSON.stringify(GOVDB)});
openGovernorDb().query("INSERT INTO sessions (sid, project, role, started_at, hb, state, capabilities) VALUES ('autow1', ?, 'worker', ?, ?, 'RUNNING', 'browser,shell,git')").run(projectIdentity(), Date.now(), Date.now());
`,
			FL_REPO,
		);
		const r = flCli([
			"dispatch",
			"--repo",
			FL_REPO,
			"--item",
			"W1",
			"--machine",
			"auto",
		]);
		// PATH scrub → honest agent-binary failure, but the machine gate and
		// work take (origin stamp) both ran
		expect(r.err).toContain("binary not found on PATH");
		const originJson = runIn(
			`
const { openGovernorDb, projectIdentity } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query("SELECT origin FROM work_items WHERE id = 'W1' AND project = ?").get(projectIdentity())));
`,
			FL_REPO,
		);
		expect(JSON.parse(originJson).origin).toBe("fleetbox:claude");
	});
});
