// hooks/lib/usage-export.ts — W179.1: the per-actor/license billing export.
// One CSV row per actor-seat: usage_rollup totals within the window, joined
// with sessions.tags (team/department), api_keys (the actor's licenses and
// limits) and budget_state (each key's newest-window O(1) counters — the
// router flushes these async). Pure function of (db, opts) like
// buildUsageReport so the golden test is deterministic; the board route
// (/api/usage/export.csv) calls maybeHarvest() then this. License joins
// degrade honestly on a db without the v8 tables: empty cells, stable
// header, never a thrown row.
import type { Database } from "bun:sqlite";
import { actorAllowlist, actorTagsMap } from "./usage.ts";

const SUMS =
	"SUM(in_tok) AS i, SUM(out_tok) AS o, SUM(cache_r) AS cr, SUM(cache_c) AS cc, SUM(requests) AS rq";

const num = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

// RFC 4180: quote a field containing comma, quote or newline; double the
// embedded quotes. Numbers and plain ids pass through bare.
const csvField = (v: string | number): string => {
	const s = String(v);
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

type Seat = {
	ids: string[];
	rpm: number | null;
	tpm: number | null;
	usedRpm: number;
	usedTpm: number;
};

// actor → license seat: api_keys rows + each key's newest budget_state
// window (upsert-ADD counters; window_start = the flusher's stamp). A db
// without the v8 tables returns the empty map — billing columns ship empty.
function licenseSeats(db: Database): Map<string, Seat> {
	const seats = new Map<string, Seat>();
	try {
		const keys = db
			.query(
				"SELECT key_id, actor, rpm_limit, tpm_limit FROM api_keys WHERE actor IS NOT NULL",
			)
			.all() as {
			key_id: string;
			actor: string;
			rpm_limit: number | null;
			tpm_limit: number | null;
		}[];
		// newest window wins per key — never sum across windows
		const win = new Map<string, { rs: number; rt: number; ws: number }>();
		for (const r of db
			.query(
				"SELECT key_id, used_rpm, used_tpm, window_start FROM budget_state",
			)
			.all() as {
			key_id: string;
			used_rpm: number;
			used_tpm: number;
			window_start: number;
		}[]) {
			const cur = win.get(r.key_id);
			if (!cur || r.window_start > cur.ws)
				win.set(r.key_id, {
					rs: num(r.used_rpm),
					rt: num(r.used_tpm),
					ws: num(r.window_start),
				});
		}
		for (const k of keys) {
			const seat = seats.get(k.actor) ?? {
				ids: [],
				rpm: null,
				tpm: null,
				usedRpm: 0,
				usedTpm: 0,
			};
			seat.ids.push(k.key_id);
			seat.rpm =
				k.rpm_limit != null ? Math.max(seat.rpm ?? 0, k.rpm_limit) : seat.rpm;
			seat.tpm =
				k.tpm_limit != null ? Math.max(seat.tpm ?? 0, k.tpm_limit) : seat.tpm;
			const b = win.get(k.key_id);
			if (b) {
				seat.usedRpm += b.rs;
				seat.usedTpm += b.rt;
			}
			seats.set(k.actor, seat);
		}
	} catch {
		return seats;
	}
	return seats;
}

/** W179.1: the per-actor/license billing CSV. One row per actor-seat,
 *  tokens-desc; window and filter semantics match buildUsageReport exactly
 *  (same hour-floor math, same allowlist) so a dashboard view and its
 *  export never disagree. */
export function buildUsageCsv(
	db: Database,
	opts: { days?: number; nowMs?: number; team?: string; dept?: string } = {},
): string {
	const days = opts.days ?? 28;
	const now = opts.nowMs ?? Date.now();
	const from = Math.floor((now - days * 86_400_000) / 3_600_000) * 3_600_000;
	const to = Math.floor(now / 3_600_000) * 3_600_000;
	const win = "hour_bucket >= ? AND hour_bucket <= ?";
	const tagsOf = actorTagsMap(db);
	const team = opts.team ?? "";
	const dept = opts.dept ?? "";
	const allow = actorAllowlist(tagsOf, team, dept);
	const inFrag =
		allow.length > 0
			? ` AND actor IN (${allow.map(() => "?").join(",")})`
			: team || dept
				? " AND 1=0" // filter active, nothing matches → honest zeros
				: "";
	const rows = db
		.query(
			`SELECT actor, ${SUMS}, COUNT(DISTINCT model) AS models FROM usage_rollup WHERE ${win}${inFrag} GROUP BY actor ORDER BY SUM(in_tok+out_tok+cache_r+cache_c) DESC`,
		)
		.all(from, to, ...allow) as Array<Record<string, unknown>>;
	const seats = licenseSeats(db);
	const iso = (ms: number): string => new Date(ms).toISOString();
	const head =
		"actor,team,department,in_tok,out_tok,cache_read_tok,cache_write_tok,total_tokens,requests,models,licenses,rpm_limit,tpm_limit,used_rpm,used_tpm,window_from,window_to";
	const lines = rows.map((r) => {
		const actor = String(r.actor);
		const seat = seats.get(actor);
		let tg: Record<string, unknown> | null = null;
		try {
			tg = JSON.parse(tagsOf.get(actor) ?? "") as Record<string, unknown>;
		} catch {
			tg = null;
		}
		const i = num(r.i);
		const o = num(r.o);
		const cr = num(r.cr);
		const cc = num(r.cc);
		const cells: (string | number)[] = [
			actor,
			typeof tg?.team === "string" ? tg.team : "",
			typeof tg?.department === "string" ? tg.department : "",
			i,
			o,
			cr,
			cc,
			i + o + cr + cc,
			num(r.rq),
			num(r.models),
			seat ? seat.ids.join(";") : "",
			seat?.rpm ?? "",
			seat?.tpm ?? "",
			seat?.usedRpm ?? 0,
			seat?.usedTpm ?? 0,
			iso(from),
			iso(to),
		];
		return cells.map(csvField).join(",");
	});
	return `${[head, ...lines].join("\n")}\n`;
}
