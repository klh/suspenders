// usage-page.test.ts — W152: the rebuilt /usage dashboard — server-side
// team/dept filtering in buildUsageReport (facets stay unfiltered) + the
// page builder's render contract (uPlot vendored inline, payload columnar,
// chips compose, aids panel degrades honestly, LOCAL-ONLY hygiene).
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-page-"));
const { buildUsageReport } = await import(
	`../hooks/lib/usage.ts?home=${encodeURIComponent(HOME)}`
);
const { usagePage } = await import(
	`../hooks/bin/usage-page-html.ts?home=${encodeURIComponent(HOME)}`
);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const ROLLUP_DDL =
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))";
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, state TEXT NOT NULL DEFAULT 'R', started_at INTEGER NOT NULL, hb INTEGER NOT NULL, actor TEXT, tags TEXT)";

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
const b = (hoursAgo: number): number => TO - hoursAgo * H;

function seed(db: Database): void {
	const ins = db.query(
		"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	// alice (platform/infra): flash-heavy; bob (apps/product): luna + local
	ins.run(b(2), "alice", "glm-5.3-flash", "flash", 1000, 500, 2000, 100, 5);
	ins.run(b(3), "alice", "claude-sonnet-5", "full", 200, 100, 0, 0, 1);
	ins.run(b(2), "bob", "luna-pro", "luna", 300, 150, 0, 0, 2);
	ins.run(b(26), "bob", "local-swarm", "local", 400, 200, 0, 0, 2);
	const sess = db.query(
		"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
	);
	sess.run("s1", 1, 1, "alice", '{"team":"platform","department":"infra"}');
	sess.run("s2", 2, 2, "bob", '{"team":"apps","department":"product"}');
}

describe("buildUsageReport filters (W152)", () => {
	test("team filter cuts every series server-side", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			team: "platform",
		});
		// alice only: (1000+200) in, (500+100) out, 2000 cache_r, 100 cache_c
		expect(r.totals).toEqual({
			i: 1200,
			o: 600,
			cr: 2000,
			cc: 100,
			rq: 6,
			tok: 3900,
		});
		expect(r.actors.map((a) => a.actor)).toEqual(["alice"]);
		const at = (hoursAgo: number): Record<string, number> =>
			r.timeline[Math.round((TO - hoursAgo * H - r.fromBucket) / H)].groups;
		expect(at(2).flash).toBe(3600);
		expect(at(2).luna).toBe(0); // bob's luna row is filtered out
		// facets come from the FULL tag universe — chips stay switchable
		expect(r.facets.teams).toEqual(["apps", "platform"]);
		expect(r.facets.depts).toEqual(["infra", "product"]);
		db.close();
	});

	test("dept filter composes; empty intersection is honest zeros", () => {
		const db = freshDb();
		seed(db);
		const prod = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			dept: "product",
		});
		expect(prod.actors.map((a) => a.actor)).toEqual(["bob"]);
		const none = buildUsageReport(db, {
			days: 7,
			nowMs: NOW,
			team: "platform",
			dept: "product",
		});
		expect(none.actors).toEqual([]);
		expect(none.totals.tok).toBe(0);
		expect(none.timeline.every((p) => p.groups.flash === 0)).toBe(true);
		db.close();
	});
});

describe("usagePage render contract (W152)", () => {
	test("embeds payload, chips, vendored uPlot, shell; LOCAL-ONLY", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW, team: "platform" });
		const html = usagePage(r, { days: 7, team: "platform", dept: "" });
		const all = buildUsageReport(db, { days: 7, nowMs: NOW });
		expect(all.totals.tok).toBe(4950);
		expect(html).toContain('id="cbar"');
		expect(html).toContain("cavbtn");
		expect(html).toContain("var uPlot=function()");
		expect(html).toContain("box-sizing: border-box");
		expect(html).toContain('id="u-timeline"');
		expect(html).toContain('id="u-hours"');
		const m = html.match(
			/<script type="application\/json" id="usage-data">([\s\S]*?)<\/script>/,
		);
		expect(m).not.toBeNull();
		const p = JSON.parse(m?.[1] ?? "{}") as {
			groups: string[];
			timeline: number[][];
			byHour: number[][];
			slot: Record<string, string>;
		};
		expect(p.groups).toEqual(["flash", "full", "luna", "local", "other"]);
		expect(p.timeline.length).toBe(6);
		expect(p.timeline[0].length).toBe(r.timeline.length);
		expect(p.byHour.length).toBe(2);
		expect(p.slot.flash).toBe("#3987e5");
		db.close();
	});
});

describe("usagePage chips + LOCAL-ONLY (W152)", () => {
	test("chips compose, actor table pre-filtered, no home paths leak", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW, team: "platform" });
		const html = usagePage(r, { days: 7, team: "platform", dept: "" });
		expect(html).toContain("dept=infra");
		expect(html).toContain("team=platform&amp;dept=infra");
		expect(html).toContain("dashboard filtered: team=platform");
		expect(html).toContain("alice");
		expect(html).not.toContain("bob<");
		expect(html).not.toContain("/Users/");
		db.close();
	});
});

describe("usagePage aids seam (W152)", () => {
	test("degrades honestly when empty, lights up when aids exist", () => {
		const db = freshDb();
		seed(db);
		const empty = usagePage(buildUsageReport(db, { days: 7, nowMs: NOW }), {
			days: 7,
		});
		expect(empty).toContain("no aid events yet");
		const r = buildUsageReport(db, { days: 7, nowMs: NOW });
		r.aids = {
			rollup: [
				{
					aid: "fleet-lessons",
					domain: "suspenders",
					injected: 12,
					skipped: 3,
					tok_injected: 4800,
				},
			],
			join: [
				{
					aid: "fleet-lessons",
					sid: "s1",
					work_item: "W152",
					actor: "alice",
					hour_bucket: b(2),
					tokens_injected: 400,
					in_tok: 1000,
					out_tok: 500,
				},
			],
		};
		const lit = usagePage(r, { days: 7 });
		expect(lit).toContain("AID ROI · INJECTED VS SKIPPED");
		expect(lit).toContain("fleet-lessons");
		expect(lit).toContain("4.8K");
		expect(lit).not.toContain("no aid events yet");
		db.close();
	});
});
