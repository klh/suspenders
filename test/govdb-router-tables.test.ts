// govdb-router-tables.test.ts — W132: the v8 router governance tables exist
// with the W131/W136/W137 shapes, ride the existing deltas trigger loop with
// zero per-table wiring (the audit trail IS the deltas log), and honor the
// two write contracts the router leans on: aid_rollup UPSERT-ADD (W137 §6 —
// flushers add, never overwrite) and budget_state upsert-add flush (W135 —
// a retried batch never loses counts). api_keys carries the token mechanics
// (access|refresh, parent_key_id rotation chain, jti denylist, NULL
// expires_at = forever) and stores HASHES only. Temp-HOME isolation per the
// govdb-migration recipe: the ?query import busts bun's shared module cache
// so this file's govdb instance binds the temp HOME, never the real
// governor.db. HOME is restored right after import — REG is captured at
// module load, so later imports in other files rebind to the real HOME.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w132-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // REG binds at govdb module load — set before import
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?w132=${encodeURIComponent(HOME)}`
);
process.env.HOME = REAL_HOME;

const DB = `${HOME}/.cache/claude-governor/governor.db`;

function freshDb(): Database {
	mkdirSync(dirname(DB), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(DB + suffix, { force: true });
	return new Database(DB, { create: true });
}

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const NEW_TABLES: Record<string, string[]> = {
	api_keys: [
		"key_id",
		"key_hash",
		"jti",
		"name",
		"team",
		"actor",
		"token_type",
		"parent_key_id",
		"scopes",
		"rpm_limit",
		"tpm_limit",
		"expires_at",
		"rotated_at",
		"revoked_at",
		"created_at",
	],
	teams: ["team_id", "name", "department", "created_at"],
	route_audit: [
		"rid",
		"ts",
		"actor",
		"dialect",
		"hint",
		"candidates",
		"resolved_target",
		"decision",
		"latency_class",
		"error_code",
	],
	aid_events: [
		"id",
		"ts",
		"sid",
		"work_item",
		"aid",
		"packet_id",
		"tokens_injected",
		"est_tok_saved",
	],
	aid_rollup: [
		"hour_bucket",
		"aid",
		"domain",
		"model_group",
		"injected",
		"skipped",
		"tok_injected",
		"est_tok_saved",
		"requests",
	],
	budget_state: ["key_id", "window", "used_rpm", "used_tpm", "window_start"],
	auth_events: ["id", "ts", "actor", "event", "jti", "via"],
};

const DML = {
	rollupAdd: `INSERT INTO aid_rollup (hour_bucket, aid, domain, model_group, injected, skipped, tok_injected, est_tok_saved, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (hour_bucket, aid, domain, model_group) DO UPDATE SET
	injected = injected + excluded.injected,
	skipped = skipped + excluded.skipped,
	tok_injected = tok_injected + excluded.tok_injected,
	est_tok_saved = est_tok_saved + excluded.est_tok_saved,
	requests = requests + excluded.requests`,
	budgetFlush: `INSERT INTO budget_state (key_id, window, used_rpm, used_tpm, window_start) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (key_id, window) DO UPDATE SET
	used_rpm = used_rpm + excluded.used_rpm,
	used_tpm = used_tpm + excluded.used_tpm,
	window_start = excluded.window_start`,
};

// W137 §6 SQL verbatim — the W132 boundary declared this exact shape
const DOC_AID_ROLLUP_SQL = `CREATE TABLE IF NOT EXISTS aid_rollup (
  hour_bucket INTEGER NOT NULL,
  aid TEXT NOT NULL,
  domain TEXT NOT NULL,
  model_group TEXT NOT NULL,
  injected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  tok_injected INTEGER NOT NULL DEFAULT 0,
  est_tok_saved INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, aid, domain, model_group)
);`;

describe("v8 migration shape", () => {
	test("user_version 9 (v9 W159 provenance columns), all seven router tables present with the designed columns", () => {
		const db = freshDb();
		db.close();
		openGovernorDb();
		const d = new Database(DB);
		const uv = (
			d.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBe(9);
		for (const [tbl, cols] of Object.entries(NEW_TABLES)) {
			const have = (
				d.query(`PRAGMA table_info(${tbl})`).all() as { name: string }[]
			).map((c) => c.name);
			expect(have).toEqual(cols);
		}
		d.close();
	});

	test("deltas triggers cover every table: 12 × 3 = 36, bus tables still untracked", () => {
		const d = new Database(DB);
		const n = (
			d
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_%'",
				)
				.get() as { n: number }
		).n;
		expect(n).toBe(36);
		const bus = d
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_events_%'",
			)
			.all();
		expect(bus).toEqual([]);
		d.close();
	});

	test("second open is idempotent: version and trigger count unchanged", () => {
		openGovernorDb(); // reopen — must not duplicate anything
		const d = new Database(DB);
		const uv = (
			d.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		const n = (
			d
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_%'",
				)
				.get() as { n: number }
		).n;
		expect(uv).toBe(9);
		expect(n).toBe(36);
		const legacy = d
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_legacy_%'",
			)
			.all();
		expect(legacy).toEqual([]);
		d.close();
	});

	test("api_keys integrity: hash required, key_id PK, jti unique, no raw-key column", () => {
		const db = openGovernorDb();
		// key_hash NOT NULL — a key without a hash is unauthenticatable
		expect(() =>
			db
				.query("INSERT INTO api_keys (key_id, created_at) VALUES ('bad', 1)")
				.run(),
		).toThrow();
		// key_id is the PK
		db.query(
			"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('dup', 'h', 1)",
		).run();
		expect(() =>
			db
				.query(
					"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('dup', 'h2', 1)",
				)
				.run(),
		).toThrow();
		// jti carries a UNIQUE index — the denylist check is one indexed lookup
		db.query(
			"INSERT INTO api_keys (key_id, key_hash, jti, created_at) VALUES ('j1', 'h1', 'jti-x', 1)",
		).run();
		expect(() =>
			db
				.query(
					"INSERT INTO api_keys (key_id, key_hash, jti, created_at) VALUES ('j2', 'h2', 'jti-x', 1)",
				)
				.run(),
		).toThrow();
		// the column set is exactly the designed one — nothing that could hold
		// a raw secret
		const d = new Database(DB);
		const cols = (
			d.query("PRAGMA table_info(api_keys)").all() as { name: string }[]
		).map((c) => c.name);
		d.close();
		expect(cols).toEqual(NEW_TABLES.api_keys);
	});
});

describe("deltas coverage — the audit win is the existing loop", () => {
	test("api_keys: insert, rotation chain, per-token and per-actor revocation", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const w = db2.query.bind(db2);
		const now = Date.now();
		// owner's forever pair: access + refresh, expires_at NULL = forever
		w(
			"INSERT INTO api_keys (key_id, key_hash, jti, name, actor, token_type, created_at) VALUES ('k-acc', 'sha256:aa', 'jti-acc', 'owner', 'klh', 'access', ?)",
		).run(now);
		w(
			"INSERT INTO api_keys (key_id, key_hash, jti, name, actor, token_type, parent_key_id, created_at) VALUES ('k-ref1', 'sha256:bb', 'jti-ref1', 'owner', 'klh', 'refresh', 'k-acc', ?)",
		).run(now);
		// rotation: new refresh row + old row stamped rotated_at
		w(
			"INSERT INTO api_keys (key_id, key_hash, jti, actor, token_type, parent_key_id, created_at) VALUES ('k-ref2', 'sha256:cc', 'jti-ref2', 'klh', 'refresh', 'k-ref1', ?)",
		).run(now + 1);
		w("UPDATE api_keys SET rotated_at = ? WHERE key_id = 'k-ref1'").run(
			now + 2,
		);
		// per-actor revocation: every row of the actor, one UPDATE
		w(
			"UPDATE api_keys SET revoked_at = ? WHERE actor = 'klh' AND revoked_at IS NULL",
		).run(now + 3);
		const rows = db2
			.query(
				"SELECT op, pk, before, after FROM deltas WHERE tbl = 'api_keys' ORDER BY seq",
			)
			.all() as {
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => r.op)).toEqual([
			"insert",
			"insert",
			"insert",
			"update",
			"update",
			"update",
			"update",
		]);
		// the per-actor revocation UPDATE fires per-row in scan order — assert
		// as a multiset so the test doesn't pin SQLite's internal scan order
		expect([...rows.map((r) => r.pk)].sort()).toEqual([
			"k-acc",
			"k-acc",
			"k-ref1",
			"k-ref1",
			"k-ref1",
			"k-ref2",
			"k-ref2",
		]);
		expect(rows.slice(0, 3).map((r) => r.pk)).toEqual([
			"k-acc",
			"k-ref1",
			"k-ref2",
		]);
		const ins = rows[0];
		expect(ins.before).toBeNull();
		expect(JSON.parse(ins.after ?? "{}").expires_at).toBeNull(); // forever
		const rot = rows.find((r) => r.pk === "k-ref1" && r.op === "update");
		expect(JSON.parse(rot?.before ?? "{}").rotated_at).toBeNull();
		expect(JSON.parse(rot?.after ?? "{}").rotated_at).toBe(now + 2);
		const rev = rows.find(
			(r) => r.pk === "k-acc" && r.op === "update",
		) as (typeof rows)[number];
		expect(JSON.parse(rev.before ?? "{}").revoked_at).toBeNull();
		expect(JSON.parse(rev.after ?? "{}").revoked_at).toBe(now + 3);
		db2.close();
	});

	test("route_audit: decision INSERT + outcome UPDATE by rid = two delta rows", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const now = Date.now();
		db2
			.query(
				"INSERT INTO route_audit (rid, ts, actor, dialect, hint, candidates, resolved_target, decision, latency_class) VALUES ('rid-1', ?, 'demo:alice', 'anthropic', 'prefer local reasoning', 'flash,local-reasoning', 'local:box:8903/reasoning', 'policy', 'fast')",
			)
			.run(now);
		// outcome write (W136 §6 two-write pattern): UPDATE in place by rid
		db2
			.query(
				"UPDATE route_audit SET decision = 'fallback', error_code = 'upstream_5xx' WHERE rid = 'rid-1'",
			)
			.run();
		const rows = db2
			.query(
				"SELECT op, pk, before, after FROM deltas WHERE tbl = 'route_audit' ORDER BY seq",
			)
			.all() as {
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => r.op)).toEqual(["insert", "update"]);
		expect(rows.map((r) => r.pk)).toEqual(["rid-1", "rid-1"]);
		expect(JSON.parse(rows[0].after ?? "{}").decision).toBe("policy");
		expect(JSON.parse(rows[0].after ?? "{}").error_code).toBeNull();
		const upd = rows[1];
		expect(JSON.parse(upd.before ?? "{}").decision).toBe("policy");
		expect(JSON.parse(upd.after ?? "{}").decision).toBe("fallback");
		expect(JSON.parse(upd.after ?? "{}").error_code).toBe("upstream_5xx");
		db2.close();
	});

	test("aid_events and auth_events: event rows land with pk = id, full images", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const now = Date.now();
		db2
			.query(
				"INSERT INTO aid_events (ts, sid, work_item, aid, packet_id, tokens_injected, est_tok_saved) VALUES (?, 'w137-aids', 'W137', 'preseed', '9f3a21', 612, NULL)",
			)
			.run(now);
		db2
			.query(
				"INSERT INTO auth_events (ts, actor, event, jti, via) VALUES (?, 'klh', 'issued', 'jti-acc', '/key/generate')",
			)
			.run(now);
		// est_tok_saved NULL at event time — the W137 honesty rule
		const ev = db2.query("SELECT id FROM aid_events").get() as { id: number };
		const rows = db2
			.query(
				"SELECT tbl, op, pk, before, after FROM deltas WHERE tbl IN ('aid_events', 'auth_events') ORDER BY seq",
			)
			.all() as {
			tbl: string;
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => [r.tbl, r.op])).toEqual([
			["aid_events", "insert"],
			["auth_events", "insert"],
		]);
		expect(rows[0].pk).toBe(String(ev.id));
		expect(rows[0].before).toBeNull();
		const afterEv = JSON.parse(rows[0].after ?? "{}");
		expect(afterEv.est_tok_saved).toBeNull();
		expect(afterEv.tokens_injected).toBe(612);
		expect(rows[1].pk).toBe("1");
		expect(JSON.parse(rows[1].after ?? "{}").event).toBe("issued");
		db2.close();
	});

	test("teams: insert lands with composite-free pk and department for the /usage filter", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		db2
			.query(
				"INSERT INTO teams (team_id, name, department, created_at) VALUES ('platform', 'Platform', 'Infrastructure', 1)",
			)
			.run();
		const row = db2
			.query("SELECT op, pk, after FROM deltas WHERE tbl = 'teams'")
			.get() as { op: string; pk: string; after: string };
		expect(row.op).toBe("insert");
		expect(row.pk).toBe("platform");
		expect(JSON.parse(row.after).department).toBe("Infrastructure");
		db2.close();
	});
});

describe("aid_rollup — W137 §6 SQL runs verbatim with UPSERT-ADD", () => {
	test("the doc's CREATE TABLE IF NOT EXISTS is a no-op against the v8 table", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		expect(() => db2.run(DOC_AID_ROLLUP_SQL)).not.toThrow();
		// shape unchanged by the verbatim run
		const d = new Database(DB);
		const cols = (
			d.query("PRAGMA table_info(aid_rollup)").all() as { name: string }[]
		).map((c) => c.name);
		d.close();
		expect(cols).toEqual(NEW_TABLES.aid_rollup);
		db2.close();
	});

	test("UPSERT-ADD accumulates; deltas shows insert then update with the composite pk", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const add = db2.query(DML.rollupAdd);
		add.run(1790849100, "preseed", "gaps", "flash", 1, 0, 612, 0, 1);
		add.run(1790849100, "preseed", "gaps", "flash", 2, 1, 388, 0, 1);
		add.run(1790849100, "preseed", "gaps", "luna", 1, 0, 100, 0, 1);
		const row = db2
			.query(
				"SELECT injected, skipped, tok_injected, requests FROM aid_rollup WHERE hour_bucket = 1790849100 AND aid = 'preseed' AND domain = 'gaps' AND model_group = 'flash'",
			)
			.get() as {
			injected: number;
			skipped: number;
			tok_injected: number;
			requests: number;
		};
		expect(row).toEqual({
			injected: 3,
			skipped: 1,
			tok_injected: 1000,
			requests: 2,
		});
		const rows = db2
			.query("SELECT op, pk FROM deltas WHERE tbl = 'aid_rollup' ORDER BY seq")
			.all() as { op: string; pk: string }[];
		expect(rows.map((r) => r.op)).toEqual(["insert", "update", "insert"]);
		expect(rows[0].pk).toBe("1790849100/preseed/gaps/flash");
		expect(rows[1].pk).toBe("1790849100/preseed/gaps/flash");
		db2.close();
	});
});

describe("budget_state — W135 async flush upsert semantics", () => {
	test("upsert-ADD accumulates counters and advances window_start on the flusher's word", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const flush = db2.query(DML.budgetFlush);
		flush.run("k-acc", "minute", 5, 1200, 1000);
		flush.run("k-acc", "minute", 3, 800, 1000);
		flush.run("k-acc", "minute", 2, 0, 1060); // window rolled: start advances
		const row = db2
			.query(
				"SELECT used_rpm, used_tpm, window_start FROM budget_state WHERE key_id = 'k-acc' AND window = 'minute'",
			)
			.get() as {
			used_rpm: number;
			used_tpm: number;
			window_start: number;
		};
		expect(row).toEqual({ used_rpm: 10, used_tpm: 2000, window_start: 1060 });
		db2.close();
	});

	test("separate windows stay independent; every flush leaves exactly one delta with pk = key/window", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const flush = db2.query(DML.budgetFlush);
		flush.run("k-acc", "minute", 5, 1200, 1000);
		flush.run("k-acc", "day", 1, 5000, 86400);
		const rows = db2
			.query(
				"SELECT op, pk, before, after FROM deltas WHERE tbl = 'budget_state' ORDER BY seq",
			)
			.all() as {
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => r.pk)).toEqual(["k-acc/minute", "k-acc/day"]);
		expect(rows.every((r) => r.op === "insert")).toBe(true);
		// a conflict-path flush is an UPDATE in deltas — before/after images
		flush.run("k-acc", "minute", 3, 800, 1000);
		const upd = db2
			.query(
				"SELECT op, before, after FROM deltas WHERE tbl = 'budget_state' AND pk = 'k-acc/minute' ORDER BY seq",
			)
			.all() as { op: string; before: string | null; after: string }[];
		expect(upd.length).toBe(2);
		expect(upd[1].op).toBe("update");
		expect(JSON.parse(upd[1].before).used_rpm).toBe(5);
		expect(JSON.parse(upd[1].after).used_rpm).toBe(8);
		db2.close();
	});
});
