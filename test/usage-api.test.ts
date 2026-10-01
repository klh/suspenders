// usage-api.test.ts — W127: golden JSON shape of buildUsageReport on a seeded
// fixture. Deterministic: fixed nowMs, TZ-agnostic hour-of-day expectations
// (computed with the same getHours() conversion the builder uses).
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-api-"));
const { buildUsageReport } = await import(
	`../hooks/lib/usage.ts?home=${encodeURIComponent(HOME)}`
);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const ROLLUP_DDL =
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))";
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'R', actor TEXT, tags TEXT)";

function freshDb(): Database {
	freshN += 1;
	const db = new Database(join(HOME, `scratch-${freshN}.db`), { create: true });
	db.run(ROLLUP_DDL);
	db.run(SESSIONS_DDL);
	return db;
}
let freshN = 0;

const H = 3_600_000;
const NOW = Date.parse("2026-10-01T12:20:00Z");
const TO = Math.floor(NOW / H) * H;
const FROM = Math.floor((NOW - 7 * 86_400_000) / H) * H;
const b = (hoursAgo: number): number => TO - hoursAgo * H;

function seed(db: Database): void {
	const ins = db.query(
		"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	// alice (team platform): flash-heavy, two buckets
	ins.run(b(2), "alice", "glm-5.3-flash", "flash", 1000, 500, 2000, 100, 5);
	ins.run(b(3), "alice", "claude-sonnet-5", "full", 200, 100, 0, 0, 1);
	// bob (team apps): luna + local
	ins.run(b(2), "bob", "luna-pro", "luna", 300, 150, 0, 0, 2);
	ins.run(b(26), "bob", "local-swarm", "local", 400, 200, 0, 0, 2);
	// outside the 7d window — must be excluded
	ins.run(b(200), "ghost", "gpt-5.2", "full", 999, 999, 999, 999, 9);
	// sessions with tags (bob also has a stale earlier stamp — last wins)
	const sess = db.query(
		"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
	);
	sess.run("s1", 1, 1, "alice", '{"team":"platform"}');
	sess.run("s2", 2, 2, "bob", '{"team":"apps"}');
	sess.run("s3", 0, 0, "bob", '{"team":"old"}');
}

describe("buildUsageReport", () => {
	test("golden shape on the seeded fixture", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		// window math
		expect(r.fromBucket).toBe(FROM);
		expect(r.toBucket).toBe(TO);
		expect(r.timeline.length).toBe(Math.round((TO - FROM) / H) + 1);
		expect(r.byHour.length).toBe(24);
		// totals exclude the out-of-window ghost row
		expect(r.totals).toEqual({
			i: 1900,
			o: 950,
			cr: 2000,
			cc: 100,
			rq: 10,
			tok: 4950,
		});
		// timeline: per-group stacks at the seeded buckets
		const at = (hoursAgo: number): Record<string, number> =>
			r.timeline[Math.round((TO - hoursAgo * H - FROM) / H)].groups;
		expect(at(2)).toMatchObject({ flash: 3600, luna: 450 });
		expect(at(3)).toMatchObject({ full: 300 });
		expect(at(26)).toMatchObject({ local: 600 });
		// hour-of-day histogram lands the seeded tokens on the right local hours
		const byH = (ms: number): number =>
			r.byHour[new Date(ms).getHours()].tokens;
		expect(byH(b(2))).toBe(4650); // b(26) shares the hour-of-day: 3600 flash + 450 luna + 600 local
		expect(byH(b(3))).toBe(300);
		// rate: newest non-empty bucket within 24h → out/3600 (500 flash + 150 luna)
		expect(r.rate.tokPerSec).toBe(0.18); // 650/3600 → 0.18
		expect(r.rate.hourBucket).toBe(b(2));
		db.close();
	});

	test("actor drill-down: tags last-stamp-wins, byModel sorted by tokens", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		expect(r.actors.map((a) => a.actor)).toEqual(["alice", "bob"]); // alice 3900 tok > bob 1050
		expect(r.actors[0].tags).toEqual({ team: "platform" });
		expect(r.actors[1].tags).toEqual({ team: "apps" }); // last stamp wins over 'old'
		expect(r.actors[0].byModel[0]).toMatchObject({
			model: "glm-5.3-flash",
			group: "flash",
		});
		db.close();
	});
});
