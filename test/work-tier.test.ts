// test/work-tier.test.ts — W83 role-tier routing: `work add --tier` encodes
// the tier per item, show/list surface it, and the vocabulary gate refuses
// unknown tiers. Isolated temp HOME + git repo (same idiom as work-cli.test).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-work-tier-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-work-tier-repo-"));
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");

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

describe("add --tier", () => {
	test("mechanical tier persists, shows, and badges", () => {
		const a = work("add", "sweep the lanes", "--tier", "mechanical");
		expect(a.code).toBe(0);
		const id = idOf(a.out);
		expect(id).toBeTruthy();
		const s = work("show", id);
		expect(s.out).toContain("tier:");
		expect(s.out).toContain("mechanical");
		const l = work("list");
		expect(l.out).toContain("⟨mech⟩");
	});

	test("flagship tier is accepted and stored", () => {
		const a = work("add", "plan the fleet", "--tier", "flagship");
		expect(a.code).toBe(0);
		expect(work("show", idOf(a.out)).out).toContain("flagship");
	});

	test("unset tier stays NULL — no badge, no tier line", () => {
		const a = work("add", "plain task");
		expect(a.code).toBe(0);
		const s = work("show", idOf(a.out));
		expect(s.out).not.toContain("tier:");
	});

	test("unknown tier dies with the vocabulary", () => {
		const a = work("add", "bad", "--tier", "turbo");
		expect(a.code).not.toBe(0);
		expect(a.err).toContain("vocabulary: mechanical|flagship");
	});
});
