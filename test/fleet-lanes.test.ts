// test/fleet-lanes.test.ts — W187 scope-add (#3854): `coord fleet --lanes`,
// the first-class lane view. laneRows is pure (registry × graph-claims union,
// injected liveness) and unit-tested in-process; the CLI surface runs in a
// subprocess against a scratch HOME + scratch git repo so the parent never
// opens the real governor.db (the coord-diff recipe).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { laneRows } from "../scripts/lib/lane.ts";

const NOW = 1_800_000_000_000;

describe("laneRows — registry × graph union", () => {
	const lanes = [
		{ sid: "autow1", item: "W1", pid: 111, launchedAt: NOW - 65_000 },
		{
			sid: "autostale",
			item: "W9",
			pid: 999_999_999,
			launchedAt: NOW - 3_600_000,
		},
	];
	const claims = [
		{ owner_sid: "autow1", id: "W1" },
		{ owner_sid: "autow1", id: "W5" }, // one lane, two claims
		{ owner_sid: "theghost", id: "W7" }, // claim with no registry entry
	];
	const noZombie = (pid: number): boolean => pid !== 999_999_999;

	test("union rows: zombies and winding-down lanes both visible", () => {
		const rows = laneRows(lanes, claims, NOW, noZombie);
		expect(rows.map((r) => r.sid).sort()).toEqual([
			"autostale",
			"autow1",
			"theghost",
		]);
	});
	test("a lane holding two claims stays ONE row, items joined", () => {
		const rows = laneRows(lanes, claims, NOW, noZombie);
		const w1 = rows.find((r) => r.sid === "autow1");
		expect(w1?.item).toBe("W1,W5");
		expect(w1?.ageS).toBe(65);
		expect(w1?.pid).toBe(111);
		expect(w1?.isAlive).toBe(true);
	});
	test("registry item survives when the sid holds no claims", () => {
		const rows = laneRows(lanes, claims, NOW, noZombie);
		expect(rows.find((r) => r.sid === "autostale")?.item).toBe("W9");
		expect(rows.find((r) => r.sid === "autostale")?.isAlive).toBe(false);
	});
	test("claim with no registry entry → zombie row, no pid, liveness unknown", () => {
		const rows = laneRows(lanes, claims, NOW, noZombie);
		const g = rows.find((r) => r.sid === "theghost");
		expect(g?.pid).toBeNull();
		expect(g?.isAlive).toBeNull();
		expect(g?.item).toBe("W7");
	});
	test("empty both → no rows", () => {
		expect(laneRows([], [], NOW)).toEqual([]);
	});
	test("claimLive: a sid with a current coord claim is live without a pid", () => {
		const rows = laneRows(
			[],
			[{ owner_sid: "s9", id: "W1" }],
			NOW,
			noZombie,
			new Set(["s9"]),
		);
		expect(rows[0]?.claimLive).toBe(true);
	});
});

// CLI surface: wiring + missing-registry tolerance (scratch HOME + git repo)
const HOME = mkdtempSync(join(process.cwd(), ".w187-lanes-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".w187-lanes-repo-"));
afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const git = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
git(["init", "-b", "main"]);

test("coord fleet --lanes on an empty fleet prints the header, exits 0", () => {
	const p = Bun.spawnSync(
		[
			"bun",
			join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
			"fleet",
			"--lanes",
		],
		{
			cwd: REPO,
			env: { ...process.env, HOME },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(p.exitCode).toBe(0);
	const out = p.stdout.toString();
	expect(out).toContain("LANES 0");
	expect(out).toContain("SID");
	expect(out).toContain("ALIVE");
});
