// knowledge-domain.test.ts — W205: the read-side domain filter binds the aux
// stores of knowledgeSearch. consult_kb carries `project` (its domain) — a
// declared domain narrows it to that project; facts carry NO domain column,
// so a declared domain excludes the store fail-closed (it cannot prove
// membership). Governor-shaped single-handle fixture with EXPLICIT handles,
// not makeStore — post-W166 knowledge.db holds no facts/consult tables, so
// the aux stores only execute against a governor-shaped db (the same
// hermeticity note knowledge-split.test.ts carries: the bare-govdb module
// cache binds REG to whichever suite loaded first). Live consult_kb
// project values are repo-identity paths (git common dir, projectIdentity()
// shape), not domain names — the equality predicate is therefore
// intentionally fail-closed for domain-name callers on live data.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeSearch } from "../hooks/lib/knowledge.ts";

const DIR = mkdtempSync(join(tmpdir(), "suspenders-w205-domain-"));
const db = new Database(join(DIR, "governor-shape.db"));
db.exec(`
	CREATE TABLE facts (
		key TEXT PRIMARY KEY,
		value TEXT,
		source TEXT,
		version INTEGER NOT NULL DEFAULT 1,
		ts INTEGER NOT NULL
	);
	CREATE VIRTUAL TABLE facts_fts USING fts5(value, key UNINDEXED);
	CREATE TABLE consult_kb (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		problem TEXT NOT NULL,
		solution TEXT NOT NULL,
		project TEXT NOT NULL,
		asked_by TEXT NOT NULL,
		answered_by TEXT NOT NULL,
		consult_id INTEGER,
		hits INTEGER NOT NULL DEFAULT 0,
		last_hit_at INTEGER,
		created_at INTEGER NOT NULL
	);
	CREATE VIRTUAL TABLE consult_kb_fts USING fts5(problem);
`);

const PROBE = "w205factprobe w205consultprobe"; // OR-joined by ftsTerms
const seed = {
	fact: db
		.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'w205', 1, ?)",
		)
		.run("w205.private.key", "w205factprobe: private coord intel", Date.now()),
	consultMine: db
		.query(
			"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, created_at) VALUES (?, ?, 'suspenders', 'w205', 'w205', ?)",
		)
		.run(
			"w205consultprobe: suspenders-scoped problem",
			"suspenders-scoped solution",
			Date.now(),
		),
	consultOther: db
		.query(
			"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, created_at) VALUES (?, ?, 'other-project', 'w205', 'w205', ?)",
		)
		.run(
			"w205consultprobe: other-scoped problem",
			"other-scoped solution",
			Date.now(),
		),
};
// raw fixture, no sync triggers: index the rows explicitly (the shape
// facts.ts:151 / consult.ts:207 use for consult_kb_fts)
db.query("INSERT INTO facts_fts (rowid, value, key) VALUES (?, ?, ?)").run(
	Number(seed.fact.lastInsertRowid),
	"w205factprobe: private coord intel",
	"w205.private.key",
);
db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
	Number(seed.consultMine.lastInsertRowid),
	"w205consultprobe: suspenders-scoped problem",
);
db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
	Number(seed.consultOther.lastInsertRowid),
	"w205consultprobe: other-scoped problem",
);

const kinds = (filters: { domain?: string | null }): string[] =>
	knowledgeSearch(db, PROBE, filters).map((h) => `${h.kind}:${h.id}`);
const consultIds = (filters: { domain?: string | null }): number[] =>
	knowledgeSearch(db, PROBE, filters)
		.filter((h) => h.kind === "consult_kb")
		.map((h) => h.id);

describe("W205 read-side domain filter", () => {
	test("unscoped: facts + consults of every project flow (status quo)", () => {
		const hits = kinds({});
		// fact hits carry no row id (KnowledgeHit.id = 0 by shape) — kind only
		expect(hits.some((h) => h.startsWith("fact:"))).toBe(true);
		expect(consultIds({}).sort((a, b) => a - b)).toEqual(
			[
				Number(seed.consultMine.lastInsertRowid),
				Number(seed.consultOther.lastInsertRowid),
			].sort((a, b) => a - b),
		);
	});

	test("declared domain: facts exit fail-closed, consults narrow by project", () => {
		const hits = kinds({ domain: "suspenders" });
		expect(hits.some((h) => h.startsWith("fact:"))).toBe(false);
		expect(consultIds({ domain: "suspenders" })).toEqual([
			Number(seed.consultMine.lastInsertRowid),
		]);
		expect(consultIds({ domain: "other-project" })).toEqual([
			Number(seed.consultOther.lastInsertRowid),
		]);
		expect(kinds({ domain: "no-such-domain" })).toEqual([]);
	});
});

afterAll(() => {
	db.close();
	rmSync(DIR, { recursive: true, force: true });
});
