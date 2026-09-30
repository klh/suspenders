// test/fleet-loop-batch.test.ts — W83 batch mode: drains READY items of a
// tier through the standard dispatch child. The selector is tier- and
// dep-aware (an unmet dependency keeps an item out of the batch); the claim
// race stays in dispatch's work take. Children run with a stripped PATH so
// the agent-binary check stops them — no real lane ever spawns in a test.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-batch-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-fleet-batch-repo-"));
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");
// dispatch children invoke the INSTALLED CLI path — wire it to this repo's
// hooks/bin so a batch's work take actually settles (and claims)
mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

const spawnLoop = (args: string[]) => {
	const p = Bun.spawnSync(
		[process.execPath, join(BIN, "fleet-loop.ts"), ...args],
		{
			cwd: REPO,
			env: { ...env, PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
};
const work = (...args: string[]) => {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
};
const idOf = (out: string): string => (out.match(/W\d+/) ?? [])[0] ?? "";

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("fleet-loop batch", () => {
	test("drains READY mechanical items, skips flagship and dep-gated", () => {
		const mech = idOf(
			work("add", "batchable mech", "--tier", "mechanical").out,
		);
		expect(mech).toBeTruthy();
		const flag = idOf(work("add", "flagship stays out").out);
		expect(flag).toBeTruthy();
		const gated = idOf(work("add", "gated mech", "--tier", "mechanical").out);
		expect(work("block", gated, "--on", flag).code).toBe(0);

		const b = spawnLoop(["batch", "--repo", REPO, "--max", "8"]);
		expect(b.code).toBe(0);
		expect(b.out).toContain(`batch: dispatched ${mech}`);
		expect(b.out).not.toContain(flag);
		expect(b.out).not.toContain(gated);

		// --tier flagship drains the other population
		const f = spawnLoop([
			"batch",
			"--repo",
			REPO,
			"--tier",
			"flagship",
			"--max",
			"8",
		]);
		expect(f.code).toBe(0);
		expect(f.out).toContain(flag);
		expect(f.out).not.toContain(mech);
	});

	test("--max caps the batch", () => {
		work("add", "capped one", "--tier", "mechanical");
		const b = spawnLoop(["batch", "--repo", REPO, "--max", "1"]);
		expect(b.code).toBe(0);
		expect(b.out.split("batch: dispatched").length - 1).toBe(1);
	});

	test("empty tier batch is a clean no-op", () => {
		const b = spawnLoop([
			"batch",
			"--repo",
			REPO,
			"--tier",
			"flagship",
			"--max",
			"8",
		]);
		expect(b.code).toBe(0);
		expect(b.out).toContain("no READY flagship items");
	});
});
