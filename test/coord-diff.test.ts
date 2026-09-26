// coord-diff.test.ts — W33: the row-image delta log (govdb v5 triggers) and
// the `coord diff` read model, against a temp HOME created under the repo
// (never /tmp). All DB access and CLI runs happen in bun subprocesses so the
// parent test process never opens the real governor.db (metrics.test.ts
// recipe), and every open of the temp DB re-runs the migration idempotently.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(process.cwd(), ".coord-diff-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const runIn = (code: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

const runCli = (args: string[]): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(["bun", COORD, ...args], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
};

// read rows via a subprocess import — never open the real governor.db here
const sql = <T>(statement: string): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all()));
`),
	);

// one subprocess seeds a full change story; timing is real-clock so the
// event → delta ordering that --since e<N> relies on actually holds
const seed = JSON.parse(
	runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const w = (q: string, ...p: unknown[]) => db.query(q).run(...p);
const now = Date.now();
w("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('diff-lane-1', '/repo', 'worker', " + now + ", " + now + ", 'RUNNING')");
w("UPDATE sessions SET hb = " + (now + 4320000) + " WHERE sid = 'diff-lane-1'");
w("INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('diff-lane-1', 'src/x', 'w33', 0, " + now + ")");
w("DELETE FROM claims WHERE sid = 'diff-lane-1' AND scope = 'src/x'");
w("INSERT OR REPLACE INTO locks (path, sid, tool, ts) VALUES ('/repo/src/x/a.ts', 'diff-lane-1', 'Edit', " + now + ")");
w("UPDATE locks SET ts = " + (now + 1000) + " WHERE path = '/repo/src/x/a.ts'");
w("INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.diff-lane-1.state', 'RUNNING', 'test', 1, " + now + ")");
w("INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.diff-lane-1.state', 'PAUSED', 'test', 1, " + now + ") ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, ts = excluded.ts");
w("INSERT INTO work_items (project, id, title, state, created_at, updated_at) VALUES ('/repo', 'W90', 'seed item', 'READY', " + now + ", " + now + ")");
w("UPDATE work_items SET state = 'DONE', result_sha = 'abc1234' WHERE project = '/repo' AND id = 'W90'");
w("INSERT INTO events (ts, source, kind, payload) VALUES (" + Date.now() + ", 'test', 'decision', '{}')");
const eventId = db.query("SELECT last_insert_rowid() AS id").get().id;
await Bun.sleep(3); // real-clock gap: post-event deltas must sort after the event
w("UPDATE sessions SET hb = " + (now + 8640000) + " WHERE sid = 'diff-lane-1'");
w("INSERT INTO facts (key, value, ts) VALUES ('diff.after.event', 'yes', " + now + ")");
console.log(JSON.stringify({ now, eventId }));
db.close();
`),
);

const midSeq = JSON.parse(
	runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
console.log(JSON.stringify(db.query("SELECT seq FROM deltas WHERE tbl = 'claims' AND op = 'insert'").get()));
db.close();
`),
).seq as number;

describe("v5 migration — deltas table + row-image triggers", () => {
	test("user_version 5, deltas table, 15 triggers, bus tables untracked", () => {
		expect((sql<{ user_version: number }>("SELECT * FROM pragma_user_version")[0] as { user_version: number }).user_version).toBe(5);
		expect((sql<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_%'")[0] as { n: number }).n).toBe(15);
		expect(sql("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_events_%'")).toEqual([]);
		expect(sql("SELECT 1 FROM deltas WHERE tbl IN ('events', 'cursors')")).toEqual([]);
	});

	test("sessions: insert and hb update carry full row images", () => {
		const rows = sql<{ op: string; pk: string; before: string | null; after: string }>(
			"SELECT op, pk, before, after FROM deltas WHERE tbl = 'sessions' ORDER BY seq",
		);
		const ins = rows[0];
		expect(ins.op).toBe("insert");
		expect(ins.pk).toBe("diff-lane-1");
		expect(ins.before).toBeNull();
		expect(JSON.parse(ins.after).state).toBe("RUNNING");
		const upd = rows.find((r) => r.op === "update");
		expect(JSON.parse(upd?.after ?? "{}").hb).toBe(seed.now + 4_320_000);
		expect(JSON.parse(upd?.before ?? "{}").hb).toBe(seed.now);
	});

	test("claims: insert + release (delete) with images and composite pk", () => {
		const rows = sql<{ op: string; pk: string; before: string | null; after: string | null }>(
			"SELECT op, pk, before, after FROM deltas WHERE tbl = 'claims' ORDER BY seq",
		);
		expect(rows.map((r) => r.op)).toEqual(["insert", "delete"]);
		expect(rows[0].pk).toBe("diff-lane-1/src/x");
		expect(JSON.parse(rows[0].after ?? "{}").intent).toBe("w33");
		expect(JSON.parse(rows[1].before ?? "{}").intent).toBe("w33");
		expect(rows[1].after).toBeNull();
	});

	test("locks: insert and renew are op-only (before/after NULL), pk = path", () => {
		const rows = sql<{ op: string; before: string | null; after: string | null }>(
			"SELECT op, before, after FROM deltas WHERE tbl = 'locks'",
		);
		expect(rows.length).toBe(2);
		for (const r of rows) {
			expect(r.before).toBeNull();
			expect(r.after).toBeNull();
		}
	});

	test("facts: insert v1 then upsert bumps version in the after image", () => {
		const rows = sql<{ op: string; after: string | null }>("SELECT op, after FROM deltas WHERE tbl = 'facts' AND pk = 'lane.diff-lane-1.state' ORDER BY seq");
		expect(rows.map((r) => r.op)).toEqual(["insert", "update"]);
		expect(JSON.parse(rows[1]?.after ?? "{}").value).toBe("PAUSED");
	});

	test("work_items: insert + done transition, project-scoped pk", () => {
		const rows = sql<{ op: string; pk: string; after: string | null }>(
			"SELECT op, pk, after FROM deltas WHERE tbl = 'work_items' ORDER BY seq",
		);
		expect(rows.map((r) => r.op)).toEqual(["insert", "update"]);
		expect(rows[0].pk).toBe("/repo/W90");
		expect(JSON.parse(rows[1]?.after ?? "{}").state).toBe("DONE");
		expect(JSON.parse(rows[1]?.after ?? "{}").result_sha).toBe("abc1234");
	});
});

describe("coord diff — the row-image read model", () => {
	test("JSON mode parses and reports every logged change", () => {
		const p = runCli(["diff", "--json"]);
		expect(p.code).toBe(0);
		const j = JSON.parse(p.out) as { total: number; tables: number; shown: number; changes: { seq: number; tbl: string; op: string; pk: string; before: unknown; after: unknown }[] };
		const dbTotal = (sql<{ n: number }>("SELECT COUNT(*) AS n FROM deltas")[0] as { n: number }).n;
		expect(j.total).toBe(dbTotal);
		expect(j.tables).toBe(
			(sql<{ t: number }>("SELECT COUNT(DISTINCT tbl) AS t FROM deltas")[0] as { t: number }).t,
		);
		expect(j.changes).toContainEqual(expect.objectContaining({ tbl: "sessions", op: "insert", pk: "diff-lane-1" }));
		expect(j.changes).toContainEqual(expect.objectContaining({ tbl: "facts", op: "update", pk: "lane.diff-lane-1.state" }));
		const lockRow = j.changes.find((c) => c.tbl === "locks");
		expect(lockRow?.before).toBeNull();
		expect(lockRow?.after).toBeNull();
		const sess = j.changes.find((c) => c.tbl === "sessions" && c.op === "insert");
		expect(sess?.after).toHaveProperty("state", "RUNNING");
	});

	test("text mode: terse per-table lines plus a summary line", () => {
		const p = runCli(["diff", "--last", "3"]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("diff-lan…");
		expect(p.out).toMatch(/sessions\s+diff-lan… ~ hb \d\d:\d\d→\d\d:\d\d/);
		expect(p.out).toMatch(/work_items\s+\S+ ~ state READY→DONE/);
		expect(p.out).toContain("shown");
		expect(p.out).toContain("changes across");
	});

	test("--since <seq>: only changes strictly after that point", () => {
		const p = runCli(["diff", "--json", "--since", String(midSeq)]);
		expect(p.code).toBe(0);
		const j = JSON.parse(p.out) as { total: number; changes: { seq: number; tbl: string; op: string }[] };
		expect(j.total).toBe((sql<{ n: number }>(`SELECT COUNT(*) AS n FROM deltas WHERE seq > ${midSeq}`)[0] as { n: number }).n);
		expect(j.changes.every((c) => c.seq > midSeq)).toBe(true);
		expect(j.changes.some((c) => c.tbl === "claims" && c.op === "insert")).toBe(false);
	});

	test("--since e<event-id>: resolves to the nearest strictly-later seq", () => {
		const evTs = (sql<{ ts: number }>(`SELECT ts FROM events WHERE id = ${seed.eventId}`)[0] as { ts: number }).ts;
		const resolved = (sql<{ m: number }>(`SELECT MIN(seq) AS m FROM deltas WHERE ts > ${evTs}`)[0] as { m: number }).m;
		const p = runCli(["diff", "--json", "--since", `e${seed.eventId}`]);
		expect(p.code).toBe(0);
		const j = JSON.parse(p.out) as { total: number; since: string; changes: { seq: number; ts: number; pk: string }[] };
		expect(j.since).toBe(`event #${seed.eventId}`);
		expect(j.total).toBe((sql<{ n: number }>(`SELECT COUNT(*) AS n FROM deltas WHERE seq >= ${resolved}`)[0] as { n: number }).n);
		expect(j.changes.length).toBeGreaterThan(0);
		expect(j.changes.every((c) => c.ts > evTs)).toBe(true);
		expect(j.changes.some((c) => c.pk === "diff.after.event")).toBe(true);
		expect(j.changes.some((c) => c.pk === "diff-lane-1" && (c as unknown as { op: string }).op === "insert")).toBe(false);
	});

	test("--last caps the tail, --table filters to one table", () => {
		const p3 = runCli(["diff", "--json", "--last", "3"]);
		const j3 = JSON.parse(p3.out) as { total: number; shown: number; changes: { seq: number }[] };
		const seqs = sql<{ seq: number }>("SELECT seq FROM deltas ORDER BY seq DESC LIMIT 3").map((r) => (r as { seq: number }).seq);
		expect(j3.shown).toBe(3);
		expect(j3.total).toBeGreaterThan(3);
		expect(j3.changes.map((c) => c.seq)).toEqual(seqs.sort((a, b) => a - b));
		const pL = runCli(["diff", "--json", "--table", "locks"]);
		const jL = JSON.parse(pL.out) as { total: number; tables: number; changes: { tbl: string }[] };
		expect(jL.total).toBe(2);
		expect(jL.tables).toBe(1);
		expect(jL.changes.every((c) => c.tbl === "locks")).toBe(true);
	});

	test("bad --since and unknown event ids die cleanly", () => {
		const bad = runCli(["diff", "--since", "zz"]);
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("bad --since");
		const noEv = runCli(["diff", "--since", "e99999"]);
		expect(noEv.code).toBe(2);
		expect(noEv.err).toContain("no event #99999");
	});
});

describe("gc — delta retention via pruneDeltas", () => {
	test("gc --days 30 prunes old deltas, keeps fresh ones, exits clean", () => {
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
db.query("UPDATE deltas SET ts = " + (Date.now() - 40 * 86400000) + " WHERE seq = (SELECT MIN(seq) FROM deltas)").run();
db.close();`);
		const before = (sql<{ n: number }>("SELECT COUNT(*) AS n FROM deltas")[0] as { n: number }).n;
		const p = runCli(["gc", "--days", "30"]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("deltas");
		const after = (sql<{ n: number }>("SELECT COUNT(*) AS n FROM deltas")[0] as { n: number }).n;
		expect(after).toBe(before - 1);
	});
});

describe("self-heal — dropped deltas artifacts are recreated on open", () => {
	test("diff survives a dropped deltas table + triggers", () => {
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
for (const t of db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_%'").all() as { name: string }[])
	db.query("DROP TRIGGER " + t.name).run();
db.query("DROP TABLE deltas").run();
db.close();`);
		const p = runCli(["diff"]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("0 changes across 0 tables");
	});
});
