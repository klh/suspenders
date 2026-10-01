#!/usr/bin/env bun
// worktree.ts — per-item git worktrees (W52). Parallel lanes on one repo get
// an isolated tree each: `.worktrees/<id>` on branch `suspenders/<id>`, with
// gitignored build dirs symlinked in. Claim scope still governs edits (the
// worktree lives inside the project); `work done` retires a clean worktree and
// refuses to destroy a dirty one or one with a live lane inside (work is never
// silently discarded — the branch survives either way for the integration
// spine).
//
//   bun worktree.ts create <id>               # item must be CLAIMED/RUNNING
//   bun worktree.ts retire <id> [--force]     # clean+idle → remove; dirty → keep (exit 3);
//                                             # clean but live lane inside → keep (exit 4)
//   bun worktree.ts path <id>                 # print the worktree path
//
// The path is DERIVED (no schema change): .worktrees/<id> existing = the item
// has a worktree. `work done` calls retire automatically.

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { openGovernorDb } from "../lib/govdb.ts";
import { symlinkBuildDirs } from "../lib/builddirs.ts";
import { worktreeLive } from "../lib/worktree-live.ts";

const [cmd, id, ...flags] = process.argv.slice(2);
const FORCE = flags.includes("--force");

if (!cmd || !id) {
	console.log("usage: worktree.ts {create|retire|path} <id> [--force]");
	process.exit(2);
}

const PROJECT = projectIdentity();
const ROOT = dirname(PROJECT); // project identity is "<repo-root>/.git"
const wtDir = join(ROOT, ".worktrees", id);
const branch = `suspenders/${id}`;

function projectIdentity(): string {
	// mirror govdb's identity: nearest .git from cwd, with the /.git suffix
	let d = process.cwd();
	while (d !== "/") {
		if (existsSync(join(d, ".git"))) return join(d, ".git");
		d = dirname(d);
	}
	console.error("worktree: not inside a git repository");
	process.exit(2);
}

const git = (args: string[], cwd = ROOT): { out: string; code: number } => {
	const p = Bun.spawnSync(["/usr/bin/git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString().trim(), code: p.exitCode };
};

const die = (msg: string, code = 1): never => {
	console.error(`worktree: ${msg}`);
	process.exit(code);
};

const emit = (kind: string, extra: Record<string, string>): void => {
	try {
		openGovernorDb()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) SELECT ?, ?, ?, scope, ?, NULL FROM work_items WHERE project = ? AND id = ?",
			)
			.run(
				Date.now(),
				"worktree",
				kind,
				JSON.stringify({ work: id, project: PROJECT, ...extra }),
				PROJECT,
				id,
			);
	} catch {
		// bus unavailable (offline mirror fallback) — worktree still works
	}
};

// ─── create ───
if (cmd === "create") {
	const db = openGovernorDb();
	const it = db
		.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
		.get(PROJECT, id) as { state: string } | null;
	if (!it) die(`no work item ${id} in ${PROJECT}`);
	if (!["CLAIMED", "RUNNING"].includes(it.state))
		die(
			`${id} is ${it.state} — a worktree follows a live claim (work take first)`,
		);
	if (existsSync(wtDir)) die(`${wtDir} already exists — retire it first`);

	// keep the isolation dir itself out of every checkout
	const giPath = join(ROOT, ".gitignore");
	if (
		!existsSync(giPath) ||
		!readFileSync(giPath, "utf8")
			.split("\n")
			.some((l) => l.trim() === ".worktrees/")
	) {
		appendFileSync(giPath, "\n.worktrees/\n");
	}

	const r = git(["worktree", "add", "-b", branch, wtDir]);
	if (r.code !== 0) die(`git worktree add failed: ${r.out || "(stderr)"}`);

	// symlink canonical gitignored build dirs so lanes skip reinstalls
	symlinkBuildDirs(ROOT, wtDir);

	emit("work.tree", id, { path: wtDir, branch });
	console.log(`${wtDir}`);
	process.exit(0);
}

// ─── retire ───
if (cmd === "retire") {
	if (!existsSync(wtDir) || !existsSync(join(wtDir, ".git"))) {
		console.log(`no worktree for ${id}`);
		process.exit(0);
	}
	const dirty = git(["status", "--porcelain"], wtDir).out;
	if (dirty && !FORCE) {
		console.error(
			`${wtDir} is dirty — keeping it (work is never silently discarded; --force to override)`,
		);
		process.exit(3);
	}
	// W123 liveness guard: a CLEAN tree can still have a live lane inside —
	// yanking its cwd kills the lane mid-teardown (same failure fleet-loop's
	// ladder hit: gaps 2026-09-30). Any live claude/codex with cwd in the
	// worktree keeps it; the branch survives and a later retire (or the
	// merge ladder, post-merge) picks it up. --force overrides, like dirty.
	if (!dirty && !FORCE && worktreeLive(wtDir)) {
		emit("work.tree", id, { kept: "live-lane", path: wtDir, branch });
		console.error(
			`${wtDir} has a live lane inside — keeping it (liveness guard; --force to override)`,
		);
		process.exit(4);
	}
	const r = git(["worktree", "remove", ...(dirty ? ["--force"] : []), wtDir]);
	if (r.code !== 0) die(`git worktree remove failed: ${r.out}`);
	// the branch suspenders/<id> survives — integration merges from refs
	emit("work.tree", id, { retired: "1", path: wtDir, branch });
	console.log(`retired ${wtDir} — branch ${branch} kept for integration`);
	process.exit(0);
}

// ─── path ───
if (cmd === "path") {
	console.log(wtDir);
	process.exit(0);
}

die(`unknown command ${cmd}`, 2);
