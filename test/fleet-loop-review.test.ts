// fleet-loop-review.test.ts — W81: the fresh-context reviewer gate runs
// before each merge (cycle and ship share mergeOne). Contract: the reviewer
// is seeded ONLY with the item objective + diff + fresh test output (the
// seed file carries no worker framing — no commit messages, no lane brief);
// a nonzero exit OR a `VERDICT: FAIL` line rejects the merge as a ladder
// strike (FAIL line, branch kept, 3 strikes park); no --review, no gate.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
const env = { ...process.env, FLEET_UNTRACKED_GRACE_MS: "0" };

// a scratch repo with main@base and a suspenders/SHIP1 worktree branch one
// commit ahead, laid out like a real lane (.worktrees/<id>) — same shape as
// fleet-loop-ship.test.ts
async function scratchRepo() {
	const dir = join(
		tmpdir(),
		`w81-review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const fails = (repo: string): Record<string, number> => {
	try {
		return JSON.parse(
			readFileSync(join(repo, ".fleet", "merge-fails.json"), "utf8"),
		) as Record<string, number>;
	} catch {
		return {};
	}
};

describe("fleet-loop review gate (W81)", () => {
	test("passing reviewer lets the merge land; REVIEW-PASS logged", async () => {
		const repo = await scratchRepo();
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--review",
			"exit 0",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("REVIEW-PASS suspenders/SHIP1");
		expect(log(repo)).toContain("MERGED suspenders/SHIP1");
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).toBe("");
		rmSync(repo, { recursive: true, force: true });
	});

	test("nonzero reviewer exit rejects the merge as a strike; the ladder never runs", async () => {
		const repo = await scratchRepo();
		// the ladder would add a SECOND strike if it ran — the count staying 1
		// proves the rejected review short-circuits ahead of the merge
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--review",
			"echo suspicious; exit 9",
			"--ladder",
			"exit 3",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("FAIL suspenders/SHIP1");
		expect(log(repo)).toContain("review rejected");
		expect(log(repo)).not.toContain("MERGED suspenders/SHIP1");
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).not.toBe("");
		expect(
			g(repo, ["rev-list", "--count", "main"]).stdout.toString().trim(),
		).toBe("1");
		expect(fails(repo)["suspenders/SHIP1"]).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test("VERDICT: FAIL rejects even when the reviewer exits 0", async () => {
		const repo = await scratchRepo();
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--review",
			"echo VERDICT: FAIL broken loop invariant",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("FAIL suspenders/SHIP1");
		expect(log(repo)).toContain("broken loop invariant");
		expect(fails(repo)["suspenders/SHIP1"]).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test("seed carries objective slot, diff, fresh tests — and no worker framing", async () => {
		const repo = await scratchRepo();
		// cat {seed} proves the {seed} substitution; the seed file is asserted
		// directly afterward
		const r = ship(repo, [
			"--branch",
			"suspenders/SHIP1",
			"--review",
			"cat {seed}",
			"--review-tests",
			"git show {branch}:f.txt",
		]);
		expect(r.code).toBe(0);
		expect(log(repo)).toContain("MERGED suspenders/SHIP1");
		const seed = readFileSync(
			join(repo, ".fleet", "review-seed-suspenders-SHIP1.md"),
			"utf8",
		);
		// the three seeded inputs
		expect(seed).toContain("## Item objective");
		expect(seed).toContain("(no work item found for branch suspenders/SHIP1)");
		expect(seed).toContain("diff --git");
		expect(seed).toContain("+two");
		expect(seed).toContain("fresh run exit code: 0");
		expect(seed).toContain("one\ntwo"); // git show {branch}:f.txt output
		// the exclusion that is the whole point: commit messages (worker
		// framing) must not reach the reviewer
		expect(seed).not.toContain("lane change");
		rmSync(repo, { recursive: true, force: true });
	});

	test("three review strikes park the branch like ladder failures", async () => {
		const repo = await scratchRepo();
		for (let i = 0; i < 3; i++)
			ship(repo, ["--branch", "suspenders/SHIP1", "--review", "exit 1"]);
		expect(log(repo)).toContain("PARKED suspenders/SHIP1 → parked/SHIP1");
		expect(
			g(repo, ["branch", "--list", "suspenders/SHIP1"]).stdout.toString(),
		).toBe("");
		expect(
			g(repo, ["branch", "--list", "parked/SHIP1"]).stdout.toString(),
		).not.toBe("");
		rmSync(repo, { recursive: true, force: true });
	});
});
