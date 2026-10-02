// hooks/lib/gitwt.ts — worktree lookup by branch from git's own registry.
// Shared by fleet-loop (retire path) and the review gate (branch-side test
// runs): gaps parks lanes under .claude/worktrees/ (not .worktrees/), so a
// default-path guess misses them and branch operations stall — git's
// registry is ground truth.
import { run } from "./run.ts";

/** Actual worktree path checked out at branch b, from git's registry. */
export function wtPathFromGit(repo: string, b: string): string | null {
	let path: string | null = null;
	const out = run("git", ["worktree", "list", "--porcelain"], { cwd: repo });
	for (const line of out.out.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch ")) {
			if (line.slice("branch ".length).trim() === `refs/heads/${b}` && path)
				return path;
		}
	}
	return null;
}
