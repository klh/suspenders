// worktree-live.ts — contract-free worktree liveness (W123): is a live
// claude/codex process sitting (cwd) inside this worktree? Independent of
// lanes.json registration state and DISPATCHED log formats — born from the
// gaps 2026-09-30 incident (live lanes retired ~90s after dispatch; both
// registration-derived guards raced the dispatcher). Shared by fleet-loop's
// merge ladder and `work done`'s auto-retire (worktree.ts retire).

const runOut = (cmd: string[]): string => {
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim();
};

export function worktreeLive(wt: string): boolean {
	try {
		const pids = runOut(["ps", "-axo", "pid=,comm="])
			.split("\n")
			.filter((l) => /claude|codex/.test(l))
			.map((l) => Number.parseInt(l.trim(), 10));
		if (pids.length === 0) return false;
		const listing = runOut([
			"lsof",
			"-a",
			"-p",
			pids.join(","),
			"-d",
			"cwd",
			"-Fpcn",
		]);
		let pid = 0;
		for (const line of listing.split("\n")) {
			if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10) || pid;
			// path-separator bound: `.worktrees/W12` must not match the cwd of a
			// lane in `.worktrees/W123` (bare startsWith collided on shared
			// id-prefixes); a cwd in a SUBDIR of the worktree still counts
			else if (
				line.startsWith("n") &&
				(line.slice(1) === wt || line.slice(1).startsWith(`${wt}/`))
			)
				return true;
		}
	} catch {}
	return false;
}
