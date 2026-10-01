// usage-seed.test.ts — W127: seed/purge round-trip. Seeded rows are clearly
// flagged (actor LIKE 'demo:%', sids demo-*) and purge removes exactly those.
import { describe, test, expect, afterAll } from "bun:test";
import { openMemoryStore, type GovernorStore } from "../hooks/lib/govdb.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-seed-"));
const { seedUsage, purgeUsage } = await import(
	`../hooks/bin/usage-seed.ts?home=${encodeURIComponent(HOME)}`
);

const NOW_MS = Date.parse("2026-10-01T12:00:00Z");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const ROLLUP_DDL =
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))";
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', capabilities TEXT, transcript_path TEXT, actor TEXT, tags TEXT)";

function freshDb(): GovernorStore {
	const db = openMemoryStore();
	db.run(ROLLUP_DDL);
	db.run(SESSIONS_DDL);
	return db;
}

const demoRollups = (db: GovernorStore): number =>
	(
		db
			.query("SELECT COUNT(*) AS n FROM usage_rollup WHERE actor LIKE 'demo:%'")
			.get() as { n: number }
	).n;

const realRollups = (db: GovernorStore): number =>
	(
		db
			.query(
				"SELECT COUNT(*) AS n FROM usage_rollup WHERE actor NOT LIKE 'demo:%'",
			)
			.get() as { n: number }
	).n;

describe("usage seed/purge", () => {
	test("seed → purge round-trip, demo rows only", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (1, 'real-alice', 'm', 'flash', 1, 1, 0, 0, 1)",
		).run();
		const s = seedUsage(db, { nowMs: NOW_MS });
		expect(s.actors).toBe(2);
		expect(s.rows).toBeGreaterThan(100);
		expect(demoRollups(db)).toBe(s.rows);
		expect(realRollups(db)).toBe(1); // the real row untouched
		// two demo sessions, CLOSED, flagged
		const sess = db
			.query("SELECT sid, role, state FROM sessions WHERE sid LIKE 'demo-%'")
			.all() as { sid: string; role: string; state: string }[];
		expect(sess.map((x) => x.role)).toEqual(["demo", "demo"]);
		expect(sess.every((x) => x.state === "CLOSED")).toBe(true);
		const p = purgeUsage(db);
		expect(p.rows).toBe(s.rows);
		expect(p.sessions).toBe(2);
		expect(demoRollups(db)).toBe(0);
		expect(realRollups(db)).toBe(1);
		db.close();
	});
});
