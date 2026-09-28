// hooks/lib/fleetlane.ts — mechanical fleet-lane identity for hooks: is the
// process firing this hook a dispatched lane, and which sid does it carry?
// Dispatch spawns the agent binary through `sh -c "exec …"`, so the agent's
// pid IS the .fleet/lanes.json pid; walking the hook process's ancestor
// chain to a lanes.json entry resolves the sid with zero per-agent plumbing
// (the codex hook adapter spec's fallback resolution, made primary — no env
// channel exists yet). Works for both backends today.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type FleetLane = {
	sid: string;
	item: string;
	branch: string;
	worktree: string;
};

type LaneEntry = FleetLane & {
	pid: number;
	agent?: string;
	launchedAt?: number;
};

// One ppid hop via ps — /proc is Linux-only and the fleet is darwin-first.
// 0 means the walk ends here (dead pid, permission, or launchd reached).
const ppid = (pid: number): number => {
	const p = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
		stdout: "pipe",
		stderr: "ignore",
	});
	if (p.exitCode !== 0) return 0;
	const n = Number(p.stdout?.toString().trim());
	return Number.isInteger(n) && n > 1 ? n : 0; // launchd (pid 1) ends every walk
};

// Fleet root = the nearest ancestor dir owning .fleet/lanes.json. Lane cwds
// live BELOW it (worktrees at <root>/.worktrees/<item>), so walking UP from
// cwd finds it; other repos resolve to null after a few existsSync calls.
const lanesFileFor = (cwd: string): string => {
	let dir = resolve(cwd);
	for (;;) {
		const f = `${dir}/.fleet/lanes.json`;
		if (existsSync(f)) return f;
		const up = resolve(dir, "..");
		if (up === dir) return "";
		dir = up;
	}
};

export function resolveFleetLane(cwd: string): FleetLane | null {
	const file = lanesFileFor(cwd);
	if (!file) return null;
	let entries: LaneEntry[];
	try {
		entries = JSON.parse(readFileSync(file, "utf8")) as LaneEntry[];
	} catch {
		return null; // unreadable registry: no lane identity → never block
	}
	// Ancestor chain: the hook process, its parent, then ps hops up. A
	// recycled pid CAN impersonate a lane (a dead entry's pid reused by a live
	// ancestor) — accepted: the guard's miss direction is fail-CLOSED (an
	// over-deny of the user's own push), never a silent lane bypass.
	const chain = new Set<number>([process.pid]);
	for (let p = process.ppid; p > 1 && chain.size < 27; p = ppid(p))
		chain.add(p);
	for (const e of entries) {
		if (e.pid > 1 && chain.has(e.pid))
			return {
				sid: e.sid,
				item: e.item,
				branch: e.branch,
				worktree: e.worktree,
			};
	}
	return null;
}
