// builddirs.ts — canonical gitignored build dirs, symlinked from the repo
// root into a fresh lane workspace so lanes skip reinstalls. One list, two
// workspace makers: worktree.ts (git worktrees) and fleet-loop.ts dispatch
// (codex plain dirs) — parity by construction, not by copy.
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function symlinkBuildDirs(repo: string, into: string): void {
	for (const d of ["node_modules", ".venv", "vendor", "target"]) {
		const src = join(repo, d);
		const dst = join(into, d);
		if (existsSync(src) && !existsSync(dst)) {
			try {
				symlinkSync(src, dst, "dir");
			} catch {
				// best effort — a missing symlink just means a local install
			}
		}
	}
}
