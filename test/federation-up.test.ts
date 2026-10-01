// test/federation-up.test.ts — W170 spoke up-feed: the domain-law filter
// (work metadata always; route_audit only hub-entitled), ack-gated cursor
// (never advances on hub-down), and the push cycle against a stub hub.
// Temp-HOME isolation (the w159 pattern) + last-known entitlement seeding.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w170-up-"));
process.env.HOME = HOME;
// query bust: this file's own govdb instance, bound to the temp HOME
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?w170up=${encodeURIComponent(HOME)}`
);
const {
	loadUpCursor,
	readWorkDeltas,
	saveUpCursor,
	targetModel,
	pushWorkDeltas,
} = await import("../hooks/lib/federation-up.ts");
const { lastKnownPath } = await import("../hooks/lib/federation.ts");
const { atomicWrite: putFile } = await import("../hooks/lib/board-config.ts");

const DB = join(HOME, ".cache", "claude-governor", "governor.db");

function freshDb(): Database {
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(DB + suffix, { force: true });
	return openGovernorDb();
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

function seedEntitlements(env: { BUCKLE_SECRETS_HOME: string }): void {
	putFile(
		lastKnownPath(env),
		JSON.stringify({
			pulled_at: "2026-10-01T00:00:00Z",
			hub_url: "http://hub.test",
			manifest: { version: "t", rules: [], cr_queue: [] },
			entitlements: { models: [{ id: "glm-5.3-flash" }] },
		}),
	);
}

/** Make real deltas rows: a live graph INSERT fires the v5 triggers. */
function seedWork(db: Database, project: string, id: string): void {
	db.query(
		"INSERT INTO work_items (project, id, title, state, created_at, updated_at) VALUES (?, ?, ?, 'READY', ?, ?)",
	).run(project, id, `title ${id}`, Date.now(), Date.now());
}

function seedRoute(db: Database, rid: string, target: string): void {
	db.query(
		"INSERT INTO route_audit (rid, ts, decision, resolved_target) VALUES (?, ?, 'routed', ?)",
	).run(rid, Date.now(), target);
}

test("targetModel: model id = tail after last slash; none → empty", () => {
	expect(targetModel("http://hub:17001/glm-5.3-flash")).toBe("glm-5.3-flash");
	expect(targetModel("local:127.0.0.1:8787/llama")).toBe("llama");
	expect(targetModel("no-slash")).toBe("");
	expect(targetModel(null)).toBe("");
});

test("readWorkDeltas: work metadata passes; local route_audit filtered out", () => {
	const db = freshDb();
	seedWork(db, "p1", "W1");
	seedRoute(db, "r1", "http://hub:17001/glm-5.3-flash");
	seedRoute(db, "r2", "local:127.0.0.1:8787/llama-local");
	const rows = readWorkDeltas(db, 0, 500, new Set(["glm-5.3-flash"]));
	expect(rows.map((r) => r.tbl).sort()).toEqual(["route_audit", "work_items"]);
	const ra = rows.find((r) => r.tbl === "route_audit");
	expect(String(ra?.pk)).toBe("r1");
});

test("readWorkDeltas: empty hub set → no route_audit (restrictive default)", () => {
	const db = freshDb();
	seedWork(db, "p1", "W1");
	seedRoute(db, "r1", "http://hub:17001/glm-5.3-flash");
	const rows = readWorkDeltas(db, 0, 500, new Set<string>());
	expect(rows.map((r) => r.tbl)).toEqual(["work_items"]);
});

test("readWorkDeltas: private tables never ride the feed (facts/locks/aid)", () => {
	const db = freshDb();
	db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES ('k', 'v', 'test', ?)",
	).run(Date.now());
	db.query(
		"INSERT INTO aid_events (ts, aid, tokens_injected) VALUES (?, 'a', 1)",
	).run(Date.now());
	seedWork(db, "p1", "W1");
	const rows = readWorkDeltas(db, 0, 500, new Set<string>(["glm-5.3-flash"]));
	expect(rows.map((r) => r.tbl)).toEqual(["work_items"]);
});

test("cursor: durable and never rewinds", () => {
	const env = { BUCKLE_SECRETS_HOME: join(HOME, "cur"), HOME };
	expect(loadUpCursor(env)).toBe(0);
	saveUpCursor(env, 41);
	expect(loadUpCursor(env)).toBe(41);
});

/** Stub hub: echoes ack with through_seq = max seq pushed. */
function stubHub(): string {
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const body = (await req.json()) as { rows?: Array<{ seq: number }> };
			const seqs = (body.rows ?? []).map((r) => r.seq);
			return Response.json({
				applied: seqs.length,
				through_seq: seqs.length > 0 ? Math.max(...seqs) : 0,
			});
		},
	});
	return `http://127.0.0.1:${String(server.port)}`;
}

test("pushWorkDeltas: ack advances cursor; next cycle pushes nothing", async () => {
	const env = { BUCKLE_SECRETS_HOME: join(HOME, "push"), HOME };
	seedEntitlements(env);
	const db = freshDb();
	seedWork(db, "p1", "W1");
	seedRoute(db, "r1", "http://hub:17001/glm-5.3-flash");
	const url = stubHub();
	const out = await pushWorkDeltas({
		env,
		db,
		hubUrl: url,
		spokeId: "spoke-t",
	});
	expect(out.ok).toBe(true);
	expect(out.pushed).toBe(2);
	expect(out.throughSeq).toBeGreaterThan(0);
	const again = await pushWorkDeltas({
		env,
		db,
		hubUrl: url,
		spokeId: "spoke-t",
	});
	expect(again.pushed).toBe(0);
});

test("pushWorkDeltas: hub-down → degraded, cursor kept (backlog = queue)", async () => {
	const env = { BUCKLE_SECRETS_HOME: join(HOME, "down"), HOME };
	seedEntitlements(env);
	const db = freshDb();
	seedWork(db, "p2", "W2");
	const out = await pushWorkDeltas({
		env,
		db,
		hubUrl: "http://127.0.0.1:1",
		timeoutMs: 800,
		spokeId: "spoke-t",
	});
	expect(out.ok).toBe(false);
	expect(out.degraded).toBe(true);
	expect(loadUpCursor(env)).toBe(0);
});
