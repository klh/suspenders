// fleet-loop-ship.test.ts — W64: the board's one-click ship trigger runs
// `fleet-loop.ts ship` on a real scratch repo. Contract: the branch goes
// through the configured ladder (template {branch} substitution), lands as a
// MERGED line in loop.log, and the merged branch + worktree retire; a
// not-ahead branch is a no-op, a failed ladder aborts the merge and leaves
// the branch (strike counted), a live daemon merge vetoes ship outright
// (W101) and crashed debris is healed, not blindly aborted.
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
const env = { ...process.env, FLEET_UNTRACKED_GRACE_MS: "0" };

// a scratch repo with main@base and a suspenders/SHIP1 worktree branch one
// commit ahead, laid out like a real lane (.worktrees/<id>); the ladder is
// passed per-invocation — the loop reads argv, the BOARD reads ship.json
async function scratchRepo() {
	const dir = join(
		tmpdir(),
		`w64-ship-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	const g = (args: string[], cwd = dir) =>
		Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	expect(g(["init", "-b", "main"]).exitCode).toBe(0);
	g(["config", "user.email", "t@threads.dk"]);
	g(["config", "user.name", "t"]);
	await Bun.write(Bun.file(join(dir, "f.txt")), "one\n");
	g(["add", "-A"]);
	expect(g(["commit", "-m", "base"]).exitCode).toBe(0);
	expect(
		g([
			"worktree",
			"add",
			"-b",
			"suspenders/SHIP1",
			join(dir, ".worktrees", "SHIP1"),
		]).exitCode,
	).toBe(0);
	await Bun.write(
		Bun.file(join(dir, ".worktrees", "SHIP1", "f.txt")),
		"one\ntwo\n",
	);
	g(["add", "-A"], join(dir, ".worktrees", "SHIP1"));
	expect(
		g(["commit", "-m", "lane change"], join(dir, ".worktrees", "SHIP1"))
			.exitCode,
	).toBe(0);
	return dir;
}

function ship(repo: string, extra: string[] = []) {
	const p = Bun.spawnSync(["bun", LOOP, "ship", "--repo", repo, ...extra], {
		cwd: repo,
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

const g = (repo: string, args: string[], cwd?: string) =>
	Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});

// ship logs to <repo>/.fleet/loop.log; sync read — tests assert its lines
const log = (repo: string): string => {
	try {
		return readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
	} catch {
		return "";
	}
};

// W101: a live merge-active marker — pid alive + exact ps cmdline + fresh
// ts, the same shape mergeOne writes; the sleeper stands in for the runner
function liveMarker(repo: string): ReturnType<typeof Bun.spawn> {
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	const dummy = Bun.spawn(["sleep", "30"]);
	writeFileSync(
		join(repo, ".fleet", "merge-active"),
		JSON.stringify({
			pid: dummy.pid,
			cmd: Bun.spawnSync(["ps", "-o", "command=", "-p", String(dummy.pid)])
				.stdout.toString()
				.trim(),
			branch: "suspenders/SHIP1",
			ts: Date.now(),
		}),
	);
	return dummy;
}

describe("fleet-loop ship mode (W64)", () => {
	test("merges one branch through the ladder, retires branch + worktree", async () => {
		const repo = await scratchRepo();
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("MERGED suspenders/SHIP1");
		// plain-merge default: merge commit exists, branch retired
		expect(g(repo, ["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			"Merge suspenders/SHIP1",
		);
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).toBe("");
		expect(g(repo, ["worktree", "list"]).stdout.toString()).not.toContain(
			"/wt",
		);
		rmSync(repo, { recursive: true, force: true });
	});

	test("ladder template substitution runs and clears prior strikes", async () => {
		const repo = await scratchRepo();
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--ladder",
			'git merge --no-ff {branch} -m "shipped {branch}"',
		]);
		expect(r.code).toBe(0);
		// substitution proven by the merge message carrying the real branch name
		expect(g(repo, ["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			"shipped suspenders/SHIP1",
		);
		expect(log(repo)).toContain("MERGED suspenders/SHIP1");
		rmSync(repo, { recursive: true, force: true });
	});

	test("not-ahead branch is a no-op that just retires", async () => {
		const repo = await scratchRepo();
		// pre-merge the branch out of band — ship has nothing to merge
		expect(
			g(repo, ["merge", "--no-ff", "suspenders/SHIP1", "-m", "pre"]).exitCode,
		).toBe(0);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(0);
		// retire deleted the merged branch; exactly one merge commit
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("3");
		expect(log(repo)).not.toContain("MERGED suspenders/SHIP1");
		rmSync(repo, { recursive: true, force: true });
	});

	test("failed ladder: FAIL, merge aborted, branch kept, strike counted", async () => {
		const repo = await scratchRepo();
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--ladder",
			"exit 7",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("FAIL suspenders/SHIP1");
		// branch still exists, main untouched, one strike recorded
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).not.toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		const fails = JSON.parse(
			await Bun.file(join(repo, ".fleet", "merge-fails.json")).text(),
		) as Record<string, number>;
		expect(fails["suspenders/SHIP1"]).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test("leftover MERGE_HEAD debris (dead runner) is healed before the merge", async () => {
		const repo = await scratchRepo();
		// stage a conflicted merge to leave MERGE_HEAD behind
		await Bun.write(Bun.file(join(repo, "f.txt")), "conflict\n");
		g(repo, ["add", "-A"]);
		expect(g(repo, ["commit", "-m", "diverge"]).exitCode).toBe(0);
		expect(g(repo, ["merge", "suspenders/SHIP1"], repo).exitCode).not.toBe(0);
		// a DEAD runner's marker: no veto — the surgical heal runs instead
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(
			join(repo, ".fleet", "merge-active"),
			JSON.stringify({ pid: 999999999, ts: Date.now() }),
		);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("SELF-HEAL");
		rmSync(repo, { recursive: true, force: true });
	});

	test("live merge marker vetoes ship — MERGE_HEAD untouched, no strike (W101)", async () => {
		const repo = await scratchRepo();
		await Bun.write(Bun.file(join(repo, "f.txt")), "conflict\n");
		g(repo, ["add", "-A"]);
		expect(g(repo, ["commit", "-m", "diverge"]).exitCode).toBe(0);
		expect(g(repo, ["merge", "suspenders/SHIP1"], repo).exitCode).not.toBe(0);
		const dummy = liveMarker(repo);
		const r = ship(repo, ["--branch", "suspenders/SHIP1"]);
		expect(r.code).toBe(1);
		expect(log(repo)).toContain("SHIP-VETO suspenders/SHIP1");
		// hands-off: the in-flight merge state survives, no strike was counted
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
		expect(existsSync(join(repo, ".fleet", "merge-fails.json"))).toBe(false);
		rmSync(repo, { recursive: true, force: true });
		dummy.kill();
	});

	test("cycle skips the merge while a runner is mid-flight (W101)", async () => {
		const repo = await scratchRepo();
		// live marker, NO MERGE_HEAD — the pre-merge ladder window
		const dummy = liveMarker(repo);
		const p = Bun.spawnSync(
			["bun", LOOP, "once", "--repo", repo, "--glob", "suspenders/*"],
			{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
		);
		expect(p.exitCode).toBe(0);
		expect(log(repo)).toContain("MERGE-BUSY suspenders/SHIP1");
		// untouched: no merge commit, branch alive, no strike
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).not.toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		expect(existsSync(join(repo, ".fleet", "merge-fails.json"))).toBe(false);
		rmSync(repo, { recursive: true, force: true });
		dummy.kill();
	});
});
