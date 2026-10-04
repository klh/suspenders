// W147: the SPA board wears the same console shell as every page — the
// topbar + avatar dropdown ship from console-html.ts (String.raw interpolates
// ${}; only escapes are raw). Avatar data is fetched live from /api/console/me.
import { TOPBAR_JS, topbar } from "./console-html.ts";
import { THEME_HEAD } from "../lib/theme.ts";

const unesc = (s) =>
	s
		.split("\\u2014")
		.join(String.fromCharCode(0x2014))
		.split("\\u00b7")
		.join(String.fromCharCode(0xb7))
		.split("\\u00B7")
		.join(String.fromCharCode(0xb7));
// fleet-board-html.ts — the fleet board page, split from the server so the
// HTML payload stays reviewable. Pure string; served by fleet-board.ts.
// Source stays pure ASCII: — renders an em dash, · a middle dot.
// v3: hash-tab shell (Decisions · Tasks · Activity · Governor · Setup),
// global project filter, decision history, task drawer, named lane states.
import { BODY } from "../board-html/body.ts";
import { CORE } from "../board-html/core.ts";
import { RENDERS } from "../board-html/renders.ts";
import { DECISIONS } from "../board-html/decisions.ts";
import { HISTORY } from "../board-html/history.ts";
import { TASKS } from "../board-html/tasks.ts";
import { DIFF } from "../board-html/diff.ts";
import { SHIP } from "../board-html/ship.ts";
import { TAIL } from "../board-html/tail.ts";
import { ACTIVITY } from "../board-html/activity.ts";
import { SETUP } from "../board-html/setup.ts";
import { TABS } from "../board-html/tabs.ts";
import { ORCH } from "../board-html/orch.ts";
import { BOOT } from "../board-html/boot.ts";

// W157: the client JS lives in hooks/board-html/*.ts as String.raw chunk
// values interpolated into ONE outer String.raw — the same template
// semantics (and bun non-ASCII escaping) as the pre-split single file,
// so the served page is byte-identical. unesc distributes over the
// concatenation, so each chunk unesc's exactly as the original did.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const HTML = unesc(String.raw`<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iI2ZmZiIvPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIzLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMjIgMTAgQzIzIDQgNDEgNCA0MiAxMCIvPgogICAgPHBhdGggZD0iTTIyIDEwIEw0NCA0NSBMMzkgNTUiLz4KICAgIDxwYXRoIGQ9Ik00MiAxMCBMMjAgNDUgTDI1IDU1Ii8+CiAgICA8cGF0aCBkPSJNMzIgMjcgTDMyIDQ5Ii8+CiAgPC9nPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIyLjQiPgogICAgPGNpcmNsZSBjeD0iMzkiIGN5PSI1Ny4yIiByPSIyLjYiLz4KICAgIDxjaXJjbGUgY3g9IjI1IiBjeT0iNTcuMiIgcj0iMi42Ii8+CiAgICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjUxLjYiIHI9IjIuNiIvPgogIDwvZz4KPC9zdmc+Cg=="><title>FLEET BOARD</title>
${THEME_HEAD}
<style>
* { box-sizing: border-box; }
:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
[hidden] { display:none !important; }
body { background:var(--klh-bg); color:var(--klh-ink); font:13px/1.45 var(--klh-font-sans); margin:0; padding:16px 20px 28px; }
.mono { font-family:var(--klh-font-mono); }
.dim { color:var(--klh-dim); }
.state { font-size:12px; padding:4px 0; }
header { display:flex; align-items:baseline; gap:14px; margin-bottom:10px; }
header .mark { font-size:13px; font-weight:600; letter-spacing:.08em; }
header .right { margin-left:auto; display:flex; align-items:center; gap:12px; }
#conn { font-size:11px; color:var(--klh-dim); }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:0; }
.dot.live { background:var(--klh-ok); }
.dot.stale { background:var(--klh-accent); }
.dot.err { background:var(--klh-danger); }
#stamp { font-size:11px; color:var(--klh-dim); font-variant-numeric:tabular-nums; }
#blockedn { color:var(--klh-danger-ink); font-size:11px; font-variant-numeric:tabular-nums; }
#needsn { background:var(--klh-danger-bg); border:1px solid var(--klh-danger); border-radius:2px; padding:2px 9px; color:var(--klh-danger-ink); font:inherit; font-size:11px; font-weight:600; cursor:pointer; }
#needsn:empty { display:none; }
.plabel { font-size:10px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; }
select { background:var(--klh-surface); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font:11px var(--klh-font-mono); max-width:380px; }
nav.tabs { display:flex; gap:2px; margin:2px 0 16px; border-bottom:1px solid var(--klh-edge); }
nav.tabs button { background:none; border:none; border-bottom:2px solid transparent; color:var(--klh-dim); font:inherit; font-size:12px; font-weight:600; letter-spacing:.04em; padding:7px 12px; cursor:pointer; }
nav.tabs button:hover { color:var(--klh-ink); }
nav.tabs button[aria-current] { color:var(--klh-ink); border-bottom-color:var(--klh-accent); }
#fleet { margin-bottom:14px; }
#fleetHead { display:block; width:100%; text-align:left; background:var(--klh-surface); border:1px solid var(--klh-edge); border-radius:2px; color:var(--klh-dim); padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
#fleetHead:hover { border-color:var(--klh-edge-strong); }
#fleetCaret { display:inline-block; width:10px; }
#fleetBody { display:none; padding:8px 2px 0; }
.chip { display:inline-block; border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font-size:10px; color:var(--klh-dim); margin:0 6px 6px 0; }
.chip b { color:var(--klh-ink); font-weight:500; }
.chip .st { text-transform:uppercase; letter-spacing:.06em; }
.chip.zombie { border-color:var(--klh-danger); color:var(--klh-danger-ink); }
.chip.zombie b { color:var(--klh-danger-ink); }
.hfclear { background:none; border:none; color:var(--klh-accent); cursor:pointer; font:inherit; padding:0; text-decoration:underline; }
#decisions { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-panel); margin-bottom:14px; }
#decisions.has { border-color:var(--klh-danger-edge); }
#decisions h2 { margin:0; padding:8px 14px; display:flex; align-items:baseline; gap:12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-danger-ink); }
#decToggle { background:none; border:none; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; }
#decCaret { display:inline-block; width:10px; }
#decState { margin-left:auto; color:var(--klh-dim); font-weight:400; text-transform:none; letter-spacing:0; font-size:12px; }
#decErr { padding:0 14px 8px; color:var(--klh-danger-ink); font-size:12px; }
#decErr:empty { display:none; }
#decisions.closed #decList, #decisions.closed #decErr { display:none; }
.dec { border-top:1px solid var(--klh-edge-faint); padding:10px 14px 12px; }
#decList .dec:first-child { border-top:none; }
.dec.sent { opacity:.55; }
.dhead { display:flex; gap:10px; align-items:baseline; font-size:11px; color:var(--klh-dim); flex-wrap:wrap; }
.dproj { color:var(--klh-accent); }
.dq { font-size:13.5px; line-height:1.4; margin:5px 0 2px; word-break:break-word; }
.dblocks { font-size:11px; color:var(--klh-dim); margin-bottom:4px; }
.dopts { margin:4px 0 2px; }
.optrow { display:flex; align-items:baseline; gap:8px; margin:4px 0; }
button.opt { background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge-strong); border-radius:2px; padding:2px 10px; font:inherit; font-size:11.5px; cursor:pointer; }
button.opt:hover { border-color:var(--klh-accent); color:var(--klh-accent); }
.optrow.sel button.opt { border-color:var(--klh-accent); color:var(--klh-accent); box-shadow:0 0 0 1px var(--klh-accent); background:var(--klh-accent-bg); }
.optrow .trade { font-size:10.5px; color:var(--klh-dim); }
.dadv { margin:7px 0 4px; padding:8px 10px; background:var(--klh-warm); border-left:2px solid var(--klh-accent); font-size:12px; }
.dadv .rhead { color:var(--klh-accent); font-weight:600; font-size:10px; letter-spacing:.06em; margin-bottom:2px; }
.dadv .why { color:var(--klh-dim); margin-top:3px; white-space:pre-wrap; }
.dadv .risk { color:var(--klh-danger-ink); margin-top:3px; }
.dans { display:flex; gap:6px; margin-top:7px; flex-wrap:wrap; align-items:center; }
.dans input { flex:1; min-width:220px; background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:5px 9px; font:inherit; font-size:12px; }
.dans input:focus { outline:1px solid var(--klh-accent); }
button.send { background:var(--klh-accent); color:var(--klh-on-accent); border:1px solid var(--klh-accent); border-radius:2px; padding:5px 16px; font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.send:disabled, button.getrec:disabled { opacity:.45; cursor:default; }
button.getrec { background:var(--klh-bg); color:var(--klh-info); border:1px solid var(--klh-info); border-radius:2px; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
button.dismiss { background:none; border:none; padding:0; color:var(--klh-dim); font:inherit; font-size:10.5px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.derr { color:var(--klh-danger-ink); font-size:11px; margin-top:5px; }
.derr:empty { display:none; }
.retry { background:none; border:1px solid var(--klh-danger); color:var(--klh-danger-ink); border-radius:2px; font:inherit; font-size:10px; padding:1px 8px; cursor:pointer; margin-left:8px; }
#hist { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-panel); }
.histhead { display:flex; align-items:baseline; gap:12px; padding:8px 14px; }
#histHead { background:none; border:none; padding:0; color:var(--klh-dim); font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; cursor:pointer; }
#histHead:hover { color:var(--klh-ink); }
#histCaret { display:inline-block; width:10px; }
#histState { font-size:12px; color:var(--klh-dim); }
#histErr { padding:0 14px 8px; color:var(--klh-danger-ink); font-size:12px; }
#histErr:empty { display:none; }
#histBody { display:none; }
.hrow { border-top:1px solid var(--klh-edge-faint); padding:8px 14px 10px; font-size:12px; color:var(--klh-dim); display:flex; gap:10px; align-items:baseline; }
.hrow .hq { color:var(--klh-ink-3); word-break:break-word; }
.hans { display:block; margin-top:2px; }
.hage { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
.pill.hst { flex:none; color:var(--klh-dim); border-color:var(--klh-edge-strong); font-size:9px; }
.pill.hst.open { color:var(--klh-danger-ink); border-color:var(--klh-danger); }
.taberr { color:var(--klh-danger-ink); font-size:12px; margin-bottom:10px; }
.taberr:empty { display:none; }
#tasksTbl { width:100%; border-collapse:collapse; font-size:12.5px; }
#tasksTbl th { text-align:left; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); border-bottom:1px solid var(--klh-edge); padding:6px 10px; }
#tasksTbl td { border-bottom:1px solid var(--klh-edge-faint); padding:7px 10px; vertical-align:top; }
#tasksTbl tbody tr:hover { background:var(--klh-surface); }
#tasksTbl th button.thsort { all:unset; cursor:pointer; font:inherit; color:inherit; text-transform:inherit; letter-spacing:inherit; }
#tasksTbl th button.thsort:hover { text-decoration:underline; text-underline-offset:3px; }
.kidmark { color:var(--klh-dim); margin-right:6px; }
.taskbar { display:flex; align-items:center; gap:10px; margin:0 0 10px; }
.taskbar select {
  background:var(--klh-surface-hi); color:var(--klh-ink-2); border:1px solid var(--klh-edge); border-radius:4px;
  font:12px var(--klh-font-mono); padding:3px 6px;
}
#tasksTbl .num { text-align:right; font-variant-numeric:tabular-nums; color:var(--klh-dim); }
/* W57 orchestrate box — LLM proposes a plan + parallel children from a goal; the human registers it as a plan-gated work split */
.orch { border:1px solid var(--klh-edge); border-radius:6px; padding:10px 12px; margin:0 0 12px; background:var(--klh-wash); }
.orchrow { display:flex; gap:8px; align-items:center; }
#orchGoal { flex:1; background:var(--klh-field); color:var(--klh-ink); border:1px solid var(--klh-edge-mid); border-radius:4px; font:12px var(--klh-font-mono); padding:5px 8px; }
#orchGoal:focus { outline:none; border-color:var(--klh-accent); }
#orchGo { background:none; border:1px solid var(--klh-accent); border-radius:4px; color:var(--klh-accent); font:inherit; font-size:11px; padding:4px 10px; cursor:pointer; }
#orchGo:disabled { opacity:.45; cursor:default; }
#orchGo:hover:not(:disabled) { background:var(--klh-accent-wash); }
.orchplan { margin-top:8px; }
.orchtitle { font-size:12px; font-weight:600; }
.orchmeta { font-size:10px; margin:2px 0 6px; }
.orchkid { font-size:11px; padding:3px 0; border-top:1px solid var(--klh-edge-faint); }
.orchkidn { color:var(--klh-accent); margin-right:4px; }
.orchbrief { font-size:10px; margin-left:14px; }
.orchactions { margin-top:8px; display:flex; gap:8px; }
.orchdisc { background:none; border:1px solid var(--klh-edge-strong); border-radius:4px; color:var(--klh-dim); font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
.orchdisc:hover { color:var(--klh-ink); }
.tidbtn { background:none; border:none; padding:0; color:var(--klh-accent); font:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
/* W65 lanes kanban — one column per work-graph state, cards carry the lane's live tail */
.kwrap { overflow-x:auto; }
.kanban { display:flex; gap:10px; align-items:flex-start; min-width:max-content; padding-bottom:8px; }
.kcol { flex:0 0 250px; max-width:250px; border-top:2px solid var(--klh-edge-mid); padding-top:6px; }
.kcol h3 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); margin:0 0 8px; }
.kcount { float:right; font-variant-numeric:tabular-nums; }
.kcard { border:1px solid var(--klh-edge-soft); border-radius:8px; padding:8px 10px; margin-bottom:8px; background:var(--klh-wash); cursor:pointer; }
.kcard:hover { border-color:var(--klh-edge-hover); }
.krow { display:flex; gap:8px; align-items:baseline; }
.kage { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
.kdec { flex:none; color:var(--klh-danger-ink); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
.ktitle { margin-top:4px; word-break:break-word; }
.klane { margin-top:3px; font-size:11px; }
.ktail { margin-top:4px; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--klh-dim); }
.kstart { margin-top:6px; background:none; border:1px solid var(--klh-accent); border-radius:4px; color:var(--klh-accent); font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
.kstart:hover { background:var(--klh-accent-wash); }
/* executor dropdown + play (board dispatch): one clean row — the select
   fills the card width, the play button hangs at its natural height inside
   the row (its old margin-top pushed it 3px low; W104) */
.kexec { margin-top:6px; display:flex; gap:6px; align-items:center; }
.kexec .kstart { margin-top:0; flex:none; }
.kexecsel { background:var(--klh-bg); border:1px solid var(--klh-accent); border-radius:4px; color:var(--klh-accent); font:inherit; font-size:11px; padding:2px 4px; max-width:250px; flex:1 1 auto; min-width:0; cursor:pointer; }
.kempty { font-size:11px; padding:2px 0 6px; }
/* W105 model badges — amber = remote model, green = local (LAN/loopback) */
.kmodel, .lmodel { display:inline-block; margin-top:4px; border:1px solid var(--klh-danger); border-radius:2px; padding:0 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--klh-danger-ink); }
.lmodel { margin-top:0; margin-left:6px; }
.kmodel.loc, .lmodel.loc { border-color:var(--klh-ok); color:var(--klh-ok-ink); }
.ttitle { word-break:break-word; max-width:480px; }
.tail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:480px; }
.akind { display:inline-block; border:1px solid var(--klh-edge-mid); border-radius:2px; padding:0 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--klh-dim); }
.sec { margin-bottom:20px; }
.sec h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); margin:0 0 8px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:10px; align-content:start; }
.card { background:var(--klh-surface); border:1px solid var(--klh-edge); border-radius:2px; padding:10px 12px; }
.pill { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:transparent; border:1px solid; border-radius:2px; padding:1px 6px; margin-left:6px; vertical-align:1px; }
.pill.run { color:var(--klh-accent); border-color:var(--klh-accent); }
.pill.done { color:var(--klh-ok-ink); border-color:var(--klh-ok); }
.pill.block { color:var(--klh-danger-ink); border-color:var(--klh-danger); }
.pill.ready { color:var(--klh-dim); border-color:var(--klh-edge-strong); }
.rq { color:var(--klh-danger-ink); }
.scard .shead { display:flex; gap:8px; align-items:baseline; font-size:12.5px; }
.sok { flex:none; font-size:9px; text-transform:uppercase; letter-spacing:.08em; border:1px solid; border-radius:2px; padding:1px 6px; }
.sok.ok { color:var(--klh-ok-ink); border-color:var(--klh-ok); }
.sok.fail { color:var(--klh-danger-ink); border-color:var(--klh-danger); }
.sdetail { margin-top:5px; font-size:11.5px; word-break:break-word; }
.sfix { margin-top:7px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.sfix code { background:var(--klh-bg); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font-size:11px; color:var(--klh-ink); word-break:break-all; }
.copyfix { background:none; border:1px solid var(--klh-edge-strong); color:var(--klh-dim); border-radius:2px; font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; }
.copyfix:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.feed { border:1px solid var(--klh-edge); border-radius:2px; padding:10px 12px; font-size:11.5px; margin-bottom:14px; }
.feed h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); margin:0 0 8px; }
.feed .filters { margin-bottom:6px; display:flex; gap:4px; flex-wrap:wrap; }
.feed .filters button { background:transparent; color:var(--klh-dim); border:1px solid var(--klh-edge); border-radius:2px; padding:1px 7px; font:9px var(--klh-font-mono); text-transform:uppercase; cursor:pointer; }
.feed .filters button.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.feed .r { display:flex; gap:8px; padding:2px 0; }
.feed .r .ts { width:52px; flex:none; text-align:right; color:var(--klh-dim); font-variant-numeric:tabular-nums; }
.feed .r.hot { border-left:2px solid var(--klh-danger); background:var(--klh-warm); padding-left:8px; }
.feed b { font-weight:500; }
#drawer { position:fixed; top:0; right:0; bottom:0; width:min(420px, 92vw); background:var(--klh-overlay); border-left:1px solid var(--klh-edge-mid); box-shadow:-8px 0 24px var(--klh-shadow); padding:14px 16px 20px; overflow-y:auto; z-index:30; }
.dwhead { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
#drawerTitle { margin:0; font-size:13px; font-weight:600; word-break:break-word; }
#drawerClose { background:none; border:1px solid var(--klh-edge-strong); border-radius:2px; color:var(--klh-dim); font-size:14px; line-height:1; padding:3px 9px; cursor:pointer; margin-left:auto; }
#drawerClose:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.dd { padding:4px 0; border-bottom:1px solid var(--klh-edge-faint); font-size:12px; }
.dd:last-child { border-bottom:none; }
#taskDiff { margin-top:10px; }
.diffbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.diffbtn { background:none; border:1px solid var(--klh-edge-strong); color:var(--klh-dim); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.diffbtn:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.diffbtn.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.diffcap { font-size:10.5px; color:var(--klh-dim); word-break:break-all; }
.diffmsg { font-size:11px; color:var(--klh-ok-ink); }
.diffmsg.risk { color:var(--klh-danger-ink); }
.diffwrap { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); }
.diffview { margin:0; padding:6px 0; font-size:10.5px; line-height:1.5; max-height:340px; overflow:auto; display:block; }
.dline { display:block; white-space:pre; padding:0 8px; }
.dline.add { background:var(--klh-ok-wash); color:var(--klh-ok-hi); }
.dline.del { background:var(--klh-danger-wash); color:var(--klh-danger-ink); }
.dline.hunk { color:var(--klh-info); }
.dline.meta { color:var(--klh-dim); }
.dlnum { display:inline-block; width:34px; text-align:right; padding-right:6px; color:var(--klh-dim); cursor:pointer; }
.dlnum:hover { color:var(--klh-accent); }
.dnote { display:flex; gap:6px; margin-top:6px; align-items:center; }
.dnote .dtgt { font-size:10.5px; color:var(--klh-accent); word-break:break-all; }
.dnote input { flex:1; min-width:140px; background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font:inherit; font-size:11px; }
.dnote input:focus { outline:1px solid var(--klh-accent); }
button.diffsend { background:var(--klh-accent); color:var(--klh-on-accent); border:1px solid var(--klh-accent); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.diffsend:disabled { opacity:.45; cursor:default; }
#taskTail { margin-top:10px; }
.tailbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.tailbtn { background:none; border:1px solid var(--klh-edge-strong); color:var(--klh-dim); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.tailbtn:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.tailbtn.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.tailcap { font-size:10.5px; color:var(--klh-dim); word-break:break-all; }
.tailwrap { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); }
.tailview { margin:0; padding:6px 0; font-size:10.5px; line-height:1.5; max-height:340px; overflow:auto; display:block; white-space:pre-wrap; word-break:break-word; }
.tailview .trow { display:block; padding:0 8px; }
.tailmsg { font-size:11px; color:var(--klh-ok-ink); }
.tailmsg.risk { color:var(--klh-danger-ink); }
.lanemsg { flex:1; min-width:140px; background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font:inherit; font-size:11px; }
.lanemsg:focus { outline:1px solid var(--klh-accent); }
button.lanesend { background:var(--klh-accent); color:var(--klh-on-accent); border:1px solid var(--klh-accent); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.lanesend:disabled { opacity:.45; cursor:default; }
#toasts { position:fixed; bottom:16px; right:16px; display:flex; flex-direction:column; gap:6px; z-index:40; max-width:min(380px, 90vw); }
.toast { background:var(--klh-warm); border:1px solid var(--klh-danger); border-left-width:3px; color:var(--klh-ink); padding:8px 12px; font-size:12px; border-radius:2px; box-shadow:0 2px 12px var(--klh-shadow); }
</style></head><body>
${topbar("suspenders")}
<script>${TOPBAR_JS}</script>
${BODY}${CORE}${RENDERS}${DECISIONS}${HISTORY}${TASKS}${DIFF}${SHIP}${TAIL}${ACTIVITY}${SETUP}${TABS}${ORCH}${BOOT}</script>
<script type="module" src="/vendor/klh-components.js"></script>`);
