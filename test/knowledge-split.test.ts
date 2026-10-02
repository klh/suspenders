// knowledge-split.test.ts — W166 test matrix (docs/design/knowledge-db-2026-10-01.md §migration plan):
// the v9→v10 split against a REAL SQLite fixture (synthesized v9-shaped store
// with rows — the same objects the live hub carries), the port rebinding,
// pragma postconditions, byte-identical search, the control-plane rejection,
// idempotency, crash-safe retry, reset-meets-kb, split-brain refusal, and the
// backup round-trip. knowledge-api/MCP/coord byte-identity rides the store:
// all three consumers call makeStore().search — one binding reaches all
// three, so a byte-identical store.search IS a byte-identical API response.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-split-"));
process.env.HOME = HOME;
const REGD = join(HOME, ".cache", "claude-governor");
mkdirSync(REGD, { recursive: true });

const { openGovernorDb, openKnowledgeDb, knowledgeSqlViolation } = await import(
	`../hooks/lib/govdb.ts?split=${encodeURIComponent(HOME)}`
);
const { SqliteKnowledgeStore } = await import(
	`../hooks/lib/knowledge-ports.ts?split=${encodeURIComponent(HOME)}`
);
const { knowledgeSearch } = await import(
	`../hooks/lib/knowledge.ts?split=${encodeURIComponent(HOME)}`
);

const GOV = join(REGD, "governor.db");
const KBP = join(REGD, "knowledge.db");

// ─── fixture: a real v9-shaped store file with deterministic rows ──────────
const KNOW_DDL =
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, hub_eligible INTEGER)";
const FTS_DDL =
	"CREATE VIRTUAL TABLE knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')";
const AI_DDL =
	"CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END";
const AD_DDL =
	"CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END";
const AU_DDL =
	"CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END";
const QUEUE_DDL =
	"CREATE TABLE knowledge_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result_key TEXT, domain TEXT, area TEXT, code_origin TEXT, started_at INTEGER, origin_sid TEXT, source_ref TEXT, source_hash TEXT, hub_eligible INTEGER)";
const CP_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING'); CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (project, id))";

function seed(): void {
	const db = new Database(GOV);
	const ins = db.query(
		"INSERT INTO knowledge (id, ts, topic, fact, confidence, domain, origin_kind, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const q = db.query(
		"INSERT INTO knowledge_queue (ts, source, payload, state, attempts) VALUES (?, ?, ?, ?, ?)",
	);
	for (let i = 1; i <= 40; i++) {
		const ts = 1_600_000_000_000 + i * 86_400_000 * 21; // ~2.3 years spread
		ins.run(
			i,
			ts,
			`wal gate note ${i}`,
			`mmap lever ${i}: busy_timeout before journal_mode on machine m${i % 4}`,
			0.5 + (i % 3) / 10,
			i % 2 ? "proj" : null,
			i % 2 ? "lesson" : "fact",
			i % 7 ? "active" : "retired",
			ts,
			ts,
		);
	}
	const now = 1_700_000_000_000;
	q.run(now, "src", "queued payload one", "queued", 0);
	q.run(now + 1, "src", "", "done", 1);
	q.run(now + 2, "src", "queued payload two", "queued", 1);
	q.run(now + 3, "src", "", "failed", 3);
	db.close();
}

function fixture(): void {
	for (const f of [
		"governor.db",
		"governor.db-wal",
		"governor.db-shm",
		"knowledge.db",
		"knowledge.db-wal",
		"knowledge.db-shm",
	]) {
		try {
			rmSync(join(REGD, f));
		} catch {}
	}
	const db = new Database(GOV);
	db.exec(
		[KNOW_DDL, FTS_DDL, AI_DDL, AD_DDL, AU_DDL, QUEUE_DDL, CP_DDL].join("; "),
	);
	db.run("PRAGMA user_version = 9");
	seed();
	db.close();
}

const countK = (file: string, sql: string): number => {
	const db = new Database(file, { readonly: true });
	const n = Number((db.query(sql).get() as { n: number }).n);
	db.close();
	return n;
};

// PRAGMA user_version reads a named column, not `n` — its own helper
const uvOf = (file: string): number => {
	const db = new Database(file, { readonly: true });
	const r = db.query("PRAGMA user_version").get() as { user_version: number };
	db.close();
	return r.user_version;
};

// byte-identity set: rank + snippet ride the SAME production knowledgeSearch
const QUERIES: [
	string,
	{ limit?: number; domain?: string; originKind?: string },
][] = [
	["wal", {}],
	["wal gate", {}],
	["mmap", { limit: 3 }],
	["gate", { domain: "proj" }],
	["wal", { originKind: "lesson" }],
	["zzz", {}],
];
const searchJson = (db: Database): string =>
	JSON.stringify(
		QUERIES.map(([query, filters]) => knowledgeSearch(db, query, filters)),
	);

describe("W166 knowledge.db split", () => {
	test("byte-identical search: v9 governor handle vs post-split store", () => {
		fixture();
		const pre = new Database(GOV); // raw v9 handle — knowledge still resident
		const before = searchJson(pre);
		pre.close();
		openGovernorDb().close(); // the migration run
		// explicit handles (NOT makeStore): the bare-govdb module cache binds
		// REG to whichever in-process suite loaded it first — this file must be
		// hermetic (knowledge.test.ts covers makeStore end-to-end via env-HOME
		// subprocesses).
		const store = new SqliteKnowledgeStore(openKnowledgeDb(), openGovernorDb());
		const after = searchJson((store as unknown as { db: Database }).db);
		expect(after).toBe(before);
	});

	test("v9→v10 postconditions: uv, schema moved, counts equal, FTS round-trip, pragmas", () => {
		// fixture state left by the byte-identity test's migration
		expect(uvOf(GOV)).toBe(10);
		expect(
			countK(
				GOV,
				"SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'knowledge%'",
			),
		).toBe(0);
		expect(countK(KBP, "SELECT COUNT(*) n FROM knowledge")).toBe(40);
		expect(countK(KBP, "SELECT COUNT(*) n FROM knowledge_queue")).toBe(4);
		expect(
			countK(
				KBP,
				"SELECT COUNT(*) n FROM knowledge_fts WHERE knowledge_fts MATCH 'wal'",
			),
		).toBe(40);
		expect(
			countK(
				KBP,
				"SELECT COUNT(*) n FROM knowledge_fts WHERE knowledge_fts MATCH 'm0'",
			),
		).toBe(10);
		const w = openKnowledgeDb();
		expect(w.query("PRAGMA page_size").get()).toEqual({ page_size: 8192 });
		expect(w.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
		expect(w.query("PRAGMA mmap_size").get()).toEqual({
			mmap_size: 1073741824,
		});
		w.close();
	});
});

describe("W166 migration resilience", () => {
	test("idempotent re-open: uv stays 10, no re-copy", () => {
		const before = countK(KBP, "SELECT COUNT(*) n FROM knowledge");
		openGovernorDb().close();
		openGovernorDb().close();
		expect(uvOf(GOV)).toBe(10);
		expect(countK(KBP, "SELECT COUNT(*) n FROM knowledge")).toBe(before);
	});

	test("reset-meets-kb: fresh governor + populated kb → kb wins, migration completes", () => {
		const before = countK(KBP, "SELECT COUNT(*) n FROM knowledge");
		rmSync(GOV); // the govdb-migration.test.ts isolation pattern
		openGovernorDb().close(); // fresh ladder → v10 with kbN > 0 → kb wins
		expect(uvOf(GOV)).toBe(10);
		expect(countK(KBP, "SELECT COUNT(*) n FROM knowledge")).toBe(before);
	});

	test("crash-safe retry: torn first attempt → rollback, rows safe in main, retry lands", () => {
		fixture(); // fresh v9 governor with rows
		const obs = new Database(KBP);
		obs.exec("CREATE TABLE knowledge (id INTEGER PRIMARY KEY, topic TEXT)"); // empty, incompatible — the copy fails mid-tx like a torn first attempt
		obs.close();
		expect(() => openGovernorDb()).toThrow(/rolled back/);
		expect(uvOf(GOV)).toBe(9);
		expect(countK(GOV, "SELECT COUNT(*) n FROM knowledge")).toBe(40);
		expect(countK(GOV, "SELECT COUNT(*) n FROM knowledge_queue")).toBe(4);
		rmSync(KBP); // obstacle gone → the next open retries and lands v10
		openGovernorDb().close();
		expect(uvOf(GOV)).toBe(10);
		expect(countK(KBP, "SELECT COUNT(*) n FROM knowledge")).toBe(40);
	});
});

describe("W166 split-brain refusal", () => {
	test("both files holding knowledge rows refuses loudly", () => {
		fixture(); // v9 governor with 40 rows
		const kb = new Database(KBP);
		kb.exec(KNOW_DDL);
		kb.exec(
			"INSERT INTO knowledge (id, ts, topic, fact) VALUES (500, 1, 'kb side', 'row in knowledge.db')",
		);
		kb.close();
		expect(() => openGovernorDb()).toThrow(/both hold knowledge rows/);
	});
});

describe("W166 store port binding", () => {
	test("makeStore binds knowledge.db — rows and queue land there, not in governor", async () => {
		fixture();
		openGovernorDb().close(); // migrate to v10
		// explicit handles — see the byte-identity test for why not makeStore()
		const store = new SqliteKnowledgeStore(openKnowledgeDb(), openGovernorDb());
		const id = await store.upsert({
			topic: "split binding",
			fact: "rows land in knowledge.db, events in governor.db",
			confidence: 0.9,
			domain: "proj",
			area: null,
			originKind: "fact",
			originSystem: null,
			sourceRef: null,
			sourceHash: null,
			originSid: "sx1",
			hubEligible: null,
			supersedesId: null,
		});
		expect(id).toBeGreaterThan(0);
		expect(countK(KBP, "SELECT COUNT(*) n FROM knowledge")).toBe(41);
		const q = new Database(KBP);
		q.run(
			"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, origin_sid) VALUES (?, 't', 'p', 'queued', 0, 'sx1')",
			[Date.now()],
		);
		q.close();
		expect(
			countK(
				KBP,
				"SELECT COUNT(*) n FROM knowledge_queue WHERE state='queued'",
			),
		).toBe(3); // 2 seeded + this one
	});

	test("bus events cross the split: complete() lands knowledge.landed in governor", async () => {
		const store = new SqliteKnowledgeStore(openKnowledgeDb(), openGovernorDb());
		const row = await store.claim(5); // queue ids continue from the seed
		if (!row) throw new Error("queue row 5 missing after split");
		await store.complete(row.id, { written: [], skipped: [] }, "proj", null);
		expect(
			countK(
				GOV,
				"SELECT COUNT(*) n FROM events WHERE kind = 'knowledge.landed'",
			),
		).toBe(1);
		await store.optimize(); // FTS merge runs clean on the split store
		const s = await store.settleHubEligible("sx1", 1);
		expect(s.queueMarked).toBe(1);
		expect(s.rowsBackfilled).toBe(1);
		const s2 = await store.settleHubEligible("sx1", 1);
		expect(s2.queueMarked).toBe(0);
		expect(s2.rowsBackfilled).toBe(0);
	});
});

describe("W166 control-plane rejection", () => {
	test("knowledgeSqlViolation: table refs rejected, word-in-string accepted", () => {
		for (const sql of [
			"SELECT * FROM knowledge",
			"INSERT INTO knowledge_queue (payload) VALUES ('x')",
			"UPDATE knowledge SET state = 'active' WHERE id = 1",
			"DELETE FROM knowledge_fts",
			"DROP TABLE knowledge",
		])
			expect(knowledgeSqlViolation(sql)).not.toBeNull();
		for (const sql of [
			"SELECT * FROM events WHERE kind LIKE 'knowledge.%'",
			"SELECT * FROM deltas WHERE tbl = 'knowledge'",
			"SELECT * FROM facts",
		])
			expect(knowledgeSqlViolation(sql)).toBeNull();
	});

	test("live /rpc: knowledge SQL rejected on the wire, control SQL flows", async () => {
		const port = 7856;
		const rpc = (sql: string): Promise<Record<string, unknown>> =>
			fetch(`http://127.0.0.1:${port}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-governor-token": "w166tok",
				},
				body: JSON.stringify({ mode: "get", sql, params: [] }),
			}).then((r) => r.json());
		const proc = Bun.spawn(
			["bun", "hooks/bin/store-server.ts", "--port", String(port)],
			{
				env: { ...process.env, HOME, GOVERNOR_STORE_TOKEN: "w166tok" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		try {
			let up = false;
			for (let i = 0; i < 40 && !up; i++) {
				up = await fetch(`http://127.0.0.1:${port}/health`)
					.then((r) => r.ok)
					.catch(() => false);
				if (!up) await Bun.sleep(100);
			}
			expect(up).toBe(true);
			const hit = (await rpc("SELECT * FROM knowledge")) as { err?: string };
			expect(hit.err ?? "").toContain("control-plane store");
		} finally {
			proc.kill();
		}
	});
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

describe("W166 backup round-trip", () => {
	test("db-backup checkpoints + copies knowledge.db; the copy restores and searches", () => {
		const dest = mkdtempSync(join(tmpdir(), "suspenders-split-backup-"));
		const r = Bun.spawnSync(
			["bun", "hooks/bin/db-backup.ts", "--home", HOME, "--dest", dest],
			{ cwd: join(import.meta.dir, "..") },
		);
		const out = `${r.stdout} ${r.stderr}`;
		const snap = readdirSync(dest).find((f) => /^knowledge-\d+\.db$/.test(f));
		expect(snap, `backup output: ${out}`).toBeDefined();
		expect(out).toContain("knowledge rows");
		expect(out).toContain("integrity ok");
		// restore: open the snapshot copy and search it
		const copy = new Database(join(dest, snap ?? ""), { readonly: true });
		const n = Number(
			(copy.query("SELECT COUNT(*) n FROM knowledge").get() as { n: number }).n,
		);
		const hits = Number(
			(
				copy
					.query(
						"SELECT COUNT(*) n FROM knowledge_fts WHERE knowledge_fts MATCH 'wal'",
					)
					.get() as { n: number }
			).n,
		);
		copy.close();
		expect(n, `backup out: ${out}`).toBe(41); // 40 seeded + the port test's upsert
		expect(hits).toBe(40); // every seeded row carries 'wal' — the upsert row does not
		rmSync(dest, { recursive: true, force: true });
	});
});
