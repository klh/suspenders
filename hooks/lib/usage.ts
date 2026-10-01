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
	// W152: team/department chip facets from the FULL sessions tag universe —
	// unfiltered, so chips stay switchable while a filter is active.
	facets: { teams: string[]; depts: string[] };
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

/** W179.1: actor → raw tags JSON, last session stamp wins. One source of
 *  truth for attribution — the report builder and the CSV export (lib/
 *  usage-export.ts) read the same map. */
export function actorTagsMap(db: Database): Map<string, string> {
	const tagsOf = new Map<string, string>();
	for (const r of db
		.query(
			"SELECT actor, tags FROM sessions WHERE actor IS NOT NULL ORDER BY started_at",
		)
		.all() as { actor: string; tags: string | null }[])
		tagsOf.set(r.actor, r.tags ?? "");
	return tagsOf;
}

/** W179.1: team/dept server-side filter → actor allowlist. Empty string
 *  filters disable; an active filter matching nothing returns [] (callers
 *  emit honest zeros, never an unfiltered scan). */
export function actorAllowlist(
	tagsOf: Map<string, string>,
	team: string,
	dept: string,
): string[] {
	if (!team && !dept) return [];
	const allow: string[] = [];
	for (const [a, raw] of tagsOf) {
		let tg: Record<string, unknown> | null = null;
		try {
			tg = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			tg = null;
		}
		if ((!team || tg?.team === team) && (!dept || tg?.department === dept))
			allow.push(a);
	}
	return allow;
}

export function buildUsageReport(
	db: Database,
	opts: {
		days?: number;
		nowMs?: number;
		/** team tag filter — server-side, cuts every series */
		team?: string;
		/** department tag filter — server-side, cuts every series */
		dept?: string;
	} = {},
): UsageReport {
	const days = opts.days ?? 28;
	const now = opts.nowMs ?? Date.now();
	const from = Math.floor((now - days * 86_400_000) / 3_600_000) * 3_600_000;
	const to = Math.floor(now / 3_600_000) * 3_600_000;
	const win = "hour_bucket >= ? AND hour_bucket <= ?";
	// W152: actor tags ride sessions (actor → latest stamp). A team/dept
	// filter resolves its actor allowlist through the same map (W179.1:
	// shared helpers, one attribution source), so EVERY series below is
	// filtered server-side — the chips cut the whole dashboard, not just
	// the actor table.
	const tagsOf = actorTagsMap(db);
	const wantTeam = opts.team ?? "";
	const wantDept = opts.dept ?? "";
	const allow = actorAllowlist(tagsOf, wantTeam, wantDept);
	const inFrag =
		allow.length > 0
			? ` AND actor IN (${allow.map(() => "?").join(",")})`
			: wantTeam || wantDept
				? " AND 1=0" // filter active, nothing matches → honest zeros
				: "";
	const t = db
		.query(`SELECT ${SUMS} FROM usage_rollup WHERE ${win}${inFrag}`)
		.get(from, to, ...allow) as Record<string, unknown> | null;
	const totals = rowSum(t);
	// timeline: every bucket present (zeros filled), five groups per bucket
	const tlRows = db
		.query(
			`SELECT hour_bucket AS h, model_group AS g, SUM(in_tok+out_tok+cache_r+cache_c) AS tok FROM usage_rollup WHERE ${win}${inFrag} GROUP BY h, g ORDER BY h`,
		)
		.all(from, to, ...allow) as { h: number; g: string; tok: number }[];
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
	// per-actor drill-down (the allowlist above pre-filters this query)
	const actRows = db
		.query(
			`SELECT actor, ${SUMS} FROM usage_rollup WHERE ${win}${inFrag} GROUP BY actor ORDER BY SUM(in_tok+out_tok+cache_r+cache_c) DESC`,
		)
		.all(from, to, ...allow) as { actor: string }[];
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
			`SELECT hour_bucket AS h, SUM(out_tok) AS o FROM usage_rollup WHERE ${win}${inFrag} GROUP BY h ORDER BY h DESC LIMIT 1`,
		)
		.get(to - 86_400_000, to, ...allow) as { h: number; o: number } | null;
	const rate = {
		tokPerSec: last ? Math.round((num(last.o) / 3600) * 100) / 100 : 0,
		hourBucket: last ? num(last.h) : to,
	};
	// W152 chip facets from the FULL tag universe — unfiltered, so chips
	// stay switchable while a filter is active.
	const teamsAll = new Set<string>();
	const deptsAll = new Set<string>();
	for (const raw of tagsOf.values()) {
		try {
			const tg = JSON.parse(raw) as Record<string, unknown>;
			if (typeof tg.team === "string") teamsAll.add(tg.team);
			if (typeof tg.department === "string") deptsAll.add(tg.department);
		} catch {
			// unparseable tags stamp no chips
		}
	}
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
		facets: {
			teams: [...teamsAll].sort(),
			depts: [...deptsAll].sort(),
		},
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
