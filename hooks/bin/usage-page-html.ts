// hooks/bin/usage-page-html.ts — W127 phase 3: the server-rendered /usage
// dashboard (Copilot-style: stat tiles, stacked-by-model-group timeline with
// a 7/28d timeframe selector, hour-of-day histogram, per-actor drill-down
// table, team/department filter). Pure string builder over UsageReport —
// inline SVG, no framework, board dark palette. Follows the dataviz method:
// form first (tiles/magnitude → stacked area/composition+time, histogram/
// distribution, table/drill-down), categorical color by identity in FIXED
// group order, palette VALIDATED (scripts/validate_palette.js, mode dark,
// surface #1c1b19 — all checks pass), 2px surface gaps between stacked
// fills, 4px-rounded data-ends, recessive grid, native <title> hovers, and
// the table itself is the accessible table view.
import { GROUPS, type UsageReport } from "../lib/usage.ts";

// validated dark categorical slots, fixed order = GROUPS (never cycled —
// color follows the entity: flash is always blue, full always orange, …)
const SLOT: Record<string, string> = {
	flash: "#3987e5",
	full: "#d95926",
	luna: "#199e70",
	local: "#c98500",
	other: "#d55181",
};

const esc = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));

// bar with a 4px-rounded data-end, anchored flat to the baseline
const roundedBar = (
	x: number,
	y: number,
	w: number,
	h: number,
	r = 4,
): string => {
	if (h <= 0) return "";
	const rr = Math.min(r, w / 2, h);
	return `M${x.toFixed(1)},${(y + h).toFixed(1)} L${x.toFixed(1)},${(y + rr).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + rr).toFixed(1)},${y.toFixed(1)} L${(x + w - rr).toFixed(1)},${y.toFixed(1)} Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + rr).toFixed(1)} L${(x + w).toFixed(1)},${(y + h).toFixed(1)} Z`;
};

// ─── timeline: stacked area by model group ───────────────────────────────
function timelineSvg(tl: UsageReport["timeline"]): string {
	const W = 720;
	const H = 190;
	const padL = 46;
	const padR = 8;
	const padT = 10;
	const padB = 22;
	const iw = W - padL - padR;
	const ih = H - padT - padB;
	const n = tl.length;
	const pt = (p: { groups: Record<string, number> }): number =>
		GROUPS.reduce((a, g) => a + p.groups[g], 0);
	const max = Math.max(1, ...tl.map(pt));
	const xAt = (i: number): number =>
		padL + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
	const yAt = (v: number): number => padT + ih - (v / max) * ih;
	const parts: string[] = [];
	// recessive grid first — bands paint OVER the hairlines (dataviz mark order)
	for (let q = 1; q <= 3; q++) {
		const v = (max * q) / 4;
		const y = yAt(v).toFixed(1);
		parts.push(
			`<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="#2c2c2a"/>`,
		);
		parts.push(
			`<text x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#898781">${fmtTok(v)}</text>`,
		);
	}
	parts.push(
		`<line x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}" stroke="#383835"/>`,
	);
	let below = tl.map(() => 0);
	for (const g of GROUPS) {
		const top = tl.map((p, i) => below[i] + p.groups[g]);
		const gTotal = tl.reduce((a, p) => a + p.groups[g], 0);
		if (gTotal > 0) {
			const d: string[] = [];
			for (let i = 0; i < n; i++)
				d.push(`${xAt(i).toFixed(1)},${yAt(top[i]).toFixed(1)}`);
			for (let i = n - 1; i >= 0; i--)
				d.push(`${xAt(i).toFixed(1)},${yAt(below[i]).toFixed(1)}`);
			const seg = `<path d="M${d.join(" L")}Z" fill="${SLOT[g]}"`;
			parts.push(`${seg} stroke="#1c1b19" stroke-width="2">`);
			parts.push(`<title>${g}: ${fmtTok(gTotal)} tok</title></path>`);
		}
		below = top;
	}
	for (let i = 0; i < n; i++) {
		if (new Date(tl[i].bucket).getHours() !== 0) continue;
		parts.push(
			`<text x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#898781">${esc(new Date(tl[i].bucket).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }))}</text>`,
		);
	}
	return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="tokens by hour, stacked by model group">${parts.join("")}</svg>`;
}

// ─── hour-of-day histogram (distribution, single series → slot 1) ─────────
function hourSvg(byHour: UsageReport["byHour"]): string {
	const W = 720;
	const H = 120;
	const padL = 46;
	const padR = 8;
	const padT = 8;
	const padB = 20;
	const iw = W - padL - padR;
	const ih = H - padT - padB;
	const max = Math.max(1, ...byHour.map((h) => h.tokens));
	const bw = iw / 24;
	const parts: string[] = [];
	// recessive grid first — bars paint OVER the hairlines, never under
	for (let q = 1; q <= 2; q++) {
		const v = (max * q) / 3;
		const y = padT + ih - (v / max) * ih;
		parts.push(
			`<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2c2c2a"/>`,
		);
		parts.push(
			`<text x="${padL - 6}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#898781">${fmtTok(v)}</text>`,
		);
	}
	for (const h of byHour) {
		const bh = (h.tokens / max) * ih;
		if (bh <= 0) continue;
		const x = padL + h.hour * bw;
		const y = padT + ih - bh;
		parts.push(
			`<path d="${roundedBar(x + 1, y, bw - 2, bh, 3)}" fill="#3987e5"><title>${String(h.hour).padStart(2, "0")}:00 — ${fmtTok(h.tokens)} tok</title></path>`,
		);
	}
	parts.push(
		`<line x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}" stroke="#383835"/>`,
	);
	for (let hh = 0; hh < 24; hh += 3) {
		const x = padL + hh * bw + bw / 2;
		parts.push(
			`<text x="${x.toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9" fill="#898781">${String(hh).padStart(2, "0")}</text>`,
		);
	}
	return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="tokens by hour of day">${parts.join("")}</svg>`;
}

// ─── stat tiles / legend / filter rows ───────────────────────────────────
function tilesHtml(r: UsageReport): string {
	const byModel = new Map<string, number>();
	for (const a of r.actors)
		for (const m of a.byModel)
			byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.tok);
	const topModel = [...byModel.entries()].sort((x, y) => y[1] - x[1])[0];
	const cells: [string, string][] = [
		["ACTIVE ACTORS", String(r.actors.length)],
		["TOTAL TOKENS", fmtTok(r.totals.tok)],
		["REQUESTS", fmtTok(r.totals.rq)],
		["MOST-USED MODEL", topModel ? esc(topModel[0]) : "—"],
		["OUTPUT TOK/S (RECENT)", String(r.rate.tokPerSec)],
	];
	return `<div class="utiles">${cells
		.map(
			([k, v]) =>
				`<div class="utile"><div class="uv">${v}</div><div class="uk">${k}</div></div>`,
		)
		.join("")}</div>`;
}

function legendHtml(): string {
	const items = GROUPS.map(
		(g) => `<span><i style="background:${SLOT[g]}"></i>${g}</span>`,
	);
	return `<div class="ulegend">${items.join("")}</div>`;
}

function filterHtml(days: number, team: string, teams: string[]): string {
	const q = (t: string): string =>
		`days=${days}${t ? `&amp;team=${encodeURIComponent(t)}` : ""}`;
	const tLinks = [7, 28]
		.map((d) => {
			const on = d === days ? " on" : "";
			return `<a class="ufilter${on}" href="/usage?days=${d}">${d}d</a>`;
		})
		.join("");
	const cLinks = ["", ...teams]
		.map((t) => {
			const on = t === team ? " on" : "";
			const label = t ? esc(t) : "all teams";
			return `<a class="ufchip${on}" href="/usage?${q(t)}">${label}</a>`;
		})
		.join("");
	return `<div class="ufilters"><span class="ufgroup">${tLinks}</span><span class="ufgroup">${cLinks}</span></div>`;
}

// ─── per-actor drill-down table ──────────────────────────────────────────
function actorRows(r: UsageReport, team: string): string {
	const actors = team
		? r.actors.filter((a) => {
				const t = a.tags as { team?: string } | null;
				return t?.team === team;
			})
		: r.actors;
	if (!actors.length) return `<p class="uempty">no actors in this filter</p>`;
	const maxTok = Math.max(1, ...actors.map((a) => a.totals.tok));
	const rows = actors.map((a) => {
		const tags = (a.tags ?? {}) as Record<string, string>;
		const chips = ["team", "department"]
			.filter((k) => tags[k])
			.map((k) => `<span class="uchip">${esc(tags[k])}</span>`)
			.join("");
		const segs = GROUPS.map((g) => {
			const tok = a.byModel
				.filter((m) => m.group === g)
				.reduce((x, m) => x + m.tok, 0);
			if (!tok) return "";
			const pct = (a.totals.tok ? (tok / a.totals.tok) * 100 : 0).toFixed(2);
			return `<i style="width:${pct}%;background:${SLOT[g]}" title="${g}: ${fmtTok(tok)} tok"></i>`;
		}).join("");
		const models = a.byModel
			.map(
				(m) =>
					`<tr><td><i class="udot" style="background:${SLOT[m.group]}"></i>${esc(m.model)}</td><td class="unum">${fmtTok(m.tok)}</td><td class="unum">${fmtTok(m.rq)}</td></tr>`,
			)
			.join("");
		const barW = Math.max(2, (a.totals.tok / maxTok) * 100);
		const detail = `<tr class="udetail"><td colspan="4"><details><summary>per-model</summary><table class="umtab"><thead><tr><th>model</th><th class="unum">tokens</th><th class="unum">req</th></tr></thead><tbody>${models}</tbody></table></details></td></tr>`;
		const main = `<tr class="uact"><td><b>${esc(a.actor)}</b>${chips}</td><td><div class="ubar" style="width:${barW.toFixed(1)}%">${segs}</div></td><td class="unum">${fmtTok(a.totals.tok)}</td><td class="unum">${fmtTok(a.totals.rq)}</td></tr>`;
		return main + detail;
	});
	return rows.join("");
}

// ─── page CSS (scoped u*) — board dark palette, dataviz chrome ───────────
const U_CSS = `
.utiles { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
.utile { flex:1 1 130px; background:#1c1b19; border:1px solid rgba(255,255,255,.10); border-radius:3px; padding:10px 14px; }
.uv { font-size:22px; font-weight:600; color:#e8e6e1; }
.uk { font-size:10px; color:#98958e; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
.upanel { background:#1c1b19; border:1px solid rgba(255,255,255,.10); border-radius:3px; padding:12px 14px 8px; margin-bottom:14px; }
.upanel h2 { margin:0 0 6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#98958e; }
.ulegend { display:flex; gap:14px; font-size:11px; color:#c3c2b7; margin:0 0 8px; flex-wrap:wrap; }
.ulegend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
.ufilters { display:flex; gap:18px; align-items:center; margin:0 0 14px; }
.ufgroup { display:flex; gap:6px; }
.ufilter, .ufchip { font-size:11px; color:#98958e; text-decoration:none; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:2px 9px; }
.ufilter.on, .ufchip.on { color:#d8900f; border-color:#d8900f; }
table.uacts { width:100%; border-collapse:collapse; font-size:12px; }
table.uacts td, table.uacts th { padding:6px 8px; border-bottom:1px solid #2c2c2a; text-align:left; }
.unum { text-align:right; font-variant-numeric:tabular-nums; color:#c3c2b7; white-space:nowrap; }
.ubar { display:flex; height:12px; border-radius:3px; overflow:hidden; min-width:2px; }
.ubar i { display:block; height:100%; }
.udot { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:6px; }
.uchip { font-size:10px; color:#98958e; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:1px 6px; margin-left:6px; }
tr.udetail td { padding-top:0; border-bottom:none; }
tr.udetail details { font-size:11px; color:#98958e; }
tr.udetail summary { cursor:pointer; }
table.umtab { margin:6px 0 10px; border-collapse:collapse; }
table.umtab td, table.umtab th { padding:2px 10px 2px 0; font-size:11px; text-align:left; color:#c3c2b7; }
.uempty { color:#98958e; font-size:12px; }
`;

// ─── page assembly ───────────────────────────────────────────────────────
export function usagePage(
	r: UsageReport,
	opts: { days: number; team?: string } = { days: r.days },
): string {
	const team = opts.team ?? "";
	const teams = [
		...new Set(
			r.actors
				.map((a) => (a.tags as { team?: string } | null)?.team)
				.filter((t): t is string => Boolean(t)),
		),
	].sort();
	const head =
		`<h1 class="utitle">USAGE</h1>` +
		filterHtml(r.days, team, teams) +
		tilesHtml(r);
	const timeline = `<div class="upanel"><h2>TOKENS · STACKED BY MODEL GROUP</h2>${legendHtml()}${timelineSvg(r.timeline)}</div>`;
	const hours = `<div class="upanel"><h2>WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)</h2>${hourSvg(r.byHour)}</div>`;
	const tbl = `<div class="upanel"><h2>ACTORS</h2><table class="uacts"><thead><tr><th>actor</th><th style="width:38%">tokens by model group</th><th class="unum">total</th><th class="unum">req</th></tr></thead><tbody>${actorRows(r, team)}</tbody></table></div>`;
	const back = `<div class="uback"><a href="/">&larr; fleet board</a><span class="uwin">${r.days}d window · buckets UTC-hourly · charts read usage_rollup</span></div>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>FLEET USAGE</title><style>body{background:#141413;color:#e8e6e1;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:16px 20px 28px;}a{color:#d8900f}.utitle{font-size:14px;letter-spacing:.08em;margin:0 0 10px;color:#e8e6e1}${U_CSS}</style></head><body>${back}${head}${timeline}${hours}${tbl}</body></html>`;
}
