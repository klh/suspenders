// hooks/bin/aid-harvest.ts — W142: pulls buckle's aid metering into
// governor.db so aids appear in the W127 usage surfaces. Raw events land in
// aid_events (deduped on (ts, aid, sid, work_item, packet_id) — govdb's
// table has no event id), the hourly rollup upserts with SET semantics (one
// buckle owns the buckets; re-pull is idempotent). Watermark rides the
// facts table. Library + thin CLI; buckle down = honest skip, never an
// error (aids are garnish — the control plane never blocks on them).
import type { Database } from "bun:sqlite";

export interface AidHarvestStats {
	pulled: number;
	events_inserted: number;
	buckets_upserted: number;
	skipped?: string;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;

const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

/** Harvest watermark: the max event ts already pulled (facts table). */
export function aidWatermark(db: Database): number {
	const r = db
		.query("SELECT value FROM facts WHERE key = 'aid_harvest.watermark'")
		.get() as { value: string | null } | undefined;
	const n = Number(r?.value ?? "");
	return Number.isFinite(n) ? n : 0;
}

function setWatermark(db: Database, ts: number, nowMs: number): void {
	db.query(
		`INSERT INTO facts (key, value, source, version, ts)
		VALUES ('aid_harvest.watermark', ?, 'aid-harvest', 1, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
	).run(String(ts), nowMs);
}

/** Natural-key dedupe — govdb aid_events has no event id column. */
function eventExists(db: Database, e: Row): boolean {
	return (
		db
			.query(
				`SELECT id FROM aid_events WHERE ts = ? AND aid = ?
				AND IFNULL(sid,'') = IFNULL(?,'')
				AND IFNULL(work_item,'') = IFNULL(?,'')
				AND IFNULL(packet_id,'') = IFNULL(?,'')`,
			)
			.get(
				num(e.ts),
				str(e.aid) ?? "",
				str(e.sid),
				str(e.work_item),
				str(e.packet_id),
			) !== null
	);
}

function insertEvent(db: Database, e: Row): boolean {
	if (eventExists(db, e)) return false;
	db.query(
		`INSERT INTO aid_events (ts, aid, sid, work_item, packet_id,
			tokens_injected, est_tok_saved)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		num(e.ts),
		str(e.aid) ?? "",
		str(e.sid),
		str(e.work_item),
		str(e.packet_id),
		num(e.tokens_injected),
		typeof e.est_tok_saved === "number" ? e.est_tok_saved : null,
	);
	return true;
}

/** Events pull: watermark → /aids/events → dedupe-insert → watermark. */
async function pullEvents(
	db: Database,
	f: typeof fetch,
	base: string,
	nowMs: number,
): Promise<{ pulled: number; inserted: number; skipped?: string }> {
	let res: Response;
	try {
		res = await f(`${base}/aids/events?since=${aidWatermark(db)}`);
	} catch {
		return { pulled: 0, inserted: 0, skipped: "buckle unreachable" };
	}
	if (!res.ok)
		return { pulled: 0, inserted: 0, skipped: `aids/events ${res.status}` };
	const body = (await res.json()) as { events?: Row[] };
	const events = body.events ?? [];
	let inserted = 0;
	let maxTs = aidWatermark(db);
	for (const e of events) {
		if (insertEvent(db, e)) inserted++;
		const ts = num(e.ts);
		if (ts > maxTs) maxTs = ts;
	}
	if (maxTs > aidWatermark(db)) setWatermark(db, maxTs, nowMs);
	return { pulled: events.length, inserted };
}

const ROLLUP_UPSERT = `INSERT INTO aid_rollup (
	hour_bucket, aid, domain, model_group, injected, skipped,
	tok_injected, est_tok_saved, requests)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hour_bucket, aid, domain, model_group) DO UPDATE SET
	injected = excluded.injected, skipped = excluded.skipped,
	tok_injected = excluded.tok_injected,
	est_tok_saved = excluded.est_tok_saved, requests = excluded.requests`;

/** Rollup pull: complete hour buckets, SET semantics (one buckle owns them). */
async function pullRollup(
	db: Database,
	f: typeof fetch,
	base: string,
): Promise<number> {
	let res: Response;
	try {
		res = await f(`${base}/aids/rollup?hours=168`);
	} catch {
		return 0;
	}
	if (!res.ok) return 0;
	const body = (await res.json()) as { rows?: Row[] };
	let n = 0;
	for (const r of body.rows ?? []) {
		db.query(ROLLUP_UPSERT).run(
			num(r.hour_bucket),
			str(r.aid) ?? "",
			str(r.domain) ?? "",
			str(r.model_group) ?? "all",
			num(r.injected),
			num(r.skipped),
			num(r.tok_injected),
			num(r.est_tok_saved),
			num(r.requests),
		);
		n++;
	}
	return n;
}

const envUrl = (): string => {
	const raw = (process.env.BUCKLE_AIDS_URL ?? "").trim();
	return raw.length > 0 ? raw : "http://127.0.0.1:4101";
};

/** Pull buckle's aid metering into governor.db. Honest skip on outage. */
export async function harvestAids(
	db: Database,
	opts: { baseUrl?: string; fetchFn?: typeof fetch; nowMs?: number } = {},
): Promise<AidHarvestStats> {
	const f = opts.fetchFn ?? fetch;
	const base = opts.baseUrl ?? envUrl();
	const ev = await pullEvents(db, f, base, opts.nowMs ?? Date.now());
	if (ev.skipped)
		return {
			pulled: 0,
			events_inserted: 0,
			buckets_upserted: 0,
			skipped: ev.skipped,
		};
	return {
		pulled: ev.pulled,
		events_inserted: ev.inserted,
		buckets_upserted: await pullRollup(db, f, base),
	};
}

// CLI: bun hooks/bin/aid-harvest.ts [--base http://127.0.0.1:4101]
if (import.meta.main) {
	const flag = process.argv.indexOf("--base");
	const base =
		flag > 0 && process.argv[flag + 1]
			? String(process.argv[flag + 1])
			: undefined;
	const { openGovernorDb } = await import("../lib/govdb.ts");
	const stats = await harvestAids(openGovernorDb(), { baseUrl: base });
	console.log(JSON.stringify(stats));
}
