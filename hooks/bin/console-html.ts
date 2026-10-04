// hooks/bin/console-html.ts — W147: the console shell + server-rendered
// console pages (belt gateway view, local services view, settings). Pure
// string builders on the klh theme tokens (hooks/lib/theme.ts — var(--klh-*),
// dark/light via data-theme), inline SVG, no framework, no external deps.
//
// The top bar is the klh-stack shell: the shared klh·fleet strip (theme.ts
// fleetNav — belt · suspenders · local, the same row belt.local and bar.local
// wear) above the console bar: wordmark + [belt gateway | fleet board | local
// services] menu, gear → settings panel (theme + console settings link), avatar circle with a keyboard-reachable actor
// dropdown. The SPA board interpolates TOPBAR the same way (String.raw
// interpolates ${}; only escapes are raw), so every page wears one shell.
//
// Settings flow (config-over-code, never a code edit): form →
// /console/settings/preview (validate + diff) → confirm form →
// /console/settings/apply (mtime guard + atomic write). Invalid config is
// rejected with the parser's own error, verbatim.
import type {
	BoardSettingsState,
	PolicyGatewayParsed,
	ResolvedPolicy,
} from "../lib/board-config.ts";
import { scrub } from "../lib/servicemon.ts";
import {
	FLEET_NAV_CSS,
	FLEET_NAV_JS,
	fleetNav,
	settingsBlock,
	THEME_HEAD,
	THEME_SETTINGS_CSS,
	THEME_SETTINGS_JS,
} from "../lib/theme.ts";
import type { RecoveryEntry } from "../lib/recovery-map.ts";
import type { ServiceProbe } from "../board/service-probe.ts";

export interface ConsoleMe {
	actor: string;
	tags: Record<string, string>;
	actors: string[];
	defaultActor: string;
}

// ─── shared chrome ────────────────────────────────────────────────────────
export const esc = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const SHELL_CSS = `
#cbbar { display:none; }
#klh-fleetnav { margin:0; padding:var(--klh-space-2) var(--klh-space-5); background:var(--klh-panel); }
#cbar { display:flex; align-items:center; gap:14px; padding:7px 16px; border-bottom:1px solid var(--klh-edge-soft); background:var(--klh-panel); position:sticky; top:0; z-index:50; }
#cbar .cw { font-size:12px; font-weight:700; letter-spacing:.10em; color:var(--klh-ink); text-decoration:none; white-space:nowrap; }
#cbar .cwdot { color:var(--klh-accent); }
#cbar .cnavs { display:flex; gap:2px; }
#cbar .cnav { color:var(--klh-dim); text-decoration:none; font-size:12px; font-weight:600; letter-spacing:.04em; padding:7px 11px; border-bottom:2px solid transparent; }
#cbar .cnav:hover { color:var(--klh-ink); }
#cbar .cnav[aria-current] { color:var(--klh-ink); border-bottom-color:var(--klh-accent); }
#cbar .cend { margin-left:auto; display:flex; align-items:center; gap:12px; }
.cavwrap { position:relative; }
.cavbtn { width:26px; height:26px; border-radius:50%; border:1px solid var(--klh-edge-strong); background:var(--klh-surface-hi); color:var(--klh-ink); font:600 11px/1 var(--klh-font-sans); cursor:pointer; padding:0; }
.cavbtn:hover, .cavbtn[aria-expanded="true"] { border-color:var(--klh-accent); color:var(--klh-accent); }
.cavdrop { position:absolute; right:0; top:32px; width:260px; background:var(--klh-surface); border:1px solid var(--klh-edge); border-radius:3px; padding:10px 12px; box-shadow:0 4px 18px var(--klh-shadow); }
.cavhead { display:flex; gap:9px; align-items:center; }
.cavbig { width:30px; height:30px; border-radius:50%; border:1px solid var(--klh-edge-strong); background:var(--klh-surface-hi); color:var(--klh-ink); font:600 13px/30px var(--klh-font-sans); text-align:center; flex:none; }
.cavname { font-size:12.5px; color:var(--klh-ink); font-weight:600; word-break:break-all; }
.cavsub { font-size:10.5px; color:var(--klh-dim); }
.cavsec { margin-top:9px; font-size:10px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; }
.cavdrop select { width:100%; margin-top:4px; }
.cavnote { margin-top:7px; font-size:10.5px; color:var(--klh-dim); }
`;

const initial = (actor: string): string =>
	actor && actor !== "unassigned" ? actor.charAt(0).toUpperCase() : "?";

const tagLine = (tags: Record<string, string>): string =>
	["team", "department"]
		.filter((k) => tags[k])
		.map((k) => esc(tags[k]))
		.join(" · ") || "no team tags";

// ─── top bar (the klh-stack shell, identical on every page) ───────────────
export const topbar = (
	active: "belt" | "suspenders" | "local" | "settings" | "",
	me?: ConsoleMe,
): string => {
	const cur = (k: string): string =>
		k === active ? ` aria-current="page"` : "";
	const actor = me?.actor ?? "unassigned";
	const sel = (): string => {
		const opts = me.actors.includes(me.defaultActor)
			? me.actors
			: [me.defaultActor, ...me.actors];
		return `<select id="cavsel" aria-label="switch actor (demo preview)">${opts.map((a) => `<option${a === me.defaultActor ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>`;
	};
	const dropInner = me
		? `<div class="cavhead"><span class="cavbig">${esc(initial(actor))}</span><span><span class="cavname">${esc(actor)}</span><br><span class="cavsub">${tagLine(me.tags)}</span></span></div><div class="cavsec">switch actor (demo preview)</div>${sel()}<div class="cavnote">demo preview — stamps nothing live; live switching is a follow-up item</div>`
		: `<div class="cavname" id="cavload">loading actor…</div>`;
	return `<style>${SHELL_CSS}${THEME_SETTINGS_CSS}${FLEET_NAV_CSS}</style>${fleetNav("suspenders")}<nav id="cbar" aria-label="klh console"><a class="cw" href="/">klh<span class="cwdot">·</span>console</a><span class="cnavs"><a class="cnav"${cur("belt")} href="/console/belt">belt gateway</a><a class="cnav"${cur("suspenders")} href="/">fleet board</a><a class="cnav"${cur("local")} href="/console/local">local services</a></span><span class="cend">${settingsBlock(`<a${cur("settings")} href="/console/settings">all console settings &rarr;</a>`)}<span class="cavwrap"><button type="button" id="cavbtn" class="cavbtn" aria-haspopup="true" aria-expanded="false" aria-label="current actor">${esc(initial(actor))}</button><span id="cavdrop" class="cavdrop" hidden>${dropInner}</span></span></span></nav>`;
};

// Dropdown behavior: click toggles, outside-click + Escape close (focus
// returns to the button). When the panel was NOT server-rendered (the SPA
// board), one /api/console/me fetch fills actor/tags/demo select.
const TOPBAR_JS_A = `(function(){
var btn=document.getElementById('cavbtn'),drop=document.getElementById('cavdrop');
if(!btn||!drop)return;
var open=false;
function set(o){open=o;drop.hidden=!o;btn.setAttribute('aria-expanded',o?'true':'false');}
btn.addEventListener('click',function(e){e.stopPropagation();set(!open);});
document.addEventListener('click',function(e){if(open&&e.target instanceof Node&&!drop.contains(e.target))set(false);});
document.addEventListener('keydown',function(e){if(open&&e.key==='Escape'){set(false);btn.focus();}});`;

// Panel fill for the SPA (no server-rendered me): one /api/console/me fetch
// builds the same panel the console pages render server-side.
const TOPBAR_JS_B = `
if(document.getElementById('cavload')){
fetch('/api/console/me').then(function(r){return r.json()}).then(function(d){
if(!d||!d.ok)return;
window.__execPrefs=(d.executor_prefs||[]);
var head=document.createElement('div');head.className='cavhead';
head.innerHTML='<span class="cavbig"></span><span><span class="cavname"></span><br><span class="cavsub"></span></span>';
head.querySelector('.cavbig').textContent=(d.actor&&d.actor!=='unassigned')?d.actor.charAt(0).toUpperCase():'?';
head.querySelector('.cavname').textContent=d.actor||'unassigned';
var tg=(d.tags&&d.tags.team?d.tags.team:'')+(d.tags&&d.tags.department?(d.tags.team?' · ':'')+d.tags.department:'');
head.querySelector('.cavsub').textContent=tg||'no team tags';
var load=document.getElementById('cavload');load.replaceWith(head);
var sec=document.createElement('div');sec.className='cavsec';sec.textContent='switch actor (demo preview)';head.after(sec);
var sel=document.createElement('select');sel.id='cavsel';sel.setAttribute('aria-label','switch actor (demo preview)');
var opts=(d.actors&&d.actors.length)?d.actors.slice():[];
if(d.default_actor&&opts.indexOf(d.default_actor)<0)opts.unshift(d.default_actor);
if(!opts.length)opts=['unassigned'];
opts.forEach(function(a){var o=document.createElement('option');o.textContent=a;if(a===d.default_actor)o.selected=true;sel.appendChild(o);});
sec.after(sel);
var note=document.createElement('div');note.className='cavnote';note.textContent='demo preview — stamps nothing live; live switching is a follow-up item';sel.after(note);
}).catch(function(){});}
})();`;
export const TOPBAR_JS =
	TOPBAR_JS_A + TOPBAR_JS_B + THEME_SETTINGS_JS + FLEET_NAV_JS;

// ─── page shell ───────────────────────────────────────────────────────────
export const consolePage = (
	title: string,
	active: "belt" | "suspenders" | "local" | "settings" | "",
	body: string,
	me?: ConsoleMe,
): string =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${THEME_HEAD}<style>body{background:var(--klh-bg);color:var(--klh-ink);font:13px/1.45 var(--klh-font-sans);margin:0;padding:0 20px 28px;}a{color:var(--klh-accent)}.ptitle{font-size:14px;letter-spacing:.08em;margin:16px 0 10px;color:var(--klh-ink)}.panel{background:var(--klh-surface);border:1px solid var(--klh-edge-soft);border-radius:3px;padding:12px 14px;margin:0 0 14px}.panel h2{margin:0 0 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--klh-dim)}.dim{color:var(--klh-dim)}.ok{color:var(--klh-ok)}.bad{color:var(--klh-danger-ink)}table.ct{width:100%;border-collapse:collapse;font-size:12px}table.ct td,table.ct th{padding:5px 8px;border-bottom:1px solid var(--klh-rule);text-align:left}table.ct th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--klh-dim)}.num{font-variant-numeric:tabular-nums}.btn{background:var(--klh-accent);color:var(--klh-on-accent);border:1px solid var(--klh-accent);border-radius:2px;padding:5px 14px;font:inherit;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;cursor:pointer}.btn2{background:var(--klh-bg);color:var(--klh-ink);border:1px solid var(--klh-edge-strong);border-radius:2px;padding:5px 12px;font:inherit;font-size:11px;cursor:pointer;text-decoration:none;display:inline-block}input,select,textarea{background:var(--klh-bg);color:var(--klh-ink);border:1px solid var(--klh-edge);border-radius:2px;padding:5px 8px;font:12px var(--klh-font-mono)}label.k{display:block;font-size:10px;color:var(--klh-dim);text-transform:uppercase;letter-spacing:.06em;margin:8px 0 3px}input.wide{width:100%}.flash{border:1px solid var(--klh-ok);color:var(--klh-ok-hi);background:var(--klh-ok-bg);border-radius:2px;padding:7px 10px;font-size:12px;margin:0 0 14px}.errbox{border:1px solid var(--klh-danger);color:var(--klh-danger-ink);background:var(--klh-danger-bg);border-radius:2px;padding:7px 10px;font-size:12px;margin:0 0 14px;white-space:pre-wrap;word-break:break-word}pre.diff{background:var(--klh-bg);border:1px solid var(--klh-edge);border-radius:2px;padding:10px 12px;font:11px/1.5 var(--klh-font-mono);overflow:auto}pre.diff .add{color:var(--klh-ok-hi);display:block}pre.diff .del{color:var(--klh-danger-ink);display:block}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}@media (max-width:700px){.formgrid{grid-template-columns:1fr}}.cfoot{font-size:10.5px;color:var(--klh-dim);margin-top:4px}</style></head><body>${topbar(active, me)}<main style="max-width:980px;margin:0 auto"><h1 class="ptitle">${esc(title)}</h1>${body}<div class="cfoot">klh console · part of the suspenders fleet board</div></main><script>${TOPBAR_JS}</script></body></html>`;

// ─── belt gateway view (/console/belt) ────────────────────────────────────
// W273: a probe row carries its recovery-map entry (null = unmapped)
export type HealthProbe = ServiceProbe & { recovery: RecoveryEntry | null };

export interface UpstreamGroup {
	name: string;
	tiers: number;
	dormant: boolean;
}

export interface BeltView {
	policy: ResolvedPolicy | null;
	gateway: PolicyGatewayParsed | null;
	policyError: string | null;
	beltApi: { url: string; via: string } | null;
	health: HealthProbe[];
	groups: UpstreamGroup[] | null;
}

const ladderHtml = (gw: PolicyGatewayParsed): string =>
	`<table class="ct"><thead><tr><th>model</th><th>fallback ladder (order = priority)</th></tr></thead><tbody>${Object.entries(
		gw.fallbacks,
	)
		.map(
			([m, tiers]) =>
				`<tr><td><b>${esc(m)}</b></td><td>${tiers.map((t, i) => `<span class="pill">${i + 1}. ${esc(t)}</span>`).join(" → ")}</td></tr>`,
		)
		.join("")}</tbody></table>`;

// W273: one <klh-service-row> per monitored service. The Lit component
// renders from the probe JSON attribute; the light-DOM children are the
// no-JS fallback (shadow DOM hides them once the component upgrades) —
// recovery commands are readable even if the module never loads.
const stateOf = (p: HealthProbe): string => p.state ?? (p.up ? "up" : "down");

const fallbackRecovery = (p: HealthProbe): string => {
	const r = p.recovery;
	if (!r || stateOf(p) === "up") return "";
	return `<details${stateOf(p) === "down" ? " open" : ""}><summary>how to recover</summary><p>${esc(r.what)}</p><ul>${r.causes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul><ol>${r.recovery.map((s) => `<li><span class="dim">${esc(s.label)}</span><pre class="rcmd"><code>${esc(s.cmd)}</code></pre></li>`).join("")}</ol></details>`;
};

export const serviceRowHtml = (p: HealthProbe): string => {
	const st = stateOf(p);
	const cls = st === "up" ? "ok" : "bad";
	const where = p.port ? ` :${p.port}` : "";
	return `<klh-service-row data-state="${st}" data-service="${esc(p.id)}" probe="${esc(JSON.stringify(p))}"><div class="srow"><span class="${cls}">${st.toUpperCase()}</span> <b>${esc(p.name)}</b><span class="dim">${where} · ${esc(p.detail)}</span></div>${fallbackRecovery(p)}</klh-service-row>`;
};

const healthHtml = (h: HealthProbe[]): string => {
	const dark = h.filter((p) => stateOf(p) !== "up").length;
	return `<div class="panel"><h2>Fleet services · ${h.length - dark}/${h.length} up${dark ? ` · ${dark} need recovery` : ""}</h2>${h.map(serviceRowHtml).join("")}</div><script type="module" src="/vendor/klh-service-row.js"></script>`;
};

const PILL_CSS = `.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px}.tile{flex:1 1 180px;background:var(--klh-surface);border:1px solid var(--klh-edge-soft);border-radius:3px;padding:10px 14px}.tnum{font-size:16px;font-weight:600}.tkey{font-size:10px;color:var(--klh-dim);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}.tsub{font-size:10.5px;color:var(--klh-dim);margin-top:3px}.srow{padding:4px 0}.rcmd{margin:2px 0 6px;background:var(--klh-surface);border:1px solid var(--klh-edge);border-radius:2px;padding:4px 8px;font:11px/1.5 var(--klh-font-mono);white-space:pre-wrap}.pill{display:inline-block;border:1px solid var(--klh-edge);border-radius:2px;padding:1px 7px;font-size:11px;color:var(--klh-ink-2);margin:1px 3px 1px 0}`;

// ─── belt page body ───────────────────────────────────────────────────────
const policyCard = (v: BeltView): string => {
	if (!v.policy)
		return `<div class="panel"><h2>Routing policy</h2><p class="dim">no routing-policy.yaml found on the belt chain (BELT_POLICY/BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)</p></div>`;
	if (v.policyError)
		return `<div class="panel"><h2>Routing policy</h2><div class="errbox">resolved ${esc(scrub(v.policy.path))} does not parse: ${esc(v.policyError)}</div></div>`;
	const gw = v.gateway;
	if (!gw)
		return `<div class="panel"><h2>Routing policy</h2><p class="dim">policy resolved but no gateway section parsed</p></div>`;
	return `<div class="panel"><h2>Routing policy · ${esc(scrub(v.policy.path))} · source: ${v.policy.source}</h2><div class="knobs"><span class="kchip">num_retries: <b>${gw.num_retries}</b></span><span class="kchip">allowed_fails: <b>${gw.allowed_fails}</b></span><span class="kchip">cooldown_time: <b>${gw.cooldown_time}s</b></span></div><div class="ladder">${ladderHtml(gw)}</div></div>`;
};

const upstreamsCard = (v: BeltView): string => {
	if (!v.groups)
		return `<div class="panel"><h2>Upstream pool</h2><p class="dimpl">upstreams.yaml unreadable — the ladder above still applies</p></div>`;
	const rows = v.groups
		.map(
			(g) =>
				`<tr><td><b>${esc(g.name)}</b></td><td class="num">${g.tiers}</td><td>${g.dormant ? `<span class="bad">dormant</span>` : `<span class="ok">active</span>`}</td></tr>`,
		)
		.join("");
	return `<div class="panel"><h2>Upstream pool (buckle upstreams.yaml)</h2><table class="ct"><thead><tr><th>group</th><th>deployments</th><th>state</th></tr></thead><tbody>${rows}</tbody></table><p class="cfoot">dormant = in the ladder but resolving to zero deployments until a BUCKLE_UPSTREAMS override supplies them</p></div>`;
};

const PAGE_CSS = `.knobs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}.kchip{border:1px solid var(--klh-edge);border-radius:2px;padding:2px 8px;font-size:11.5px;color:var(--klh-ink-2)}.kchip b{color:var(--klh-ink)}.dimpl{color:var(--klh-dim);font-size:12px}.btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}`;

export const beltPage = (v: BeltView, me?: ConsoleMe): string => {
	const body =
		`<style>${PILL_CSS}${PAGE_CSS}</style>` +
		healthHtml(v.health) +
		policyCard(v) +
		upstreamsCard(v) +
		(v.beltApi
			? `<div class="panel"><h2>belt API</h2><p>reachable at <span class="mono">${esc(scrub(v.beltApi.url))}</span> <span class="dim">(via ${esc(v.beltApi.via)})</span></p><p class="cfoot">read-only view in this item — routing edits live on the settings page</p></div>`
			: `<div class="panel"><h2>belt API</h2><p class="dimpl">belt API not reachable (env → belt.json → belt.local chain) — gateway health above is probed directly</p></div>`);
	return consolePage("BELT · GATEWAY", "belt", body, me);
};

// ─── local services view (/console/local) — static registry first ─────────
export interface LocalService {
	name: string;
	port: number;
	created: string;
}

export interface LocalView {
	services: LocalService[];
	regPath: string;
	error: string | null;
	probes: ServiceProbe[];
	source: "registry" | "probes+registry" | "probes";
}

export const localPage = (v: LocalView, me?: ConsoleMe): string => {
	const upCount = v.probes.filter((p) => p.up).length;
	const probeRows = v.probes
		.map(
			(p) =>
				`<tr><td><b>${esc(p.name)}</b></td><td class="num">${p.port || "—"}</td><td class="${p.up ? "ok" : "bad"}">${p.up ? "UP" : p.state.toUpperCase()}</td><td class="dim">${esc(p.detail)}</td></tr>`,
		)
		.join("");
	const regRows = v.services
		.map(
			(s) =>
				`<tr><td><b>${esc(s.name)}</b></td><td class="num">${s.port}</td><td>—</td><td><a href="https://${esc(s.name)}.local/">https://${esc(s.name)}.local/</a> <span class="dim">· since ${esc(s.created.slice(0, 10))}</span></td></tr>`,
		)
		.join("");
	const body =
		`<style>${PAGE_CSS}</style>` +
		(v.error ? `<div class="errbox">${esc(v.error)}</div>` : "") +
		`<div class="panel"><h2>monitored fleet services — ${upCount}/${v.probes.length} up</h2>` +
		(v.probes.length
			? `<table class="ct"><thead><tr><th>service</th><th>port</th><th>state</th><th>detail</th></tr></thead><tbody>${probeRows}</tbody></table>`
			: `<p class="dimpl">no monitored services — the recovery map is empty in this deployment</p>`) +
		(v.services.length
			? `</div><div class="panel"><h2>Caddy-served .local services · registry: ${esc(scrub(v.regPath))}</h2><table class="ct"><thead><tr><th>service</th><th>port</th><th>state</th><th>url</th></tr></thead><tbody>${regRows}</tbody></table>`
			: "") +
		`<p class="cfoot">${esc(v.source)} — live probes with 15s cache (W273 recovery map); the klh/local registry shows only when present</p></div>`;
	return consolePage("LOCAL · SERVICES", "local", body, me);
};

// ─── settings (/console/settings) — one entry per feature ─────────────────
export type Feature = "belt" | "buckle" | "suspenders";

export interface PolicyCur {
	path: string;
	source: string;
	gateway: PolicyGatewayParsed | null;
	error: string | null;
}

// ─── settings form pages ──────────────────────────────────────────────────
export interface FormCur {
	gateway: PolicyGatewayParsed | null;
	polError: string | null;
	target: string;
	set: BoardSettingsState;
}

const numField = (
	label: string,
	name: string,
	val: number | undefined,
	hint: string,
): string =>
	`<div><label class="k" for="f_${name}">${label}</label><input id="f_${name}" name="${name}" type="number" step="1" min="0" value="${val ?? ""}"><div class="cfoot">${hint}</div></div>`;

const textField = (
	label: string,
	name: string,
	val: string,
	hint: string,
): string =>
	`<div><label class="k" for="f_${name}">${label}</label><input class="wide" id="f_${name}" name="${name}" type="text" value="${esc(val)}"><div class="cfoot">${hint}</div></div>`;

const FORM_CSS = `.cfield-hint{font-size:10.5px;color:var(--klh-dim);margin:2px 0 8px}`;

const ladderFields = (gw: PolicyGatewayParsed): string =>
	Object.entries(gw.fallbacks)
		.map(
			([m, tiers]) =>
				`<label class="k" for="l_${esc(m)}">ladder · ${esc(m)} (comma-separated, order = priority)</label><input class="wide" id="l_${esc(m)}" name="ladder_${esc(m)}" value="${esc(tiers.join(", "))}"><div class="cfield-hint">tiers listed are ON; removing a tier switches it off (flashx is refused outright)</div>`,
		)
		.join("");

const formFoot = `<p class="cfoot">Writes are config-over-code. belt+buckle share the policy file: belt activates at the next gateway-config emit + launchctl kickstart (between fan-outs — a reload drops in-flight streams); buckle loads the policy at boot.</p>`;

const formFrame = (
	title: string,
	head: string,
	form: string,
	me?: ConsoleMe,
): string =>
	consolePage(
		title,
		"settings",
		`<style>${FORM_CSS}</style>${head}<form method="post" action="/console/settings/preview">${form}<div class="btnrow"><button class="btn" type="submit">preview diff</button><a class="btn2" href="/console/settings">cancel</a></div></form>${formFoot}`,
		me,
	);

const HIDDEN_FEATURE = (f: Feature): string =>
	`<input type="hidden" name="feature" value="${f}">`;

export const settingsFormPage = (
	feature: Feature,
	cur: FormCur,
	me?: ConsoleMe,
): string => {
	const head = `<p class="dimpl">Target file: <span class="mono">${esc(cur.target)}</span>. Every write previews a diff and needs an explicit confirm.</p>`;
	if (feature === "suspenders") {
		const s = cur.set.settings;
		const body =
			`<div class="panel"><h2>board knobs · suspenders-board.json</h2>` +
			(cur.set.error
				? `<div class="errbox">current file does not parse: ${esc(cur.set.error)}</div>`
				: "") +
			`<div class="formgrid">` +
			numField(
				"STATUS_REFRESH_S",
				"status_refresh_s",
				s.status_refresh_s,
				"servicemon /status TTL seconds; 0 = always fresh; file beats env at board start",
			) +
			numField(
				"harvest TTL (s)",
				"harvest_ttl_s",
				s.harvest_ttl_s,
				"usage harvest runs at most once per this many seconds (maybeHarvest default TTL)",
			) +
			`</div>` +
			textField(
				"default actor (demo switch preselect)",
				"default_actor",
				s.default_actor ?? "",
				"preselects the avatar dropdown's demo switch; coord bootstrap default is a follow-up",
			) +
			`</div>`;
		return formFrame(
			"SETTINGS · SUSPENDERS",
			head,
			HIDDEN_FEATURE("suspenders") + body,
			me,
		);
	}
	if (!cur.gateway)
		return consolePage(
			`SETTINGS · ${feature.toUpperCase()}`,
			"settings",
			`<style>${FORM_CSS}</style>${head}<div class="errbox">no parsable policy on the belt chain — resolve that first (see /console/belt): ${esc(cur.polError ?? "not found")}</div><div class="btnrow"><a class="btn2" href="/console/settings">back</a></div>`,
			me,
		);
	const gw = cur.gateway;
	const fields =
		feature === "belt"
			? numField(
					"num_retries",
					"num_retries",
					gw.num_retries,
					"per-call retries before the ladder is tried (native retry-after backoff)",
				) +
				numField(
					"allowed_fails",
					"allowed_fails",
					gw.allowed_fails,
					"consecutive failures that bench a deployment into cooldown",
				)
			: ladderFields(gw);
	const ttl = numField(
		"cooldown_time (s)",
		"cooldown_time",
		gw.cooldown_time,
		"cooldown TTL — bench duration after allowed_fails consecutive failures",
	);
	const wrap =
		feature === "belt"
			? `<div class="formgrid">${fields}${ttl}</div>`
			: `${fields}${ttl}`;
	return formFrame(
		`SETTINGS · ${feature.toUpperCase()}`,
		head,
		HIDDEN_FEATURE(feature) +
			`<div class="panel"><h2>routing-policy.yaml · gateway</h2>${wrap}<p class="cfield-hint">shared with ${feature === "belt" ? "buckle" : "belt"} — one file, both processes read it</p></div>`,
		me,
	);
};

export const settingsIndexPage = (a: SettingsIndexArgs): string => {
	const pol = a.pol;
	const polCard = pol
		? `<div class="panel"><h2>routing-policy.yaml · ${esc(scrub(pol.path))} · source: ${esc(pol.source)}</h2>` +
			(pol.error
				? `<div class="errbox">current file does not parse: ${esc(pol.error)}</div>`
				: `<div class="knobs">${
						pol.gateway
							? `<span class="kchip">num_retries: <b>${pol.gateway.num_retries}</b></span><span class="kchip">allowed_fails: <b>${pol.gateway.allowed_fails}</b></span><span class="kchip">cooldown_time: <b>${pol.gateway.cooldown_time}s</b></span><span class="kchip">ladder: <b>${Object.entries(
									pol.gateway.fallbacks,
								)
									.map(([m, t]) => `${esc(m)} → ${t.length} tiers`)
									.join(" · ")}</b></span>`
							: ""
					}</div>`) +
			`<p class="cfoot">belt + buckle share this file — edits apply to both (belt at the next gateway-config emit + kickstart, buckle at restart)</p></div>`
		: `<div class="panel"><h2>routing-policy.yaml</h2><p class="dimpl">no policy file found on the belt chain</p></div>`;
	const s = a.set;
	const setCard =
		`<div class="panel"><h2>suspenders-board.json · ${esc(s.path)}${s.exists ? "" : " · not created yet"}</h2>` +
		(s.error
			? `<div class="errbox">current file does not parse: ${esc(s.error)}</div>`
			: `<div class="knobs"><span class="kchip">STATUS_REFRESH_S: <b>${s.settings.status_refresh_s ?? "default (5s)"}</b></span><span class="kchip">harvest TTL: <b>${s.settings.harvest_ttl_s ? `${s.settings.harvest_ttl_s}s` : "default (300s)"}</b></span><span class="kchip">default actor: <b>${s.settings.default_actor ? esc(s.settings.default_actor) : "unset"}</b></span></div>`) +
		`</div>`;
	return consolePage(
		"SETTINGS",
		"settings",
		`<style>${PAGE_CSS}</style><p class="dimpl">One entry per feature, each with its real config surface. Writes are config-over-code: YAML/JSON in known paths, never code. Every write previews a diff and needs an explicit confirm; invalid config is rejected with the parser's error.</p>` +
			polCard +
			`<div class="panel"><h2>edit</h2><div class="btnrow"><a class="btn2" href="/console/settings/belt">belt · budgets</a> <a class="btn2" href="/console/settings/buckle">buckle · ladder + cooldowns</a> <a class="btn2" href="/console/settings/suspenders">suspenders · board</a></div></div>` +
			setCard,
		a.me,
	);
};

// ─── preview + confirm (the write guard) ──────────────────────────────────
export interface PreviewArgs {
	feature: Feature;
	diff: string[];
	valuesJson: string;
	mtimeMs: string;
	target: string;
	flash?: string;
	error?: string | null;
}

export const previewPage = (a: PreviewArgs, me?: ConsoleMe): string => {
	// values ride base64 (not HTML-escaped JSON) so the confirm round-trip is
	// lossless regardless of quoting; apply decodes + revalidates server-side
	const vB64 = Buffer.from(a.valuesJson, "utf8").toString("base64");
	const confirmForm =
		`<form method="post" action="/console/settings/apply">` +
		`<input type="hidden" name="feature" value="${a.feature}">` +
		`<input type="hidden" name="values" value="${vB64}">` +
		`<input type="hidden" name="mtime" value="${a.mtimeMs}">` +
		`<div class="btnrow"><button class="btn" type="submit">apply</button><a class="btn2" href="/console/settings">cancel</a></div></form>`;
	return consolePage(
		"SETTINGS · PREVIEW",
		"settings",
		`<style>${PILL_CSS}</style>` +
			(a.flash ? `<div class="flash">${esc(a.flash)}</div>` : "") +
			(a.error ? `<div class="errbox">${esc(a.error)}</div>` : "") +
			`<div class="panel"><h2>target · ${esc(a.target)}</h2><pre class="diff">${a.diff.map((l) => (l.startsWith("+ ") ? `<span class="add">${esc(l)}</span>` : l.startsWith("- ") ? `<span class="del">${esc(l)}</span>` : esc(l))).join("\n") || "no textual change"}</pre></div>` +
			confirmForm,
		me,
	);
};
