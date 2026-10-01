// W147: the SPA board wears the same console shell as every page — the
// topbar + avatar dropdown ship from console-html.ts (String.raw interpolates
// ${}; only escapes are raw). Avatar data is fetched live from /api/console/me.
import { TOPBAR_JS, topbar } from "./console-html.ts";

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
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
:focus-visible { outline:2px solid #d8900f; outline-offset:2px; }
[hidden] { display:none !important; }
body { background:#141413; color:#e8e6e1; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; margin:0; padding:16px 20px 28px; }
.mono { font-family:ui-monospace,Menlo,monospace; }
.dim { color:#98958e; }
.state { font-size:12px; padding:4px 0; }
header { display:flex; align-items:baseline; gap:14px; margin-bottom:10px; }
header .mark { font-size:13px; font-weight:600; letter-spacing:.08em; }
header .right { margin-left:auto; display:flex; align-items:center; gap:12px; }
#conn { font-size:11px; color:#98958e; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:0; }
.dot.live { background:#5c7a35; }
.dot.stale { background:#d8900f; }
.dot.err { background:#af2f12; }
#stamp { font-size:11px; color:#98958e; font-variant-numeric:tabular-nums; }
#blockedn { color:#c96a4f; font-size:11px; font-variant-numeric:tabular-nums; }
#needsn { background:#221512; border:1px solid #af2f12; border-radius:2px; padding:2px 9px; color:#c96a4f; font:inherit; font-size:11px; font-weight:600; cursor:pointer; }
#needsn:empty { display:none; }
.plabel { font-size:10px; color:#98958e; text-transform:uppercase; letter-spacing:.06em; }
select { background:#1c1b19; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font:11px ui-monospace,Menlo,monospace; max-width:380px; }
nav.tabs { display:flex; gap:2px; margin:2px 0 16px; border-bottom:1px solid rgba(255,255,255,.12); }
nav.tabs button { background:none; border:none; border-bottom:2px solid transparent; color:#98958e; font:inherit; font-size:12px; font-weight:600; letter-spacing:.04em; padding:7px 12px; cursor:pointer; }
nav.tabs button:hover { color:#e8e6e1; }
nav.tabs button[aria-current] { color:#e8e6e1; border-bottom-color:#d8900f; }
#fleet { margin-bottom:14px; }
#fleetHead { display:block; width:100%; text-align:left; background:#1c1b19; border:1px solid rgba(255,255,255,.12); border-radius:2px; color:#98958e; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
#fleetHead:hover { border-color:rgba(255,255,255,.24); }
#fleetCaret { display:inline-block; width:10px; }
#fleetBody { display:none; padding:8px 2px 0; }
.chip { display:inline-block; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font-size:10px; color:#98958e; margin:0 6px 6px 0; }
.chip b { color:#e8e6e1; font-weight:500; }
.chip .st { text-transform:uppercase; letter-spacing:.06em; }
.chip.zombie { border-color:#af2f12; color:#c96a4f; }
.chip.zombie b { color:#c96a4f; }
.hfclear { background:none; border:none; color:#d8900f; cursor:pointer; font:inherit; padding:0; text-decoration:underline; }
#decisions { border:1px solid rgba(255,255,255,.12); border-radius:2px; background:#171614; margin-bottom:14px; }
#decisions.has { border-color:rgba(175,47,18,.6); }
#decisions h2 { margin:0; padding:8px 14px; display:flex; align-items:baseline; gap:12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#c96a4f; }
#decToggle { background:none; border:none; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; }
#decCaret { display:inline-block; width:10px; }
#decState { margin-left:auto; color:#98958e; font-weight:400; text-transform:none; letter-spacing:0; font-size:12px; }
#decErr { padding:0 14px 8px; color:#c96a4f; font-size:12px; }
#decErr:empty { display:none; }
#decisions.closed #decList, #decisions.closed #decErr { display:none; }
.dec { border-top:1px solid rgba(255,255,255,.07); padding:10px 14px 12px; }
#decList .dec:first-child { border-top:none; }
.dec.sent { opacity:.55; }
.dhead { display:flex; gap:10px; align-items:baseline; font-size:11px; color:#98958e; flex-wrap:wrap; }
.dproj { color:#d8900f; }
.dq { font-size:13.5px; line-height:1.4; margin:5px 0 2px; word-break:break-word; }
.dblocks { font-size:11px; color:#98958e; margin-bottom:4px; }
.dopts { margin:4px 0 2px; }
.optrow { display:flex; align-items:baseline; gap:8px; margin:4px 0; }
button.opt { background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.22); border-radius:2px; padding:2px 10px; font:inherit; font-size:11.5px; cursor:pointer; }
button.opt:hover { border-color:#d8900f; color:#d8900f; }
.optrow.sel button.opt { border-color:#d8900f; color:#d8900f; box-shadow:0 0 0 1px #d8900f; background:#221f14; }
.optrow .trade { font-size:10.5px; color:#98958e; }
.dadv { margin:7px 0 4px; padding:8px 10px; background:#221f1c; border-left:2px solid #d8900f; font-size:12px; }
.dadv .rhead { color:#d8900f; font-weight:600; font-size:10px; letter-spacing:.06em; margin-bottom:2px; }
.dadv .why { color:#98958e; margin-top:3px; white-space:pre-wrap; }
.dadv .risk { color:#c96a4f; margin-top:3px; }
.dans { display:flex; gap:6px; margin-top:7px; flex-wrap:wrap; align-items:center; }
.dans input { flex:1; min-width:220px; background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:5px 9px; font:inherit; font-size:12px; }
.dans input:focus { outline:1px solid #d8900f; }
button.send { background:#d8900f; color:#141413; border:1px solid #d8900f; border-radius:2px; padding:5px 16px; font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.send:disabled, button.getrec:disabled { opacity:.45; cursor:default; }
button.getrec { background:#141413; color:#8cbbad; border:1px solid #8cbbad; border-radius:2px; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
button.dismiss { background:none; border:none; padding:0; color:#98958e; font:inherit; font-size:10.5px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.derr { color:#c96a4f; font-size:11px; margin-top:5px; }
.derr:empty { display:none; }
.retry { background:none; border:1px solid #af2f12; color:#c96a4f; border-radius:2px; font:inherit; font-size:10px; padding:1px 8px; cursor:pointer; margin-left:8px; }
#hist { border:1px solid rgba(255,255,255,.12); border-radius:2px; background:#171614; }
.histhead { display:flex; align-items:baseline; gap:12px; padding:8px 14px; }
#histHead { background:none; border:none; padding:0; color:#98958e; font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; cursor:pointer; }
#histHead:hover { color:#e8e6e1; }
#histCaret { display:inline-block; width:10px; }
#histState { font-size:12px; color:#98958e; }
#histErr { padding:0 14px 8px; color:#c96a4f; font-size:12px; }
#histErr:empty { display:none; }
#histBody { display:none; }
.hrow { border-top:1px solid rgba(255,255,255,.07); padding:8px 14px 10px; font-size:12px; color:#98958e; display:flex; gap:10px; align-items:baseline; }
.hrow .hq { color:#a5a29a; word-break:break-word; }
.hans { display:block; margin-top:2px; }
.hage { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
.pill.hst { flex:none; color:#98958e; border-color:rgba(255,255,255,.24); font-size:9px; }
.pill.hst.open { color:#c96a4f; border-color:#af2f12; }
.taberr { color:#c96a4f; font-size:12px; margin-bottom:10px; }
.taberr:empty { display:none; }
#tasksTbl { width:100%; border-collapse:collapse; font-size:12.5px; }
#tasksTbl th { text-align:left; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#98958e; border-bottom:1px solid rgba(255,255,255,.12); padding:6px 10px; }
#tasksTbl td { border-bottom:1px solid rgba(255,255,255,.07); padding:7px 10px; vertical-align:top; }
#tasksTbl tbody tr:hover { background:#1c1b19; }
#tasksTbl th button.thsort { all:unset; cursor:pointer; font:inherit; color:inherit; text-transform:inherit; letter-spacing:inherit; }
#tasksTbl th button.thsort:hover { text-decoration:underline; text-underline-offset:3px; }
.kidmark { color:#98958e; margin-right:6px; }
.taskbar { display:flex; align-items:center; gap:10px; margin:0 0 10px; }
.taskbar select {
  background:#232220; color:#d6d3cc; border:1px solid rgba(255,255,255,.14); border-radius:4px;
  font:12px ui-monospace, Menlo, monospace; padding:3px 6px;
}
#tasksTbl .num { text-align:right; font-variant-numeric:tabular-nums; color:#98958e; }
/* W57 orchestrate box — LLM proposes a plan + parallel children from a goal; the human registers it as a plan-gated work split */
.orch { border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:10px 12px; margin:0 0 12px; background:rgba(255,255,255,.03); }
.orchrow { display:flex; gap:8px; align-items:center; }
#orchGoal { flex:1; background:#121110; color:#e8e6e1; border:1px solid rgba(255,255,255,.16); border-radius:4px; font:12px ui-monospace, Menlo, monospace; padding:5px 8px; }
#orchGoal:focus { outline:none; border-color:#d8900f; }
#orchGo { background:none; border:1px solid #d8900f; border-radius:4px; color:#d8900f; font:inherit; font-size:11px; padding:4px 10px; cursor:pointer; }
#orchGo:disabled { opacity:.45; cursor:default; }
#orchGo:hover:not(:disabled) { background:rgba(216,144,15,.12); }
.orchplan { margin-top:8px; }
.orchtitle { font-size:12px; font-weight:600; }
.orchmeta { font-size:10px; margin:2px 0 6px; }
.orchkid { font-size:11px; padding:3px 0; border-top:1px solid rgba(255,255,255,.06); }
.orchkidn { color:#d8900f; margin-right:4px; }
.orchbrief { font-size:10px; margin-left:14px; }
.orchactions { margin-top:8px; display:flex; gap:8px; }
.orchdisc { background:none; border:1px solid rgba(255,255,255,.22); border-radius:4px; color:#98958e; font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
.orchdisc:hover { color:#e8e6e1; }
.tidbtn { background:none; border:none; padding:0; color:#d8900f; font:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
/* W65 lanes kanban — one column per work-graph state, cards carry the lane's live tail */
.kwrap { overflow-x:auto; }
.kanban { display:flex; gap:10px; align-items:flex-start; min-width:max-content; padding-bottom:8px; }
.kcol { flex:0 0 250px; max-width:250px; border-top:2px solid rgba(255,255,255,.16); padding-top:6px; }
.kcol h3 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#98958e; margin:0 0 8px; }
.kcount { float:right; font-variant-numeric:tabular-nums; }
.kcard { border:1px solid rgba(255,255,255,.1); border-radius:8px; padding:8px 10px; margin-bottom:8px; background:rgba(255,255,255,.03); cursor:pointer; }
.kcard:hover { border-color:rgba(255,255,255,.28); }
.krow { display:flex; gap:8px; align-items:baseline; }
.kage { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
.kdec { flex:none; color:#c96a4f; font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
.ktitle { margin-top:4px; word-break:break-word; }
.klane { margin-top:3px; font-size:11px; }
.ktail { margin-top:4px; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#98958e; }
.kstart { margin-top:6px; background:none; border:1px solid #d8900f; border-radius:4px; color:#d8900f; font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
.kstart:hover { background:rgba(216,144,15,.12); }
/* executor dropdown + play (board dispatch): one clean row — the select
   fills the card width, the play button hangs at its natural height inside
   the row (its old margin-top pushed it 3px low; W104) */
.kexec { margin-top:6px; display:flex; gap:6px; align-items:center; }
.kexec .kstart { margin-top:0; flex:none; }
.kexecsel { background:#141413; border:1px solid #d8900f; border-radius:4px; color:#d8900f; font:inherit; font-size:11px; padding:2px 4px; max-width:250px; flex:1 1 auto; min-width:0; cursor:pointer; }
.kempty { font-size:11px; padding:2px 0 6px; }
/* W105 model badges — amber = remote model, green = local (LAN/loopback) */
.kmodel, .lmodel { display:inline-block; margin-top:4px; border:1px solid #af2f12; border-radius:2px; padding:0 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:#c96a4f; }
.lmodel { margin-top:0; margin-left:6px; }
.kmodel.loc, .lmodel.loc { border-color:#5c7a35; color:#7da652; }
.ttitle { word-break:break-word; max-width:480px; }
.tail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:480px; }
.akind { display:inline-block; border:1px solid rgba(255,255,255,.18); border-radius:2px; padding:0 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:#98958e; }
.sec { margin-bottom:20px; }
.sec h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#98958e; margin:0 0 8px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:10px; align-content:start; }
.card { background:#1c1b19; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:10px 12px; }
.pill { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:transparent; border:1px solid; border-radius:2px; padding:1px 6px; margin-left:6px; vertical-align:1px; }
.pill.run { color:#d8900f; border-color:#d8900f; }
.pill.done { color:#7da652; border-color:#5c7a35; }
.pill.block { color:#c96a4f; border-color:#af2f12; }
.pill.ready { color:#98958e; border-color:rgba(255,255,255,.24); }
.rq { color:#c96a4f; }
.scard .shead { display:flex; gap:8px; align-items:baseline; font-size:12.5px; }
.sok { flex:none; font-size:9px; text-transform:uppercase; letter-spacing:.08em; border:1px solid; border-radius:2px; padding:1px 6px; }
.sok.ok { color:#7da652; border-color:#5c7a35; }
.sok.fail { color:#c96a4f; border-color:#af2f12; }
.sdetail { margin-top:5px; font-size:11.5px; word-break:break-word; }
.sfix { margin-top:7px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.sfix code { background:#141413; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font-size:11px; color:#e8e6e1; word-break:break-all; }
.copyfix { background:none; border:1px solid rgba(255,255,255,.22); color:#98958e; border-radius:2px; font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; }
.copyfix:hover { color:#e8e6e1; border-color:rgba(255,255,255,.4); }
.feed { border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:10px 12px; font-size:11.5px; margin-bottom:14px; }
.feed h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#98958e; margin:0 0 8px; }
.feed .filters { margin-bottom:6px; display:flex; gap:4px; flex-wrap:wrap; }
.feed .filters button { background:transparent; color:#98958e; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:1px 7px; font:9px ui-monospace,Menlo,monospace; text-transform:uppercase; cursor:pointer; }
.feed .filters button.on { color:#d8900f; border-color:#d8900f; }
.feed .r { display:flex; gap:8px; padding:2px 0; }
.feed .r .ts { width:52px; flex:none; text-align:right; color:#98958e; font-variant-numeric:tabular-nums; }
.feed .r.hot { border-left:2px solid #af2f12; background:#221f1c; padding-left:8px; }
.feed b { font-weight:500; }
#drawer { position:fixed; top:0; right:0; bottom:0; width:min(420px, 92vw); background:#1a1917; border-left:1px solid rgba(255,255,255,.18); box-shadow:-8px 0 24px rgba(0,0,0,.45); padding:14px 16px 20px; overflow-y:auto; z-index:30; }
.dwhead { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
#drawerTitle { margin:0; font-size:13px; font-weight:600; word-break:break-word; }
#drawerClose { background:none; border:1px solid rgba(255,255,255,.22); border-radius:2px; color:#98958e; font-size:14px; line-height:1; padding:3px 9px; cursor:pointer; margin-left:auto; }
#drawerClose:hover { color:#e8e6e1; border-color:rgba(255,255,255,.4); }
.dd { padding:4px 0; border-bottom:1px solid rgba(255,255,255,.07); font-size:12px; }
.dd:last-child { border-bottom:none; }
#taskDiff { margin-top:10px; }
.diffbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.diffbtn { background:none; border:1px solid rgba(255,255,255,.22); color:#98958e; border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.diffbtn:hover { color:#e8e6e1; border-color:rgba(255,255,255,.4); }
.diffbtn.on { color:#d8900f; border-color:#d8900f; }
.diffcap { font-size:10.5px; color:#98958e; word-break:break-all; }
.diffmsg { font-size:11px; color:#7da652; }
.diffmsg.risk { color:#c96a4f; }
.diffwrap { border:1px solid rgba(255,255,255,.12); border-radius:2px; background:#141413; }
.diffview { margin:0; padding:6px 0; font-size:10.5px; line-height:1.5; max-height:340px; overflow:auto; display:block; }
.dline { display:block; white-space:pre; padding:0 8px; }
.dline.add { background:rgba(92,122,53,.18); color:#a9c47f; }
.dline.del { background:rgba(175,47,18,.16); color:#c96a4f; }
.dline.hunk { color:#8cbbad; }
.dline.meta { color:#98958e; }
.dlnum { display:inline-block; width:34px; text-align:right; padding-right:6px; color:#98958e; cursor:pointer; }
.dlnum:hover { color:#d8900f; }
.dnote { display:flex; gap:6px; margin-top:6px; align-items:center; }
.dnote .dtgt { font-size:10.5px; color:#d8900f; word-break:break-all; }
.dnote input { flex:1; min-width:140px; background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font:inherit; font-size:11px; }
.dnote input:focus { outline:1px solid #d8900f; }
button.diffsend { background:#d8900f; color:#141413; border:1px solid #d8900f; border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.diffsend:disabled { opacity:.45; cursor:default; }
#taskTail { margin-top:10px; }
.tailbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.tailbtn { background:none; border:1px solid rgba(255,255,255,.22); color:#98958e; border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.tailbtn:hover { color:#e8e6e1; border-color:rgba(255,255,255,.4); }
.tailbtn.on { color:#d8900f; border-color:#d8900f; }
.tailcap { font-size:10.5px; color:#98958e; word-break:break-all; }
.tailwrap { border:1px solid rgba(255,255,255,.12); border-radius:2px; background:#141413; }
.tailview { margin:0; padding:6px 0; font-size:10.5px; line-height:1.5; max-height:340px; overflow:auto; display:block; white-space:pre-wrap; word-break:break-word; }
.tailview .trow { display:block; padding:0 8px; }
.tailmsg { font-size:11px; color:#7da652; }
.tailmsg.risk { color:#c96a4f; }
.lanemsg { flex:1; min-width:140px; background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font:inherit; font-size:11px; }
.lanemsg:focus { outline:1px solid #d8900f; }
button.lanesend { background:#d8900f; color:#141413; border:1px solid #d8900f; border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.lanesend:disabled { opacity:.45; cursor:default; }
#toasts { position:fixed; bottom:16px; right:16px; display:flex; flex-direction:column; gap:6px; z-index:40; max-width:min(380px, 90vw); }
.toast { background:#221f1c; border:1px solid #af2f12; border-left-width:3px; color:#e8e6e1; padding:8px 12px; font-size:12px; border-radius:2px; box-shadow:0 2px 12px rgba(0,0,0,.5); }
</style></head><body>
${topbar("suspenders")}
<script>${TOPBAR_JS}</script>
${BODY}${CORE}${RENDERS}${DECISIONS}${HISTORY}${TASKS}${DIFF}${SHIP}${TAIL}${ACTIVITY}${SETUP}${TABS}${ORCH}${BOOT}`);
