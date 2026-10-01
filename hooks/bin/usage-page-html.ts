// hooks/bin/usage-page-html.ts — W152: /usage rebuilt Grafana-grade on
// vendored uPlot (the time-series engine behind Grafana's charts, MIT).
// Server-rendered chrome + embedded uPlot-ready JSON payload; the client
// renderer (usage-charts.ts) draws the panels. NO CDN — uPlot's IIFE + css
// are vendored under hooks/bin/vendor/ (license headers preserved) and
// inlined, so the LAN-only board renders with the network down.
//
// Panels: stat tiles row → stacked-area timeline by model group with a
// 7/28d timeframe selector → hour-of-day histogram → per-actor table with
// inline stacked-by-model bars + per-model drill-down → aid-ROI panel that
// degrades honestly until aid_events land (W142 seam). Team/DEPARTMENT
// filter chips are server-side and cut the whole dashboard (the report is
// filtered in buildUsageReport), and every view is a shareable URL: days,
// team, dept all live in the query string.
//
// W127 dataviz discipline kept: form first, categorical color by identity
// in FIXED group order (never cycled — flash is always blue), palette
// validated against surface #1c1b19, recessive grid, muted axis ink,
// tabular-nums, native <title> hovers on the non-uPlot marks, dark palette.
import { readFileSync } from "node:fs";
import { GROUPS, type UsageReport } from "../lib/usage.ts";
// W147: every page wears the console shell — topbar + avatar dropdown JS
import { TOPBAR_JS, topbar } from "./console-html.ts";
import { USAGE_CHART_JS } from "./usage-charts.ts";

// uPlot 1.6.32 (MIT, © Leon Sorokin, https://github.com/leeoniya/uPlot) —
// vendored single file, license header preserved at the top of the source.
// Read at render time relative to this module; inlined per page load.
const UPILOT_SRC = readFileSync(
	new URL("./vendor/uPlot.iife.min.js", import.meta.url),
	"utf8",
);
const UPLOT_CSS = readFileSync(
	new URL("./vendor/uPlot.min.css", import.meta.url),
	"utf8",
);

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

// ─── uPlot-ready payload (embedded as #usage-data JSON) ──────────────────
// Columnar on purpose: timeline = [x, flash, full, luna, local, other] with
// x in unix SECONDS (uPlot's native shape), byHour = [0..23, tokens]. The
// client renderer mounts them directly — zero reshaping in browser JS.
const chartPayload = (r: UsageReport): string =>
	JSON.stringify({
		groups: GROUPS,
		slot: SLOT,
		timeline: [
			r.timeline.map((p) => Math.round(p.bucket / 1000)),
			...GROUPS.map((g) => r.timeline.map((p) => p.groups[g])),
		],
		byHour: [r.byHour.map((h) => h.hour), r.byHour.map((h) => h.tokens)],
	});

// ─── stat tiles row ───────────────────────────────────────────────────────
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

// ─── filter row: timeframe + team/department chips (server-side) ──────────
// State is the query string itself — chips toggle by rewriting only their
// own param, so any dashboard view is a shareable URL. Facet lists come
// from the UNFILTERED tag universe (report.facets) so chips stay switchable
// while a filter is active.
function filterHtml(
	r: UsageReport,
	days: number,
	team: string,
	dept: string,
): string {
	const teams = r.facets.teams;
	const depts = r.facets.depts;
	const href = (over: {
		days?: number;
		team?: string | null;
		dept?: string | null;
	}): string => {
		const p = new URLSearchParams();
		p.set("days", String(over.days ?? days));
		const t = over.team !== undefined ? over.team : team;
		if (t) p.set("team", t);
		const d = over.dept !== undefined ? over.dept : dept;
		if (d) p.set("dept", d);
		return `/usage?${p.toString()}`;
	};
	const tLinks = [7, 28]
		.map(
			(dd) =>
				`<a class="ufilter${dd === days ? " on" : ""}" href="${esc(href({ days: dd }))}">${dd}d</a>`,
		)
		.join("");
	const chip = (v: string, cur: string, key: "team" | "dept"): string =>
		`<a class="ufchip${v && v === cur ? " on" : ""}" href="${esc(href({ [key]: v || null }))}">${v ? esc(v) : "all"}</a>`;
	const group = (label: string, inner: string): string =>
		`<span class="ufgroup" data-label="${label}">${inner}</span>`;
	const teamChips = group(
		"team",
		["", ...teams].map((v) => chip(v, team, "team")).join(""),
	);
	const deptChips = group(
		"dept",
		["", ...depts].map((v) => chip(v, dept, "dept")).join(""),
	);
	// W179.1: the billing export rides the same filter state as the
	// dashboard — one click, current window/team/dept preserved.
	const csvParams = new URLSearchParams();
	csvParams.set("days", String(days));
	if (team) csvParams.set("team", team);
	if (dept) csvParams.set("dept", dept);
	const csv = `<a class="ufilter" href="/api/usage/export.csv?${csvParams.toString()}" download>export csv</a>`;
	const active = [
		team ? `team=${team}` : "",
		dept ? `dept=${dept}` : "",
	].filter(Boolean);
	const labels = active.length
		? ` <span class="uon">dashboard filtered: ${esc(active.join(", "))}</span>`
		: "";
	return `<div class="ufilters">${group(
		"window",
		tLinks,
	)}${teamChips}${deptChips}${group("export", csv)}${labels}</div>`;
}

// ─── per-actor drill-down table (the report arrives pre-filtered) ─────────
function actorRows(r: UsageReport): string {
	if (!r.actors.length) return `<p class="uempty">no actors in this filter</p>`;
	const maxTok = Math.max(1, ...r.actors.map((a) => a.totals.tok));
	const rows = r.actors.map((a) => {
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

// ─── aid-ROI panel: the W142 seam, honest when empty ──────────────────────
function aidsHtml(r: UsageReport): string {
	if (!r.aids)
		return `<div class="upanel"><h2>AID ROI · W142 SEAM</h2><p class="uempty">no aid events yet — this panel lights up when aid_events land (knowledge-aids metering)</p></div>`;
	const roll = r.aids.rollup
		.map(
			(a) =>
				`<tr><td><b>${esc(a.aid)}</b></td><td>${esc(a.domain)}</td><td class="unum">${fmtTok(a.injected)}</td><td class="unum">${fmtTok(a.skipped)}</td><td class="unum">${fmtTok(a.tok_injected)}</td></tr>`,
		)
		.join("");
	return `<div class="upanel"><h2>AID ROI · INJECTED VS SKIPPED</h2><p class="ufoot">${r.aids.join.length} aid-joined session hours in window · join: aid_events(sid) ⋈ sessions(sid→actor) ⋈ usage_rollup(actor, hour)</p><table class="uacts"><thead><tr><th>aid</th><th>domain</th><th class="unum">injected</th><th class="unum">skipped</th><th class="unum">tok injected</th></tr></thead><tbody>${roll}</tbody></table></div>`;
}

// ─── page CSS (scoped u*) — board dark palette, dataviz chrome ────────────
const U_CSS = `
.utiles { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
.utile { flex:1 1 150px; background:#1c1b19; border:1px solid rgba(255,255,255,.10); border-radius:3px; padding:10px 14px; }
.uv { font-size:22px; font-weight:600; color:#e8e6e1; font-variant-numeric:tabular-nums; word-break:break-all; }
.uk { font-size:10px; color:#98958e; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
.uback { display:flex; gap:16px; align-items:baseline; margin:12px 0 0; }
.uwin { font-size:10.5px; color:#98958e; }
.upanel { background:#1c1b19; border:1px solid rgba(255,255,255,.10); border-radius:3px; padding:12px 14px 10px; margin-bottom:14px; }
.upanel h2 { margin:0 0 6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#98958e; }
.upanel .uhead { display:flex; align-items:baseline; gap:12px; }
.upanel .uhead .ufoot { margin:0; }
.ulegend { display:flex; gap:14px; font-size:11px; color:#c3c2b7; margin:0 0 8px; flex-wrap:wrap; }
.ulegend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
.ufilters { display:flex; gap:18px; align-items:center; margin:0 0 14px; flex-wrap:wrap; }
.ufgroup { display:flex; gap:6px; align-items:center; }
.ufgroup::before { content:attr(data-label); font-size:9.5px; color:#98958e; text-transform:uppercase; letter-spacing:.06em; }
.ufilter, .ufchip { font-size:11px; color:#98958e; text-decoration:none; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:2px 9px; }
.ufilter.on, .ufchip.on { color:#d8900f; border-color:#d8900f; }
.uon { font-size:10.5px; color:#d8900f; }
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
.ufoot { font-size:10.5px; color:#98958e; margin:2px 0 8px; }
.uchart { width:100%; }
/* uPlot chrome on the board dark palette: recessive grid + muted axis ink
   are also set per-axis in usage-charts.ts; these style the live legend */
.uplot .u-legend { font: 10.5px/1.7 ui-monospace,Menlo,monospace; color:#c3c2b7; text-transform:uppercase; letter-spacing:.04em; }
.uplot .u-legend .u-value { font-variant-numeric:tabular-nums; color:#e8e6e1; }
.uplot .u-legend .u-series.u-off { opacity:.4; }
.uplot .u-marker { width:9px; height:9px; border-radius:2px; }
.uplot text { font-size:10px; }
`;

// ─── page assembly ───────────────────────────────────────────────────────
function legendHtml(): string {
	const items = GROUPS.map(
		(g) => `<span><i style="background:${SLOT[g]}"></i>${g}</span>`,
	);
	return `<div class="ulegend">${items.join("")}</div>`;
}

export function usagePage(
	r: UsageReport,
	opts: { days: number; team?: string; dept?: string } = { days: r.days },
): string {
	const team = opts.team ?? "";
	const dept = opts.dept ?? "";
	const head =
		`<h1 class="utitle">USAGE</h1>` +
		filterHtml(r, r.days, team, dept) +
		tilesHtml(r);
	const timeline = `<div class="upanel"><div class="uhead"><h2>TOKENS · STACKED BY MODEL GROUP</h2><p class="ufoot">hover = values · drag = zoom · double-click = reset</p></div>${legendHtml()}<div id="u-timeline" class="uchart"></div></div>`;
	const hours = `<div class="upanel"><h2>WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)</h2><div id="u-hours" class="uchart"></div></div>`;
	const tbl = `<div class="upanel"><h2>ACTORS</h2><table class="uacts"><thead><tr><th>actor</th><th style="width:38%">tokens by model group</th><th class="unum">total</th><th class="unum">req</th></tr></thead><tbody>${actorRows(r)}</tbody></table></div>`;
	const back = `<div class="uback"><a href="/">&larr; fleet board</a><span class="uwin">${r.days}d window · buckets UTC-hourly · charts read usage_rollup · filter state lives in the URL — copy the address bar to share this exact view</span></div>`;
	const scripts = `<style>${UPLOT_CSS}</style><script type="application/json" id="usage-data">${chartPayload(r)}</script><script>${TOPBAR_JS}</script><script>${USAGE_CHART_JS}</script>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>FLEET USAGE</title><style>body{background:#141413;color:#e8e6e1;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;padding:0 20px 28px;}a{color:#d8900f}.utitle{font-size:14px;letter-spacing:.08em;margin:14px 0 10px;color:#e8e6e1}${U_CSS}</style></head><body>${topbar("suspenders")}<main style="max-width:1060px;margin:0 auto">${back}${head}${timeline}${hours}${tbl}${aidsHtml(r)}</main><script>${UPILOT_SRC}</script>${scripts}</body></html>`;
}
