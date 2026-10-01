// hooks/lib/usage.ts — W127: the /api/usage report builder. Pure function of
// (db, {days, nowMs}) so the golden test is deterministic; the board route
// calls maybeHarvest() then this. All sums run over usage_rollup within the
// window [floor(now - days), floor(now)] on hour boundaries.
import type { Database } from "bun:sqlite";
import type { ModelGroup } from "../bin/usage-harvest.ts";

export const GROUPS: ModelGroup[] = ["flash", "full", "luna", "local", "other"];

type Sum = {
	i: number;
	o: number;
	cr: number;
	cc: number;
	rq: number;
	tok: number;
};

export interface UsageReport {
	days: number;
	fromBucket: number;
	toBucket: number;
	totals: Sum;
	// hour-of-day histogram (local time), all 24 hours present
	byHour: { hour: number; tokens: number }[];
	// every hour bucket in the window, five model groups each (zeros filled)
	timeline: { bucket: number; groups: Record<ModelGroup, number> }[];
	actors: {
		actor: string;
		tags: Record<string, unknown> | null;
		totals: Sum;
		byModel: (Sum & { model: string; group: ModelGroup })[];
	}[];
	rate: { tokPerSec: number; hourBucket: number };
	// W142 aid ROI seam: present only when aid events exist in the window
	// (omit honestly otherwise). `join` is the contract join —
	// aid_events(sid) ⋈ sessions(sid→actor) ⋈ usage_rollup(actor, hour).
	aids?: {
		rollup: Array<{
			aid: string;
			domain: string;
			injected: number;
			skipped: number;
			tok_injected: number;
		}>;
		join: Array<{
			aid: string;
			sid: string | null;
			work_item: string | null;
			actor: string;
			hour_bucket: number;
			tokens_injected: number;
			in_tok: number;
			out_tok: number;
		}>;
	};
}

const SUMS =
	"SUM(in_tok) AS i, SUM(out_tok) AS o, SUM(cache_r) AS cr, SUM(cache_c) AS cc, SUM(requests) AS rq";

const num = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

const rowSum = (r: Record<string, unknown> | null): Sum => {
	const s = {
		i: num(r?.i),
		o: num(r?.o),
		cr: num(r?.cr),
		cc: num(r?.cc),
		rq: num(r?.rq),
		tok: 0,
	};
	s.tok = s.i + s.o + s.cr + s.cc;
	return s;
};

const zeroGroups = (): Record<ModelGroup, number> => ({
	flash: 0,
	full: 0,
	luna: 0,
	local: 0,
	other: 0,
});

export function buildUsageReport(
	db: Database,
	opts: { days?: number; nowMs?: number } = {},
): UsageReport {
	const days = opts.days ?? 28;
	const now = opts.nowMs ?? Date.now();
	const from = Math.floor((now - days * 86_400_000) / 3_600_000) * 3_600_000;
	const to = Math.floor(now / 3_600_000) * 3_600_000;
	const win = "hour_bucket >= ? AND hour_bucket <= ?";
	const t = db
		.query(`SELECT ${SUMS} FROM usage_rollup WHERE ${win}`)
		.get(from, to) as Record<string, unknown> | null;
	const totals = rowSum(t);
	// timeline: every bucket present (zeros filled), five groups per bucket
	const tlRows = db
		.query(
			`SELECT hour_bucket AS h, model_group AS g, SUM(in_tok+out_tok+cache_r+cache_c) AS tok FROM usage_rollup WHERE ${win} GROUP BY h, g ORDER BY h`,
		)
		.all(from, to) as { h: number; g: string; tok: number }[];
	const timeline: UsageReport["timeline"] = [];
	for (let b = from; b <= to; b += 3_600_000)
		timeline.push({ bucket: b, groups: zeroGroups() });
	for (const r of tlRows) {
		const p = timeline[Math.round((num(r.h) - from) / 3_600_000)];
		if (p && (GROUPS as string[]).includes(r.g))
			p.groups[r.g as ModelGroup] = num(r.tok);
	}
	// hour-of-day histogram in LOCAL time — the operator's day shape
	const ptok = (g: Record<ModelGroup, number>): number =>
		GROUPS.reduce((a, k) => a + g[k], 0);
	const byHour = Array.from({ length: 24 }, (_, hour) => ({
		hour,
		tokens: 0,
	}));
	for (const p of timeline)
		byHour[new Date(p.bucket).getHours()].tokens += ptok(p.groups);
	// per-actor drill-down; tags ride the sessions table (actor → latest stamp)
	const tagsOf = new Map<string, string>();
	for (const r of db
		.query(
			"SELECT actor, tags FROM sessions WHERE actor IS NOT NULL ORDER BY started_at",
		)
		.all() as { actor: string; tags: string | null }[])
		tagsOf.set(r.actor, r.tags ?? "");
	const actRows = db
		.query(
			`SELECT actor, ${SUMS} FROM usage_rollup WHERE ${win} GROUP BY actor ORDER BY SUM(in_tok+out_tok+cache_r+cache_c) DESC`,
		)
		.all(from, to) as { actor: string }[];
	const actors = actRows.map((a) => {
		const ms = db
			.query(
				`SELECT model, MAX(model_group) AS g, ${SUMS} FROM usage_rollup WHERE actor = ? AND ${win} GROUP BY model ORDER BY SUM(in_tok+out_tok+cache_r+cache_c) DESC`,
			)
			.all(a.actor, from, to) as Record<string, unknown>[];
		const sum = rowSum(
			db
				.query(`SELECT ${SUMS} FROM usage_rollup WHERE actor = ? AND ${win}`)
				.get(a.actor, from, to) as Record<string, unknown> | null,
		);
		let tags: Record<string, unknown> | null = null;
		try {
			tags = JSON.parse(tagsOf.get(a.actor) ?? "") as Record<string, unknown>;
		} catch {
			tags = null;
		}
		return {
			actor: a.actor,
			tags,
			totals: sum,
			byModel: ms.map((m) => ({
				model: String(m.model),
				group: m.g as ModelGroup,
				...rowSum(m),
			})),
		};
	});
	// recent throughput: newest non-empty bucket in the last 24h, out/3600
	const last = db
		.query(
			`SELECT hour_bucket AS h, SUM(out_tok) AS o FROM usage_rollup WHERE ${win} GROUP BY h ORDER BY h DESC LIMIT 1`,
		)
		.get(to - 86_400_000, to) as { h: number; o: number } | null;
	const rate = {
		tokPerSec: last ? Math.round((num(last.o) / 3600) * 100) / 100 : 0,
		hourBucket: last ? num(last.h) : to,
	};
	const aids = aidSection(db, from, to);
	return {
		days,
		fromBucket: from,
		toBucket: to,
		totals,
		timeline,
		byHour,
		actors,
		rate,
		...(aids ? { aids } : {}),
	};
}

/** W142: aid ROI section — the contract join aid_events(sid) ⋈
 *  sessions(sid→actor) ⋈ usage_rollup(actor, hour), plus the hourly aid
 *  rollup. Omitted honestly when no aid events exist in the window. */
function aidSection(
	db: Database,
	from: number,
	to: number,
): UsageReport["aids"] | null {
	try {
		const rollup = db
			.query(
				`SELECT aid, domain, SUM(injected) AS injected, SUM(skipped) AS skipped,
				SUM(tok_injected) AS tok_injected
				FROM aid_rollup WHERE hour_bucket >= ? AND hour_bucket <= ?
				GROUP BY aid, domain ORDER BY tok_injected DESC`,
			)
			.all(from, to) as Array<Record<string, unknown>>;
		const join = db
			.query(
				`SELECT ae.aid, ae.sid, ae.work_item, s.actor,
				(ae.ts / 3600000) * 3600000 AS hour_bucket,
				ae.tokens_injected, ur.in_tok, ur.out_tok
				FROM aid_events ae
				JOIN sessions s ON s.sid = ae.sid
				JOIN usage_rollup ur
					ON ur.actor = s.actor AND ur.hour_bucket = (ae.ts / 3600000) * 3600000
				WHERE (ae.ts / 3600000) * 3600000 >= ? AND (ae.ts / 3600000) * 3600000 <= ?`,
			)
			.all(from, to) as Array<Record<string, unknown>>;
		if (rollup.length === 0 && join.length === 0) return null;
		return { rollup, join };
	} catch {
		return null; // db without the aid tables → omit honestly
	}
}
