const unesc = (s) => s.split("\\u2014").join(String.fromCharCode(0x2014)).split("\\u00b7").join(String.fromCharCode(0xb7)).split("\\u00B7").join(String.fromCharCode(0xb7));
// fleet-board-html.ts — the fleet board page, split from the server so the
// HTML payload stays reviewable. Pure string; served by fleet-board.ts.
// Source stays pure ASCII: — renders an em dash, · a middle dot.
// v3: hash-tab shell (Decisions · Tasks · Activity · Governor · Setup),
// global project filter, decision history, task drawer, named lane states.
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
.tidbtn { background:none; border:none; padding:0; color:#d8900f; font:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.ttitle { word-break:break-word; max-width:480px; }
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
#toasts { position:fixed; bottom:16px; right:16px; display:flex; flex-direction:column; gap:6px; z-index:40; max-width:min(380px, 90vw); }
.toast { background:#221f1c; border:1px solid #af2f12; border-left-width:3px; color:#e8e6e1; padding:8px 12px; font-size:12px; border-radius:2px; box-shadow:0 2px 12px rgba(0,0,0,.5); }
</style></head><body>
<header>
  <span class="mark">FLEET BOARD</span>
  <div class="right">
    <span id="conn"></span>
    <span id="stamp"></span>
    <span id="blockedn"></span>
    <button id="needsn" type="button"></button>
    <label class="plabel" for="proj">project</label>
    <select id="proj"><option value="all">all projects</option></select>
  </div>
</header>
<nav class="tabs" aria-label="board sections">
  <button type="button" data-tab="decisions" aria-current="true">Decisions</button>
  <button type="button" data-tab="tasks">Tasks</button>
  <button type="button" data-tab="activity">Activity</button>
  <button type="button" data-tab="governor">Governor</button>
  <button type="button" data-tab="setup">Setup</button>
</nav>
<main>
<section id="tab-decisions">
  <section id="decisions">
    <h2><button id="decToggle" type="button"><span id="decCaret">-</span> Decisions needed</button><span id="decState" aria-live="polite">loading decisions...</span></h2>
    <div id="decErr"></div>
    <div id="decList"></div>
  </section>
  <div id="hist">
    <div class="histhead">
      <button id="histHead" type="button" aria-expanded="false"><span id="histCaret">+</span> History</button>
      <span id="histState"></span>
    </div>
    <div id="histErr"></div>
    <div id="histBody"></div>
  </div>
</section>
<section id="tab-tasks" hidden>
  <div class="taskbar">
    <label class="plabel" for="taskOwner">session</label>
    <select id="taskOwner"><option value="all">all sessions</option></select>
    <span id="taskCount" class="dim"></span>
  </div>

  <div id="tasksErr" class="taberr"></div>
  <table id="tasksTbl">
    <thead><tr>
      <th scope="col" data-k="id"><button type="button" class="thsort" data-label="id">id</button></th>
      <th scope="col" data-k="title"><button type="button" class="thsort" data-label="task">task</button></th>
      <th scope="col" data-k="state"><button type="button" class="thsort" data-label="state">state</button></th>
      <th scope="col" data-k="owner"><button type="button" class="thsort" data-label="owner">owner</button></th>
      <th scope="col" data-k="age"><button type="button" class="thsort" data-label="age">age</button></th>
      <th scope="col" data-k="decisions"><button type="button" class="thsort" data-label="decisions">decisions</button></th>
    </tr></thead>
    <tbody id="tasksBody"><tr><td colspan="6" class="dim">loading tasks...</td></tr></tbody>
  </table>
</section>
<section id="tab-activity" hidden>
  <div id="actErr" class="taberr"></div>
  <div class="feed"><div id="actBody"><div class="r"><span class="dim">loading activity...</span></div></div></div>
</section>
<section id="tab-governor" hidden>
  <div id="fleet">
    <button id="fleetHead" type="button" aria-expanded="true"><span id="fleetCaret">-</span> <span id="fleetLine">fleet: loading...</span></button>
    <div id="fleetBody" style="display:block"></div>
  </div>
  <div class="sec"><h2>Claims <span class="dim">(file -&gt; owner -&gt; waiting -&gt; lease)</span></h2><div class="feed" id="claims"></div></div>
  <div class="sec"><h2>Completed</h2><div class="feed" id="done"></div></div>
  <div class="sec"><h2>Event stream</h2><div class="feed"><div class="filters" id="filters"></div><div id="events"></div></div></div>
</section>
<section id="tab-setup" hidden>
  <div id="setupErr" class="taberr"></div>
  <div class="grid" id="setupBody"><div class="state dim">loading setup checks...</div></div>
</section>
</main>
<aside id="drawer" role="dialog" aria-modal="false" aria-labelledby="drawerTitle" hidden>
  <div class="dwhead"><h2 id="drawerTitle">Task</h2><button id="drawerClose" type="button" aria-label="close task details">&times;</button></div>
  <div id="drawerBody"></div>
</aside>
<div id="toasts" aria-live="polite"></div>
<script>
var sel = document.getElementById('proj'); // global project filter (full git-common-dir paths, 'all' = no filter)
var lastData = null; // last good /api/data
var lastDataTs = 0;
var dataOkAt = 0; var dataErr = null; var dataBusy = false;
var lastDec = null; // last good /api/decisions {ts, decisions}
var decOkAt = 0; var decErr = null; var decBusy = false; var decLoaded = false; var decBaseline = false;
var seen = {}; // decision ids ever toasted (baseline on first good fetch)
var drafts = {}; // dec id -> typed-but-unsent text, survives re-renders
var selOpt = {}; // dec id -> chosen option label (selecting, not submitting)
var advising = {}; // dec id -> ms when the advise request started
var advErr = {}; // dec id -> advise request error (inline)
var answering = {}; // dec id -> true while an answer POST is in flight
var ansErr = {}; // dec id -> inline answer/delivery error
var sentOk = {}; // dec id -> answer accepted (until the poll drops the card)
var decCollapsed = false;
var evFilter = 'all';
var projBaseline = false; // suppress toast storm right after a project switch
var knownProj = {}; // distinct project paths seen in any 'projects' response
var TABS = { decisions: 1, tasks: 1, activity: 1, governor: 1, setup: 1 };
var curTab = 'decisions';
var tasksData = null; var tasksOkAt = 0; var tasksErr = null; var tasksBusy = false; var tasksLoaded = false;
var actData = null; var actOkAt = 0; var actErr = null; var actBusy = false; var actLoaded = false;
var histOpen = false; var histData = null; var histOkAt = 0; var histErr = null; var histBusy = false; var histLoaded = false;
var setupData = null; var setupOkAt = 0; var setupErr = null; var setupBusy = false; var setupLoaded = false;
var task = { id: null, proj: null, data: null, err: null, busy: false, okAt: 0, trigger: null }; // open drawer state
function byId(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function setText(el, v){ if (el && el.textContent !== v) el.textContent = v; }
function sigSet(el, sig, html){
  if (el.getAttribute('data-sig') === sig) return;
  el.setAttribute('data-sig', sig);
  el.innerHTML = html;
}
// sig-guarded rebuild that keeps focus alive across row swaps (tasks table)
function sigSetKeep(el, sig, html, attr){
  var prev = el.contains(document.activeElement) && document.activeElement !== document.body ? document.activeElement : null;
  var pid = prev && prev.getAttribute ? prev.getAttribute(attr) : null;
  sigSet(el, sig, html);
  if (pid != null && !document.contains(prev)) {
    var nb = el.querySelector('[' + attr + '="' + pid + '"]');
    if (nb) nb.focus();
  }
}
function ago(s){
  if (s == null || s < 0) return '';
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) { var m = Math.round(s / 60); return m + (m === 1 ? ' minute' : ' minutes') + ' ago'; }
  if (s < 86400) { var h = Math.round(s / 3600); return h + (h === 1 ? ' hour' : ' hours') + ' ago'; }
  var dd = Math.round(s / 86400); return dd + (dd === 1 ? ' day' : ' days') + ' ago';
}
function agoShort(s){
  if (s == null || s < 0) return '-';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}
function msAgo(ts){ return ts != null ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null; }
function taskPill(state){
  var s = String(state || '').toLowerCase();
  if (state === 'CLAIMED' || state === 'RUNNING') return '<span class="pill run">' + s + '</span>';
  if (state === 'DONE') return '<span class="pill done">done</span>';
  if (state === 'BLOCKED' || state === 'PAUSED' || state === 'FAILED') return '<span class="pill block">' + s + '</span>';
  return '<span class="pill ready">' + (s || '?') + '</span>';
}
function zombieFor(sid, zombies){
  for (var z = 0; z < zombies.length; z++) if (String(zombies[z].label).indexOf(String(sid).slice(0, 10)) === 0) return true;
  return false;
}
// named lane states — raw jargon never rendered as visible text
var STATES = { RUNNING: 'working', WAITING: 'waiting for you', PAUSED: 'paused', RATE_LIMITED: 'rate-limited', ZOMBIE: 'zombie', CLOSED: 'quiet', IDLE: 'quiet' };
function stateLabel(state, flagged){
  if (flagged) return 'waiting for you'; // pending decisions beat the raw state
  var raw = String(state == null ? '' : state).toUpperCase();
  return STATES[raw] || (raw ? raw.toLowerCase() : 'quiet');
}
// --- polling: single in-flight request per endpoint, 8s timeout, stale
// responses dropped by server-ts compare, last good kept on failure ---
function postJSON(url, body){
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    .then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        j = j || {};
        if (!r.ok && !j.error && !j.output) j.error = 'HTTP ' + r.status;
        return j;
      });
    });
}
function projQuery(){
  if (!sel.value || sel.value === 'all') return '';
  return '?project=' + encodeURIComponent(sel.value);
}
// merge every good response's 'projects' list into the global filter
function noteProjects(list){
  if (!Array.isArray(list)) return;
  var added = false;
  for (var i = 0; i < list.length; i++) {
    var p = String(list[i] || '');
    if (!p || knownProj[p]) continue;
    knownProj[p] = true;
    added = true;
  }
  if (!added) return;
  var keys = Object.keys(knownProj).sort();
  var cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  for (var k = 0; k < keys.length; k++) {
    var o = document.createElement('option');
    o.value = keys[k];
    o.textContent = keys[k];
    sel.appendChild(o);
  }
  sel.value = cur === 'all' || knownProj[cur] ? cur : 'all';
}
function pollData(){
  if (dataBusy) return;
  dataBusy = true;
  fetch('/api/data', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || typeof j.ts !== 'number' || !Array.isArray(j.projects)) throw new Error('bad /api/data payload');
      if (j.ts >= lastDataTs) { lastData = j; lastDataTs = j.ts; }
      dataOkAt = Date.now(); dataErr = null;
    })
    .catch(function(e){ dataErr = String((e && e.message) || e); })
    .finally(function(){ dataBusy = false; renderAll(); });
}
function pollDec(){
  if (decBusy) return;
  decBusy = true;
  fetch('/api/decisions' + projQuery(), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || typeof j.ts !== 'number' || !Array.isArray(j.decisions)) throw new Error('bad /api/decisions payload');
      if (!lastDec || j.ts >= lastDec.ts) lastDec = j;
      decOkAt = Date.now(); decErr = null; decLoaded = true;
      noteProjects(j.projects);
      noteNew(j.decisions);
    })
    .catch(function(e){ decErr = String((e && e.message) || e); })
    .finally(function(){ decBusy = false; renderAll(); });
}
function tick(){ pollData(); pollDec(); pollActiveTab(); if (task.id) pollTask(false); }
function noteNew(list){
  var base = projBaseline || !decBaseline;
  projBaseline = false;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (d.state && d.state !== 'OPEN') continue;
    if (base) { seen[d.id] = true; continue; } // baseline or fresh project filter, no toast storm
    if (seen[d.id]) continue;
    seen[d.id] = true;
    toast('new decision #' + d.id + ' — ' + String(d.question || '').slice(0, 90));
  }
  decBaseline = true;
}
function toast(msg){
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  byId('toasts').appendChild(t);
  setTimeout(function(){ t.remove(); }, 6000);
}
// sig-guarded inline error banner with a retry button; keeps last good data visible
function errBanner(el, text, onretry){
  if (el.getAttribute('data-sig') === text) return;
  el.setAttribute('data-sig', text);
  el.textContent = text + ' ';
  var rb = document.createElement('button');
  rb.className = 'retry';
  rb.type = 'button';
  rb.textContent = 'retry';
  rb.addEventListener('click', onretry);
  el.appendChild(rb);
}
function clearErr(el){
  if (el.getAttribute('data-sig') === '') return;
  el.setAttribute('data-sig', '');
  el.textContent = '';
}
// --- 1: overall status + connection health (live / stale / error) ---
function renderConn(){
  var dAge = dataOkAt ? Math.round((Date.now() - dataOkAt) / 1000) : -1;
  var cAge = decOkAt ? Math.round((Date.now() - decOkAt) / 1000) : -1;
  var cls, txt;
  if (dataErr && !dataOkAt) { cls = 'err'; txt = 'connecting'; }
  else if (dataErr) { cls = 'err'; txt = 'error — last good ' + ago(dAge); }
  else if (dAge >= 5) { cls = 'stale'; txt = 'stale — last good ' + ago(dAge); }
  else { cls = 'live'; txt = 'live'; }
  var dec;
  if (!decLoaded) dec = 'decisions loading';
  else if (decErr) dec = 'decisions unavailable';
  else dec = 'decisions checked ' + ago(cAge);
  var sig = cls + '|' + txt + '|' + dec;
  var el = byId('conn');
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    el.innerHTML = '<span class="dot ' + cls + '"></span>' + esc(txt) + ' <span class="dim">| ' + esc(dec) + '</span>' +
      (dataErr ? ' <button class="retry" id="connRetry" type="button">retry</button>' : '');
    var rb = byId('connRetry');
    if (rb) rb.addEventListener('click', function(){ dataErr = null; pollData(); });
  }
}
// --- fleet health (Governor tab): summary line + one chip per lane ---
function chipHtml(s, zombies, needs){
  var z = zombieFor(s.sid, zombies);
  var flagged = !!(needs && needs[s.sid] && needs[s.sid].length);
  var bits = '<b>' + esc(s.label) + '</b> · <span class="st">' + esc(stateLabel(s.state, flagged)) + '</span> · heartbeat ' + ago(s.hbAgo);
  if (s.progressAgo != null) bits += ' · progress ' + ago(s.progressAgo);
  if (s.project) bits += ' · <span class="mono">' + esc(s.project) + '</span>';
  return '<span class="chip' + (z ? ' zombie' : '') + '" title="' + esc(s.sid) + '">' + bits + '</span>';
}
function renderFleet(){
  var d = lastData;
  if (!d) { setText(byId('fleetLine'), 'fleet: loading...'); return; }
  var ss = d.sessions || [];
  var working = 0;
  for (var i = 0; i < ss.length; i++) if (ss[i].state === 'RUNNING') working++;
  var zN = (d.zombies || []).length;
  var blocked = 0;
  var proj = d.projects || [];
  for (var p = 0; p < proj.length; p++) blocked += (proj[p].gated || []).length;
  var line = 'fleet: ' + working + ' working · ' + openDecs().length + ' waiting on you · ' + blocked + ' blocked' +
    (zN ? ' · ' + zN + ' zombie' + (zN === 1 ? '' : 's') : '');
  var ck = d.consults;
  if (ck && (ck.human || ck.kbSolutions)) {
    line += ' · consults: ' + ck.open + ' open, ' + (ck.human + ck.kb) + ' answered' +
      (ck.kbSolutions ? ' · kb ' + ck.kbSolutions + ' solutions/' + ck.kbHits + ' hits' : '');
  }
  var el = byId('fleetLine');
  if (el.getAttribute('data-sig') !== line) { el.setAttribute('data-sig', line); el.innerHTML = line; }
  setText(byId('stamp'), 'updated ' + ago(Math.max(0, Math.round((Date.now() - d.ts) / 1000))));
  byId('blockedn').textContent = blocked ? blocked + ' blocked' : '';
  var body = byId('fleetBody');
  if (body.style.display === 'none') return; // collapsed: skip chip rebuild
  var zg = '';
  for (var zi = 0; zi < (d.zombies || []).length; zi++) zg += '<span class="chip zombie">zombie: ' + esc(d.zombies[zi].label) + '</span>';
  var chips = '';
  for (var ci = 0; ci < ss.length; ci++) chips += chipHtml(ss[ci], d.zombies || [], d.needs || {});
  var fsig = chips + zg;
  if (body.getAttribute('data-sig') !== fsig) { body.setAttribute('data-sig', fsig); body.innerHTML = chips + zg; }
}
function renderClaims(d){
  var out = '';
  var cs = d.claims || [];
  for (var i = 0; i < cs.length; i++) {
    var x = cs[i];
    var owner = esc((d.labels || {})[x.sid] || String(x.sid || '').slice(0, 10));
    var wait = x.waiters != null ? 'waiting ' + esc(String(x.waiters)) : '';
    if (!wait && x.intent) wait = esc(x.intent).slice(0, 44);
    var lease = x.lease != null ? esc(String(x.lease)) : 'held ' + ago(x.tsAgo);
    out += '<div class="r' + (x.hot ? ' hot' : '') + '"><span class="mono">' + esc(x.scope || '?') + '</span>';
    out += ' <span class="dim">-&gt;</span> ' + owner;
    if (wait) out += ' <span class="dim">-&gt;</span> ' + wait;
    out += ' <span class="dim">-&gt;</span> lease: ' + lease + '</div>';
  }
  byId('claims').innerHTML = out || '<div class="r"><span class="dim">(no claims)</span></div>';
}
function renderDone(d){
  var done = '';
  var proj = d.projects || [];
  for (var pd = 0; pd < proj.length; pd++) {
    var dlist = proj[pd].done || [];
    for (var idd = 0; idd < dlist.length; idd++) {
      var dn = dlist[idd];
      done += '<div class="r"><span class="ts">' + (dn.updatedAgo >= 0 ? agoShort(dn.updatedAgo) : '-') + '</span>';
      done += '<span><b class="mono">' + esc(dn.id) + '</b> ' + esc(dn.title).slice(0, 60) + '</span></div>';
    }
  }
  byId('done').innerHTML = done || '<div class="r"><span class="ts">-</span><span class="dim">(none yet)</span></div>';
}
function renderEvents(d){
  var filts = ['all','landed','blocked','need','checkpoint','alert','answer'];
  var fh = '';
  for (var f = 0; f < filts.length; f++) {
    var on = evFilter === filts[f] ? ' on' : '';
    fh += '<button class="' + on + '" onclick="setFilt(\'' + filts[f] + '\')">' + filts[f] + '</button>';
  }
  byId('filters').innerHTML = fh;
  var ev = '';
  var es = d.events || [];
  for (var j = es.length - 1; j >= 0; j--) {
    var e = es[j];
    var kl = String(e.kind).toLowerCase();
    if (evFilter !== 'all' && kl.indexOf(evFilter) < 0) continue;
    var row = '<div class="r"><span class="ts">' + agoShort(e.tsAgo) + '</span>';
    row += '<span><span class="mono">#' + e.id + '</span> <b>' + esc(e.kind) + '</b> ' + esc(e.source).slice(0, 12);
    if (e.target) row += ' -&gt; ' + esc(e.target).slice(0, 10);
    if (e.note) row += ' — ' + esc(e.note).slice(0, 56);
    ev += row + '</span></div>';
  }
  byId('events').innerHTML = ev || '<div class="r"><span class="dim">(none match)</span></div>';
}
function setFilt(f){ evFilter = f; if (lastData) renderEvents(lastData); }
// --- 2: decisions needed (Decisions tab, /api/decisions) ---
function openDecs(){
  var ds = (lastDec && lastDec.decisions) || [];
  var out = [];
  for (var i = 0; i < ds.length; i++) {
    if (!ds[i].state || ds[i].state === 'OPEN') out.push(ds[i]);
  }
  return out;
}
function decById(id){
  var ds = (lastDec && lastDec.decisions) || [];
  for (var i = 0; i < ds.length; i++) {
    if (ds[i].id === id) return ds[i];
  }
  return null;
}
function decNodeEl(id){ return document.querySelector('.dec[data-id="' + id + '"]'); }
// recommendation: /api/decisions record when the backend adds it there,
// else the /api/data needs map (the advice.<id> fact written by advise.ts)
function adviceFor(id){
  var d = decById(id);
  if (d && (d.advice || d.adviceError)) return d;
  var nd = (lastData && lastData.needs) || {};
  for (var s in nd) {
    var arr = nd[s];
    for (var j = 0; j < arr.length; j++) {
      if (arr[j].id === id) return arr[j];
    }
  }
  return null;
}
function decAge(d){
  if (d.age_s != null) return d.age_s;
  if (d.created_ts) return Math.max(0, Math.round((Date.now() - d.created_ts) / 1000));
  return null;
}
// feed failure banner (sig-guarded; never rendered as "0 pending")
function showDecFeedError(errEl){
  var when = decOkAt ? ago(Math.round((Date.now() - decOkAt) / 1000)) : 'never';
  var sig = 'unavailable|' + when;
  if (errEl.getAttribute('data-sig') !== sig) {
    errEl.setAttribute('data-sig', sig);
    errEl.textContent = 'decision feed unavailable — last good ' + when;
    var rb = document.createElement('button');
    rb.className = 'retry';
    rb.type = 'button';
    rb.textContent = 'retry';
    rb.addEventListener('click', function(){ decErr = null; pollDec(); });
    errEl.appendChild(rb);
  }
  errEl.style.display = 'block';
}
// one explicit state, never render failure as zero pending
function renderDecisions(){
  try {
    renderDecisionsInner();
  } catch (e) {
    var errEl = byId('decErr');
    errEl.textContent = 'decision render failed — last good data kept';
    errEl.style.display = 'block';
  }
}
function projBase(){
  if (!sel.value || sel.value === 'all') return null;
  var b = String(sel.value).split('/').pop() || sel.value;
  return b.replace(/\.git$/, '');
}
function renderDecisionsInner(){
  var all = openDecs();
  var live = {};
  for (var i = 0; i < all.length; i++) live[all[i].id] = true;
  // request-state cleanup for decisions that left the list
  for (var k in advising) if (!live[k]) delete advising[k];
  for (var k2 in advErr) if (!live[k2]) delete advErr[k2];
  for (var k3 in answering) if (!live[k3]) delete answering[k3];
  for (var k4 in sentOk) if (!live[k4]) delete sentOk[k4];
  // header state: loading / N need you / none / feed unavailable
  var st = byId('decState');
  var errEl = byId('decErr');
  if (!decLoaded) {
    setText(st, 'loading decisions...');
    errEl.style.display = 'none';
  } else if (decErr) {
    setText(st, '');
    showDecFeedError(errEl);
  } else if (all.length) {
    setText(st, all.length + ' decision' + (all.length === 1 ? '' : 's') + ' need you');
    errEl.style.display = 'none';
  } else {
    setText(st, 'No pending decisions · checked ' + ago(Math.round((Date.now() - decOkAt) / 1000)));
    errEl.style.display = 'none';
  }
  // badge always visible while pending; "(N)" in title while collapsed
  var badge = byId('needsn');
  var btxt = all.length ? all.length + ' need you' : '';
  if (badge.textContent !== btxt) badge.textContent = btxt;
  var pb = projBase();
  var base = pb ? String(pb).toUpperCase() + ' · FLEET BOARD' : 'FLEET BOARD';
  var ttl = decCollapsed && all.length ? base + ' (' + all.length + ')' : base;
  if (document.title !== ttl) document.title = ttl;
  byId('decisions').classList.toggle('closed', decCollapsed);
  byId('decisions').classList.toggle('has', all.length > 0);
  setText(byId('decCaret'), decCollapsed ? '+' : '-');
  // keyed nodes: create once per decision id, remove + clean up on exit
  var list = byId('decList');
  var want = {};
  for (var wi = 0; wi < all.length; wi++) want[all[wi].id] = true;
  for (var ci = list.children.length - 1; ci >= 0; ci--) {
    var kid = list.children[ci];
    var kidId = kid.getAttribute('data-id');
    if (!want[kidId]) {
      kid.remove();
      delete drafts[kidId]; delete selOpt[kidId]; delete ansErr[kidId];
      delete sentOk[kidId];
    }
  }
  for (var di = 0; di < all.length; di++) decNode(all[di]);
}
function decNode(d){
  var list = byId('decList');
  var q = decNodeEl(d.id);
  if (!q) {
    q = document.createElement('div');
    q.className = 'dec';
    q.setAttribute('data-id', d.id);
    q.innerHTML =
      '<div class="dhead"><span class="dproj mono"></span><span class="dwho"></span><span class="dage dim"></span></div>' +
      '<div class="dq"></div>' +
      '<div class="dblocks"></div>' +
      '<div class="dopts"></div>' +
      '<div class="dadv"></div>' +
      '<div class="dans"><input class="ans" placeholder="your decision...">' +
      '<button class="send" type="button">Send</button>' +
      '<button class="getrec" type="button">Get recommendation</button>' +
      '<button class="dismiss" type="button">cancel</button></div>' +
      '<div class="derr" role="alert"></div>';
    list.appendChild(q);
  }
  var inp = q.querySelector('input.ans');
  if (document.activeElement !== inp && inp.value !== (drafts[d.id] || '')) {
    inp.value = drafts[d.id] || '';
  }
  if (!q.getAttribute('data-wired')) {
    q.setAttribute('data-wired', '1');
    inp.addEventListener('input', function(){ drafts[d.id] = inp.value; });
    inp.addEventListener('keydown', function(e){
      if (e.key === 'Enter') {
        e.preventDefault();
        sendAns(d.id);
      }
    });
    q.addEventListener('click', function(e){
      var t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('send')) sendAns(d.id);
      else if (t.classList.contains('getrec') || t.classList.contains('advretry')) askAdv(d.id);
      else if (t.classList.contains('dismiss')) cancelDec(d.id);
      else if (t.classList.contains('use')) useRec(d.id);
      else if (t.classList.contains('opt')) pickOpt(d.id, t);
    });
  } else if (drafts[d.id] != null && inp.value !== drafts[d.id] && document.activeElement !== inp) {
    inp.value = drafts[d.id];
  }
  q.classList.toggle('sent', !!sentOk[d.id]);
  setText(q.querySelector('.dproj'), d.project || '(unknown project)');
  setText(q.querySelector('.dwho'), (d.asked_by_label || d.asked_by || '?') + ' · #' + d.id);
  setText(q.querySelector('.dage'), ago(decAge(d)));
  setText(q.querySelector('.dq'), d.question || '(no question text)');
  var blocks = 'blocks: ' + (d.task_title || (d.task_id ? 'task ' + d.task_id : 'no linked task'));
  setText(q.querySelector('.dblocks'), blocks);
  var errEl2 = q.querySelector('.derr');
  var errTxt = ansErr[d.id] || (d.delivery === 'FAILED' ? 'delivery failed — press Send to retry' : '');
  if (errEl2.getAttribute('data-sig') !== errTxt) {
    errEl2.setAttribute('data-sig', errTxt);
    errEl2.textContent = errTxt;
  }
  var sb = q.querySelector('.send');
  sb.disabled = !!answering[d.id];
  setText(sb, sentOk[d.id] ? 'Sent' : 'Send');
  q.querySelector('.getrec').disabled = !!advising[d.id];
  var optEl = q.querySelector('.dopts');
  var opts = Array.isArray(d.options) ? d.options : [];
  var osig = JSON.stringify(opts) + '|' + (selOpt[d.id] || '');
  if (optEl.getAttribute('data-sig') !== osig) {
    optEl.setAttribute('data-sig', osig);
    optEl.innerHTML = '';
    for (var oi = 0; oi < opts.length; oi++) {
      var o = opts[oi] || {};
      var row = document.createElement('div');
      row.className = 'optrow' + (selOpt[d.id] === o.label ? ' sel' : '');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', selOpt[d.id] === o.label ? 'true' : 'false');
      var tr = document.createElement('span');
      tr.className = 'trade dim';
      tr.textContent = o.tradeoff || '';
      row.appendChild(b);
      row.appendChild(tr);
      optEl.appendChild(row);
    }
  }
  var advEl = q.querySelector('.dadv');
  if (advising[d.id] && adviceFor(d.id)) delete advising[d.id]; // fact landed
  var a = advising[d.id] ? null : adviceFor(d.id);
  var asig;
  if (advising[d.id]) asig = 'busy:' + Math.round((Date.now() - advising[d.id]) / 1000);
  else if (advErr[d.id]) asig = 'adverr:' + advErr[d.id];
  else if (a && a.adviceError) asig = 'aerr:' + a.adviceError;
  else if (a && a.advice) asig = 'adv:' + JSON.stringify(a.advice);
  else asig = '';
  if (advEl.getAttribute('data-sig') !== asig) {
    advEl.setAttribute('data-sig', asig);
    advEl.innerHTML = '';
    if (asig === '') {
      advEl.style.display = 'none';
    } else if (advising[d.id]) {
      advEl.style.display = 'block';
      var secs = Math.round((Date.now() - advising[d.id]) / 1000);
      advEl.innerHTML = '<span class="dim">getting recommendation... ' + secs + 's</span>';
    } else if (advErr[d.id]) {
      advEl.style.display = 'block';
      advEl.innerHTML = '<span class="risk">advice request failed: ' + esc(advErr[d.id]) + '</span>' +
        ' <button class="advretry" type="button">retry</button>';
    } else if (a && a.adviceError) {
      advEl.style.display = 'block';
      advEl.innerHTML = '<span class="risk">advice failed: ' + esc(a.adviceError) + '</span>' +
        ' <button class="advretry" type="button">retry</button>';
    } else if (a && a.advice) {
      var ac = a.advice;
      var rhead = '<div class="rhead">RECOMMENDATION' + (ac.model ? ' <span class="dim">' + esc(ac.model) + '</span>' : '') + '</div>';
      var rbody = '<div class="rec">' + esc(ac.rec || '') + '</div>';
      if (ac.rationale) rbody += '<div class="why">' + esc(ac.rationale) + '</div>';
      if (ac.risk) rbody += '<div class="risk">risk: ' + esc(ac.risk) + '</div>';
      advEl.innerHTML = rhead + rbody + ' <button class="use" type="button">use</button>';
    }
  }
}
function pickOpt(id, btn){
  var d = decById(id);
  if (!d) return;
  var opts = Array.isArray(d.options) ? d.options : [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i] || {};
    if (o.label === btn.textContent) {
      selOpt[id] = o.label;
      var q = decNodeEl(id);
      var inp = q && q.querySelector('input.ans');
      if (inp) {
        inp.value = o.label;
        drafts[id] = o.label;
        inp.focus();
      }
      renderDecisions();
      return;
    }
  }
}
function sendAns(id){
  if (answering[id]) return; // in flight — never resubmit
  var d = decById(id);
  var q = decNodeEl(id);
  if (!d || !q) return;
  var inp = q.querySelector('input.ans');
  var note = (inp.value || '').trim();
  if (!note) {
    ansErr[id] = 'type an answer first';
    renderDecisions();
    return;
  }
  answering[id] = true;
  delete ansErr[id];
  q.querySelector('.send').disabled = true;
  // contract POST /api/answer: token the client read + note; to/forEvent kept
  // for backward compatibility with the pre-contract backend
  postJSON('/api/answer', { id: id, token: d.answer_token, note: note, to: d.asked_by, forEvent: id })
    .then(function(res){
      delete answering[id];
      if (res && res.ok) {
        sentOk[id] = true;
        delete drafts[id];
        inp.value = '';
        delete selOpt[id];
      } else {
        var stale = res && res.error === 'stale';
        ansErr[id] = stale ? 'stale — changed elsewhere, reloading' : ((res && (res.error || res.output)) || 'send failed — press Send to retry');
      }
      renderDecisions();
      tick();
    })
    .catch(function(e){
      delete answering[id];
      ansErr[id] = String((e && e.message) || e) + ' — press Send to retry';
      renderDecisions();
    });
}
function askAdv(id){
  if (advising[id]) return;
  delete advErr[id];
  advising[id] = Date.now();
  renderDecisions();
  postJSON('/api/advise', { id: id })
    .then(function(res){
      if (!res || !res.ok) {
        delete advising[id];
        advErr[id] = (res && res.error) || 'advise failed to start';
      }
      renderDecisions();
    })
    .catch(function(e){
      delete advising[id];
      advErr[id] = String((e && e.message) || e) + ' — retry';
      renderDecisions();
    });
}
function useRec(id){
  var a = adviceFor(id);
  var q = decNodeEl(id);
  if (!a || !a.advice || !q) return;
  var inp = q.querySelector('input.ans');
  inp.value = a.advice.rec || '';
  drafts[id] = inp.value;
  inp.focus();
}
function cancelDec(id){
  if (!window.confirm('Cancel this decision? The asking lane will see it as cancelled.')) return;
  postJSON('/api/ack', { id: id })
    .then(function(res){
      if (!res || !res.ok) {
        ansErr[id] = (res && (res.error || res.output)) || 'cancel failed — retry';
        renderDecisions();
      }
      tick();
    })
    .catch(function(e){
      ansErr[id] = String((e && e.message) || e) + ' — retry';
      renderDecisions();
    });
}
// --- 3: decision history (collapsed under OPEN, /api/decisions&history=1) ---
function pollHist(){
  if (!histOpen || histBusy || curTab !== 'decisions') return;
  histBusy = true;
  var q = projQuery();
  fetch('/api/decisions' + q + (q ? '&' : '?') + 'history=1', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.decisions)) throw new Error('bad /api/decisions payload');
      histData = j; histOkAt = Date.now(); histErr = null; histLoaded = true;
      noteProjects(j.projects);
    })
    .catch(function(e){ histErr = String((e && e.message) || e); })
    .finally(function(){ histBusy = false; renderHist(); });
}
function renderHist(){
  var st = byId('histState');
  var errEl = byId('histErr');
  var body = byId('histBody');
  if (!histOpen) { setText(st, ''); clearErr(errEl); return; }
  var rows = [];
  if (histData) {
    var ds = histData.decisions || [];
    for (var i = 0; i < ds.length; i++) if (ds[i].state && ds[i].state !== 'OPEN') rows.push(ds[i]);
  }
  if (!histLoaded && !histErr) { setText(st, 'loading history...'); clearErr(errEl); return; }
  if (histErr) {
    var when = histOkAt ? ago(Math.round((Date.now() - histOkAt) / 1000)) : 'never';
    errBanner(errEl, 'history unavailable — last good ' + when, function(){ histErr = null; pollHist(); });
    setText(st, rows.length ? rows.length + ' archived · stale' : 'unavailable');
  } else {
    clearErr(errEl);
    setText(st, rows.length ? rows.length + ' archived' : '(no archived decisions)');
  }
  if (!rows.length) { sigSet(body, 'empty', ''); return; }
  var html = '';
  for (var r = 0; r < rows.length; r++) {
    var d = rows[r];
    var age = ago(msAgo(d.answered_ts || d.ack_ts || d.created_ts));
    html += '<div class="hrow"><span class="pill hst">' + esc(String(d.state).toLowerCase()) + '</span>' +
      '<span><span class="hq">' + esc(String(d.question || '(no question text)').slice(0, 140)) + '</span>' +
      (d.answer_note ? '<span class="hans">' + esc(String(d.answer_note).slice(0, 200)) + '</span>' : '') +
      '</span><span class="hage dim">' + age + '</span></div>';
  }
  sigSet(body, String(histOkAt), html); // rebuild per good poll; ages stay fresh
}
// --- 4: tasks table (Tasks tab, /api/tasks) + drawer (/api/task) ---
// view state: session filter + column sort, persisted per browser (owner
// asked: filter tasks by owning session, sortable table, fragments grouped)
var taskSort = {key: 'id', dir: 1};
var taskOwner = 'all';
try {
  var savedSort = JSON.parse(localStorage.getItem('sb.taskSort') || 'null');
  if (savedSort && savedSort.key) taskSort = savedSort;
  var savedOwner = localStorage.getItem('sb.taskOwner');
  if (savedOwner) taskOwner = String(savedOwner);
} catch (e) {}
function saveTaskView(){
  try { localStorage.setItem('sb.taskSort', JSON.stringify(taskSort)); localStorage.setItem('sb.taskOwner', taskOwner); } catch (e) {}
}
function ownerKey(t){ return t.owner_sid ? String(t.owner_sid) : 'unclaimed'; }
var ownerDisp = {}; // sid → display label, rebuilt per poll; shared intent labels get the sid appended
function ownerName(t){
  var s = t.owner_sid ? String(t.owner_sid) : '';
  if (s && ownerDisp[s]) return ownerDisp[s];
  return t.owner_label || (s ? s.slice(0, 10) : '') || 'unclaimed';
}
function buildOwnerDisp(ts){ // seven lanes all claiming "work-graph" must stay distinguishable
  var sidLabel = {}, byLabel = {};
  for (var i = 0; i < ts.length; i++){
    var s = ts[i].owner_sid ? String(ts[i].owner_sid) : '';
    if (!s) continue;
    var l = ts[i].owner_label || s.slice(0, 10) || 'unclaimed';
    sidLabel[s] = l;
    (byLabel[l] || (byLabel[l] = {}))[s] = 1;
  }
  ownerDisp = {};
  for (var s2 in sidLabel){
    var l2 = sidLabel[s2];
    var n = 0; for (var x in byLabel[l2]) n++;
    ownerDisp[s2] = n > 1 ? l2 + ' (' + s2.slice(0, 12) + ')' : l2;
  }
}
function taskSortVal(t, k){
  if (k === 'age') return Number(t.age_s || 0);
  if (k === 'decisions') return Number(t.open_decisions || 0);
  if (k === 'owner') return ownerName(t).toLowerCase();
  var s2 = String(k === 'title' ? t.title : k === 'state' ? t.state : t.id || '');
  return s2.toLowerCase();
}
function sortTasks(arr){
  var k = taskSort.key, d = taskSort.dir;
  arr.sort(function(a, b){
    var va = taskSortVal(a, k), vb = taskSortVal(b, k);
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
  });
}
function taskGroups(ts){ // dotted fragments (W138.1) nest under their parent row
  var byIdMap = {}, roots = [], kids = {};
  for (var i = 0; i < ts.length; i++) byIdMap[String(ts[i].id)] = ts[i];
  for (var j = 0; j < ts.length; j++){
    var t = ts[j], id = String(t.id), dot = id.lastIndexOf('.');
    var pid = dot > 0 ? id.slice(0, dot) : null;
    if (pid && byIdMap[pid]) (kids[pid] || (kids[pid] = [])).push(t);
    else roots.push(t);
  }
  return {roots: roots, kids: kids};
}
function renderTaskOwnerOptions(ts){
  var sel = byId('taskOwner');
  var seen = {}, names = [];
  for (var i = 0; i < ts.length; i++){
    var k = ownerKey(ts[i]);
    if (!seen[k]) { seen[k] = ownerName(ts[i]); names.push([k, seen[k]]); }
  }
  names.sort(function(a, b){ return a[1].localeCompare(b[1]); });
  var html = '<option value="all">all sessions</option>';
  for (var j = 0; j < names.length; j++) html += '<option value="' + esc(names[j][0]) + '">' + esc(names[j][1]) + '</option>';
  if (sel.dataset.sig === html) return;
  sel.innerHTML = html;
  sel.dataset.sig = html;
  var has = false;
  for (var o = 0; o < sel.options.length; o++) if (sel.options[o].value === taskOwner) has = true;
  if (!has) { taskOwner = 'all'; saveTaskView(); }
  sel.value = taskOwner;
}
function paintSort(){
  var ths = document.querySelectorAll('#tasksTbl th');
  for (var i = 0; i < ths.length; i++){
    var th = ths[i], k = th.getAttribute('data-k');
    var b = th.querySelector('.thsort');
    if (!k || !b) continue;
    var active = k === taskSort.key;
    th.setAttribute('aria-sort', active ? (taskSort.dir === 1 ? 'ascending' : 'descending') : 'none');
    b.textContent = (b.getAttribute('data-label') || '') + (active ? (taskSort.dir === 1 ? ' \u25B4' : ' \u25BE') : '');
  }
}
function pollTasks(){
  if (tasksBusy || curTab !== 'tasks') return;
  tasksBusy = true;
  fetch('/api/tasks' + projQuery(), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.tasks)) throw new Error('bad /api/tasks payload');
      tasksData = j; tasksOkAt = Date.now(); tasksErr = null; tasksLoaded = true;
      noteProjects(j.projects);
    })
    .catch(function(e){ tasksErr = String((e && e.message) || e); })
    .finally(function(){ tasksBusy = false; renderTasks(); });
}
function taskRow(t, parentId){
  var owner = ownerName(t);
  var od = t.open_decisions || 0;
  var kid = parentId ? '<span class="kidmark">↳</span>' : '';
  return '<tr data-tid="' + esc(t.id) + '"><td>' + kid + '<button type="button" class="tidbtn mono" data-task="' + esc(t.id) + '" data-proj="' + esc(t.project || '') + '" aria-haspopup="dialog">' + esc(t.id) + '</button></td>' +
    '<td class="ttitle">' + esc(String(t.title || '(untitled)')).slice(0, 120) + '</td>' +
    '<td>' + taskPill(t.state) + '</td>' +
    '<td>' + esc(owner) + '</td>' +
    '<td class="num">' + agoShort(t.age_s) + '</td>' +
    '<td class="num' + (od ? ' rq' : '') + '">' + (od || '-') + '</td></tr>';
}
function renderTasks(){
  var errEl = byId('tasksErr');
  var body = byId('tasksBody');
  if (!tasksLoaded && !tasksErr) {
    clearErr(errEl);
    sigSet(body, 'loading', '<tr><td colspan="6" class="dim">loading tasks...</td></tr>');
    return;
  }
  if (tasksErr) {
    var when = tasksOkAt ? ago(Math.round((Date.now() - tasksOkAt) / 1000)) : 'never';
    errBanner(errEl, 'task list unavailable — last good ' + when, function(){ tasksErr = null; pollTasks(); });
  } else {
    clearErr(errEl);
  }
  if (!tasksData) return; // nothing good yet — keep loading/error row
  var ts = tasksData.tasks;
  buildOwnerDisp(ts);
  renderTaskOwnerOptions(ts);
  var own = taskOwner === 'all' ? ts : ts.filter(function(t){ return ownerKey(t) === taskOwner; });
  var g = taskGroups(own); // fragments nest under their parent row
  sortTasks(g.roots);
  var html = '';
  for (var i = 0; i < g.roots.length; i++){
    var r = g.roots[i];
    html += taskRow(r);
    var kids = g.kids[r.id];
    if (kids) { sortTasks(kids); for (var c = 0; c < kids.length; c++) html += taskRow(kids[c], r.id); }
  }
  if (!html) html = '<tr><td colspan="6" class="dim">' + (ts.length ? '(no tasks for this session)' : '(no tasks)') + '</td></tr>';
  var cnt = byId('taskCount');
  if (cnt) cnt.textContent = own.length === ts.length ? own.length + ' tasks' : own.length + ' of ' + ts.length + ' tasks';
  sigSetKeep(body, html, html, 'data-task'); // rebuild only on real change; refocus the row button if the table swapped under it
}
function openTask(id, proj, trigger){
  task.id = id; task.proj = proj || null; task.data = null; task.err = null; task.okAt = 0; task.trigger = trigger || null;
  byId('drawer').hidden = false;
  setText(byId('drawerTitle'), 'task ' + id);
  sigSet(byId('drawerBody'), '', '<div class="state dim">loading task...</div>');
  pollTask(true);
  byId('drawerClose').focus();
}
function closeTask(){
  byId('drawer').hidden = true;
  var t = task.trigger;
  var id = task.id;
  task.id = null; task.trigger = null; task.data = null;
  if (t && document.contains(t)) { t.focus(); return; }
  var b = id ? document.querySelector('#tasksBody [data-task="' + id + '"]') : null;
  if (b) b.focus(); // row was re-rendered while open — refocus its button
}
function pollTask(force){
  if (!task.id || task.busy) return;
  if (!force && task.okAt && Date.now() - task.okAt < 5000) return; // drawer refresh throttle
  task.busy = true;
  // the task's own project beats the global filter — 'all' must still resolve
  var qp = task.proj ? '?project=' + encodeURIComponent(task.proj) : projQuery();
  fetch('/api/task' + qp + (qp ? '&' : '?') + 'id=' + encodeURIComponent(task.id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false) throw new Error((j && j.error) || 'bad /api/task payload');
      if (!j.task || !Array.isArray(j.events)) throw new Error('bad /api/task payload');
      task.data = j; task.err = null; task.okAt = Date.now();
    })
    .catch(function(e){ task.err = String((e && e.message) || e); })
    .finally(function(){ task.busy = false; renderDrawer(); });
}
function renderDrawer(){
  if (!task.id) return;
  var d = task.data;
  setText(byId('drawerTitle'), d ? d.task.id + ' — ' + String(d.task.title || '').slice(0, 70) : 'task ' + task.id);
  var body = byId('drawerBody');
  if (!d) {
    if (!task.err) return; // keep the loading row
    body.setAttribute('data-sig', '');
    body.innerHTML = '<div class="derr">task unavailable — ' + esc(String(task.err).slice(0, 120)) + '</div>' +
      '<button class="retry" id="taskRetry" type="button">retry</button>';
    byId('taskRetry').addEventListener('click', function(){ task.err = null; pollTask(true); });
    return;
  }
  var t = d.task;
  var meta = '<div class="r"><span class="dim">state</span> ' + taskPill(t.state) + '</div>' +
    '<div class="r"><span class="dim">owner</span> ' + esc(t.owner_label || (t.owner_sid ? String(t.owner_sid).slice(0, 12) : '') || 'unclaimed') + '</div>' +
    '<div class="r"><span class="dim">project</span> <span class="mono">' + esc(t.project || '?') + '</span></div>' +
    (t.requires ? '<div class="r"><span class="dim">needs</span> <span class="rq mono">' + esc(String(t.requires)) + '</span></div>' : '') +
    (t.scope ? '<div class="r"><span class="dim">scope</span> <span class="mono">' + esc(String(t.scope)) + '</span></div>' : '') +
    (t.parent_id ? '<div class="r"><span class="dim">parent</span> ' + esc(t.parent_id) + '</div>' : '') +
    '<div class="r"><span class="dim">age</span> ' + ago(t.age_s) + '</div>' +
    '<div class="r"><span class="dim">open decisions</span> ' + (t.open_decisions || 0) + '</div>';
  var decs = '';
  var dl = d.decisions || [];
  for (var i = 0; i < dl.length; i++) {
    var dd = dl[i] || {};
    decs += '<div class="dd"><span class="pill hst' + (dd.state === 'OPEN' ? ' open' : '') + '">' + esc(String(dd.state || '?').toLowerCase()) + '</span> ' +
      '<span class="hq">' + esc(String(dd.question || '').slice(0, 120)) + '</span>' +
      (dd.answer_note ? '<span class="hans">' + esc(String(dd.answer_note).slice(0, 160)) + '</span>' : '') + '</div>';
  }
  if (!decs) decs = '<div class="r"><span class="dim">(none)</span></div>';
  var tl = '';
  var evs = d.events || [];
  for (var j = 0; j < evs.length; j++) {
    var e = evs[j] || {};
    tl += '<div class="r"><span class="ts">' + agoShort(msAgo(e.ts)) + '</span><span><span class="akind">' + esc(String(e.kind || '?')) + '</span> ' +
      '<span class="mono">' + esc(String(e.source || '').slice(0, 16)) + '</span>' +
      (e.note ? ' — ' + esc(String(e.note).slice(0, 90)) : '') +
      (e.sha ? ' <span class="mono">@' + esc(String(e.sha).slice(0, 7)) + '</span>' : '') + '</span></div>';
  }
  if (!tl) tl = '<div class="r"><span class="dim">(no events)</span></div>';
  var html = '<div class="feed"><h2>Details</h2>' + meta + '</div>' +
    '<div class="feed"><h2>Linked decisions</h2>' + decs + '</div>' +
    '<div class="feed"><h2>Timeline</h2>' + tl + '</div>';
  if (task.err) html += '<div class="derr">refresh failed — ' + esc(String(task.err).slice(0, 120)) + '</div>';
  sigSet(body, String(task.okAt) + '|' + (task.err || ''), html);
}
// --- 5: activity feed (Activity tab, /api/activity, newest first) ---
function pollAct(){
  if (actBusy || curTab !== 'activity') return;
  actBusy = true;
  fetch('/api/activity' + projQuery(), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.events)) throw new Error('bad /api/activity payload');
      actData = j; actOkAt = Date.now(); actErr = null; actLoaded = true;
      noteProjects(j.projects);
    })
    .catch(function(e){ actErr = String((e && e.message) || e); })
    .finally(function(){ actBusy = false; renderAct(); });
}
function renderAct(){
  var errEl = byId('actErr');
  var body = byId('actBody');
  if (!actLoaded && !actErr) {
    clearErr(errEl);
    sigSet(body, 'loading', '<div class="r"><span class="dim">loading activity...</span></div>');
    return;
  }
  if (actErr) {
    var when = actOkAt ? ago(Math.round((Date.now() - actOkAt) / 1000)) : 'never';
    errBanner(errEl, 'activity feed unavailable — last good ' + when, function(){ actErr = null; pollAct(); });
  } else {
    clearErr(errEl);
  }
  if (!actData) return;
  var ev = actData.events || [];
  var html = '';
  for (var i = 0; i < ev.length; i++) {
    var e = ev[i] || {};
    var row = '<div class="r"><span class="ts">' + agoShort(msAgo(e.ts)) + '</span><span>';
    row += '<span class="akind">' + esc(String(e.kind || '?')) + '</span> <span class="mono">' + esc(String(e.source || '?').slice(0, 16)) + '</span>';
    if (e.target) row += ' -&gt; ' + esc(String(e.target).slice(0, 12));
    if (e.note) row += ' — ' + esc(String(e.note).slice(0, 80));
    if (e.sha) row += ' <span class="mono">@' + esc(String(e.sha).slice(0, 7)) + '</span>';
    html += row + '</span></div>';
  }
  if (!html) html = '<div class="r"><span class="dim">(no activity yet)</span></div>';
  sigSet(body, String(actOkAt), html);
}
// --- 6: setup checklist (Setup tab, /api/setup) ---
function pollSetup(){
  if (setupBusy) return;
  setupBusy = true;
  fetch('/api/setup', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.checks)) throw new Error('bad /api/setup payload');
      setupData = j; setupOkAt = Date.now(); setupErr = null; setupLoaded = true;
    })
    .catch(function(e){ setupErr = String((e && e.message) || e); })
    .finally(function(){ setupBusy = false; renderSetup(); });
}
function renderSetup(){
  var errEl = byId('setupErr');
  var body = byId('setupBody');
  if (!setupLoaded && !setupErr) {
    clearErr(errEl);
    sigSet(body, 'loading', '<div class="state dim">loading setup checks...</div>');
    return;
  }
  if (setupErr) {
    var when = setupOkAt ? ago(Math.round((Date.now() - setupOkAt) / 1000)) : 'never';
    errBanner(errEl, 'setup checks unavailable — last good ' + when, function(){ setupErr = null; pollSetup(); });
  } else {
    clearErr(errEl);
  }
  if (!setupData) return;
  var cs = setupData.checks || [];
  var html = '';
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i] || {};
    html += '<div class="card scard"><div class="shead"><span class="sok ' + (c.ok ? 'ok' : 'fail') + '">' + (c.ok ? 'ok' : 'fail') + '</span> <b>' + esc(c.label || c.id || '?') + '</b></div>' +
      '<div class="sdetail dim">' + esc(String(c.detail || '')) + '</div>' +
      (c.fix ? '<div class="sfix"><code>' + esc(String(c.fix)) + '</code> <button type="button" class="copyfix" data-fix="' + esc(String(c.fix)) + '">copy</button></div>' : '') +
      '</div>';
  }
  if (!html) html = '<div class="state dim">(no checks returned)</div>';
  sigSet(body, String(setupOkAt), html);
}
// --- 7: tab shell (location.hash driven, deep-linkable, back/forward) ---
function pollActiveTab(){
  if (curTab === 'tasks') pollTasks();
  else if (curTab === 'activity') pollAct();
  else if (curTab === 'decisions') pollHist(); // no-op while history is collapsed
  // governor rides /api/data; setup fetches on activation
}
function renderTab(){
  if (curTab === 'decisions') renderHist();
  else if (curTab === 'tasks') renderTasks();
  else if (curTab === 'activity') renderAct();
  else if (curTab === 'governor') { if (lastData) { renderClaims(lastData); renderDone(lastData); renderEvents(lastData); } }
  else if (curTab === 'setup') renderSetup();
}
var nav = document.querySelector('nav.tabs');
function setTab(id, fromHash){
  if (!TABS[id]) id = 'decisions';
  curTab = id;
  var bs = nav.querySelectorAll('button[data-tab]');
  for (var i = 0; i < bs.length; i++) {
    if (bs[i].getAttribute('data-tab') === id) bs[i].setAttribute('aria-current', 'true');
    else bs[i].removeAttribute('aria-current');
  }
  for (var name in TABS) byId('tab-' + name).hidden = name !== id;
  if (!fromHash && location.hash !== '#' + id) location.hash = id;
  pollActiveTab();
  renderTab();
}
// --- wiring ---
nav.addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('button[data-tab]');
  if (b) setTab(b.getAttribute('data-tab'));
});
window.addEventListener('hashchange', function(){
  var h = (location.hash || '').replace(/^#/, '');
  if (TABS[h]) setTab(h, true);
});
byId('tasksTbl').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('[data-task]');
  if (b) openTask(b.getAttribute('data-task'), b.getAttribute('data-proj'), b);
});
var theadEl = document.querySelector('#tasksTbl thead');
if (theadEl) theadEl.addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('.thsort') : null;
  if (!b) return;
  var th = b.closest('th');
  var k = th ? th.getAttribute('data-k') : null;
  if (!k) return;
  if (taskSort.key === k) taskSort.dir = -taskSort.dir;
  else { taskSort.key = k; taskSort.dir = 1; }
  saveTaskView(); paintSort(); renderTasks();
});
var ownSel = byId('taskOwner');
if (ownSel) ownSel.addEventListener('change', function(e){
  taskOwner = e.target.value || 'all';
  saveTaskView(); renderTasks();
});
paintSort();
byId('drawerClose').addEventListener('click', closeTask);
byId('setupBody').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.copyfix');
  if (!b) return;
  var fix = b.getAttribute('data-fix') || '';
  navigator.clipboard.writeText(fix).then(function(){ toast('copied to clipboard'); }, function(){ toast('copy failed — select the command text'); });
});
byId('decToggle').addEventListener('click', function(){ setCollapsed(!decCollapsed); });
byId('needsn').addEventListener('click', function(){
  setTab('decisions');
  if (decCollapsed) setCollapsed(false);
  byId('decisions').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
byId('histHead').addEventListener('click', function(){
  histOpen = !histOpen;
  byId('histHead').setAttribute('aria-expanded', histOpen ? 'true' : 'false');
  setText(byId('histCaret'), histOpen ? '-' : '+');
  byId('histBody').style.display = histOpen ? 'block' : 'none';
  if (histOpen) pollHist();
  renderHist();
});
byId('fleetHead').addEventListener('click', function(){
  var b = byId('fleetBody');
  var open = b.style.display !== 'none';
  b.style.display = open ? 'none' : 'block';
  setText(byId('fleetCaret'), open ? '+' : '-');
  byId('fleetHead').setAttribute('aria-expanded', open ? 'false' : 'true');
});
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  if (task.id) { closeTask(); return; } // drawer first, then the section
  setCollapsed(true); // collapses the section, not the decisions
});
sel.addEventListener('change', function(){
  projBaseline = true; // fresh scope — re-baseline toasts
  tick();
});
function renderAll(){
  renderConn();
  renderFleet();
  renderDecisions();
  renderTab();
}
function setCollapsed(v){
  decCollapsed = v;
  renderDecisions();
}
setInterval(tick, 1000);
if (!location.hash) history.replaceState(null, '', '#decisions');
setTab(TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'decisions', true);
tick();
renderAll();
</script></body></html>`);
