// test/aid-harvest.test.ts — W142 metering seam: buckle :4101 →
// aid-harvest → governor.db aid_events + aid_rollup, and the W127 usage
// surface join (aid_events(sid) ⋈ sessions ⋈ usage_rollup(actor, hour)).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { harvestAids } from "../hooks/bin/aid-harvest.ts";
import { buildUsageReport } from "../hooks/lib/usage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', actor TEXT, tags TEXT);
CREATE TABLE IF NOT EXISTS usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model));
CREATE TABLE IF NOT EXISTS aid_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sid TEXT, work_item TEXT, aid TEXT NOT NULL, packet_id TEXT, tokens_injected INTEGER NOT NULL DEFAULT 0, est_tok_saved INTEGER);
CREATE TABLE IF NOT EXISTS aid_rollup (hour_bucket INTEGER NOT NULL, aid TEXT NOT NULL, domain TEXT NOT NULL, model_group TEXT NOT NULL, injected INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, tok_injected INTEGER NOT NULL DEFAULT 0, est_tok_saved INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, aid, domain, model_group));
`;

function scratchDb(): Database {
	const db = new Database(":memory:");
	db.exec(SCHEMA);
	return db;
}

/** Stub buckle: /aids/events + /aids/rollup over fixture rows. */
function stubBuckle(rows: { events: unknown[]; rollup: unknown[] }): {
	server: ReturnType<typeof Bun.serve>;
	base: string;
} {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/aids/events")
				return Response.json({ ok: true, events: rows.events });
			if (url.pathname === "/aids/rollup")
				return Response.json({ ok: true, rows: rows.rollup });
			return new Response("no", { status: 404 });
		},
	});
	return { server, base: `http://127.0.0.1:${server.port}` };
}

const HOUR = 3_600_000;
const NOW = Date.now();
const BUCKET = Math.floor(NOW / HOUR) * HOUR;

describe("aid harvest + usage join", () => {
	test("buckle → govdb: dedupe-insert, rollup upsert, join renders", async () => {
		const db = scratchDb();
		db.run(
			"INSERT INTO sessions (sid, actor, started_at, hb) VALUES ('w142-e2e', 'klaus', ?, ?)",
			[NOW, NOW],
		);
		db.run(
			"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, requests) VALUES (?, 'klaus', 'claude-sonnet-5', 'full', 150000, 60000, 40)",
			[BUCKET],
		);
		const ev = {
			ts: NOW,
			aid: "preseed",
			decision: "injected",
			domain: "gaps",
			sid: "w142-e2e",
			work_item: "W142",
			packet_id: "abc123",
			tokens_injected: 612,
		};
		const { server, base } = stubBuckle({
			events: [ev],
			rollup: [
				{
					hour_bucket: BUCKET,
					aid: "preseed",
					domain: "gaps",
					model_group: "all",
					injected: 1,
					skipped: 0,
					tok_injected: 612,
					est_tok_saved: 0,
					requests: 1,
				},
			],
		});
		const s1 = await harvestAids(db, { baseUrl: base });
		expect(s1.events_inserted).toBe(1);
		expect(s1.buckets_upserted).toBe(1);
		// idempotent re-run: natural-key dedupe, SET-semantics rollup
		const s2 = await harvestAids(db, { baseUrl: base });
		expect(s2.events_inserted).toBe(0);
		expect(db.query("SELECT COUNT(*) AS n FROM aid_events").get()).toEqual({
			n: 1,
		});
		const report = buildUsageReport(db, { days: 7 });
		expect(report.aids).toBeTruthy();
		expect(report.aids?.rollup[0]?.aid).toBe("preseed");
		const j = report.aids?.join[0];
		expect(j?.actor).toBe("klaus");
		expect(j?.tokens_injected).toBe(612);
		expect(j?.in_tok).toBe(150000);
		server.stop(true);
	});
});
