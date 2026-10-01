// test/w159-settle.test.ts — W159 session-end knowledge settle: the
// provenance sort (hub → hub-eligible; private → local-only; mixed →
// most-restrictive), sticky domain recording, idempotent passes, the
// distill-time inheritance seam, and the session-end phase wiring (real
// entry, subprocess, temp HOME — the knowledge.test.ts isolation pattern).
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w159-"));
process.env.HOME = HOME;
// query bust: this file's own govdb instance, bound to the temp HOME
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?w159=${encodeURIComponent(HOME)}`
);
const { settleSessionWith, sessionDomain, recordSessionDomain } = await import(
	"../hooks/lib/settle.ts"
);

const DB = join(HOME, ".cache", "claude-governor", "governor.db");
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });

function freshDb(): Database {
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(DB + suffix, { force: true });
	return openGovernorDb();
}

function queueRow(sid: string, hubEligible: 0 | 1 | null = null): number {
	const db = openGovernorDb();
	const r = db
		.query(
			"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, origin_sid, hub_eligible) VALUES (?, 'test', 'payload text', 'queued', 0, ?, ?)",
		)
		.run(Date.now(), sid, hubEligible);
	return Number(r.lastInsertRowid);
}

function knowledgeRow(sid: string): void {
	const db = openGovernorDb();
	db.query(
		"INSERT INTO knowledge (ts, topic, fact, confidence, state, origin_sid) VALUES (?, 't', 'f', 0.5, 'candidate', ?)",
	).run(Date.now(), sid);
}

function flags(table: "knowledge_queue" | "knowledge", sid: string): number[] {
	const db = openGovernorDb();
	return (
		db
			.query(
				`SELECT hub_eligible FROM ${table} WHERE origin_sid = ? ORDER BY id`,
			)
			.all(sid) as { hub_eligible: number | null }[]
	).map((r) => r.hub_eligible ?? -1);
}

function seedSession(sid: string, domain?: "hub" | "private"): void {
	const db = openGovernorDb();
	db.query(
		"INSERT INTO sessions (sid, project, started_at, hb, state) VALUES (?, 'p', ?, ?, 'RUNNING')",
	).run(sid, Date.now(), Date.now());
	if (domain)
		db.query("UPDATE sessions SET data_domain = ? WHERE sid = ?").run(
			domain,
			sid,
		);
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("sessionDomain: unknown/anything-but-hub defaults private", () => {
	const db = freshDb();
	expect(sessionDomain(db, "no-such-sid")).toBe("private");
	seedSession("s-explicit", "hub");
	expect(sessionDomain(db, "s-explicit")).toBe("hub");
	seedSession("s-priv", "private");
	expect(sessionDomain(db, "s-priv")).toBe("private");
});

test("recordSessionDomain: sticky most-restrictive; hub+private=private", () => {
	const db = freshDb();
	seedSession("s-mix");
	expect(recordSessionDomain(db, "s-mix", "hub")).toEqual({
		recorded: true,
		domain: "hub",
	});
	expect(recordSessionDomain(db, "s-mix", "private")).toEqual({
		recorded: true,
		domain: "private",
	});
	seedSession("s-hubonly");
	recordSessionDomain(db, "s-hubonly", "hub");
	expect(recordSessionDomain(db, "s-hubonly", "hub")).toEqual({
		recorded: true,
		domain: "hub",
	});
	// unknown session: nothing to carry the label
	expect(recordSessionDomain(db, "ghost", "hub").recorded).toBe(false);
});

test("hub session settles hub-eligible; private settles local-only", () => {
	const db = freshDb();
	seedSession("s-hub2", "hub");
	queueRow("s-hub2");
	queueRow("s-hub2");
	knowledgeRow("s-hub2");
	const r = settleSessionWith(db, "s-hub2");
	expect(r.domain).toBe("hub");
	expect(r.queueMarked).toBe(2);
	expect(r.rowsBackfilled).toBe(1);
	expect(flags("knowledge_queue", "s-hub2")).toEqual([1, 1]);
	expect(flags("knowledge", "s-hub2")).toEqual([1]);

	seedSession("s-p2");
	queueRow("s-p2");
	knowledgeRow("s-p2");
	const rp = settleSessionWith(db, "s-p2");
	expect(rp.domain).toBe("private");
	expect(rp.queueMarked).toBe(1);
	expect(flags("knowledge_queue", "s-p2")).toEqual([0]);
	expect(flags("knowledge", "s-p2")).toEqual([0]);
});

test("mixed session (hub then private) takes most-restrictive: private", () => {
	const db = freshDb();
	seedSession("s-mixed");
	recordSessionDomain(db, "s-mixed", "hub");
	recordSessionDomain(db, "s-mixed", "private");
	queueRow("s-mixed");
	knowledgeRow("s-mixed");
	const r = settleSessionWith(db, "s-mixed");
	expect(r.domain).toBe("private");
	expect(flags("knowledge_queue", "s-mixed")).toEqual([0]);
	expect(flags("knowledge", "s-mixed")).toEqual([0]);
});

test("settle is idempotent and never re-flips settled rows", () => {
	const db = freshDb();
	seedSession("s-idem", "hub");
	queueRow("s-idem");
	knowledgeRow("s-idem");
	expect(settleSessionWith(db, "s-idem").queueMarked).toBe(1);
	// even if the session domain changes later, settled rows keep their flag
	db.query("UPDATE sessions SET data_domain = 'private' WHERE sid = ?").run(
		"s-idem",
	);
	const r2 = settleSessionWith(db, "s-idem");
	expect(r2.queueMarked).toBe(0);
	expect(r2.rowsBackfilled).toBe(0);
	expect(flags("knowledge_queue", "s-idem")).toEqual([1]);
});

test("emits a knowledge.settled event for observability", () => {
	const db = freshDb();
	seedSession("s-evt", "hub");
	queueRow("s-evt");
	settleSessionWith(db, "s-evt");
	const evt = db
		.query(
			"SELECT payload FROM events WHERE kind = 'knowledge.settled' ORDER BY id DESC LIMIT 1",
		)
		.get() as { payload: string } | null;
	expect(evt).not.toBeNull();
	const payload = JSON.parse(evt?.payload ?? "{}") as {
		sid: string;
		domain: string;
		queueMarked: number;
	};
	expect(payload.sid).toBe("s-evt");
	expect(payload.domain).toBe("hub");
	expect(payload.queueMarked).toBe(1);
});

test("distill-time inheritance: claim surfaces hub_eligible, upsert stamps it", async () => {
	const db = freshDb();
	const { SqliteKnowledgeStore } = await import(
		`../hooks/lib/knowledge-ports.ts?w159=${encodeURIComponent(HOME)}`
	);
	const store = new SqliteKnowledgeStore(db);
	const settled = queueRow("s-inh", 1);
	const unsettled = queueRow("s-inh", null);
	const jobSettled = await store.claim(settled);
	expect(jobSettled?.hubEligible).toBe(1);
	const id = await store.upsert({
		topic: "t",
		fact: "f",
		confidence: 0.5,
		domain: null,
		area: null,
		originKind: null,
		originSystem: null,
		sourceRef: null,
		sourceHash: null,
		originSid: "s-inh",
		hubEligible: jobSettled?.hubEligible ?? null,
		supersedesId: null,
	});
	const row = db
		.query("SELECT hub_eligible FROM knowledge WHERE id = ?")
		.get(id) as { hub_eligible: number | null };
	expect(row.hub_eligible).toBe(1);
	const jobUnsettled = await store.claim(unsettled);
	expect(jobUnsettled?.hubEligible).toBeNull();
});

test("session-end phase: real entry, subprocess, settle ran + CLOSED", async () => {
	const db = freshDb();
	seedSession("s-proc", "hub");
	queueRow("s-proc");
	const proc = Bun.spawn(["bun", "hooks/session-end.ts"], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(JSON.stringify({ session_id: "s-proc" }));
	await proc.stdin.end();
	const exit = await proc.exited;
	expect(exit).toBe(0);
	const row = db
		.query("SELECT state, data_domain FROM sessions WHERE sid = ?")
		.get("s-proc") as { state: string; data_domain: string };
	expect(row.state).toBe("CLOSED");
	expect(row.data_domain).toBe("hub");
	// the settle stamped the session's queue row hub-eligible
	expect(flags("knowledge_queue", "s-proc")).toEqual([1]);
});
