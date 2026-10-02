// test/dispatch-next.test.ts — W145: suspenders dispatches its own fan-outs
// through the fleet machinery. Covered: the capsule write/read round-trip
// through the REAL coord verb (scratch-HOME governor db), dry-run dispatch
// (prints item + brief, spawns nothing, takes nothing), and resume-rebrief
// composition (dead lane's last capsule returns as RESUME CONTEXT).
import { describe, expect, test, afterAll } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composeBrief,
	isOwnerGated,
	parseCapsuleGet,
	parseReady,
} from "../scripts/dispatch-next.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w145-dispatch-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w145-dispatch-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = { ...process.env, HOME };

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: one commit so worktree ops would have a base
import { spawnSync } from "node:child_process";
const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
import { writeFileSync } from "node:fs";
writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

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
const dispatch = (...args: string[]) => {
	// dispatch-next lives in scripts/, not hooks/bin — spawn it directly
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
			"--repo",
			REPO,
			...args,
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

describe("capsule protocol (real coord verb, scratch db)", () => {
	test("write/read round-trip", () => {
		const set = tool(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			"autowrt",
			"--checkpoint=deadbeef",
			"--file=src/x.ts:42",
			"--done=parser green",
			"--next=wire the gate",
		);
		expect(set.code).toBe(0);
		const got = tool("coord.ts", "capsule", "get", "--as", "autowrt");
		expect(got.code).toBe(0);
		const cap = parseCapsuleGet(got.out);
		expect(cap).not.toBeNull();
		expect(cap?.checkpoint).toBe("deadbeef");
		expect(cap?.next).toBe("wire the gate");
		// empty read is null, not a crash — the fresh-lane path
		expect(parseCapsuleGet("(no capsule)")).toBeNull();
	});
});

describe("dry-run dispatch", () => {
	let id = "";
	test("prints chosen item + full brief, takes nothing, spawns nothing", () => {
		const added = tool("work.ts", "add", "sample lane mission");
		id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const out = dispatch("--dry-run", "--target", "1");
		expect(out.out).toContain(`DRY dispatch ${id}`);
		expect(out.out).toContain("CAPSULE PROTOCOL");
		expect(out.out).toContain("LANDING CHAIN");
		expect(out.out).toContain(`lane "autow${id.slice(1)}"`);
		// W187: the cap decision reads the governor (graph claims × alive pids)
		expect(out.out).toContain("lanes live: 0/1");
		// no side effects: no claim, no worktree, no lane registry
		const show = tool("work.ts", "show", id);
		expect(show.out).toContain("READY");
		expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		expect(existsSync(join(REPO, ".fleet", "lanes.json"))).toBe(false);
	});
});

describe("resume-rebrief composition", () => {
	test("dead lane's capsule returns as RESUME CONTEXT", () => {
		const showOut = "◐ W140 RUNNING  sample item\n  owner_sid: autow140";
		const base = {
			item: "W140",
			showOut,
			sid: "autow140",
			branch: "suspenders/W140",
			worktree: "/tmp/nowhere/.worktrees/W140",
		};
		const fresh = composeBrief({ ...base, capsule: null });
		expect(fresh).not.toContain("RESUME CONTEXT —");
		expect(fresh).toContain("CAPSULE PROTOCOL");
		expect(fresh).toContain(`done W140 --sha <branch-head> --as autow140`);
		expect(fresh).toContain("finding.w140");
		const resumed = composeBrief({
			...base,
			capsule: { checkpoint: "abc123", done: "half", next: "other half" },
		});
		expect(resumed).toContain("RESUME CONTEXT —");
		expect(resumed).toContain("abc123");
	});
});

describe("pool parsing", () => {
	test("parseReady reads renderRow rows; owner-gated titles skip", () => {
		const rows = [
			"\x1b[36m  · W140   build the thing\x1b[0m",
			"  · W141   OWNER-GATED: wait for owner",
			"  ⚠ W142   blocked row (not READY glyph)",
		].join("\n");
		const parsed = parseReady(rows);
		expect(parsed.map((r) => r.id)).toEqual(["W140", "W141"]);
		expect(parsed[1].title).toContain("OWNER-GATED");
		expect(isOwnerGated(parsed[1].title)).toBe(true);
		expect(isOwnerGated(parsed[0].title)).toBe(false);
	});
});
