// governor-leases.test.ts — lease enforcement across both gates (Write/Edit
// via `governor`, shell via `pre-bash`): leases live in SQLite (the legacy
// locks.json read is gone), lane identity keeps same-session subagents from
// sharing ownership, acquisition is atomic, and the sweep respects ownership.
// Isolated temp HOME → governor.db lands in the temp .cache; isolated temp
// git repo → project identity. Covers review findings 1, 2, 3.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-leases-"));
// REPO must NOT live under /tmp: the bash gate exempts /tmp/** paths from
// lease arbitration by design, and on Linux os.tmpdir() IS /tmp — the lease
// tests would silently test nothing. The checkout (process.cwd()) is never
// under /tmp, on macOS, Linux, or CI.
const REPO = mkdtempSync(join(process.cwd(), ".tmp-lease-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
mkdirSync(join(REPO, "sub"), { recursive: true });
const env = { ...process.env, HOME };
const HOOKS = join(import.meta.dir, "..", "hooks");
const REG = join(HOME, ".cache", "claude-governor");
const DB = join(REG, "governor.db");

let payloadN = 0;
function gate(event: string, hook: Record<string, unknown>): { out: string; code: number } {
	// Bun 1.4 spawnSync silently drops the `input` option — hook payloads go
	// via a temp file on stdin (Bun.file), the one verified-delivery channel
	const payload = join(HOME, `hook-payload-${payloadN++}.json`);
	writeFileSync(payload, JSON.stringify(hook));
	const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), event], { cwd: REPO, env, stdin: Bun.file(payload), stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), code: p.exitCode };
}
const allowed = (r: { out: string }) => expect(r.out).toBe("{}");
const denied = (r: { out: string }) => expect(r.out).toContain('"permissionDecision":"deny"');

const writeHook = (session: string, tp: string, file: string): Record<string, unknown> => ({
	tool_name: "Write", tool_input: { file_path: join(REPO, file) }, cwd: REPO, session_id: session, transcript_path: tp,
});
const bashHook = (session: string, tp: string, command: string): Record<string, unknown> => ({
	tool_name: "Bash", tool_input: { command }, cwd: REPO, session_id: session, transcript_path: tp,
});
const MAIN_TP = join(HOME, "sessA.jsonl");
const subTp = (n: string): string => join(HOME, "proj", "sessA", "subagents", `${n}.jsonl`);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("lease enforcement (findings 1-3)", () => {
	test("bash gate enforces the SQLite lease the write gate holds (finding 1)", () => {
		writeFileSync(join(REPO, "f.txt"), "hello\n");
		allowed(gate("governor", writeHook("sessA", MAIN_TP, "f.txt"))); // lane A claims via Write
		denied(gate("pre-bash", bashHook("sessB", join(HOME, "sessB.jsonl"), "touch f.txt"))); // foreign shell write
		allowed(gate("pre-bash", bashHook("sessA", MAIN_TP, "touch f.txt"))); // owner shell write
		denied(gate("pre-bash", bashHook("sessB", join(HOME, "sessB.jsonl"), "echo x > f.txt"))); // foreign redirect
	});

	test("bash gate resolves targets against the command's working dir (finding 1)", () => {
		writeFileSync(join(REPO, "sub", "g.txt"), "hi\n");
		allowed(gate("governor", writeHook("sessA", subTp("agent-1"), "sub/g.txt"))); // subagent lane claims
		// `cd sub && touch g.txt` must resolve g.txt against sub/ — a bare-cwd
		// resolution would miss the lease entirely
		denied(gate("pre-bash", bashHook("sessB", join(HOME, "sessB.jsonl"), "cd sub && touch g.txt")));
		allowed(gate("pre-bash", bashHook("sessA", subTp("agent-1"), "cd sub && touch g.txt"))); // owning lane
	});

	test("sibling subagents do not share lease ownership (finding 2)", () => {
		// same session_id, distinct /subagents/ transcripts ⇒ distinct lanes
		denied(gate("governor", writeHook("sessA", subTp("agent-2"), "sub/g.txt"))); // sibling subagent
		denied(gate("governor", writeHook("sessA", MAIN_TP, "sub/g.txt"))); // parent main lane
		allowed(gate("governor", writeHook("sessA", subTp("agent-1"), "sub/g.txt"))); // owner renews
		// the bash gate computes the SAME lane identity: parent lane via shell is foreign too
		denied(gate("pre-bash", bashHook("sessA", MAIN_TP, "touch sub/g.txt")));
	});

	test("bash gate allows when no registry exists (fail open, no side effects)", () => {
		const H2 = mkdtempSync(join(tmpdir(), "suspenders-noreg-"));
		try {
			const payload = join(HOME, "noreg-payload.json");
			writeFileSync(payload, JSON.stringify(bashHook("x", join(H2, "x.jsonl"), "touch f.txt")));
			const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), "pre-bash"], { cwd: REPO, env: { ...process.env, HOME: H2 }, stdin: Bun.file(payload), stdout: "pipe" });
			expect(p.stdout.toString()).toBe("{}");
			expect(existsSync(join(H2, ".cache", "claude-governor"))).toBe(false);
		} finally {
			rmSync(H2, { recursive: true, force: true });
		}
	});

	test("concurrent claims of one path yield exactly one owner (finding 3)", async () => {
		writeFileSync(join(REPO, "race.txt"), "x\n");
		const lanes = [1, 2, 3, 4].map((i) => writeHook("raceSess", subTp(`race-${i}`), "race.txt"));
		const procs = await Promise.all(
			lanes.map(async (h, i) => {
				const payload = join(HOME, `race-payload-${i}.json`);
				await Bun.write(payload, JSON.stringify(h));
				return Bun.spawn({ cmd: ["bun", join(HOOKS, "gate.ts"), "governor"], cwd: REPO, env, stdin: Bun.file(payload), stdout: "pipe", stderr: "ignore" });
			}),
		);
		const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
		await Promise.all(procs.map((p) => p.exited));
		expect(outs.filter((o) => o.trim() === "{}").length).toBe(1);
		expect(outs.filter((o) => o.includes('"permissionDecision":"deny"')).length).toBe(lanes.length - 1);
	});

	test("sweep deletes stale leases regardless of holder liveness (per-file TTL)", () => {
		mkdirSync(REG, { recursive: true });
		writeFileSync(join(REPO, "dead.txt"), "d\n");
		writeFileSync(join(REPO, "alive.txt"), "a\n");
		writeFileSync(join(REPO, "fresh.txt"), "f\n");
		writeFileSync(join(REPO, "sweep-probe.txt"), "s\n");
		const liveTp = join(HOME, "tp-live.jsonl");
		writeFileSync(liveTp, "transcript\n"); // real, fresh mtime — must NOT matter anymore
		const dead = realpathSync(join(REPO, "dead.txt"));
		const alive = realpathSync(join(REPO, "alive.txt"));
		const fresh = realpathSync(join(REPO, "fresh.txt"));
		const old = Date.now() - 2 * 60 * 60_000;
		const seed = new Database(DB);
		const ins = seed.query("INSERT OR REPLACE INTO locks (path, sid, tool, ts, tp, hash, seen) VALUES (?, ?, ?, ?, ?, NULL, NULL)");
		ins.run(dead, "dead-owner", "Write", old, join(HOME, "gone.jsonl"));
		ins.run(alive, "alive-owner", "Write", old, liveTp);
		ins.run(fresh, "fresh-owner", "Write", Date.now(), null);
		seed.close();
		allowed(gate("governor", writeHook("sweeper", join(HOME, "sweeper.jsonl"), "sweep-probe.txt"))); // triggers the sweep
		const check = new Database(DB);
		const paths: Record<string, string> = {};
		for (const r of check.query("SELECT path, sid FROM locks").all() as { path: string; sid: string }[]) paths[r.path] = r.sid;
		check.close();
		// owner 2026-09-25: holder liveness is irrelevant — a lease whose last
		// governed touch is 15+ min old releases even with a live transcript
		expect(paths[dead]).toBeUndefined(); // stale touch, dead transcript → swept
		expect(paths[alive]).toBeUndefined(); // stale touch, LIVE transcript → swept too
		expect(paths[fresh]).toBe("fresh-owner"); // fresh touch → kept
	});

	test("coord lease-release drops only the caller's own leases", () => {
		writeFileSync(join(REPO, "rel-a.txt"), "a\n");
		writeFileSync(join(REPO, "rel-b.txt"), "b\n");
		allowed(gate("governor", writeHook("relA", join(HOME, "relA.jsonl"), "rel-a.txt")));
		allowed(gate("governor", writeHook("relB", join(HOME, "relB.jsonl"), "rel-b.txt")));
		const rel = (who: string, file: string) =>
			Bun.spawnSync(["bun", join(HOOKS, "bin", "coord.ts"), "lease-release", join(REPO, file), "--as", who], {
				cwd: REPO,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
		const foreign = rel("relA", "rel-b.txt"); // foreign caller → no effect
		expect(foreign.exitCode).toBe(0);
		const own = rel("relB", "rel-b.txt"); // owner → row gone
		expect(own.exitCode).toBe(0);
		const check = new Database(DB);
		const paths = new Set((check.query("SELECT path FROM locks").all() as { path: string }[]).map((r) => r.path));
		check.close();
		expect(paths.has(realpathSync(join(REPO, "rel-a.txt")))).toBe(true); // relA keeps its lease
		expect(paths.has(realpathSync(join(REPO, "rel-b.txt")))).toBe(false); // released
		// the released file is immediately claimable by a third lane
		allowed(gate("governor", writeHook("relC", join(HOME, "relC.jsonl"), "rel-b.txt")));
	});
});

// W9 — lane heartbeat: tool activity must advance the session row's hb so a
// lane mid-turn never reads as dead (hb used to advance only at SessionStart,
// making every lane instantly stale). The gate is the one component that sees
// every Write/Edit/Bash, and it already opens governor.db — one UPDATE. A
// row that SessionStart has not registered yet is a legal silent no-op.
describe("W9 lane heartbeat", () => {
	test("tool activity advances hb on the acting row only", () => {
		const db0 = new Database(DB);
		const T = Date.now() - 3_600_000; // 1h stale — would read dead without the heartbeat
		db0.query("INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state, parent_sid, role) VALUES ('hb9', ?, ?, ?, 'RUNNING', NULL, 'worker')").run(REPO, T, T);
		db0.query("INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state, parent_sid, role) VALUES ('hb9#agent-1', ?, ?, ?, 'RUNNING', 'hb9', 'worker')").run(REPO, T, T);
		db0.close();
		allowed(gate("governor", writeHook("hb9", subTp("agent-1"), "hb.txt"))); // lane touch — must still ALLOW
		const d = new Database(DB, { readonly: true });
		const laneHb = (d.query("SELECT hb FROM sessions WHERE sid = 'hb9#agent-1'").get() as { hb: number }).hb;
		const topHb = (d.query("SELECT hb FROM sessions WHERE sid = 'hb9'").get() as { hb: number }).hb;
		d.close();
		expect(laneHb).toBeGreaterThan(T); // the lane's own row heartbeat
		expect(topHb).toBe(T); // the top-level row is NOT touched by a lane-scoped call
	});
});
