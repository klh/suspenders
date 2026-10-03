// test/knowledge-curation.test.ts — W208 knowledge curation engine: the
// decay planner (pure), then the store round-trip propose → dispose on an
// isolated temp HOME (w159-settle's isolation + query-bust import pattern).
// The CLI wiring gets one spawn smoke at the end.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w208-"));
process.env.HOME = HOME;
const { openGovernorDb, openKnowledgeDb } = await import(
	`../hooks/lib/govdb.ts?w208=${encodeURIComponent(HOME)}`
);

const DAY = 86_400_000;
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

// governor open bootstraps the kb schema (v10 split); knowledge.db's own
// extra tables (knowledge_proposals) self-heal on every openKnowledgeDb.
function freshKb(): Database {
	return openGovernorDb() && openKnowledgeDb();
}

// seed one knowledge row with a controlled last-touch and state
function seed(
	topic: string,
	opts: { ageDays: number; confidence?: number; state?: string },
): number {
	const db = openKnowledgeDb();
	const ts = Date.now() - opts.ageDays * DAY;
	const r = db
		.query(
			"INSERT INTO knowledge (ts, topic, fact, confidence, state, updated_at) VALUES (?, ?, 'fact text', ?, ?, ?)",
		)
		.run(ts, topic, opts.confidence ?? 0.8, opts.state ?? "active", ts);
	return Number(r.lastInsertRowid);
}

function proposals(state: string): { id: number; knowledge_id: number }[] {
	const db = openKnowledgeDb();
	return db
		.query(
			"SELECT id, knowledge_id FROM knowledge_proposals WHERE state = ? ORDER BY id",
		)
		.all(state) as { id: number; knowledge_id: number }[];
}

function rowState(id: number): string | undefined {
	const db = openKnowledgeDb();
	return (
		db.query("SELECT state FROM knowledge WHERE id = ?").get(id) as
			| { state: string }
			| undefined
	)?.state;
}

let SqliteKnowledgeStore: new (
	db: Database,
) => import("../hooks/lib/knowledge-ports.ts").SqliteKnowledgeStore;
let decayScore: typeof import("../hooks/lib/knowledge-curate.ts").decayScore;
let planDecayProposals: typeof import("../hooks/lib/knowledge-curate.ts").planDecayProposals;

test("boot", async () => {
	const kb = freshKb();
	expect(kb).toBeDefined();
	({ SqliteKnowledgeStore } = await import("../hooks/lib/knowledge-ports.ts"));
	({ decayScore, planDecayProposals } = await import(
		"../hooks/lib/knowledge-curate.ts"
	));
	expect(proposals("open")).toEqual([]);
});

test("decayScore: halves per half-life, clamps negative age, 0-conf stays 0", () => {
	expect(decayScore(0, 1)).toBe(1);
	expect(decayScore(45, 1)).toBeCloseTo(0.5);
	expect(decayScore(90, 1)).toBeCloseTo(0.25);
	expect(decayScore(-5, 0.6)).toBe(decayScore(0, 0.6));
	expect(decayScore(200, 0)).toBe(0);
	expect(decayScore(10, 0.8, 0)).toBe(0.8); // degenerate half-life = off
});

test("planner: proposes decayed rows, weights candidates, honors cooldown, stale-closes recovered", () => {
	const now = Date.now();
	const rows = [
		{
			id: 1,
			topic: "fresh",
			confidence: 0.9,
			state: "active",
			ts: now - DAY,
			updated_at: now - DAY,
		},
		{
			id: 2,
			topic: "old active",
			confidence: 0.8,
			state: "active",
			ts: now - 200 * DAY,
			updated_at: now - 200 * DAY,
		},
		{
			id: 3,
			topic: "old candidate",
			confidence: 0.6,
			state: "candidate",
			ts: now - 100 * DAY,
			updated_at: null,
		},
	];
	// row 1 is fresh but holds an open proposal → stale-close, not propose
	const plan = planDecayProposals(
		rows,
		[{ id: 11, knowledge_id: 1, score: 0.1 }],
		[
			{ knowledge_id: 3, decided_at: now - 5 * DAY }, // inside cooldown
			{ knowledge_id: 4, decided_at: now - 40 * DAY }, // expired (no row 4)
		],
		{ now },
	);
	expect(plan.checked).toBe(3);
	expect(plan.propose.map((p) => p.knowledgeId)).toEqual([2]);
	expect(plan.stale).toEqual([11]);
	expect(plan.refresh).toEqual([]);
});

test("planner: refresh drafts when a row still qualifies with an open proposal", () => {
	const now = Date.now();
	const plan = planDecayProposals(
		[
			{
				id: 5,
				topic: "still stale",
				confidence: 0.5,
				state: "active",
				ts: now - 300 * DAY,
				updated_at: now - 300 * DAY,
			},
		],
		[{ id: 21, knowledge_id: 5, score: 0.01 }],
		[],
		{ now },
	);
	expect(plan.refresh.length).toBe(1);
	expect(plan.refresh[0].proposalId).toBe(21);
	expect(plan.propose).toEqual([]);
});

test("store: proposeDecay writes one open proposal per row; re-sweep refreshes, never duplicates", async () => {
	const s = new SqliteKnowledgeStore(openKnowledgeDb());
	const a = seed("w208-stale-a", { ageDays: 200 });
	seed("w208-stale-b", { ageDays: 150 });
	const first = await s.proposeDecay({ by: "test" });
	const aProps = first.proposed.filter((p) => p.knowledgeId === a);
	expect(aProps.length).toBe(1);
	expect(aProps[0].score).toBeLessThan(0.25);
	const second = await s.proposeDecay({ by: "test" });
	expect(second.proposed).toEqual([]);
	expect(second.refreshed).toBeGreaterThanOrEqual(2);
	expect(proposals("open").filter((p) => p.knowledge_id === a).length).toBe(1);
	// freshness resets the clock: note() bumps updated_at → recovery
	await s.note(a, "tester", "still true today");
	const third = await s.proposeDecay({ by: "test" });
	expect(third.stale).toBe(1); // row a's open proposal auto-closed
	expect(rowState(a)).toBe("active"); // the sweep never retires
});

test("store: dispose approve retires the row; double dispose refuses", async () => {
	const s = new SqliteKnowledgeStore(openKnowledgeDb());
	const id = seed("w208-approve", { ageDays: 200 });
	await s.proposeDecay({ by: "test" });
	const [p] = proposals("open").filter((p) => p.knowledge_id === id);
	expect(p).toBeDefined();
	const res = await s.disposeProposal(p.id, "approve", { by: "tester" });
	expect(res.ok).toBe(true);
	expect(res.retired).toBe(true);
	expect(rowState(id)).toBe("retired");
	const again = await s.disposeProposal(p.id, "approve", { by: "tester" });
	expect(again.ok).toBe(false);
	// retired rows leave the sweep entirely
	const sweep = await s.proposeDecay({ by: "test" });
	expect(sweep.proposed.filter((x) => x.knowledgeId === id)).toEqual([]);
});

test("store: dispose dismiss buys the cooldown; expiry re-proposes", async () => {
	const s = new SqliteKnowledgeStore(openKnowledgeDb());
	const id = seed("w208-dismiss", { ageDays: 200 });
	await s.proposeDecay({ by: "test" });
	const [p] = proposals("open").filter((p) => p.knowledge_id === id);
	const res = await s.disposeProposal(p.id, "dismiss", { by: "tester" });
	expect(res.ok).toBe(true);
	expect(res.retired).toBe(false);
	expect(rowState(id)).toBe("active"); // dismissal keeps the row
	expect((await s.proposeDecay({ by: "test" })).proposed).toEqual([]); // cooled down
	expect(
		(await s.proposeDecay({ by: "test", cooldownDays: 0 })).proposed.length,
	).toBe(1); // expired cooldown re-proposes (new proposal, not dupe)
});

test("cli: knowledge-propose/proposals/dispose route through coord", async () => {
	const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	const run = (args: string[]): { out: string; code: number } => {
		const p = Bun.spawnSync(["bun", coord, ...args], {
			cwd: import.meta.dir,
			env: { ...process.env, HOME },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { out: p.stdout.toString(), code: p.exitCode };
	};
	seed("w208-cli", { ageDays: 250, confidence: 0.5 });
	const prop = run(["knowledge-propose", "--as", "cli-test"]);
	expect(prop.code).toBe(0);
	expect(prop.out).toContain("propose:");
	const list = run(["knowledge-proposals"]);
	expect(list.out).toContain("k#");
	const ids = proposals("open").map((x) => x.id);
	const done = run(["knowledge-dispose", String(ids.at(-1)), "dismiss"]);
	expect(done.out).toContain("dismissed");
});
