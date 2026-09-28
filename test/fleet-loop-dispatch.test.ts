// test/fleet-loop-dispatch.test.ts — W72: codex workspace parity with
// worktree.ts — a fresh codex workspace gets the repo's gitignored build
// dirs symlinked in (same list, same best-effort semantics), so codex lanes
// skip reinstalls like git-worktree lanes do. Dispatch without the agent
// binary on PATH stops at the binary check, which leaves the fresh
// workspace observable; the resume path must not duplicate or clobber.
import { describe, expect, test, afterAll } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readlinkSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-w72-dispatch-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-fleet-dispatch-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = { ...process.env, HOME };

// dispatch invokes the INSTALLED CLI path ($HOME/.claude/hooks/suspenders/
// bin) — wire it to this repo's hooks/bin so the test exercises the repo
// under test, not whatever is installed on the machine
mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

// /usr/bin/git is PATH-independent (launchd-minimal envs), mirrors worktree.ts
const g = (args: string[], cwd = REPO): { out: string; code: number } => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString().trim(), code: p.exitCode ?? 1 };
};

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: a commit, a node_modules dir worth symlinking
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
mkdirSync(join(REPO, "node_modules"), { recursive: true });
writeFileSync(join(REPO, "node_modules", "m.js"), "x");
writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
expect(g(["commit", "-m", "base"]).code).toBe(0);

const tool = (bin: string, ...args: string[]) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

const added = tool("work.ts", "add", "codex parity");
const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
expect(id).toBeTruthy();
expect(
	tool(
		"coord.ts",
		"bootstrap",
		"--as",
		`autow${id.slice(1)}`,
		"--role",
		"worker",
	).code,
).toBe(0);

// dispatch with the agent binary absent: workspace creation and the work
// claim happen first; the run stops at the Bun.which check
const dispatch = () => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(BIN, "fleet-loop.ts"),
			"dispatch",
			"--repo",
			REPO,
			"--item",
			id,
			"--agent",
			"codex",
		],
		{
			cwd: REPO,
			env: { ...env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

describe("codex dispatch workspace parity", () => {
	test("fresh workspace symlinks build dirs; resume leaves them alone", () => {
		const d1 = dispatch();
		expect(d1.err).toContain("codex binary not found");
		const wt = join(REPO, ".worktrees", id);
		expect(existsSync(wt)).toBe(true);
		const link = join(wt, "node_modules");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(join(REPO, "node_modules"));

		// resume (claim already ours, workspace exists): no duplicate, no clobber
		const d2 = dispatch();
		expect(d2.err).toContain("codex binary not found");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readdirSync(wt).filter((e) => e === "node_modules")).toHaveLength(1);
	});
});
