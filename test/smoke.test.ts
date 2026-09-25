// smoke.test.ts — the control plane round-trips in an isolated HOME: temp
// HOME → governor.db lands in the temp .cache; temp git repo = project
// identity. Covers the dispatch gate, the fork path, and monitor health.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-smoke-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true }); // projectIdentity = git dir
const env = { ...process.env, HOME };
const bin = join(import.meta.dir, "..", "hooks", "bin");

function run(cmd: string, args: string[]) {
	const p = Bun.spawnSync(["bun", join(bin, cmd), ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("control plane", () => {
	test("bootstrap registers a session", () => {
		const r = run("coord.ts", ["bootstrap", "--as", "smoke-coord-1111", "--role", "coordinator", "--caps", "shell,fs,git"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("SESSION");
	});

	test("work add → take → done round-trip", () => {
		expect(run("work.ts", ["add", "wire the flux capacitor", "--scope", "src/flux"]).code).toBe(0);
		expect(run("work.ts", ["take", "W1", "--as", "smoke-coord-1111"]).out).toContain("claimed");
		const d = run("work.ts", ["done", "W1", "--sha", "abc1234"]);
		expect(d.code).toBe(0);
		const ready = run("work.ts", ["ready"]);
		expect(ready.out).not.toContain("W1 ");
	});

	test("capability gate refuses uncapable sessions", () => {
		expect(run("work.ts", ["add", "needs a compiler", "--requires", "build"]).code).toBe(0);
		const r = run("work.ts", ["take", "W2", "--as", "smoke-coord-1111"]);
		expect(r.code).not.toBe(0);
		expect(r.err + r.out).toContain("requires");
	});

	test("fork reaches the target inbox", () => {
		const e = run("coord.ts", ["emit", "NEED_DECISION", "--to", "smoke-coord-1111", "--note", "ship or hold?", "--as", "smoke-coord-1111"]);
		expect(e.code).toBe(0);
		const inbox = run("coord.ts", ["inbox", "--as", "smoke-coord-1111"]);
		expect(inbox.out).toContain("NEED_DECISION");
		expect(inbox.out).toContain("ship or hold?");
	});

	test("monitor reports clean health on a fresh plane", () => {
		const r = run("monitor.ts", []);
		expect(r.out).toContain("health clean");
	});
});
