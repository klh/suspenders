// fleet-loop-done-cadence.test.ts — W84: dispatcher policy in the loop —
// DONE branches flow to the ladder every cycle, keyed on the Work Graph
// rather than the static glob. Contract: a DONE item's suspenders/<id>
// branch merges when the recorded result_sha sits on it (single-concern
// flow), a result sha that lives on a foreign branch holds the branch with
// an honest HOLD line (single-concern guard), a WIP item never flows, and a
// DONE item whose branch already landed retires worktree + branch.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOOP = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const env = {
	...process.env,
	FLEET_UNTRACKED_GRACE_MS: "0",
};

// a scratch repo with main@base, one lane-style worktree branch
// suspenders/<id> the given commits ahead, plus an isolated fake HOME so
// the loop's Work Graph reads hit a scratch governor.db — never the real one
async function scratchRepo(id: string) {
	const dir = join(
		tmpdir(),
		`w84-cadence-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const g = (args: string[], cwd = dir) =>
		Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	expect(g(["init", "-b", "main"]).exitCode).toBe(0);
	g(["config", "user.email", "t@threads.dk"]);
	g(["config", "user.name", "t"]);
	await Bun.write(Bun.file(join(dir, "f.txt")), "one\n");
	g(["add", "-A"]);
	expect(g(["commit", "-m", "base"]).exitCode).toBe(0);
	const wt = join(dir, ".worktrees", id);
	expect(g(["worktree", "add", "-b", `suspenders/${id}`, wt]).exitCode).toBe(0);
	return { dir, home, wt, g };
}

// the loop resolves the Work Graph project as the repo's realpath common git
// dir (projectIdentity) — same call the test makes to seed the scratch DB
function projectId(repo: string): string {
	const r = Bun.spawnSync(
		["git", "-C", repo, "rev-parse", "--git-common-dir"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return realpathSync(resolve(repo, r.stdout.toString().trim()));
}

// seed a work item into the scratch HOME's governor.db — govdb's REG is
// HOME-derived at import, so a child `bun -e` with the fake HOME opens the
// scratch DB (migrations included); the real one is never touched
function seedItem(
	home: string,
	project: string,
	id: string,
	state: string,
	sha: string | null,
): void {
	const script = `
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
db.query(
	"INSERT INTO work_items (project, id, title, state, result_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run(${JSON.stringify(project)}, ${JSON.stringify(id)}, ${JSON.stringify(`item ${id}`)}, ${JSON.stringify(state)}, ${sha ? JSON.stringify(sha) : null}, Date.now(), Date.now());
`;
	const p = Bun.spawnSync(["bun", "-e", script], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`seed failed: ${p.stderr.toString().slice(0, 400)}`);
}

function once(repo: string, home: string) {
	const p = Bun.spawnSync(["bun", LOOP, "once", "--repo", repo], {
		cwd: repo,
		env: { ...env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

const log = (repo: string): string => {
	try {
		return readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
	} catch {
		return "";
	}
};

const count = (repo: string, b: string): string | null => {
	const p = Bun.spawnSync(
		["git", "-C", repo, "rev-list", "--count", `main..${b}`],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

// mark the lane change on a worktree branch: f.txt gains a line naming <tag>
async function laneCommit(
	wt: string,
	g: (args: string[], cwd?: string) => ReturnType<typeof Bun.spawnSync>,
	tag: string,
): Promise<string> {
	await Bun.write(Bun.file(join(wt, "f.txt")), `one\n${tag}\n`);
	expect(g(["add", "-A"], wt).exitCode).toBe(0);
	expect(g(["commit", "-m", `lane ${tag}`], wt).exitCode).toBe(0);
	const head = g(["rev-parse", "HEAD"], wt);
	return head.stdout.toString().trim();
}

describe("fleet-loop DONE cadence (W84)", () => {
	test("a DONE item's branch flows to the ladder without matching the glob", async () => {
		const { dir, home, wt, g } = await scratchRepo("DONE1");
		const sha = await laneCommit(wt, g, "done1");
		seedItem(home, projectId(dir), "DONE1", "DONE", sha);
		const r = once(dir, home);
		expect(r.code).toBe(0);
		expect(log(dir)).toContain("MERGED suspenders/DONE1");
		// merged then retired in the same cycle — the W84 lifecycle end-to-end
		expect(log(dir)).toContain("RETIRED suspenders/DONE1");
		expect(count(dir, "suspenders/DONE1")).toBeNull();
		expect(readFileSync(join(dir, "f.txt"), "utf8")).toContain("done1");
	});

	test("a result sha that lives on a foreign branch is HELD, not flowed", async () => {
		const { dir, home, wt, g } = await scratchRepo("DONE2");
		await laneCommit(wt, g, "done2");
		// the recorded sha lives on another branch entirely — a multi-concern
		// or mis-recorded result. The branch must NOT flow.
		expect(g(["branch", "other/holder"]).exitCode).toBe(0);
		expect(g(["checkout", "other/holder"]).exitCode).toBe(0);
		await Bun.write(Bun.file(join(dir, "foreign.txt")), "x\n");
		g(["add", "-A"]);
		expect(g(["commit", "-m", "foreign"]).exitCode).toBe(0);
		const foreignSha = g(["rev-parse", "HEAD"]).stdout.toString().trim();
		expect(g(["checkout", "main"]).exitCode).toBe(0);
		seedItem(home, projectId(dir), "DONE2", "DONE", foreignSha);
		const r = once(dir, home);
		expect(r.code).toBe(0);
		expect(log(dir)).toContain("HOLD suspenders/DONE2");
		expect(log(dir)).not.toContain("MERGED suspenders/DONE2");
		// refusal is honest: the branch keeps its unmerged commit
		expect(count(dir, "suspenders/DONE2")).toBe("1");
	});

	test("a WIP (CLAIMED) item never flows through the DONE sweep", async () => {
		const { dir, home, wt, g } = await scratchRepo("DONE3");
		const sha = await laneCommit(wt, g, "done3");
		seedItem(home, projectId(dir), "DONE3", "CLAIMED", sha);
		const r = once(dir, home);
		expect(r.code).toBe(0);
		expect(log(dir)).not.toContain("MERGED suspenders/DONE3");
		expect(log(dir)).not.toContain("HOLD suspenders/DONE3");
		expect(count(dir, "suspenders/DONE3")).toBe("1");
	});

	test("a DONE item whose branch already landed retires worktree + branch", async () => {
		const { dir, home, wt, g } = await scratchRepo("DONE4");
		const sha = await laneCommit(wt, g, "done4");
		// simulate an earlier merge: the branch's content is on main, so the
		// branch reads not-ahead — the sweep's job is the retire half now
		expect(g(["cherry-pick", "--allow-empty", sha]).exitCode).toBe(0);
		seedItem(home, projectId(dir), "DONE4", "DONE", sha);
		const r = once(dir, home);
		expect(r.code).toBe(0);
		expect(log(dir)).toContain("RETIRED suspenders/DONE4");
		expect(count(dir, "suspenders/DONE4")).toBeNull();
	});
});
