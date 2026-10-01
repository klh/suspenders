// test/worktree.test.ts — W52 per-item worktrees: create/retire lifecycle,
// dirty-keep refusal, branch survival, and the symlinked build dirs.
// Follows test/work-cli.test.ts: isolated temp HOME + a real git repo under
// process.cwd() (a /tmp checkout would test nothing — the bash gate exempts
// /tmp paths by design).
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-worktree-home-"));
const gitInit = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	const r = Bun.spawnSync(["git", "init", "-q", dir], {
		stdout: "ignore",
		stderr: "ignore",
	});
	void r;
};
const REPO = mkdtempSync(join(process.cwd(), ".tmp-worktree-repo-"));
gitInit(REPO);
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");

function run(
	cwd: string,
	bin: string,
	...args: string[]
): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, bin), ...args], {
		cwd,
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
const work = (...args: string[]) => run(REPO, "work.ts", ...args);
const wt = (...args: string[]) => run(REPO, "worktree.ts", ...args);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("worktree lifecycle", () => {
	test("create → isolated tree, branch, gitignore, symlinks; dirty retire refuses; clean retire removes and keeps the branch", () => {
		// repo needs a commit for worktree add to branch from
		writeFileSync(join(REPO, "README.md"), "x");
		Bun.spawnSync(["git", "-C", REPO, "add", "-A"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(
			["git", "-C", REPO, "commit", "-q", "-m", "init", "--allow-empty"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		mkdirSync(join(REPO, "node_modules"), { recursive: true });
		writeFileSync(join(REPO, "node_modules", "m.js"), "x");

		const added = work("add", "isolated work");
		expect(added.code).toBe(0);
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		expect(
			run(REPO, "coord.ts", "bootstrap", "--as", "wt-lane", "--role", "worker")
				.code,
		).toBe(0);
		expect(work("take", id, "--as", "wt-lane").code).toBe(0);

		// create refused before the claim? no — claim exists, so create works
		const c = wt("create", id);
		expect(c.code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(join(dir, "node_modules"))).toBe(true); // symlinked build dir
		const gi = readFileSync(join(REPO, ".gitignore"), "utf8");
		expect(gi).toContain(".worktrees/");

		// dirty worktree: retire refuses, dir survives
		writeFileSync(join(dir, "wip.txt"), "wip");
		const d = wt("retire", id);
		expect(d.code).toBe(3);
		expect(existsSync(dir)).toBe(true);

		// retire after committing the wip: clean → removed, branch survives
		Bun.spawnSync(["git", "-C", dir, "add", "-A"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "wip"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const r2 = wt("retire", id);
		expect(r2.code).toBe(0);
		expect(existsSync(dir)).toBe(false);
		const b = Bun.spawnSync(
			["git", "-C", REPO, "rev-parse", "--verify", `suspenders/${id}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(b.exitCode).toBe(0); // branch kept for integration
	});

	test("W123 liveness guard: clean worktree with a live lane inside is kept (exit 4), retired once the lane exits", () => {
		const added = work("add", "liveness guard");
		expect(added.code).toBe(0);
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		expect(
			run(REPO, "coord.ts", "bootstrap", "--as", "wt-live", "--role", "worker")
				.code,
		).toBe(0);
		expect(work("take", id, "--as", "wt-live").code).toBe(0);
		expect(wt("create", id).code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		// the symlinked node_modules reads untracked → dirty would mask the
		// liveness guard (exit 3 beats 4) — commit the fresh tree clean first
		Bun.spawnSync(["git", "-C", dir, "add", "-A"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(
			["git", "-C", dir, "commit", "-q", "-m", "w", "--allow-empty"],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		);

		// fake a live lane: the binary's name is the contract (ps comm match),
		// so a copy of /bin/sleep named "codex" with cwd in the tree reads live
		const fake = join(HOME, "codex");
		cpSync("/bin/sleep", fake);
		const lane = Bun.spawn([fake, "30"], {
			cwd: dir,
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			let r: { out: string; err: string; code: number } | null = null;
			for (let i = 0; i < 10; i++) {
				// fresh pids race ps/lsof enumeration — retry until seen
				r = wt("retire", id);
				if (r.code === 4) break;
				Bun.sleepSync(200);
			}
			expect(r?.code).toBe(4);
			expect(existsSync(dir)).toBe(true);
			expect(r?.err).toContain("live lane");
		} finally {
			lane.kill();
		}

		// once the lane exits, the same retire removes the tree, branch kept
		let r2: { out: string; err: string; code: number } | null = null;
		for (let i = 0; i < 10; i++) {
			r2 = wt("retire", id);
			if (r2.code === 0) break;
			Bun.sleepSync(200);
		}
		expect(r2?.code).toBe(0);
		expect(existsSync(dir)).toBe(false);
	});
});
