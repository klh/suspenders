// test/federation-hub.test.ts — W170 hub side: batch landing (idempotent,
// bounded, skip-and-count) + the global lane view builder + HTML render.
// Temp-HOME isolation (the w159 pattern): a fresh governor.db per file.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w170-hub-"));
process.env.HOME = HOME;
// query bust: this file's own govdb instance, bound to the temp HOME
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?w170hub=${encodeURIComponent(HOME)}`
);
const { buildLaneView, landWorkDeltas, renderLaneViewHtml, DeltaBatchError } =
	await import("../hooks/lib/federation-hub.ts");

const DB = join(HOME, ".cache", "claude-governor", "governor.db");

function freshDb(): Database {
	for (const suffix of ["", "-wal", "-shm"])
		rmSync(DB + suffix, { force: true });
	return openGovernorDb();
}

function row(
	seq: number,
	tbl: string,
	pk: string,
	after: Record<string, unknown> | null,
	op = "insert",
): Record<string, unknown> {
	return {
		seq,
		ts: Date.now(),
		tbl,
		op,
		pk,
		before: null,
		after: after === null ? null : JSON.stringify(after),
	};
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("landWorkDeltas: lands, acks through_seq, idempotent on redelivery", () => {
	const db = freshDb();
	const batch = {
		spoke: "spoke-a",
		rows: [
			row(1, "work_items", "proj/W1", {
				project: "proj",
				id: "W1",
				title: "t1",
				state: "READY",
			}),
			row(2, "claims", "s1/work", {
				sid: "s1",
				scope: "work",
				intent: "i",
				hot: 0,
			}),
		],
	};
	const first = landWorkDeltas(db, batch);
	expect(first.applied).toBe(2);
	expect(first.throughSeq).toBe(2);
	const again = landWorkDeltas(db, batch);
	expect(again.applied).toBe(0);
	expect(again.throughSeq).toBe(2);
	const n = (
		db.query("SELECT COUNT(*) AS n FROM fed_work_log").get() as { n: number }
	).n;
	expect(n).toBe(2);
});

test("landWorkDeltas: unknown tbl skips-and-counts; malformed row too", () => {
	const db = freshDb();
	const out = landWorkDeltas(db, {
		spoke: "spoke-b",
		rows: [
			row(1, "usage_rollup", "h/a/m", { hour_bucket: 1 }),
			row(2, "work_items", "proj/W2", { id: "W2" }),
			{ seq: "x", tbl: "work_items", pk: "p" },
		],
	});
	expect(out.applied).toBe(1);
	expect(out.skipped).toBe(2);
	expect(out.throughSeq).toBe(2);
});

test("landWorkDeltas: bad body shape throws 400-shaped DeltaBatchError", () => {
	const db = freshDb();
	expect(() => landWorkDeltas(db, { spoke: "", rows: [] })).toThrow(
		DeltaBatchError,
	);
	expect(() => landWorkDeltas(db, { spoke: "s", rows: "nope" })).toThrow(
		DeltaBatchError,
	);
	expect(() =>
		landWorkDeltas(db, { spoke: "s", rows: new Array(501).fill(0) }),
	).toThrow(DeltaBatchError);
});

test("buildLaneView: two spokes → lanes ⋈ sessions, work log", () => {
	const db = freshDb();
	landWorkDeltas(db, {
		spoke: "spoke-a",
		rows: [
			row(10, "work_items", "projA/W10", {
				project: "projA",
				id: "W10",
				title: "first",
				state: "DONE",
			}),
			row(11, "sessions", "s-a", {
				sid: "s-a",
				role: "lane",
				project: "projA",
				state: "RUNNING",
			}),
			row(12, "claims", "s-a/work", {
				sid: "s-a",
				scope: "work",
				intent: "grind",
				hot: 1,
			}),
		],
	});
	landWorkDeltas(db, {
		spoke: "spoke-b",
		rows: [
			row(10, "work_items", "projB/W20", {
				project: "projB",
				id: "W20",
				title: "second",
				state: "READY",
			}),
		],
	});
	const v = buildLaneView(db, { nowMs: 0 });
	expect(v.spoke_count).toBe(2);
	expect(v.lanes).toHaveLength(1);
	expect(v.lanes[0]?.sid).toBe("s-a");
	expect(v.lanes[0]?.role).toBe("lane");
	expect(v.work_log).toHaveLength(2);
});

test("buildLaneView: route rollup by decision + latest image wins", () => {
	const db = freshDb();
	landWorkDeltas(db, {
		spoke: "spoke-a",
		rows: [
			row(20, "route_audit", "r1", { rid: "r1", decision: "local" }),
			row(21, "route_audit", "r2", { rid: "r2", decision: "routed" }),
			row(22, "route_audit", "r1", { rid: "r1", decision: "routed" }, "update"),
		],
	});
	const v = buildLaneView(db, { nowMs: 0 });
	expect(v.route.requests).toBe(2);
	expect(v.route.by_decision).toEqual({ routed: 2 });
});

test("buildLaneView: released claim (op delete) drops out; html renders", () => {
	const db = freshDb();
	landWorkDeltas(db, {
		spoke: "spoke-a",
		rows: [
			row(30, "claims", "s-z/work", { sid: "s-z", scope: "work" }),
			row(31, "claims", "s-z/work", null, "delete"),
		],
	});
	const v = buildLaneView(db, { nowMs: 0 });
	expect(v.lanes).toHaveLength(0);
	expect(renderLaneViewHtml(v)).toContain("federation lane view");
});
