// consult-kb.test.ts — the knowledge layer: consult-reply harvests (problem →
// solution) pairs; a repeat consult resolves from the store without routing
// to an expert (--no-kb escapes); unrelated questions stay OPEN; stats/search
// run clean. Isolated temp HOME + repo, spawns the real CLI (monitor recipe).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-kb-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-kb-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// projectIdentity(), mirrored: git-common-dir from inside the temp repo —
// NOTE git walks UP through a scaffolded .git to the parent checkout, so
// the identity is the PARENT repo's .git; seeds must match it exactly
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(join(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
const TS = Date.now();
const EXPERT = "expert-sess-11111111";
const ASKER = "asker-sess-22222222";

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", coord, ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

function seedSession(sid: string) {
	const db = new Database(DB);
	db.query("INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')").run(sid, PROJ, TS, TS);
	db.close();
}

function consultRow(id: number) {
	const db = new Database(DB, { readonly: true });
	const r = db.query("SELECT state, answer, expert_sid FROM consults WHERE id = ?").get(id) as
		| { state: string; answer: string | null; expert_sid: string }
		| undefined;
	db.close();
	return r;
}

// bootstrap: the first CLI open runs the migrations — creates the db dir and
// the v3 schema — so the seed helpers have something to write into
run(["kb", "stats"]);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("consult knowledge layer", () => {
	test("kb miss: consult routes OPEN to the live expert", () => {
		seedSession(EXPERT);
		const r = run(["consult", EXPERT, "How do we fix the retry contract for stale leases?", "--as", ASKER]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("CONSULT C1");
		expect(consultRow(1)?.state).toBe("OPEN");
	});

	test("consult-reply harvests the pair into the kb", () => {
		const r = run(["consult-reply", "C1", "Release the stale lease via coord lease-release, then re-take the file.", "--as", EXPERT]);
		expect(r.code).toBe(0);
		expect(consultRow(1)?.state).toBe("ANSWERED");
		const d = new Database(DB, { readonly: true });
		const kb = d.query("SELECT problem, solution, asked_by, answered_by FROM consult_kb").all() as {
			problem: string; solution: string; asked_by: string; answered_by: string;
		}[];
		const fts = (d.query("SELECT COUNT(*) AS n FROM consult_kb_fts").get() as { n: number }).n;
		d.close();
		expect(kb.length).toBe(1);
		expect(kb[0].answered_by).toBe(EXPERT);
		expect(kb[0].solution).toContain("lease-release");
		expect(fts).toBe(1);
	});

	test("repeat question resolves from kb: no expert round-trip, provenance recorded", () => {
		const r = run(["consult", EXPERT, "What is the way to fix the retry contract for stale leases here?", "--as", ASKER]);
		expect(r.out).toContain("knowledge base");
		const row = consultRow(2);
		expect(row?.state).toBe("KB");
		expect(row?.answer).toContain("lease-release");
		expect(row?.expert_sid).toBe(EXPERT); // provenance: who solved it originally
		const d = new Database(DB, { readonly: true });
		expect((d.query("SELECT hits FROM consult_kb WHERE id = 1").get() as { hits: number }).hits).toBe(1);
		const ev = d.query("SELECT payload FROM events WHERE target = ? AND kind = 'consult.answer' ORDER BY id DESC LIMIT 1").get(ASKER) as { payload: string };
		expect(JSON.parse(ev.payload).kb.expert_live).toBe(true);
		d.close();
	});

	test("--no-kb forces live-expert routing despite a stored hit", () => {
		const r = run(["consult", EXPERT, "fix the retry contract for stale leases", "--no-kb", "--as", ASKER]);
		expect(r.out).toContain("CONSULT C3");
		expect(consultRow(3)?.state).toBe("OPEN");
	});

	test("unrelated question stays OPEN (all-terms AND match, high precision)", () => {
		const r = run(["consult", EXPERT, "which ports does the llm stack listen on", "--as", ASKER]);
		expect(r.out).toContain("CONSULT C4");
		expect(consultRow(4)?.state).toBe("OPEN");
	});

	test("kb stats and search run clean", () => {
		const stats = run(["kb", "stats"]);
		expect(stats.code).toBe(0);
		expect(stats.out).toContain("solutions");
		const search = run(["kb", "search", "retry contract stale leases"]);
		expect(search.out).toContain("lease-release");
		const miss = run(["kb", "search", "totally unrelated words about databases"]);
		expect(miss.code).toBe(1);
	});
});
