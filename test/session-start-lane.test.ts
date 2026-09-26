// session-start-lane.test.ts — subagent lanes claim under their own lane id
// (parent#agent), never the parent's raw sid: Claude Code gives a subagent
// the parent's session_id, so raw-sid claims land on the parent's account
// (W24/W30, 2026-09-26). Isolated temp HOME + repo, spawns the real hook.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-lane-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-lane-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const hook = join(import.meta.dir, "..", "hooks", "session-start.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const PARENT = "parent-sess-11111111";

function runHook(tp: string) {
	const payload = join(HOME, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(payload, JSON.stringify({ session_id: PARENT, source: "startup", transcript_path: tp, cwd: REPO }));
	const p = Bun.spawnSync(["bun", hook], { cwd: REPO, env, stdin: Bun.file(payload), stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("subagent lane identity", () => {
	test("top-level start registers the bare sid with no parent", () => {
		const r = runHook(join(HOME, "tp.jsonl"));
		expect(r.code).toBe(0);
		expect(r.out).toContain("SESSION parent-s");
		const db = new Database(DB, { readonly: true });
		const row = db.query("SELECT sid, parent_sid FROM sessions").get() as { sid: string; parent_sid: string | null };
		db.close();
		expect(row.sid).toBe(PARENT);
		expect(row.parent_sid).toBeNull();
	});

	test("subagent start registers parent#agent and injects the lane id", () => {
		const r = runHook(join(HOME, "whatever", "subagents", "agent-abc.jsonl"));
		expect(r.out).toContain("SUBAGENT LANE");
		expect(r.out).toContain(`--as ${PARENT}#agent-abc`);
		const db = new Database(DB, { readonly: true });
		const laneRow = db.query("SELECT sid, parent_sid FROM sessions WHERE sid LIKE '%#%'").get() as
			| { sid: string; parent_sid: string | null }
			| undefined;
		db.close();
		expect(laneRow?.sid).toBe(`${PARENT}#agent-abc`);
		expect(laneRow?.parent_sid).toBe(PARENT);
	});
});
