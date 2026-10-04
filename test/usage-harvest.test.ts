// usage-harvest.test.ts — W127: usage_rollup math, idempotent re-harvest
// (same mtime+size → no double count; append → tail-only), model→group
// mapping, actor attribution via sessions.actor, and the govdb v7 migration
// (sessions.actor/tags + usage_rollup) on a temp HOME — never the live hub.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	appendFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-usage-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const { harvestUsage, modelGroup } = await import(
	`../hooks/bin/usage-harvest.ts?home=${encodeURIComponent(HOME)}`
);
// restore: REG was already captured at govdb module load; leaving the temp
// HOME set leaks into later-loading suites (the gate-writes interference)
process.env.HOME = REAL_HOME;
// the attribution fallback reads ~/.claude/local-llm/suspenders-board.json at
// CALL time (boardSettingsPath → process.env.HOME): under the real home an
// operator default_actor leaks into the rollup. Harvest under the temp home —
// no settings file there, so the fallback stays the honest "unassigned".
const withHome = <T>(home: string, fn: () => T): T => {
	const prev = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn();
	} finally {
		process.env.HOME = prev;
	}
};

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

// ─── v7 migration guard ─────────────────────────────────────────────────────
describe("govdb v7 usage migration", () => {
	test("sessions gains actor/tags; usage_rollup + index exist", () => {
		const db = openGovernorDb();
		const cols = (
			db.query("PRAGMA table_info(sessions)").all() as { name: string }[]
		).map((c) => c.name);
		expect(cols).toContain("actor");
		expect(cols).toContain("tags");
		const tables = (
			db
				.query("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
				.all() as { name: string }[]
		).map((r) => r.name);
		expect(tables).toContain("usage_rollup");
		expect(tables).toContain("usage_rollup_actor");
		const uv = (
			db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBeGreaterThanOrEqual(7);
		db.close();
	});
});

// ─── model→group mapping ────────────────────────────────────────────────────
describe("modelGroup", () => {
	test("routing-doctrine classes", () => {
		expect(modelGroup("glm-5.3-flash")).toBe("flash");
		expect(modelGroup("glm-4.5-flashx")).toBe("flash"); // flash family
		expect(modelGroup("luna-local-swarm")).toBe("luna");
		expect(modelGroup("local-swarm")).toBe("local");
		expect(modelGroup("ollama/llama3:70b")).toBe("local");
		expect(modelGroup("claude-sonnet-5")).toBe("full");
		expect(modelGroup("anthropic/claude-sonnet-5")).toBe("full"); // prefix stripped
		expect(modelGroup("gpt-5.2")).toBe("full");
		expect(modelGroup("o3-mini")).toBe("full");
		expect(modelGroup("gemini-3-pro")).toBe("full");
		expect(modelGroup("<synthetic>")).toBe("other");
		expect(modelGroup("")).toBe("other");
	});
});

// ─── harvest + rollup math ──────────────────────────────────────────────────
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', capabilities TEXT, transcript_path TEXT, actor TEXT, tags TEXT)";
const FACTS_DDL =
	"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)";
const ROLLUP_DDL =
	"CREATE TABLE usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))";

function freshDb(): Database {
	const db = new Database(join(HOME, "scratch.db"), { create: true });
	db.run(SESSIONS_DDL);
	db.run(FACTS_DDL);
	db.run(ROLLUP_DDL);
	return db;
}

const ROOT = join(HOME, "projects");
mkdirSync(join(ROOT, "proj"), { recursive: true });

const al = (
	model: string,
	inv: number,
	outv: number,
	iso: string,
	cacheR = 0,
	cacheC = 0,
): string =>
	JSON.stringify({
		type: "assistant",
		timestamp: iso,
		message: {
			model,
			usage: {
				input_tokens: inv,
				output_tokens: outv,
				cache_read_input_tokens: cacheR,
				cache_creation_input_tokens: cacheC,
			},
		},
	});

const bucket = (iso: string): number =>
	Math.floor(Date.parse(iso) / 3_600_000) * 3_600_000;

const rowOf = (db: Database, model: string): Record<string, string | number> =>
	db
		.query(
			"SELECT actor, model_group, in_tok, out_tok, cache_r, cache_c, requests FROM usage_rollup WHERE model = ?",
		)
		.get(model) as Record<string, string | number>;

describe("harvestUsage", () => {
	test("rollup math, actor attribution, idempotent re-harvest, append tail", () => {
		const db = freshDb();
		db.query(
			"INSERT INTO sessions (sid, started_at, hb, actor, tags) VALUES (?, ?, ?, ?, ?)",
		).run("sid-a", 1, 1, "alice", '{"team":"platform"}');
		const w = (name: string, lines: string[]): void => {
			writeFileSync(join(ROOT, "proj", name), `${lines.join("\n")}\n`);
		};
		w("sid-a.jsonl", [
			'{"type":"user","message":{"role":"user"}}',
			al("glm-5.3-flash", 100, 50, "2026-10-01T10:30:00Z", 200, 20),
			"not json",
			al("claude-sonnet-5", 10, 5, "2026-10-01T10:45:00Z"),
		]);
		w("sid-b.jsonl", [al("gpt-5.2", 7, 3, "2026-10-01T11:15:00Z")]);

		const s1 = withHome(HOME, () => harvestUsage(db, { root: ROOT }));
		expect(s1.requests).toBe(3);
		expect(s1.inTok).toBe(117);
		expect(s1.outTok).toBe(58);
		expect(s1.cacheR).toBe(200);
		expect(s1.cacheC).toBe(20);
		// hour bucketing: 10:30Z lands in the 10:00Z bucket
		const hbRow = db
			.query(
				"SELECT hour_bucket FROM usage_rollup WHERE model = 'glm-5.3-flash'",
			)
			.get() as { hour_bucket: number };
		expect(hbRow.hour_bucket).toBe(bucket("2026-10-01T10:00:00Z"));
		// per-row: actor attribution + exact rollup cells
		expect(rowOf(db, "glm-5.3-flash")).toEqual({
			actor: "alice",
			model_group: "flash",
			in_tok: 100,
			out_tok: 50,
			cache_r: 200,
			cache_c: 20,
			requests: 1,
		});
		expect(rowOf(db, "claude-sonnet-5")).toMatchObject({
			actor: "alice",
			model_group: "full",
		});
		expect(rowOf(db, "gpt-5.2")).toMatchObject({
			actor: "unassigned",
			model_group: "full",
		});

		// idempotent: unchanged transcripts → skipped, rollups untouched
		const s2 = withHome(HOME, () => harvestUsage(db, { root: ROOT }));
		expect(s2.skipped).toBe(2);
		expect(s2.harvested).toBe(0);
		expect(s2.requests).toBe(0);

		// append-only tail: a grown transcript counts ONLY the new line
		appendFileSync(
			join(ROOT, "proj", "sid-a.jsonl"),
			`${al("luna-pro", 4, 2, "2026-10-01T12:05:00Z")}\n`,
		);
		const s3 = withHome(HOME, () => harvestUsage(db, { root: ROOT }));
		expect(s3.harvested).toBe(1);
		expect(s3.requests).toBe(1);
		expect(rowOf(db, "glm-5.3-flash")).toMatchObject({ in_tok: 100 });
		expect(rowOf(db, "luna-pro")).toMatchObject({
			model_group: "luna",
			in_tok: 4,
			requests: 1,
		});
		db.close();
	});
});
