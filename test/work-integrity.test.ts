// work-integrity.test.ts — Work Graph integrity (review findings 4 + 12):
// roll-up requires every required child in a successful terminal state (a
// FAILED child must NOT complete a SHATTERED parent; nested SHATTERED and
// ORPHANED block; optional children do not; supersession closes), and the
// start/done/release transitions validate state and caller ownership.
// Isolated temp HOME (governor.db) + temp repo (project identity).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-work-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-wrepo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

function work(...args: string[]): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}
const idOf = (out: string): string => (out.match(/W\d+(?:\.\d+)*/) ?? [])[0] ?? "";
const firstLine = (s: string): string => (s.split("\n")[0] ?? "").trim();

function withDb(fn: (db: Database) => void): void {
	const db = new Database(DB, { create: true });
	fn(db);
	db.close();
}

/** take → (start) → done: the disciplined completion path. */
function finish(id: string, sid: string): { code: number; out: string; err: string } {
	const t = work("take", id, "--as", sid);
	if (t.code !== 0) return t;
	const s = work("start", id, "--as", sid);
	if (s.code !== 0) return s;
	return work("done", id, "--as", sid, "--sha", `sha-${sid}`);
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("roll-up requires successful terminal children (finding 4)", () => {
	test("repro: FAILED required child must not let the parent complete", () => {
		const w1 = idOf(work("add", "W1 root").out);
		const split1 = work("split", w1, "a", "b", "--reason", "independent-scopes");
		expect(split1.code).toBe(0);
		const c1 = `${w1}.1`, c2 = `${w1}.2`;
		expect(finish(c2, "fb").code).toBe(0); // W1.2 completes fine
		expect(work("take", c1, "--as", "fa").code).toBe(0);
		expect(work("fail", c1, "--note", "blew up").code).toBe(0);
		// W1.1 FAILED + W1.2 DONE ⇒ W1 must stay SHATTERED, never DONE
		expect(firstLine(work("show", w1).out)).toContain("SHATTERED");
		// recovery is supersession (or reclaim): superseding the last
		// unsatisfied child closes the parent
		expect(work("supersede", c1, "--by", `${w1}.9`).code).toBe(0);
		expect(firstLine(work("show", w1).out)).toContain("DONE");
	});

	test("nested SHATTERED children block until their own leaves close", () => {
		const w2 = idOf(work("add", "W2 root").out);
		expect(work("split", w2, "x", "y", "--reason", "independent-scopes").code).toBe(0);
		expect(work("split", `${w2}.1`, "x1", "x2", "--reason", "independent-scopes").code).toBe(0);
		expect(finish(`${w2}.2`, "gy").code).toBe(0); // direct child done
		// W2.1 still SHATTERED-open ⇒ W2 must not complete
		expect(firstLine(work("show", w2).out)).toContain("SHATTERED");
		expect(finish(`${w2}.1.1`, "gx1").code).toBe(0);
		expect(firstLine(work("show", w2).out)).toContain("SHATTERED"); // one leaf left
		expect(finish(`${w2}.1.2`, "gx2").code).toBe(0);
		expect(firstLine(work("show", `${w2}.1`).out)).toContain("DONE"); // rolls up
		expect(firstLine(work("show", w2).out)).toContain("DONE"); // …and recurses to the root
	});

	test("ORPHANED required child blocks the parent until reclaimed", () => {
		const w3 = idOf(work("add", "W3 root").out);
		expect(work("split", w3, "p", "q", "--reason", "independent-scopes").code).toBe(0);
		expect(work("take", `${w3}.1`, "--as", "gone-lane").code).toBe(0);
		withDb((db) => db.query("UPDATE work_items SET state = 'ORPHANED' WHERE project = (SELECT project FROM work_items WHERE id = ?) AND id = ?").run(`${w3}.1`, `${w3}.1`));
		expect(finish(`${w3}.2`, "w3b").code).toBe(0);
		expect(firstLine(work("show", w3).out)).toContain("SHATTERED"); // orphan blocks
		expect(work("reclaim", `${w3}.1`).code).toBe(0); // operator override path
		expect(finish(`${w3}.1`, "rescue-lane").code).toBe(0);
		expect(firstLine(work("show", w3).out)).toContain("DONE");
	});

	test("optional (required=0) child in FAILED state does not block the parent", () => {
		const w4 = idOf(work("add", "W4 root").out);
		expect(work("split", w4, "m", "n", "--reason", "independent-scopes").code).toBe(0);
		withDb((db) => db.query("UPDATE work_items SET required = 0, state = 'FAILED' WHERE project = (SELECT project FROM work_items WHERE id = ?) AND id = ?").run(`${w4}.1`, `${w4}.1`));
		expect(finish(`${w4}.2`, "w4b").code).toBe(0);
		expect(firstLine(work("show", w4).out)).toContain("DONE");
	});
});

describe("transition + ownership validation (finding 12)", () => {
	test("start/done validate state and caller; release requires --as and owner match", () => {
		const w5 = idOf(work("add", "W5 root").out);
		// from READY: nothing but take is allowed
		expect(work("start", w5).err).toContain("only CLAIMED/RUNNING");
		expect(work("done", w5, "--sha", "x").err).toContain("only CLAIMED/RUNNING");
		expect(work("release", w5).err).toContain("usage: release <id> --as <sid>");
		expect(work("release", w5, "--as", "w5-owner").err).toContain("only CLAIMED/RUNNING");
		expect(work("take", w5, "--as", "w5-owner").code).toBe(0);
		// wrong caller cannot start/done/release
		expect(work("start", w5, "--as", "intruder").err).toContain("cannot start it");
		expect(work("done", w5, "--as", "intruder", "--sha", "x").err).toContain("cannot complete it");
		expect(work("release", w5, "--as", "intruder").err).toContain("cannot release it");
		// the owner can
		expect(work("start", w5, "--as", "w5-owner").code).toBe(0);
		expect(work("done", w5, "--as", "w5-owner", "--sha", "abc1234").code).toBe(0);
		// terminal states are frozen for these transitions
		expect(work("start", w5).err).toContain("only CLAIMED/RUNNING");
		expect(work("done", w5, "--sha", "x").err).toContain("only CLAIMED/RUNNING");
		expect(work("release", w5, "--as", "w5-owner").err).toContain("only CLAIMED/RUNNING");
	});

	test("split children inherit the parent's requires capability set", () => {
		const coord = (...args: string[]) => {
			const p = Bun.spawnSync(["bun", join(BIN, "coord.ts"), ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
			return { code: p.exitCode, out: p.stdout.toString() };
		};
		expect(coord("bootstrap", "--as", "caps-worker", "--role", "worker", "--caps", "shell,fs").code).toBe(0);
		expect(coord("bootstrap", "--as", "caps-builder", "--role", "worker", "--caps", "shell,build").code).toBe(0);
		const w7 = idOf(work("add", "W7 needs a compiler", "--requires", "build").out);
		expect(work("split", w7, "s1", "s2", "--reason", "independent-scopes").code).toBe(0);
		// the constraint travels down: a build-capable session is still required
		expect(work("show", `${w7}.1`).out).toContain("requires: build");
		expect(work("take", `${w7}.1`, "--as", "caps-worker").err).toContain("requires [build]");
		expect(work("take", `${w7}.1`, "--as", "caps-builder").code).toBe(0);
	});
});
