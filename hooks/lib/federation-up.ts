// hooks/lib/federation-up.ts — W170 federation phase 2 (spoke side): the
// work-delta up-feed. Reads the spoke's own deltas log and pushes bounded
// batches hub-ward (spoke-initiated, W154 channel shape), advancing a
// durable cursor ONLY on the hub's ack — at-least-once delivery, hub-side
// dedupe on (spoke, seq_spoke) makes redelivery a no-op.
//
// Law shape: work metadata (work_items/sessions/claims) feeds the lane
// view; route_audit rows go ONLY when hub-entitled (resolved_target model
// ∈ the last-known entitlements — the visibility-boundary law: spoke-local
// LLM traffic stays on the machine, the hub sees what transits it and
// nothing else). Facts, locks, aid/usage, identity tables NEVER ride the
// feed. Degradation law: hub down → cursor untouched (the deltas backlog
// IS the queue), one honest line, never throw.
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	federationHome,
	loadLastKnown,
	readCapped,
	type FederationEnv,
	type WorkDeltaRow,
	WORK_DELTA_TABLES,
} from "./federation.ts";
import { hubModelIdsFrom } from "./provenance.ts";
import { openGovernorDb } from "./govdb.ts";
import { atomicWrite } from "./board-config.ts";

/** Up-feed cursor file: <home>/federation-up-cursor.json — {seq, pushed_at}. */
export function upCursorPath(env: FederationEnv = {}): string {
	return join(federationHome(env), "federation-up-cursor.json");
}

/** Read the up-feed cursor; 0 when absent/unparseable (feed from the top —
 *  the hub's UNIQUE dedupe makes the replay a no-op). */
export function loadUpCursor(env: FederationEnv = {}): number {
	const p = upCursorPath(env);
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		const seq = (parsed as { seq?: unknown })?.seq;
		return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0
			? seq
			: 0;
	} catch {
		return 0;
	}
}

/** Durable cursor: written ONLY on the hub's ack (at-least-once contract). */
export function saveUpCursor(env: FederationEnv, seq: number): void {
	mkdirSync(federationHome(env), { recursive: true });
	atomicWrite(
		upCursorPath(env),
		JSON.stringify({ seq, pushed_at: new Date().toISOString() }),
	);
}

/** The hub-entitlement check for route_audit rows: resolved_target is
 *  "kind:host:port/model" — the model id is the tail after the last "/".
 *  A target whose model is NOT in the spoke's last-known hub menu never
 *  transits (visibility-boundary law) and never rides the feed. */
export function targetModel(target: string | null | undefined): string {
	if (target === null || target === undefined) return "";
	const i = target.lastIndexOf("/");
	return i === -1 ? "" : target.slice(i + 1);
}

/** Read one bounded push batch off the spoke's deltas log, filtered per the
 *  domain law: work metadata (work_items/sessions/claims) always; route_audit
 *  only for hub-entitled targets (empty hub set → none — the restrictive
 *  default: without a policy pull the spoke cannot prove hub-routed). */
export function readWorkDeltas(
	db: Database,
	since: number,
	limit: number,
	hubModelIds: Set<string>,
): WorkDeltaRow[] {
	const rows = db
		.query(
			"SELECT seq, ts, tbl, op, pk, before, after FROM deltas WHERE seq > ? ORDER BY seq LIMIT ?",
		)
		.all(since, limit) as WorkDeltaRow[];
	const inScope = new Set<string>(WORK_DELTA_TABLES);
	return rows.filter((r) => {
		if (!inScope.has(r.tbl)) return false;
		if (r.tbl !== "route_audit") return true;
		return hubModelIds.has(routeTargetModel(r.after));
	});
}

/** resolved_target rides INSIDE the row image JSON — parse it out; an
 *  unparseable image is not provably hub-routed (excluded, honest default). */
function routeTargetModel(after: string | null): string {
	if (after === null) return "";
	try {
		const img: unknown = JSON.parse(after);
		const t = (img as { resolved_target?: unknown })?.resolved_target;
		return targetModel(typeof t === "string" ? t : null);
	} catch {
		return "";
	}
}

export interface PushResult {
	ok: boolean;
	degraded: boolean;
	reason: string | null;
	/** rows in the pushed batch (0 when nothing new). */
	pushed: number;
	/** the acked through_seq — the durable cursor after this cycle. */
	throughSeq: number;
}

/** Degradation-law shape: one honest stderr line + cursor untouched. */
function degradedPush(reason: string, cursor: number): PushResult {
	console.error(
		`[federation-up] degraded: ${reason}; cursor kept at ${String(cursor)}`,
	);
	return {
		ok: false,
		degraded: true,
		reason,
		pushed: 0,
		throughSeq: cursor,
	};
}

/** POST one batch hub-ward, capped-stream parse the ack. Throws on network
 *  failure — the caller degrades (never a throw across the law boundary). */
async function fetchAck(
	hubUrl: string,
	token: string | null,
	spoke: string,
	rows: WorkDeltaRow[],
	timeoutMs: number,
): Promise<{ applied: unknown; through_seq: unknown }> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (token !== null && token.length > 0)
		headers.authorization = `Bearer ${token}`;
	const res = await fetch(`${hubUrl}/federation/work-delta`, {
		method: "POST",
		headers,
		body: JSON.stringify({ spoke, rows }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const ack = (await readCapped(res)) as {
		applied?: unknown;
		through_seq?: unknown;
	};
	if (!res.ok) throw new Error(`hub store answered ${String(res.status)}`);
	return ack;
}

interface PushPrep {
	env: FederationEnv;
	db: Database;
	hubUrl: string;
	spoke: string;
	cursor: number;
	rows: WorkDeltaRow[];
}

/** Resolve env/db/hubUrl/spoke, load cursor + hub entitlements, read one
 *  bounded filtered batch. Shared by the push cycle (and the bin entry). */
function pushPrep(opts: PushOpts = {}): PushPrep {
	const env = opts.env ?? process.env;
	const db = opts.db ?? openGovernorDb();
	const hubUrl = (opts.hubUrl ?? env.BUCKLE_HUB_STORE_URL ?? "").replace(
		/\/$/,
		"",
	);
	const spoke = opts.spokeId ?? env.BUCKLE_SPOKE_ID ?? hostname();
	const cursor = loadUpCursor(env);
	const hubIds = hubModelIdsFrom(loadLastKnown(env));
	const rows = readWorkDeltas(db, cursor, opts.limit ?? 500, hubIds);
	return { env, db, hubUrl, spoke, cursor, rows };
}

export interface PushOpts {
	env?: FederationEnv;
	db?: Database;
	hubUrl?: string;
	token?: string | null;
	timeoutMs?: number;
	limit?: number;
	spokeId?: string;
}

/** Never rewind: the cursor advances only to a sane, acked through_seq —
 *  anything else (garbage ack, stale retry) keeps the old cursor. */
function ackedNext(through: unknown, cursor: number): number {
	return typeof through === "number" &&
		Number.isSafeInteger(through) &&
		through >= cursor
		? through
		: cursor;
}

/** One push cycle: read → filter → bounded POST → cursor ONLY on ack.
 *  Never throws for hub-down; that state is degraded: true (degradation
 *  law) — the deltas backlog is the queue, the cursor file stays put. */
export async function pushWorkDeltas(opts: PushOpts = {}): Promise<PushResult> {
	const { env, hubUrl, spoke, cursor, rows } = pushPrep(opts);
	if (hubUrl.length === 0)
		return degradedPush("no hub store URL (BUCKLE_HUB_STORE_URL)", cursor);
	if (rows.length === 0)
		return {
			ok: true,
			degraded: false,
			reason: null,
			pushed: 0,
			throughSeq: cursor,
		};
	try {
		const ack = await fetchAck(
			hubUrl,
			opts.token ?? env.BUCKLE_SPOKE_TOKEN ?? null,
			spoke,
			rows,
			opts.timeoutMs ?? 5000,
		);
		const next = ackedNext(ack.through_seq, cursor);
		saveUpCursor(env, next);
		return {
			ok: true,
			degraded: false,
			reason: null,
			pushed: rows.length,
			throughSeq: next,
		};
	} catch (e) {
		return degradedPush(String(e), cursor);
	}
}
