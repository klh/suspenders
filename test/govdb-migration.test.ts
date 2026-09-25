// govdb-migration.test.ts — finding 6 guard: legacy (single-PK, pre-partition)
// work tables holding rows must NEVER be dropped by the schema migration —
// they are renamed to <name>_legacy_<ts> so rows survive verbatim. Empty
// legacy tables may be recreated in the current shape; current-shape tables
// pass through untouched.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-mig-"));
process.env.HOME = HOME; // govdb computes REG from HOME at module load — set before the dynamic import
const { openGovernorDb } = await import("../hooks/lib/govdb.ts");

const DB = `${HOME}/.cache/claude-governor/governor.db`;

// pre-partition shapes, as an older install would have created them
const LEGACY_ITEMS =
	"CREATE TABLE work_items (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'READY', owner_sid TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)";
const LEGACY_DEPS =
	"CREATE TABLE work_deps (work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (work_id, depends_on), FOREIGN KEY (work_id) REFERENCES work_items(id))";

// REG is bound to the import-time HOME, so scenario isolation = delete the db files
function freshDb(): Database {
	mkdirSync(dirname(DB), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
	return new Database(DB, { create: true });
}

function shapes(): { items?: string; deps?: string; backups: string[] } {
	const db = new Database(DB);
	const rows = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as { name: string; sql: string }[];
	db.close();
	return {
		items: rows.find((r) => r.name === "work_items")?.sql,
		deps: rows.find((r) => r.name === "work_deps")?.sql,
		backups: rows.filter((r) => /_legacy_\d+/.test(r.name)).map((r) => r.name),
	};
}

function rowCount(table: string): number {
	const db = new Database(DB);
	const r = db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
	db.close();
	return r.n;
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

describe("govdb work-graph migration guard", () => {
	test("legacy tables with rows are backed up, never dropped", () => {
		const db = freshDb();
		db.run(LEGACY_ITEMS);
		db.run(LEGACY_DEPS);
		db.run("INSERT INTO work_items (id, title, created_at, updated_at) VALUES ('W1', 'legacy row one', 1, 1)");
		db.run("INSERT INTO work_items (id, title, created_at, updated_at) VALUES ('W2', 'only W2', 2, 2)");
		db.run("INSERT INTO work_deps (work_id, depends_on) VALUES ('W1', 'W2')");
		db.close();

		expect(() => openGovernorDb()).not.toThrow();
		const s = shapes();
		expect(s.items).toContain("PRIMARY KEY (project, id)"); // current shape recreated
		expect(s.deps).toContain("PRIMARY KEY (project, work_id, depends_on)");
		expect(s.backups.sort()).toEqual([expect.any(String), expect.any(String)].map(() => expect.stringMatching(/_legacy_\d+$/)));
		expect(s.backups.some((b) => b.startsWith("work_items_legacy_"))).toBe(true);
		expect(s.backups.some((b) => b.startsWith("work_deps_legacy_"))).toBe(true);

		const backup = s.backups.find((b) => b.startsWith("work_items_legacy_")) as string;
		expect(rowCount(backup)).toBe(2);
		const r = new Database(DB);
		const titles = r.query(`SELECT title FROM "${backup}"`).all() as { title: string }[];
		r.close();
		expect(titles.map((t) => t.title).sort()).toEqual(["legacy row one", "only W2"]);
	});

	test("empty legacy tables are recreated without a backup", () => {
		const db = freshDb();
		db.run(LEGACY_ITEMS);
		db.run(LEGACY_DEPS);
		db.close();

		openGovernorDb();
		const s = shapes();
		expect(s.items).toContain("PRIMARY KEY (project, id)");
		expect(s.deps).toContain("PRIMARY KEY (project, work_id, depends_on)");
		expect(s.backups).toEqual([]);
		expect(rowCount("work_items")).toBe(0);
	});

	test("current-shape tables with rows pass through untouched", () => {
		const db = freshDb();
		db.close();
		openGovernorDb(); // creates current shape
		const w = new Database(DB);
		w.run("INSERT INTO work_items (project, id, title, created_at, updated_at) VALUES ('/repo', 'W1', 'live row', 1, 1)");
		w.close();

		openGovernorDb(); // second open: migration must be a no-op
		const s = shapes();
		expect(s.backups).toEqual([]);
		expect(rowCount("work_items")).toBe(1);
	});
});
