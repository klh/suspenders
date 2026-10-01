// test/store-port-consumers.test.ts — W102: the consumer subsystems outside
// W92.2/3/4's leased files (usage-seed, usage-harvest, advise, session-start,
// session-end, supervise) now bind via openStore(). Each entry point runs
// against an isolated temp HOME (never the live governor.db) and must behave
// byte-compatibly with the pre-port file binding; GOVERNOR_STORE_URL is
// pinned empty so a dev-shell remote binding cannot leak into the children.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(process.cwd(), ".store-port-consumers-"));
afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

// Bun.spawnSync ignores `input` (1.4.2) — stdin payloads ride a temp file
const run = (
	rel: string,
	args: string[] = [],
	stdin = "",
): { code: number; out: string; err: string } => {
	const payload = join(home, `payload-${Math.random().toString(36).slice(2)}`);
	if (stdin) writeFileSync(payload, stdin);
	const p = Bun.spawnSync(["bun", join(ROOT, rel), ...args], {
		cwd: ROOT,
		env: {
			...process.env,
			HOME: home,
			NO_COLOR: "1",
			GOVERNOR_STORE_URL: "",
		},
		stdin: stdin ? Bun.file(payload) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};

describe("W102 store-port consumers", () => {
	test("usage-seed seeds, then purges exactly the demo rows", () => {
		const s = run("hooks/bin/usage-seed.ts");
		expect(s.code).toBe(0);
		const seeded = JSON.parse(s.out) as { actors: number; rows: number };
		expect(seeded.actors).toBe(2);
		expect(seeded.rows).toBeGreaterThan(100);
		const p = run("hooks/bin/usage-seed.ts", ["--purge"]);
		expect(p.code).toBe(0);
		const purged = JSON.parse(p.out) as { rows: number; sessions: number };
		expect(purged.rows).toBe(seeded.rows);
		// sessions changes() counts the deltas-trigger inserts too (W92/v8
		// trigger accounting on a migrated db) — the old :memory: unit test
		// never saw it; demo rows must simply be gone afterwards
		expect(purged.sessions).toBeGreaterThan(0);
	});

	test("usage-harvest stamps the TTL cursor through the port", () => {
		// empty transcript tree must EXIST — a missing root soft-fails to
		// {skipped} by design
		mkdirSync(join(home, ".claude", "projects"), { recursive: true });
		const first = run("hooks/bin/usage-harvest.ts", ["--force"]);
		expect(first.code).toBe(0);
		const s = JSON.parse(first.out) as { files: number; harvested: number };
		expect(s.files).toBe(0);
		// the no-force follow-up must ride the TTL fast path — the cursor fact
		// write only happens if the store binding actually works
		const second = run("hooks/bin/usage-harvest.ts");
		expect(second.code).toBe(0);
		expect(JSON.parse(second.out)).toEqual({ skipped: "ttl-fresh" });
	});

	test("session-end closes a session through the port", () => {
		const r = run(
			"hooks/session-end.ts",
			[],
			'{"session_id":"w102-consumer-smoke"}',
		);
		expect(r.code).toBe(0);
		expect(r.err).toBe("");
	});

	test("session-start bootstraps through the port (sweep rides db.local)", () => {
		const r = run(
			"hooks/session-start.ts",
			[],
			JSON.stringify({
				session_id: "w102-consumer-smoke-start",
				transcript_path: "/nonexistent.jsonl",
				source: "startup",
			}),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("SESSION");
	});

	test("advise opens the store at module top, then rejects a non-decision id", () => {
		const r = run("hooks/bin/advise.ts", ["999999"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("advise wants a NEED% fork");
	});

	test("supervise keeps its unbootstrapped-host guard", () => {
		// a pristine HOME — the shared temp home grew a governor.db from the
		// earlier children, and the guard only fires with no db at all
		const fresh = mkdtempSync(join(process.cwd(), ".store-port-consumers-"));
		try {
			const p = Bun.spawnSync(
				["bun", join(ROOT, "scripts/supervise.ts"), "W102", "--dry-run"],
				{
					cwd: ROOT,
					env: {
						...process.env,
						HOME: fresh,
						NO_COLOR: "1",
						GOVERNOR_STORE_URL: "",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(p.exitCode).not.toBe(0);
			expect(p.stderr.toString()).toContain("no governor db");
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});
});
