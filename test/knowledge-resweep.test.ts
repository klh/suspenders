// knowledge-resweep.test.ts — W117: mechanical pointer re-sweep against a
// TEMP COPY DB (never the live hub). Covers: pointer-ize of empty-source_ref
// rows (the W112-style 22), already-referenced rows untouched, retired rows
// untouched, absent files stay untouched, and the row→docs-root mapping arms
// (origin_sid / contributors / domain-basename / root-map override) plus the
// CLI face (dry-run default, guarded --write).
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildRootIndex,
	candidateRoots,
	sweep,
	type ResweepRow,
} from "../hooks/bin/knowledge-resweep.ts";
import { createHash } from "node:crypto";

const WORK = mkdtempSync(join(tmpdir(), "suspenders-resweep-"));
// repo dir basename MUST equal the domain ("proj") — the domain arm matches
// sessions.project basenames exactly (live evidence: gaps, hojtaler, …)
const REPO_DIR = join(WORK, "proj");
mkdirSync(REPO_DIR, { recursive: true });
const REPO = realpathSync(REPO_DIR);
mkdirSync(join(REPO, "docs", "deep"), { recursive: true });
const PLAN_TEXT = "Resweep fixture: the plan doc content qz7f.";
const ARCH_TEXT = "Resweep fixture: deep architecture doc bx2k.";
writeFileSync(join(REPO, "docs", "plan.md"), PLAN_TEXT);
writeFileSync(join(REPO, "docs", "deep", "arch.md"), ARCH_TEXT);

// a second repo (same domain basename) that must NOT win over the first
const OTHER = realpathSync(mkdtempSync(join(WORK, "other-proj-")));
mkdirSync(join(OTHER, ".git"), { recursive: true });
mkdirSync(join(OTHER, "docs"), { recursive: true });
writeFileSync(
	join(OTHER, "docs", "plan.md"),
	"WRONG repo content — must never be referenced.",
);

const DB_PATH = join(WORK, "governor.db");
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

const KNOWLEDGE_DDL =
	"CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT)";
const SESSIONS_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING', capabilities TEXT, transcript_path TEXT)";

function freshDb(): Database {
	if (openDb) openDb.close();
	const db = new Database(DB_PATH, { create: true });
	openDb = db;
	db.exec("DROP TABLE IF EXISTS knowledge");
	db.exec("DROP TABLE IF EXISTS sessions");
	db.exec(KNOWLEDGE_DDL);
	db.exec(SESSIONS_DDL);
	const now = Date.now();
	const sess = db.query(
		"INSERT INTO sessions (sid, project, started_at, hb) VALUES (?, ?, ?, ?)",
	);
	sess.run("s1", `${REPO}/.git`, now, now);
	sess.run("s2", `${OTHER}/.git`, now, now);
	sess.run("s3", "/nonexistent/stale/.git", now, now); // stale — dropped
	const ins = db.query(
		"INSERT INTO knowledge (ts, topic, fact, domain, origin_sid, contributors, state, source_ref, source_hash) VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?)",
	);
	// the W112-style row: empty source_ref, fact names an existing doc
	ins.run(
		now,
		"plannable sid row",
		"Per docs/plan.md the gate is gated.",
		"proj",
		"s1",
		null,
		null,
		null,
	);
	// domain-only row: no sid, resolved via the domain-basename arm
	ins.run(
		now,
		"plannable domain row",
		"Spec lives in docs/deep/arch.md.",
		"proj",
		null,
		null,
		null,
		null,
	);
	// contributors-only row: sid arrives via contributors JSON
	ins.run(
		now,
		"plannable contributors row",
		"See docs/plan.md for details.",
		"proj",
		null,
		'[{"sid":"s1","ts":1,"what":"origin"}]',
		null,
		null,
	);
	// already referenced — never overwritten
	ins.run(
		now,
		"already referenced",
		"See docs/plan.md again.",
		"proj",
		"s1",
		null,
		"docs/keep.md",
		"keephash",
	);
	// absent file — must stay untouched
	ins.run(
		now,
		"absent target",
		"Read docs/absent.md first.",
		"proj",
		"s1",
		null,
		null,
		null,
	);
	// retired — must stay untouched even with an empty ref + real path
	ins.run(
		now,
		"retired bait",
		"Retired but names docs/plan.md.",
		"proj",
		"s1",
		null,
		null,
		null,
	);
	db.query(
		"UPDATE knowledge SET state = 'retired' WHERE topic = 'retired bait'",
	).run();
	return db;
}

let openDb: Database | null = null;

const rowByTopic = (db: Database, topic: string): ResweepRow =>
	db.query("SELECT * FROM knowledge WHERE topic = ?").get(topic) as ResweepRow;

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

describe("W117 knowledge-resweep", () => {
	test("root index: strips .git, drops stale, root-map first in arm order", () => {
		const rm = new Map([["proj", [OTHER]]]);
		const idx = buildRootIndex(
			[
				{ sid: "s1", project: `${REPO}/.git` },
				{ sid: "s2", project: `${OTHER}/.git` },
				{ sid: "s3", project: "/nonexistent/stale/.git" },
			],
			rm,
		);
		expect(idx.bySid.get("s1")).toEqual([REPO]);
		expect(idx.bySid.get("s3")).toBeUndefined(); // stale dropped
		const row: ResweepRow = {
			id: 1,
			topic: "t",
			fact: "x",
			domain: "proj",
			origin_sid: "s1",
			contributors: null,
			state: "candidate",
			source_ref: null,
			source_hash: null,
		};
		expect(candidateRoots(row, idx)).toEqual([OTHER, REPO]); // override first
	});

	test("dry-run plans the empty-ref rows; retired and referenced stay out", () => {
		const db = freshDb();
		const rep = sweep(db, { write: false });
		expect(rep.total).toBe(6);
		expect(rep.retired).toBe(1);
		expect(rep.alreadyReferenced).toBe(1);
		expect(rep.scanned).toBe(4);
		expect(rep.noPaths).toBe(0);
		expect(rep.planned).toHaveLength(3);
		expect(rep.unresolved).toHaveLength(1);
		// nothing written
		expect(
			db
				.query("SELECT COUNT(*) c FROM knowledge WHERE source_ref IS NOT NULL")
				.get(),
		).toMatchObject({ c: 1 });
		// mapping arms: sid, domain-basename, contributors — refs hash the file
		const refs = new Map(rep.planned.map((p) => [p.id, p] as const));
		const sidRow = rowByTopic(db, "plannable sid row");
		const domRow = rowByTopic(db, "plannable domain row");
		const conRow = rowByTopic(db, "plannable contributors row");
		expect(refs.get(sidRow.id)).toMatchObject({
			ref: "docs/plan.md",
			via: "origin_sid",
			root: REPO,
		});
		expect(refs.get(domRow.id)).toMatchObject({
			ref: "docs/deep/arch.md",
			via: "domain",
			root: REPO,
		});
		expect(refs.get(conRow.id)).toMatchObject({
			ref: "docs/plan.md",
			via: "contributors",
			root: REPO,
		});
		expect(refs.get(sidRow.id)?.hash).toBe(sha(PLAN_TEXT));
		expect(refs.get(domRow.id)?.hash).toBe(sha(ARCH_TEXT));
	});

	test("absent file stays unresolved — no root invents it", () => {
		const db = freshDb();
		const rep = sweep(db, { write: false });
		const absent = rowByTopic(db, "absent target");
		expect(rep.unresolved.map((u) => u.id)).toContain(absent.id);
	});

	test("--write applies only planned rows; invariants re-checked in SQL", () => {
		const db = freshDb();
		const rep = sweep(db, { write: true });
		expect(rep.changes).toBe(3);
		expect(db2Count().referenced).toBe(4);
		// untouched: already-referenced, absent, retired
		const keep = rowByTopic(db, "already referenced");
		expect(keep.source_ref).toBe("docs/keep.md");
		expect(keep.source_hash).toBe("keephash");
		const absent = rowByTopic(db, "absent target");
		expect(absent.source_ref).toBeNull();
		const bait = rowByTopic(db, "retired bait");
		expect(bait.source_ref).toBeNull();
		// a planned row's stored hash matches the file content
		const sidRow = rowByTopic(db, "plannable sid row");
		expect(sidRow.source_ref).toBe("docs/plan.md");
		expect(sidRow.source_hash).toBe(sha(PLAN_TEXT));
		// guarded UPDATE refuses a second pass (refs now non-empty)
		const again = sweep(db, { write: true });
		expect(again.changes).toBe(0);
		expect(again.alreadyReferenced).toBe(4);
	});
});

test("CLI: dry-run is the default and mutates nothing; --write applies", () => {
	const db = freshDb();
	db.close();
	const script = resolve(
		import.meta.dir,
		"..",
		"hooks",
		"bin",
		"knowledge-resweep.ts",
	);
	const args = ["bun", script, "--db", DB_PATH];
	const dry = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" });
	expect(dry.exitCode).toBe(0);
	expect(dry.stdout.toString()).toContain("planned pointer rows: 3");
	expect(db2Count()).toMatchObject({ referenced: 1 });
	const wr = Bun.spawnSync([...args, "--write"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(wr.exitCode).toBe(0);
	expect(wr.stdout.toString()).toContain("applied: 3");
	expect(db2Count().referenced).toBe(4);
});

function db2Count(): { referenced: number } {
	const d = new Database(DB_PATH, { readonly: true });
	const r = d
		.query(
			"SELECT COUNT(*) AS referenced FROM knowledge WHERE source_ref IS NOT NULL",
		)
		.get() as { referenced: number };
	d.close();
	return r;
}
