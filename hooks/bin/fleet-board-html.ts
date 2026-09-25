const unesc = (s) => s.split("\\u2014").join(String.fromCharCode(0x2014)).split("\\u00b7").join(String.fromCharCode(0xb7)).split("\\u00B7").join(String.fromCharCode(0xb7));
// fleet-board-html.ts — the fleet board page, split from the server so the
// HTML payload stays reviewable. Pure string; served by fleet-board.ts.
// Source stays pure ASCII: — renders an em dash, · a middle dot.
export const HTML = unesc(String.raw`<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iI2ZmZiIvPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIzLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMjIgMTAgQzIzIDQgNDEgNCA0MiAxMCIvPgogICAgPHBhdGggZD0iTTIyIDEwIEw0NCA0NSBMMzkgNTUiLz4KICAgIDxwYXRoIGQ9Ik00MiAxMCBMMjAgNDUgTDI1IDU1Ii8+CiAgICA8cGF0aCBkPSJNMzIgMjcgTDMyIDQ5Ii8+CiAgPC9nPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIyLjQiPgogICAgPGNpcmNsZSBjeD0iMzkiIGN5PSI1Ny4yIiByPSIyLjYiLz4KICAgIDxjaXJjbGUgY3g9IjI1IiBjeT0iNTcuMiIgcj0iMi42Ii8+CiAgICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjUxLjYiIHI9IjIuNiIvPgogIDwvZz4KPC9zdmc+Cg=="><title>FLEET BOARD</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background:#141413; color:#e8e6e1; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; margin:0; padding:16px 20px 28px; }
.mono { font-family:ui-monospace,Menlo,monospace; }
.dim { color:#8a8781; }
.state { font-size:12px; padding:4px 0; }
header { display:flex; align-items:baseline; gap:14px; margin-bottom:10px; }
header .mark { font-size:13px; font-weight:600; letter-spacing:.08em; }
header .right { margin-left:auto; display:flex; align-items:center; gap:12px; }
#conn { font-size:11px; color:#8a8781; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:0; }
.dot.live { background:#5c7a35; }
.dot.stale { background:#d8900f; }
.dot.err { background:#af2f12; }
#stamp { font-size:11px; color:#8a8781; font-variant-numeric:tabular-nums; }
#blockedn { color:#af2f12; font-size:11px; font-variant-numeric:tabular-nums; }
#needsn { background:#221512; border:1px solid #af2f12; border-radius:2px; padding:2px 9px; color:#c96a4f; font:inherit; font-size:11px; font-weight:600; cursor:pointer; }
#needsn:empty { display:none; }
select { background:#1c1b19; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font:11px ui-monospace,Menlo,monospace; max-width:380px; }
#fleet { margin-bottom:12px; }
#fleetHead { display:block; width:100%; text-align:left; background:#1c1b19; border:1px solid rgba(255,255,255,.12); border-radius:2px; color:#8a8781; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
#fleetHead:hover { border-color:rgba(255,255,255,.24); }
#fleetCaret { display:inline-block; width:10px; }
#fleetBody { display:none; padding:8px 2px 0; }
.chip { display:inline-block; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font-size:10px; color:#8a8781; margin:0 6px 6px 0; }
.chip b { color:#e8e6e1; font-weight:500; }
.chip .st { text-transform:uppercase; letter-spacing:.06em; }
.chip.zombie { border-color:#af2f12; color:#c96a4f; }
.chip.zombie b { color:#c96a4f; }
#decisions { border:1px solid rgba(255,255,255,.12); border-radius:2px; background:#171614; margin-bottom:16px; }
#decisions.has { border-color:rgba(175,47,18,.6); }
#decisions h2 { margin:0; padding:8px 14px; display:flex; align-items:baseline; gap:12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#af2f12; }
#decToggle { background:none; border:none; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; }
#decCaret { display:inline-block; width:10px; }
#decState { margin-left:auto; color:#8a8781; font-weight:400; text-transform:none; letter-spacing:0; font-size:12px; }
#decErr { padding:0 14px 8px; color:#c96a4f; font-size:12px; }
#decErr:empty { display:none; }
#decisions.closed #decList, #decisions.closed #decErr { display:none; }
.dec { border-top:1px solid rgba(255,255,255,.07); padding:10px 14px 12px; }
#decList .dec:first-child { border-top:none; }
.dec.hit, .card.hit { outline:2px solid #d8900f; outline-offset:-2px; }
.dec.sent { opacity:.55; }
.dhead { display:flex; gap:10px; align-items:baseline; font-size:11px; color:#8a8781; flex-wrap:wrap; }
.dproj { color:#d8900f; }
.dq { font-size:13.5px; line-height:1.4; margin:5px 0 2px; word-break:break-word; }
.dblocks { font-size:11px; color:#8a8781; margin-bottom:4px; }
.dopts { margin:4px 0 2px; }
.optrow { display:flex; align-items:baseline; gap:8px; margin:4px 0; }
button.opt { background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.22); border-radius:2px; padding:2px 10px; font:inherit; font-size:11.5px; cursor:pointer; }
button.opt:hover { border-color:#d8900f; color:#d8900f; }
.optrow.sel button.opt { border-color:#d8900f; color:#d8900f; box-shadow:0 0 0 1px #d8900f; background:#221f14; }
.optrow .trade { font-size:10.5px; color:#8a8781; }
.dadv { margin:7px 0 4px; padding:8px 10px; background:#221f1c; border-left:2px solid #d8900f; font-size:12px; }
.dadv .rhead { color:#d8900f; font-weight:600; font-size:10px; letter-spacing:.06em; margin-bottom:2px; }
.dadv .why { color:#8a8781; margin-top:3px; white-space:pre-wrap; }
.dadv .risk { color:#c96a4f; margin-top:3px; }
.dans { display:flex; gap:6px; margin-top:7px; flex-wrap:wrap; align-items:center; }
.dans input { flex:1; min-width:220px; background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:5px 9px; font:inherit; font-size:12px; }
.dans input:focus { outline:1px solid #d8900f; }
button.send { background:#d8900f; color:#141413; border:1px solid #d8900f; border-radius:2px; padding:5px 16px; font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.send:disabled, button.getrec:disabled { opacity:.45; cursor:default; }
button.getrec { background:#141413; color:#8cbbad; border:1px solid #8cbbad; border-radius:2px; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
button.dismiss { background:none; border:none; padding:0; color:#8a8781; font:inherit; font-size:10.5px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.derr { color:#c96a4f; font-size:11px; margin-top:5px; }
.derr:empty { display:none; }
.retry { background:none; border:1px solid #af2f12; color:#c96a4f; border-radius:2px; font:inherit; font-size:10px; padding:1px 8px; cursor:pointer; margin-left:8px; }
#board .sec { margin-bottom:20px; }
#board h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#8a8781; margin:0 0 8px; }
#board h2.sub { margin-top:16px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:10px; align-content:start; }
.pname { font-size:11px; color:#d8900f; margin:8px 0 4px; grid-column:1 / -1; }
.pname .pct { color:#8a8781; }
.card { background:#1c1b19; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:10px 12px; }
.card:hover { border-color:rgba(255,255,255,.24); background:#25231f; }
.card.mine { border-left:2px solid #d8900f; }
.card.gated { opacity:.6; }
.card.need { border-color:#af2f12; box-shadow:0 0 0 1px #af2f12; cursor:pointer; }
.card .id { font-weight:600; font-size:12.5px; }
.card .t { font-weight:500; word-break:break-word; margin-top:2px; }
.card .m { color:#8a8781; font-size:10.5px; margin-top:4px; }
.pill { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:transparent; border:1px solid; border-radius:2px; padding:1px 6px; margin-left:6px; vertical-align:1px; }
.pill.run { color:#d8900f; border-color:#d8900f; }
.pill.done { color:#5c7a35; border-color:#5c7a35; }
.pill.block { color:#af2f12; border-color:#af2f12; }
.rq { color:#c96a4f; }
.card.flash { animation: tint .3s; }
@keyframes tint { from { background:#2a2822; } to { background:#1c1b19; } }
.card[data-open] { cursor:pointer; }
details#diag { border:1px solid rgba(255,255,255,.12); border-radius:2px; }
details#diag > summary { cursor:pointer; padding:8px 12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#8a8781; }
#diagBody { padding:4px 12px 12px; }
.feed { border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:10px 12px; font-size:11.5px; margin-bottom:14px; }
.feed h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#8a8781; margin:0 0 8px; }
.feed .filters { margin-bottom:6px; display:flex; gap:4px; flex-wrap:wrap; }
.feed .filters button { background:transparent; color:#8a8781; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:1px 7px; font:9px ui-monospace,Menlo,monospace; text-transform:uppercase; cursor:pointer; }
.feed .filters button.on { color:#d8900f; border-color:#d8900f; }
.feed .r { display:flex; gap:8px; padding:2px 0; }
.feed .r .ts { width:52px; flex:none; text-align:right; color:#8a8781; font-variant-numeric:tabular-nums; }
.feed .r.hot { border-left:2px solid #af2f12; background:#221f1c; padding-left:8px; }
.feed b { font-weight:500; }
#toasts { position:fixed; bottom:16px; right:16px; display:flex; flex-direction:column; gap:6px; z-index:20; max-width:min(380px, 90vw); }
.toast { background:#221f1c; border:1px solid #af2f12; border-left-width:3px; color:#e8e6e1; padding:8px 12px; font-size:12px; border-radius:2px; box-shadow:0 2px 12px rgba(0,0,0,.5); }
</style></head><body>
<header>
  <span class="mark">FLEET BOARD</span>
  <div class="right">
    <span id="conn"></span>
    <span id="stamp"></span>
    <span id="blockedn"></span>
    <button id="needsn" type="button"></button>
    <select id="sess"><option value="">all lanes</option></select>
  </div>
</header>
<div id="fleet">
  <button id="fleetHead" type="button"><span id="fleetCaret">+</span> <span id="fleetLine">fleet: loading...</span></button>
  <div id="fleetBody"></div>
</div>
<section id="decisions">
  <h2><button id="decToggle" type="button"><span id="decCaret">-</span> Decisions needed</button><span id="decState">loading decisions...</span></h2>
  <div id="decErr"></div>
  <div id="decList"></div>
</section>
<div id="board">
  <div class="sec"><h2>Active work</h2><div class="grid" id="activeBody"><div class="state dim">loading fleet...</div></div></div>
  <div class="sec"><h2>Queued / blocked</h2><div class="grid" id="queuedBody"></div>
    <h2 class="sub">Failures</h2><div class="feed" id="fails"></div>
  </div>
</div>
<details id="diag">
  <summary>diagnostics</summary>
  <div id="diagBody">
    <div class="feed"><h2>Completed</h2><div id="done"></div></div>
    <div class="feed"><h2>Claims <span class="dim">(file -&gt; owner -&gt; waiting -&gt; lease)</span></h2><div id="claims"></div></div>
    <div class="feed"><h2>Event stream</h2><div class="filters" id="filters"></div><div id="events"></div></div>
  </div>
</details>
<div id="toasts"></div>
<script>
var sel = document.getElementById('sess');
var prev = {}; // board card change-detection (flash on change)
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
var flash = {}; // 'd'+decId or workItemId -> ms until which to highlight
var evFilter = 'all';
var titleProj = null;
function byId(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function setText(el, v){ if (el && el.textContent !== v) el.textContent = v; }
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
function pill(state){
  if (state === 'CLAIMED' || state === 'RUNNING') return '<span class="pill run">' + state.toLowerCase() + '</span>';
  if (state === 'DONE') return '<span class="pill done">done</span>';
  if (state === 'BLOCKED' || state === 'PAUSED' || state === 'FAILED') return '<span class="pill block">' + state.toLowerCase() + '</span>';
  return '';
}
function zombieFor(sid, zombies){
  for (var z = 0; z < zombies.length; z++) if (String(zombies[z].label).indexOf(String(sid).slice(0, 10)) === 0) return true;
  return false;
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
function pollData(){
  if (dataBusy) return;
  dataBusy = true;
  fetch('/api/data?session=' + encodeURIComponent(sel.value), { signal: AbortSignal.timeout(8000) })
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
  fetch('/api/decisions', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || typeof j.ts !== 'number' || !Array.isArray(j.decisions)) throw new Error('bad /api/decisions payload');
      if (!lastDec || j.ts >= lastDec.ts) lastDec = j;
      decOkAt = Date.now(); decErr = null; decLoaded = true;
      noteNew(j.decisions);
    })
    .catch(function(e){ decErr = String((e && e.message) || e); })
    .finally(function(){ decBusy = false; renderAll(); });
}
function tick(){ pollData(); pollDec(); }
function noteNew(list){
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (d.state && d.state !== 'OPEN') continue;
    if (!decBaseline) { seen[d.id] = true; continue; } // baseline, no toast storm
    if (seen[d.id]) continue;
    seen[d.id] = true;
    toast('new decision #' + d.id + ' — ' + String(d.question || '').slice(0, 90));
  }
  decBaseline = true;
}
function toast(msg){
  var t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  byId('toasts').appendChild(t);
  setTimeout(function(){ t.remove(); }, 6000);
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
function focusProject(){
  if (!lastData || !sel.value) return null;
  var ss = lastData.sessions || [];
  for (var i = 0; i < ss.length; i++) if (ss[i].sid === sel.value) return ss[i].project || null;
  return null;
}
// --- compact fleet summary (replaces the chip badge wall) ---
function chipHtml(s, zombies){
  var z = zombieFor(s.sid, zombies);
  var bits = '<b>' + esc(s.label) + '</b> · <span class="st">' + esc(String(s.state).toLowerCase()) + '</span> · heartbeat ' + ago(s.hbAgo);
  if (s.progressAgo != null) bits += ' · progress ' + ago(s.progressAgo);
  if (s.project) bits += ' · <span class="mono">' + esc(s.project) + '</span>';
  return '<span class="chip' + (z ? ' zombie' : '') + '" title="' + esc(s.sid) + '">' + bits + '</span>';
}
function renderFleet(){
  var d = lastData;
  if (!d) { setText(byId('fleetLine'), 'fleet: loading...'); return; }
  var ss = d.sessions || [];
  var running = 0;
  for (var i = 0; i < ss.length; i++) if (ss[i].state === 'RUNNING') running++;
  var zN = (d.zombies || []).length;
  var blocked = 0;
  var proj = d.projects || [];
  for (var p = 0; p < proj.length; p++) blocked += (proj[p].gated || []).length;
  var line = 'fleet: ' + running + ' running · ' + openDecs().length + ' waiting on you · ' + blocked + ' blocked' +
    (zN ? ' · ' + zN + ' zombie' + (zN === 1 ? '' : 's') : '');
  var el = byId('fleetLine');
  if (el.getAttribute('data-sig') !== line) { el.setAttribute('data-sig', line); el.innerHTML = line; }
  var body = byId('fleetBody');
  if (body.style.display === 'none') return; // collapsed: skip chip rebuild
  var zg = '';
  for (var zi = 0; zi < (d.zombies || []).length; zi++) zg += '<span class="chip zombie">zombie: ' + esc(d.zombies[zi].label) + '</span>';
  var chips = '';
  for (var ci = 0; ci < ss.length; ci++) {
    var s = ss[ci];
    if (s.state !== 'RUNNING' && !zombieFor(s.sid, d.zombies || [])) continue;
    chips += chipHtml(s, d.zombies || []);
  }
  var fsig = chips + zg;
  if (body.getAttribute('data-sig') !== fsig) { body.setAttribute('data-sig', fsig); body.innerHTML = fsig; }
}
function syncSessions(d){
  var want = {};
  for (var i = 0; i < d.sessions.length; i++) {
    var s = d.sessions[i];
    var flagged = d.needs && d.needs[s.sid] && d.needs[s.sid].length;
    want[s.sid] = s.label + ' - ' + s.role + ' - ' + s.state + (flagged ? '  [NEEDS ANSWER]' : '');
  }
  for (var oi = sel.options.length - 1; oi >= 1; oi--) if (!want[sel.options[oi].value]) sel.remove(oi);
  var have = {};
  for (var hi = 0; hi < sel.options.length; hi++) have[sel.options[hi].value] = sel.options[hi];
  for (var sid in want) {
    if (have[sid]) { if (have[sid].textContent !== want[sid]) have[sid].textContent = want[sid]; }
    else { var o = document.createElement('option'); o.value = sid; o.textContent = want[sid]; sel.appendChild(o); }
  }
}
function phead(p){
  return '<div class="pname">' + esc(p.name || p.project || '') + ' <span class="pct">— ' + (p.doneN || 0) + '/' + (p.total || 0) + ' (' + (p.pct || 0) + '%)</span></div>';
}
function card(w, focus, L, openable, N){
  var key = w.id + '|' + w.state + '|' + (w.owner || '') + '|' + (w.sha || '');
  var changed = prev[w.id] !== undefined && prev[w.id] !== key;
  prev[w.id] = key;
  var mine = focus && w.owner === focus;
  var gated = (w.blocked && w.state === 'READY') || w.state === 'BLOCKED' || w.state === 'PAUSED';
  var needsIt = w.owner && N[w.owner] && N[w.owner].length;
  var cls = 'card' + (mine ? ' mine' : '') + (changed ? ' flash' : '') + (gated ? ' gated' : '') + (needsIt ? ' need' : '') + (flash[w.id] && flash[w.id] > Date.now() ? ' hit' : '');
  var m = esc(w.owner ? (L[w.owner] || String(w.owner).slice(0, 10)) : 'unclaimed') + ' · ' + (w.updatedAgo >= 0 ? ago(w.updatedAgo) : '');
  if (w.sha) m += ' · <span class="mono">@' + esc(String(w.sha).slice(0, 7)) + '</span>';
  if (w.requires) m += ' · <span class="rq">needs <span class="mono">' + esc(String(w.requires)) + '</span></span>';
  if (w.note) m += ' · <span class="rq">' + esc(w.note).slice(0, 80) + '</span>';
  if (w.deps && w.deps.length) m += ' · <span class="rq">blocked by ' + esc(w.deps.join(', ')) + '</span>';
  var attrs = openable ? ' role="button" tabindex="0" data-open="item:' + esc(w.id) + '"' : '';
  return '<div class="' + cls + '"' + attrs + ' data-wid="' + esc(w.id) + '"><span class="id mono">' + esc(w.id) + '</span>' + pill(w.state) + '<div class="t">' + esc(w.title).slice(0, 90) + '</div><div class="m">' + m + '</div></div>';
}
function renderBoard(){
  var d = lastData;
  var actEl = byId('activeBody');
  var qEl = byId('queuedBody');
  if (!d) {
    if (dataErr) {
      actEl.innerHTML = '<div class="state dim">fleet data unavailable — no good response yet ' +
        '<button class="retry" id="dataRetry" type="button">retry</button></div>';
      byId('dataRetry').addEventListener('click', function(){ dataErr = null; pollData(); });
    } else {
      actEl.innerHTML = '<div class="state dim">loading fleet...</div>';
    }
    setText(byId('done'), ''); setText(byId('claims'), '');
    return;
  }
  syncSessions(d);
  var focus = sel.value;
  var focusProj = focusProject();
  var proj = d.projects || [];
  var flt = [];
  for (var pf = 0; pf < proj.length; pf++) {
    if (!focusProj || proj[pf].project === focusProj) flt.push(proj[pf]);
  }
  proj = flt;
  var L = d.labels || {};
  var N = d.needs || {};
  var blocked = 0;
  for (var bp = 0; bp < proj.length; bp++) blocked += (proj[bp].gated || []).length;
  byId('blockedn').textContent = blocked ? blocked + ' blocked' : '';
  byId('stamp').textContent = 'updated ' + ago(Math.max(0, Math.round((Date.now() - d.ts) / 1000)));
  titleProj = proj.length === 1 ? (proj[0].name || proj[0].project) : null;
  var act = '';
  for (var pa = 0; pa < proj.length; pa++) {
    var pp = proj[pa] || {};
    var infl = pp.inflight || [];
    if (!infl.length) continue;
    if (proj.length > 1 || pp.total) act += phead(pp);
    for (var ia = 0; ia < infl.length; ia++) act += card(infl[ia], focus, L, false, N);
  }
  actEl.innerHTML = act || '<div class="state dim">(nothing running)</div>';
  var q = '';
  for (var pq = 0; pq < proj.length; pq++) {
    var pr = proj[pq];
    var list = (pr.todo || []).concat(pr.gated || []);
    if (!list.length) continue;
    if (proj.length > 1) q += phead(pr);
    for (var iq = 0; iq < list.length; iq++) q += card(list[iq], focus, L, true, N);
  }
  qEl.innerHTML = q || '<div class="state dim">(queue empty)</div>';
  var fails = '';
  for (var fp = 0; fp < proj.length; fp++) {
    var others = proj[fp].other || [];
    for (var fw = 0; fw < others.length; fw++) {
      var oth = others[fw];
      var isFail = oth.state === 'FAILED' || oth.state === 'ORPHANED';
      if (!isFail) continue;
      var head = '<div class="r' + (oth.state === 'FAILED' ? ' hot' : '') + '">';
      var st = pill(oth.state) || '<span class="pill block">' + esc(String(oth.state).toLowerCase()) + '</span>';
      fails += head + '<span class="ts">' + (oth.updatedAgo >= 0 ? agoShort(oth.updatedAgo) : '-') + '</span>';
      fails += '<span><b class="mono">' + esc(oth.id) + '</b> ' + st + ' ' + esc(oth.title).slice(0, 60);
      if (oth.note) fails += ' <span class="rq">' + esc(oth.note).slice(0, 80) + '</span>';
      fails += '</span></div>';
    }
  }
  byId('fails').innerHTML = fails || '<div class="r"><span class="ts">-</span><span class="dim">(none)</span></div>';
  var done = '';
  for (var pd = 0; pd < proj.length; pd++) {
    var dlist = proj[pd].done || [];
    for (var idd = 0; idd < dlist.length; idd++) {
      var dn = dlist[idd];
      var dnRow = '<div class="r"><span class="ts">' + (dn.updatedAgo >= 0 ? agoShort(dn.updatedAgo) : '-') + '</span>';
      done += dnRow + '<span><b class="mono">' + esc(dn.id) + '</b> ' + esc(dn.title).slice(0, 60) + '</span></div>';
    }
  }
  byId('done').innerHTML = done || '<div class="r"><span class="ts">-</span><span class="dim">(none yet)</span></div>';
  renderClaims(d);
  renderEvents(d);
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
function setFilt(f){ evFilter = f; if (lastData) renderBoard(); }
function renderAll(){
  renderConn();
  renderFleet();
  renderBoard();
  renderDecisions();
}
// --- 2: decisions needed (persistent section, /api/decisions) ---
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
function renderDecisionsInner(){
  var focusProj = focusProject();
  var all = openDecs();
  var hiddenN = 0;
  var live = {};
  for (var i = 0; i < all.length; i++) {
    live[all[i].id] = true;
    if (focusProj && all[i].project !== focusProj) hiddenN++;
  }
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
    var label = all.length + ' decision' + (all.length === 1 ? '' : 's') + ' need you';
    if (hiddenN) label += ' — ' + hiddenN + ' more in other projects';
    setText(st, label);
    errEl.style.display = 'none';
  } else {
    setText(st, 'No pending decisions · checked ' + ago(Math.round((Date.now() - decOkAt) / 1000)));
    errEl.style.display = 'none';
  }
  // badge always visible while pending; "(N)" in title while collapsed
  var badge = byId('needsn');
  var btxt = all.length ? all.length + ' need you' : '';
  if (badge.textContent !== btxt) badge.textContent = btxt;
  var base = titleProj ? String(titleProj).toUpperCase() + ' · FLEET BOARD' : 'FLEET BOARD';
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
  for (var di = 0; di < all.length; di++) decNode(all[di], focusProj);
}
function decNode(d, focusProj){
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
  var visible = !(focusProj && d.project !== focusProj);
  q.style.display = visible ? '' : 'none';
  q.classList.toggle('sent', !!sentOk[d.id]);
  q.classList.toggle('hit', !!flash['d' + d.id] && flash['d' + d.id] > Date.now());
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
function findItem(d, id){
  var cols = ['todo','gated','inflight','done','other'];
  for (var p = 0; p < d.projects.length; p++) {
    for (var c = 0; c < cols.length; c++) {
      var arr = d.projects[p][cols[c]] || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === id) return arr[i];
      }
    }
  }
  return null;
}
// blocked item opened from the board: anchor to its decision (task match,
// else the asking agent) and flash it; else flash the queued card itself
function openItem(id){
  var d = lastData;
  if (!d) return;
  var it = findItem(d, id);
  var target = null;
  var all = openDecs();
  for (var i = 0; i < all.length; i++) {
    var dd = all[i];
    if (dd.task_id === id || (dd.question && String(dd.question).indexOf(id) >= 0)) {
      target = dd;
      break;
    }
    if (!target && it && it.owner && dd.asked_by) {
      if (dd.asked_by === it.owner || String(it.owner).indexOf(String(dd.asked_by)) === 0) {
        target = dd;
        break;
      }
    }
  }
  if (target) {
    setCollapsed(false);
    flash['d' + target.id] = Date.now() + 4000;
    renderDecisions();
    var dq = decNodeEl(target.id);
    if (dq) dq.scrollIntoView({ block: 'center' });
    return;
  }
  flash[id] = Date.now() + 4000;
  renderBoard();
  var el = byId('queuedBody').querySelector('[data-wid="' + id + '"]');
  if (!el) el = byId('activeBody').querySelector('[data-wid="' + id + '"]');
  if (el) el.scrollIntoView({ block: 'center' });
}
function setCollapsed(v){
  decCollapsed = v;
  renderDecisions();
}
// --- wiring ---
byId('board').addEventListener('click', function(e){
  var el = e.target.closest && e.target.closest('[data-open]');
  if (el) openItem(el.getAttribute('data-open').slice(5));
});
byId('board').addEventListener('keydown', function(e){
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var el = e.target.closest && e.target.closest('[data-open]');
  if (el) {
    e.preventDefault();
    openItem(el.getAttribute('data-open').slice(5));
  }
});
byId('decToggle').addEventListener('click', function(){ setCollapsed(!decCollapsed); });
byId('needsn').addEventListener('click', function(){
  if (decCollapsed) setCollapsed(false);
  byId('decisions').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
byId('fleetHead').addEventListener('click', function(){
  var b = byId('fleetBody');
  var open = b.style.display !== 'none';
  b.style.display = open ? 'none' : 'block';
  setText(byId('fleetCaret'), open ? '+' : '-');
});
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') setCollapsed(true); // collapses the section, not the decisions
});
sel.addEventListener('change', tick);
setInterval(tick, 1000);
tick();
renderAll();
</script></body></html>`);

