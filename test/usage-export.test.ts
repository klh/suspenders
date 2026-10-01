// usage-export.test.ts — W179.1: golden CSV of buildUsageCsv on a seeded
// fixture: window math, license/budget joins, RFC 4180 escaping, team
// filter, honest degradation without the v8 tables, page export link.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-export-"));
const { buildUsageReport } = await import(
	`../hooks/lib/usage.ts?home=${encodeURIComponent(HOME)}`
);
const { buildUsageCsv } = await import(
	`../hooks/lib/usage-export.ts?home=${encodeURIComponent(HOME)}`
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
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'R', actor TEXT, tags TEXT)";
const KEYS_DDL =
	"CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, jti TEXT, name TEXT, team TEXT, actor TEXT, token_type TEXT NOT NULL DEFAULT 'access', parent_key_id TEXT, scopes TEXT, rpm_limit INTEGER, tpm_limit INTEGER, expires_at INTEGER, rotated_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL)";
const BUDGET_DDL =
	"CREATE TABLE budget_state (key_id TEXT NOT NULL, window TEXT NOT NULL, used_rpm INTEGER NOT NULL DEFAULT 0, used_tpm INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, PRIMARY KEY (key_id, window))";

function freshDb(opts: { withV8?: boolean } = {}): Database {
	freshN += 1;
	const db = new Database(join(HOME, `scratch-${freshN}.db`), { create: true });
	db.run(ROLLUP_DDL);
	db.run(SESSIONS_DDL);
	if (opts.withV8 !== false) {
		db.run(KEYS_DDL);
		db.run(BUDGET_DDL);
	}
	return db;
}
let freshN = 0;

const H = 3_600_000;
const NOW = Date.parse("2026-10-01T12:20:00Z");
const TO = Math.floor(NOW / H) * H;
const FROM = Math.floor((NOW - 7 * 86_400_000) / H) * H;
const b = (hoursAgo: number): number => TO - hoursAgo * H;
const iso = (ms: number): string => new Date(ms).toISOString();

function seed(db: Database): void {
	const ins = db.query(
		"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	// alice (platform/infra): 3900 tok; bob (apps/product): 1050 tok
	ins.run(b(2), "alice", "glm-5.3-flash", "flash", 1000, 500, 2000, 100, 5);
	ins.run(b(3), "alice", "claude-sonnet-5", "full", 200, 100, 0, 0, 1);
	ins.run(b(2), "bob", "luna-pro", "luna", 300, 150, 0, 0, 2);
	ins.run(b(26), "bob", "local-swarm", "local", 400, 200, 0, 0, 2);
	// outside the 7d window — must be excluded
	ins.run(b(200), "ghost", "gpt-5.2", "full", 999, 999, 999, 999, 9);
	const sess = db.query(
		"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
	);
	sess.run("s1", 1, 1, "alice", '{"team":"platform","department":"infra"}');
	sess.run("s2", 2, 2, "bob", '{"team":"apps","department":"product"}');
}

// licenses + budgets: alice holds two keys (one limited, one bare), bob
// one; alice's key carries two budget windows — the newest window wins.
function seedKeys(db: Database): void {
	const key = db.query(
		"INSERT INTO api_keys (key_id, key_hash, actor, rpm_limit, tpm_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	key.run("key-alice-1", "h1", "alice", 40, 90000, 1);
	key.run("key-alice-2", "h2", "alice", null, null, 2);
	key.run("key-bob-1", "h3", "bob", 10, 10000, 3);
	const bud = db.query(
		"INSERT INTO budget_state (key_id, window, used_rpm, used_tpm, window_start) VALUES (?, ?, ?, ?, ?)",
	);
	bud.run("key-alice-1", "minute", 7, 1234, 1000);
	bud.run("key-alice-1", "hour", 100, 20000, 2000);
	bud.run("key-bob-1", "hour", 2, 345, 1500);
}

describe("buildUsageCsv (W179.1)", () => {
	test("golden rows: seat join, window math, tokens-desc order", () => {
		const db = freshDb();
		seed(db);
		seedKeys(db);
		const csv = buildUsageCsv(db, { days: 7, nowMs: NOW });
		const rows = csv.trimEnd().split("\n");
		expect(rows.length).toBe(3); // header + alice + bob (ghost excluded)
		expect(rows[0]).toBe(
			"actor,team,department,in_tok,out_tok,cache_read_tok,cache_write_tok,total_tokens,requests,models,licenses,rpm_limit,tpm_limit,used_rpm,used_tpm,window_from,window_to",
		);
		expect(rows[1]).toBe(
			`alice,platform,infra,1200,600,2000,100,3900,6,2,key-alice-1;key-alice-2,40,90000,100,20000,${iso(FROM)},${iso(TO)}`,
		);
		expect(rows[2]).toBe(
			`bob,apps,product,700,350,0,0,1050,4,2,key-bob-1,10,10000,2,345,${iso(FROM)},${iso(TO)}`,
		);
		db.close();
	});
});

describe("buildUsageCsv filters + escaping (W179.1)", () => {
	test("team filter cuts to the allowlist, window matches the report", () => {
		const db = freshDb();
		seed(db);
		seedKeys(db);
		const csv = buildUsageCsv(db, {
			days: 7,
			nowMs: NOW,
			team: "platform",
		});
		const rows = csv.trimEnd().split("\n");
		expect(rows.length).toBe(2); // header + alice
		expect(rows[1].startsWith("alice,platform,infra,")).toBe(true);
		db.close();
	});

	test("RFC 4180: comma/quote actors are quoted and doubled", () => {
		const db = freshDb();
		seed(db);
		const ins = db.query(
			"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		ins.run(b(2), 'x "q", y', "glm-5.3-flash", "flash", 30, 20, 0, 0, 1);
		const csv = buildUsageCsv(db, { days: 7, nowMs: NOW });
		const rows = csv.trimEnd().split("\n");
		expect(rows[rows.length - 1]).toBe(
			`"x ""q"", y",,,30,20,0,0,50,1,1,,,,0,0,${iso(FROM)},${iso(TO)}`,
		);
		db.close();
	});
});

describe("buildUsageCsv degradation + page seam (W179.1)", () => {
	test("db without the v8 tables: no throw, license cells ship empty", () => {
		const db = freshDb({ withV8: false });
		seed(db);
		const csv = buildUsageCsv(db, { days: 7, nowMs: NOW });
		const rows = csv.trimEnd().split("\n");
		expect(rows.length).toBe(3); // actors still export, honestly unlicensed
		expect(rows[1]).toBe(
			`alice,platform,infra,1200,600,2000,100,3900,6,2,,,,0,0,${iso(FROM)},${iso(TO)}`,
		);
		db.close();
	});

	test("usage page links the export carrying the active filter state", () => {
		const db = freshDb();
		seed(db);
		const r = buildUsageReport(db, { days: 7, nowMs: NOW, team: "platform" });
		const html = usagePage(r, { days: 7, team: "platform", dept: "" });
		expect(html).toContain("export.csv?days=7&team=platform");
		expect(html).toContain("download");
		db.close();
	});
});
