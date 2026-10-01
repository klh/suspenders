// hooks/lib/federation-hub.ts — W170 federation phase 2 (hub side): the
// work-delta up-feed receiver core + the global lane view. Pure functions
// over the hub's governor.db (db-injected, golden-testable like usage.ts);
// store-server.ts maps them onto HTTP. The landing zone is fed_work_log
// (govdb v11): UNIQUE(spoke, seq_spoke) makes at-least-once redelivery a
// no-op; rows land in hub-arrival order while keeping per-spoke ordering.
//
// Domain law (federation-2026-10-01): the hub sees what transits it, and
// nothing else. The spoke filters BEFORE push (federation-up.ts): work
// metadata always (work_items/sessions/claims — the lane view's bread),
// route_audit only for hub-entitled targets. The hub skips (never chokes
// on) unknown table names — forward-compatible with future spokes.
import type { Database } from "bun:sqlite";
import { WORK_DELTA_TABLES } from "./federation.ts";

// ── receiver ──────────────────────────────────────────────────────────

export interface LandResult {
	/** rows actually landed (INSERT OR IGNORE — redeliveries don't count). */
	applied: number;
	/** rows skipped: unknown tbl or malformed image — skip-and-count. */
	skipped: number;
	/** max spoke seq received — the ack the spoke advances its cursor to. */
	throughSeq: number;
}

export class DeltaBatchError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

const MAX_SPOKE = 128;
const MAX_ROWS = 500;
const MAX_ROW_BYTES = 32 * 1024;

const asInt = (v: unknown): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : -1;

/** Validate one pushed batch body; throws DeltaBatchError (400-shaped) on
 *  structural problems (bad spoke, missing/oversized rows array). Row-shape
 *  problems are skip-and-count at landing — a deltas row is machine-made,
 *  so wedging the whole feed over one bad image is the worse failure. */
export function validateBatch(body: unknown): {
	spoke: string;
	rows: Record<string, unknown>[];
} {
	const b = (typeof body === "object" && body !== null ? body : {}) as {
		spoke?: unknown;
		rows?: unknown;
	};
	if (
		typeof b.spoke !== "string" ||
		b.spoke.length === 0 ||
		b.spoke.length > MAX_SPOKE
	)
		throw new DeltaBatchError(
			"body.spoke must be a non-empty string (<= 128 chars)",
			400,
		);
	if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS)
		throw new DeltaBatchError(
			`body.rows must be an array of at most ${String(MAX_ROWS)} rows`,
			400,
		);
	return { spoke: b.spoke, rows: b.rows as Record<string, unknown>[] };
}

/** Land one row image. Returns 1 landed / 0 skipped (with an honest stderr
 *  line — skip-and-count, never wedge the feed). */
function landRow(
	db: Database,
	spoke: string,
	raw: Record<string, unknown>,
): number {
	const seq = asInt(raw.seq);
	const ts = asInt(raw.ts);
	const tbl = typeof raw.tbl === "string" ? raw.tbl : "";
	const op = typeof raw.op === "string" ? raw.op : "";
	const pk = typeof raw.pk === "string" ? raw.pk : "";
	if (
		seq < 0 ||
		ts < 0 ||
		tbl.length === 0 ||
		op.length === 0 ||
		pk.length === 0
	) {
		console.error(`[federation-hub] skip malformed row spoke=${spoke}`);
		return 0;
	}
	if (!(WORK_DELTA_TABLES as readonly string[]).includes(tbl)) {
		console.error(
			`[federation-hub] skip unknown tbl=${tbl} spoke=${spoke} (forward-compat)`,
		);
		return 0;
	}
	const before = typeof raw.before === "string" ? raw.before : null;
	const after = typeof raw.after === "string" ? raw.after : null;
	if (
		(before !== null && before.length > MAX_ROW_BYTES) ||
		(after !== null && after.length > MAX_ROW_BYTES)
	) {
		console.error(`[federation-hub] skip oversized image spoke=${spoke}`);
		return 0;
	}
	const ins = db
		.query(
			"INSERT OR IGNORE INTO fed_work_log (spoke, seq_spoke, ts, tbl, op, pk, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(spoke, seq, ts, tbl, op, pk, before, after);
	return ins.changes;
}

/** Validate + land one pushed batch: one transaction, INSERT OR IGNORE per
 *  row (at-least-once redelivery = no-op via UNIQUE(spoke, seq_spoke)).
 *  Serialized by the caller (store-server's connection chain) so batch
 *  landing never interleaves /rpc writes. Throws DeltaBatchError on a bad
 *  batch SHAPE; row-level problems skip-and-count (landRow). */
export function landWorkDeltas(db: Database, body: unknown): LandResult {
	const { spoke, rows } = validateBatch(body);
	let applied = 0;
	let skipped = 0;
	let throughSeq = 0;
	db.run("BEGIN IMMEDIATE");
	try {
		for (const raw of rows) {
			const landed = landRow(db, spoke, raw);
			if (landed === 0) skipped += 1;
			applied += landed;
			const seq = asInt(raw.seq);
			if (seq > throughSeq) throughSeq = seq;
		}
		db.run("COMMIT");
	} catch (e) {
		db.run("ROLLBACK");
		throw e;
	}
	return { applied, skipped, throughSeq };
}

// ── lane view ─────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null =>
	typeof v === "string" ? v : null;

const parseImg = (s: string | null): Record<string, unknown> | null => {
	if (s === null) return null;
	try {
		const p: unknown = JSON.parse(s);
		return typeof p === "object" && p !== null
			? (p as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
};

/** Latest row image per (spoke, pk) for one table, newest hub-arrival first. */
function latestPerKey(
	db: Database,
	tbl: string,
	limit: number,
): Array<{
	spoke: string;
	op: string;
	ts: number;
	img: Record<string, unknown> | null;
}> {
	const rows = db
		.query(
			`SELECT f.spoke AS spoke, f.op AS op, f.ts AS ts, f.after AS after FROM fed_work_log f
			JOIN (SELECT spoke, pk, MAX(seq) AS seq FROM fed_work_log WHERE tbl = ? GROUP BY spoke, pk) m
			ON m.spoke = f.spoke AND m.seq = f.seq
			ORDER BY f.ts DESC, f.seq DESC LIMIT ?`,
		)
		.all(tbl, limit) as Array<{
		spoke: string;
		op: string;
		ts: number;
		after: string | null;
	}>;
	return rows.map((r) => ({
		spoke: r.spoke,
		op: r.op,
		ts: r.ts,
		img: parseImg(r.after),
	}));
}

export interface LaneRow {
	spoke: string;
	sid: string;
	scope: string;
	intent: string | null;
	hot: 0 | 1;
	ts: number;
	role: string | null;
	project: string | null;
	state: string | null;
}

/** The live-lane half: latest claims image per (spoke, "sid/scope"),
 *  annotated by the latest sessions image per sid. Released claims (op
 *  delete) and unknown shapes drop out — a released claim is not a lane. */
function lanesOf(db: Database, limit: number): LaneRow[] {
	const lanes: LaneRow[] = [];
	for (const c of latestPerKey(db, "claims", limit * 2)) {
		if (c.op === "delete" || c.img === null) continue;
		const sid = str(c.img.sid);
		if (sid.length === 0) continue;
		lanes.push({
			spoke: c.spoke,
			sid,
			scope: str(c.img.scope),
			intent: strOrNull(c.img.intent),
			hot: c.img.hot === 1 ? 1 : 0,
			ts: c.ts,
			role: null,
			project: null,
			state: null,
		});
	}
	return lanes;
}

export interface WorkLogRow {
	spoke: string;
	project: string;
	id: string;
	title: string;
	state: string;
	owner_sid: string | null;
	op: string;
	ts: number;
}

/** The work-log half: latest work_items image per (spoke, "project/id").
 *  Deletes drop out — a deleted item is not log material; a malformed image
 *  is skipped honestly (machine-generated, can't-happen tolerated). */
function workLogOf(db: Database, limit: number): WorkLogRow[] {
	const out: WorkLogRow[] = [];
	for (const w of latestPerKey(db, "work_items", limit * 2)) {
		if (w.op === "delete" || w.img === null) continue;
		const id = str(w.img.id);
		if (id.length === 0) continue;
		out.push({
			spoke: w.spoke,
			project: str(w.img.project),
			id,
			title: str(w.img.title),
			state: str(w.img.state),
			owner_sid: strOrNull(w.img.owner_sid),
			op: w.op,
			ts: w.ts,
		});
	}
	return out;
}

/** Route summary rollup over the latest route_audit image per (spoke, rid),
 *  bounded (a rollup, not the ledger). */
function routeSummary(db: Database): {
	requests: number;
	by_decision: Record<string, number>;
} {
	const byDecision = new Map<string, number>();
	let requests = 0;
	for (const r of latestPerKey(db, "route_audit", 10_000)) {
		if (r.op === "delete") continue;
		const d = str(r.img?.decision) || "unknown";
		byDecision.set(d, (byDecision.get(d) ?? 0) + 1);
		requests += 1;
	}
	return { requests, by_decision: Object.fromEntries(byDecision) };
}

export interface LaneView {
	generated_at: string;
	spoke_count: number;
	lanes: LaneRow[];
	work_log: WorkLogRow[];
	route: { requests: number; by_decision: Record<string, number> };
}

/** Annotate lanes in place from the latest sessions images (role/project/
 *  state by sid) — the ⋈ in claims ⋈ sessions. */
function annotateLanes(
	lanes: LaneRow[],
	sessRows: Array<{
		spoke: string;
		op: string;
		ts: number;
		img: Record<string, unknown> | null;
	}>,
): void {
	const sess = new Map<string, Record<string, unknown>>();
	for (const s of sessRows) {
		if (s.op === "delete") continue;
		const sid = str(s.img?.sid);
		if (sid.length > 0) sess.set(sid, s.img ?? {});
	}
	for (const l of lanes) {
		const s = sess.get(l.sid);
		if (s === undefined) continue;
		l.role = strOrNull(s.role);
		l.project = strOrNull(s.project);
		l.state = strOrNull(s.state);
	}
}

/** The cross-user/team lane view: live lanes (claims ⋈ sessions) + the
 *  work-log + the route summary. Pure function of (db, opts) — pinned by
 *  the golden test. */
export function buildLaneView(
	db: Database,
	opts: { limit?: number; nowMs?: number } = {},
): LaneView {
	const limit = opts.limit ?? 200;
	const lanes = lanesOf(db, limit);
	annotateLanes(lanes, latestPerKey(db, "sessions", limit * 2));
	const work_log = workLogOf(db, limit);
	return {
		generated_at: new Date(opts.nowMs ?? Date.now()).toISOString(),
		spoke_count: new Set([...lanes, ...work_log].map((r) => r.spoke)).size,
		lanes,
		work_log,
		route: routeSummary(db),
	};
}

// ── renderers ─────────────────────────────────────────────────────────

const esc = (s: string): string =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

/** W152-style renderer: data-chaste HTML, one obvious path, no chartjunk. */
export function renderLaneViewHtml(v: LaneView): string {
	const laneTr = v.lanes
		.map(
			(l) =>
				`<tr><td>${esc(l.spoke)}</td><td>${esc(l.sid.slice(0, 8))}</td><td>${esc(l.scope)}</td><td>${esc(l.intent ?? "")}</td><td>${esc(l.state ?? "")}</td></tr>`,
		)
		.join("");
	const workTr = v.work_log
		.map(
			(w) =>
				`<tr><td>${esc(w.spoke)}</td><td>${esc(w.project)}</td><td>${esc(w.id)}</td><td>${esc(w.title)}</td><td>${esc(w.state)}</td><td>${esc(w.owner_sid === null ? "" : w.owner_sid.slice(0, 8))}</td></tr>`,
		)
		.join("");
	const decisions = Object.entries(v.route.by_decision)
		.map(([d, n]) => `${esc(d)}=${String(n)}`)
		.join(", ");
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>federation lane view</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.2rem .5rem;text-align:left;font-size:.9rem}h2{font-size:1rem;margin:1rem 0 .4rem}</style>
</head>
<body>
<h1>federation lane view</h1>
<p>spokes=${String(v.spoke_count)} · route requests=${String(v.route.requests)}${decisions.length > 0 ? ` (${decisions})` : ""} · generated ${esc(v.generated_at)}</p>
<h2>lanes (claims ⋈ sessions/claims)</h2>
<table><tr><th>spoke</th><th>sid</th><th>scope</th><th>intent</th><th>state</th></tr>${laneTr}</table>
<h2>work log</h2>
<table><tr><th>spoke</th><th>project</th><th>id</th><th>title</th><th>state</th><th>owner</th></tr>${workTr}</table>
</body>
</html>
`;
}
