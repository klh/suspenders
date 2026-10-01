// hooks/lib/settle.ts — W159 session-end knowledge settle (federation
// 2026-10-01, Session-end knowledge settle + Domain separation §2). At
// session end the local system contributes what it learned to the knowledge
// store — the write-back half of the knowledge-aids architecture (W142's
// laws both ways: verified-only, metered, doc-covered ground gets pointer
// rows or rejection at ingest — the settle never bypasses that bar; it adds
// the provenance SORT on top).
//
// The sort: sessions with data_domain=hub may contribute to the hub-ward
// feed; private sessions write ONLY to the local shelf; mixed sessions take
// the most restrictive domain (private, period — restrictiveDomain). The
// settle NEVER sends content anywhere: it stamps hub_eligible on the
// session's knowledge_queue + knowledge rows (NULL = unsettled); actual
// hub-ward transfer rides the existing feed filtering hub only.
import type { Database } from "bun:sqlite";
import { openGovernorDb, openKnowledgeDb } from "./govdb.ts";
import {
	SqliteKnowledgeStore,
	type KnowledgeStore,
} from "./knowledge-ports.ts";
import { restrictiveDomain, type DataDomain } from "./provenance.ts";

export interface SettleResult {
	sid: string;
	/** Effective session domain — anything unknown defaults private. */
	domain: DataDomain;
	/** knowledge_queue rows stamped this pass. */
	queueMarked: number;
	/** knowledge rows backfilled this pass (distilled before the settle). */
	rowsBackfilled: number;
}

/** Session provenance: sessions.data_domain, anything but 'hub' = private
 *  (the most restrictive default per the domain-separation law). */
export function sessionDomain(db: Database, sid: string): DataDomain {
	const row = db
		.query("SELECT data_domain FROM sessions WHERE sid = ?")
		.get(sid) as { data_domain: string | null } | null;
	return row?.data_domain === "hub" ? "hub" : "private";
}

/** Routing-plane seam: record what a session actually routed through.
 *  Sticky most-restrictive — once private, a session stays private; 'hub'
 *  requires every touch to have been hub. Returns the merged domain and
 *  whether a sessions row exists to carry it. */
export function recordSessionDomain(
	db: Database,
	sid: string,
	domain: DataDomain,
): { recorded: boolean; domain: DataDomain } {
	const cur = db
		.query("SELECT data_domain FROM sessions WHERE sid = ?")
		.get(sid) as { data_domain: string | null } | null;
	const next =
		cur === null || cur.data_domain === null
			? domain
			: restrictiveDomain(
					cur.data_domain === "hub" ? "hub" : "private",
					domain,
				);
	const r = db
		.query("UPDATE sessions SET data_domain = ? WHERE sid = ?")
		.run(next, sid);
	return { recorded: r.changes > 0, domain: next };
}

/** The settle core, db-injected for tests. Idempotent: already-settled rows
 *  (hub_eligible IS NOT NULL) are never re-flipped by a later pass. */
export async function settleSessionWith(
	db: Database,
	sid: string,
	opts: { store?: KnowledgeStore; emit?: boolean } = {},
): Promise<SettleResult> {
	const domain = sessionDomain(db, sid);
	const flag = domain === "hub" ? 1 : 0;
	// W167: the stamps ride the W91 knowledge STORE PORT — the seam runs on
	// knowledge.db (W166 split), never the governor handle. Its counts are
	// pre-SELECTs: bun:sqlite `changes` is inflated on trigger-covered
	// tables (deltas/FTS writes count too), so COUNT first, then stamp.
	const { queueMarked, rowsBackfilled } = await (
		opts.store ?? new SqliteKnowledgeStore(openKnowledgeDb(), db)
	).settleHubEligible(sid, flag);
	const result: SettleResult = {
		sid,
		domain,
		queueMarked,
		rowsBackfilled,
	};
	if (opts.emit !== false) {
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.settled', 'knowledge', ?, NULL)",
		).run(Date.now(), `settle:${sid.slice(0, 8)}`, JSON.stringify(result));
	}
	return result;
}

/** One settle pass for a session — the session-end phase. */
export async function settleSession(sid: string): Promise<SettleResult> {
	const gov = openGovernorDb();
	const kb = openKnowledgeDb();
	try {
		return await settleSessionWith(gov, sid, {
			store: new SqliteKnowledgeStore(kb, gov),
		});
	} finally {
		kb.close();
		gov.close();
	}
}
