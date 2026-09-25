const unesc = (s) => s.split("\\u2014").join(String.fromCharCode(0x2014));
// fleet-board-html.ts — the fleet board page, split from the server so the
// HTML payload stays reviewable. Pure string; served by fleet-board.ts.
export const HTML = unesc(String.raw`<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iI2ZmZiIvPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIzLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMjIgMTAgQzIzIDQgNDEgNCA0MiAxMCIvPgogICAgPHBhdGggZD0iTTIyIDEwIEw0NCA0NSBMMzkgNTUiLz4KICAgIDxwYXRoIGQ9Ik00MiAxMCBMMjAgNDUgTDI1IDU1Ii8+CiAgICA8cGF0aCBkPSJNMzIgMjcgTDMyIDQ5Ii8+CiAgPC9nPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIyLjQiPgogICAgPGNpcmNsZSBjeD0iMzkiIGN5PSI1Ny4yIiByPSIyLjYiLz4KICAgIDxjaXJjbGUgY3g9IjI1IiBjeT0iNTcuMiIgcj0iMi42Ii8+CiAgICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjUxLjYiIHI9IjIuNiIvPgogIDwvZz4KPC9zdmc+Cg=="><title>FLEET BOARD</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background:#141413; color:#e8e6e1; font:13px/1.4 ui-monospace,Menlo,monospace; margin:0; padding:16px 20px 20px; }
header { display:flex; align-items:baseline; gap:16px; margin-bottom:12px; }
header .mark { font-size:13px; font-weight:600; letter-spacing:.08em; }
header .right { margin-left:auto; display:flex; align-items:center; gap:12px; }
#stamp { font-size:11px; color:#8a8781; font-variant-numeric:tabular-nums; }
#blockedn { color:#af2f12; font-size:11px; font-variant-numeric:tabular-nums; }
#needsn { background:none; border:none; padding:0; color:#af2f12; font:inherit; font-size:11px; font-weight:600; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
#lanes { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
.chip { border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font-size:10px; color:#8a8781; }
.chip b { color:#e8e6e1; font-weight:500; }
.chip .st { text-transform:uppercase; letter-spacing:.06em; }
.chip.zombie { border-color:#af2f12; color:#c96a4f; }
.chip.zombie b { color:#c96a4f; }
.card.need { border-color:#af2f12; box-shadow:0 0 0 1px #af2f12; cursor:pointer; }
.card.need .m { color:#c96a4f; }
#needsPanel { display:none; position:fixed; top:64px; right:20px; width:min(560px,90vw); background:#1c1b19; border:1px solid #af2f12; border-radius:2px; padding:14px 16px; z-index:10; max-height:75vh; overflow:auto; }
#needsPanel h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#af2f12; margin:0 0 10px; display:flex; justify-content:space-between; }
#needsPanel h2 button { background:none; border:none; padding:0; color:#8a8781; font:inherit; font-size:11px; cursor:pointer; }
#needsPanel .q { margin-bottom:14px; border-bottom:1px solid rgba(255,255,255,.07); padding-bottom:12px; }
#needsPanel .q:last-child { border-bottom:none; }
#needsPanel .q .who { font-size:11px; color:#8a8781; margin-bottom:2px; }
#needsPanel .q .txt { font-size:12px; margin-bottom:6px; word-break:break-word; }
#needsPanel .q .opts { margin-bottom:6px; display:flex; flex-wrap:wrap; gap:4px; }
#needsPanel .q .opts button { background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.2); border-radius:2px; padding:2px 8px; font:10px ui-monospace,Menlo,monospace; cursor:pointer; }
#needsPanel .q .opts button:hover { border-color:#d8900f; color:#d8900f; }
#needsPanel .q .adv { font-size:11px; margin-bottom:6px; padding:8px 10px; background:#221f1c; border-left:2px solid #d8900f; display:none; }
#needsPanel .q .adv .r { color:#d8900f; font-weight:600; }
#needsPanel .q .adv .why { color:#8a8781; margin-top:3px; white-space:pre-wrap; }
#needsPanel .q .adv .risk { color:#c96a4f; margin-top:3px; }
#needsPanel .q .adv .use { margin-top:5px; background:#141413; color:#d8900f; border:1px solid #d8900f; border-radius:2px; padding:2px 8px; font:10px ui-monospace,Menlo,monospace; cursor:pointer; text-transform:uppercase; letter-spacing:.06em; }
#needsPanel .q .adv .mdl { float:right; color:#8a8781; font-size:9px; }
#needsPanel .q .ans { display:flex; gap:6px; }
#needsPanel .q .ans input { flex:1; background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:4px 8px; font:11px ui-monospace,Menlo,monospace; }
#needsPanel .q .ans button { background:#141413; color:#d8900f; border:1px solid #d8900f; border-radius:2px; padding:4px 10px; font:10px ui-monospace,Menlo,monospace; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
#needsPanel .q .ans button.advice { color:#8cb; border-color:#8cb; }
#needsPanel .q .ans button:disabled { opacity:.5; cursor:default; }
#needsPanel .dismiss { background:none; border:none; padding:0; color:#8a8781; font:inherit; font-size:10px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
#nCtx { font-size:11px; color:#d8900f; margin-bottom:10px; }
#nEmpty { font-size:12px; color:#8a8781; }
.rq { color:#c96a4f; }
select { background:#1c1b19; color:#e8e6e1; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:3px 8px; font:11px ui-monospace,Menlo,monospace; max-width:380px; }
#wrap { display:flex; gap:24px; align-items:flex-start; }
#board { flex:1; display:grid; grid-template-columns:repeat(3,minmax(240px,1fr)); gap:12px; align-content:start; overflow-x:auto; }
.col { min-width:0; }
.col h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#8a8781; margin:0 0 8px; }
.pname { font-size:11px; color:#d8900f; margin:0 0 4px; }
.pname .pct { color:#8a8781; }
.card { background:#1c1b19; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:10px 12px; margin-bottom:8px; }
.card:hover { border-color:rgba(255,255,255,.24); background:#25231f; }
.card.mine { border-left:2px solid #d8900f; }
.card.gated { opacity:.6; }
.card .id { font-weight:600; font-size:13px; }
.card .t { font-weight:500; word-break:break-word; }
.card .m { color:#8a8781; font-size:10px; font-variant-numeric:tabular-nums; margin-top:4px; }
.pill { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:transparent; border:1px solid; border-radius:2px; padding:1px 6px; margin-left:6px; vertical-align:1px; }
.pill.run { color:#d8900f; border-color:#d8900f; }
.pill.done { color:#5c7a35; border-color:#5c7a35; }
.pill.block { color:#af2f12; border-color:#af2f12; }
.card.flash { animation: tint .3s; }
#needsPanel .q.flash { animation: tint .6s; }
.card[data-open] { cursor:pointer; }
@keyframes tint { from { background:#2a2822; } to { background:#1c1b19; } }
#rail { width:28%; min-width:280px; display:flex; flex-direction:column; gap:24px; }
.feed { border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:10px 12px; font-size:11px; }
.feed h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#8a8781; margin:0 0 8px; }
.feed .filters { margin-bottom:6px; display:flex; gap:4px; flex-wrap:wrap; }
.feed .filters button { background:transparent; color:#8a8781; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:1px 7px; font:9px ui-monospace,Menlo,monospace; text-transform:uppercase; cursor:pointer; }
.feed .filters button.on { color:#d8900f; border-color:#d8900f; }
.feed .r { display:flex; gap:8px; padding:2px 0; }
.feed .r .ts { width:44px; flex:none; text-align:right; color:#8a8781; font-variant-numeric:tabular-nums; }
.feed .r.hot { border-left:2px solid #af2f12; background:#221f1c; padding-left:8px; }
.feed b { font-weight:500; }
</style></head><body>
<header>
  <span class="mark">FLEET BOARD</span>
  <div class="right">
    <span id="stamp"></span>
    <span id="blockedn"></span>
    <button id="needsn" type="button"></button>
    <select id="sess"><option value="">all</option></select>
  </div>
</header>
<div id="lanes"></div>
<div id="wrap">
  <div id="board"></div>
  <div id="rail">
    <div class="feed"><h2>Failures</h2><div id="fails"></div></div>
    <div class="feed"><h2>Claims</h2><div id="claims"></div></div>
    <div class="feed"><h2>Event stream</h2><div class="filters" id="filters"></div><div id="events"></div></div>
  </div>
</div>
<div id="needsPanel"><h2>DECISION FORKS <button id="nClose" type="button">&times; close</button></h2><div id="nCtx" style="display:none"></div><div id="nList"></div><div id="nEmpty" style="display:none">nothing waiting — lanes are autonomous</div></div>
<script>
var sel = document.getElementById('sess');
var prev = {};
var lastData = null;
var evFilter = 'all';
var advising = {}; // id -> ms timestamp when the advise request started
var answering = {}; // id -> true while an answer POST is in flight
var drafts = {}; // id -> typed-but-unsent text, survives re-renders
var needFilter = null; // target sid when opened from a lane card
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function pill(state){
  if (state==='CLAIMED'||state==='RUNNING') return '<span class="pill run">' + state.toLowerCase() + '</span>';
  if (state==='DONE') return '<span class="pill done">done</span>';
  if (state==='BLOCKED'||state==='PAUSED'||state==='FAILED') return '<span class="pill block">' + state.toLowerCase() + '</span>';
  return '';
}
function card(w, focus, L, N){
  var key = w.id+'|'+w.state+'|'+(w.owner||'')+'|'+(w.sha||'');
  var changed = prev[w.id] !== undefined && prev[w.id] !== key;
  prev[w.id] = key;
  var mine = focus && w.owner === focus;
  var gated = (w.blocked && w.state==='READY') || w.state==='BLOCKED' || w.state==='PAUSED';
  var needsIt = w.owner && N[w.owner] && N[w.owner].length;
  var cls = 'card' + (mine?' mine':'') + (changed?' flash':'') + (gated?' gated':'') + (needsIt?' need':'');
  var m = esc(w.owner ? (L[w.owner] || w.owner.slice(0,10)) : 'unclaimed') + ' · ' + (w.updatedAgo>=0 ? w.updatedAgo+'s' : '');
  if (w.sha) m += ' · @' + esc(String(w.sha).slice(0,7));
  if (w.requires) m += ' · <span class="rq">needs ' + esc(String(w.requires)) + '</span>';
  if (w.note) m += ' · <span class="rq">' + esc(w.note).slice(0,80) + '</span>';
  var open = needsIt ? 'need:'+esc(w.owner) : (gated ? 'item:'+esc(w.id) : '');
  var attrs = open ? ' role="button" tabindex="0" data-open="' + open + '"' : '';
  return '<div class="' + cls + '"' + attrs + '><span class="id">' + esc(w.id) + '</span>' + pill(w.state) + '<div class="t">' + esc(w.title).slice(0,90) + '</div><div class="m">' + m + '</div></div>';
}
function zombieFor(sid, zombies){
  for (var z = 0; z < zombies.length; z++) if (zombies[z].label.indexOf(sid.slice(0,10)) === 0) return true;
  return false;
}
function chipHtml(s, zombies){
  var z = zombieFor(s.sid, zombies);
  return '<span class="chip' + (z?' zombie':'') + '" title="' + esc(s.sid) + '"><b>' + esc(s.label) + '</b> · <span class="st">' + esc(s.state.toLowerCase()) + '</span> · hb ' + s.hbAgo + 's</span>';
}
function syncSessions(d){
  var want = {};
  for (var i = 0; i < d.sessions.length; i++) {
    var s = d.sessions[i];
    var flagged = d.needs && d.needs[s.sid] && d.needs[s.sid].length;
    want[s.sid] = s.label + ' · ' + s.role + ' · ' + s.state + (flagged ? '  ⚑ NEEDS ANSWER' : '');
  }
  for (var oi = sel.options.length - 1; oi >= 1; oi--) if (!want[sel.options[oi].value]) sel.remove(oi);
  var have = {};
  for (var hi = 0; hi < sel.options.length; hi++) have[sel.options[hi].value] = sel.options[hi];
  for (var sid in want) {
    if (have[sid]) { if (have[sid].textContent !== want[sid]) have[sid].textContent = want[sid]; }
    else { var o = document.createElement('option'); o.value = sid; o.textContent = want[sid]; sel.appendChild(o); }
  }
}
function render(d) {
  lastData = d;
  syncSessions(d);
  var zg = '';
  for (var zi = 0; zi < d.zombies.length; zi++) zg += '<span class="chip zombie">☠ ' + esc(d.zombies[zi].label) + '</span>';
  var chips = '';
  for (var ci = 0; ci < d.sessions.length; ci++) {
    var ss = d.sessions[ci];
    if (ss.state !== 'RUNNING' && !zombieFor(ss.sid, d.zombies)) continue;
    chips += chipHtml(ss, d.zombies);
  }
  document.getElementById('lanes').innerHTML = chips + zg;
  var focus = sel.value;
  var focusProj = focus ? (d.sessions.find(function(s){return s.sid === focus;}) || {}).project : null;
  var proj = d.projects;
  if (focusProj) proj = d.projects.filter(function(p){return p.project === focusProj;});
  var blocked = 0;
  for (var bp = 0; bp < proj.length; bp++) blocked += proj[bp].gated.length; // once, not per column
  var cols = [['01 / TODO','todo'],['02 / IN-FLIGHT','inflight'],['03 / DONE','done']];
  var html = '';
  for (var c = 0; c < cols.length; c++) {
    html += '<div class="col"><h2>' + cols[c][0] + '</h2>';
    for (var p = 0; p < proj.length; p++) {
      var list = proj[p][cols[c][1]].concat(cols[c][1] === 'todo' ? proj[p].gated : []);
      if (proj.length > 1) html += '<div class="pname">' + esc(proj[p].name) + ' <span class="pct">— ' + proj[p].doneN + '/' + proj[p].total + ' (' + proj[p].pct + '%)</span></div>';
      else if (c === 0) document.title = proj[p].name.toUpperCase() + ' · FLEET BOARD';
      for (var k = 0; k < list.length; k++) html += card(list[k], focus, d.labels, d.needs || {});
    }
    html += '</div>';
  }
  document.getElementById('board').innerHTML = html;
  document.getElementById('stamp').textContent = 'updated ' + Math.max(0, Math.round((Date.now() - d.ts)/1000)) + 's ago';
  document.getElementById('blockedn').textContent = blocked ? blocked + ' blocked' : '';
  var fails = '';
  for (var fp = 0; fp < proj.length; fp++)
    for (var fw = 0; fw < proj[fp].other.length; fw++) {
      var oth = proj[fp].other[fw];
      if (oth.state !== 'FAILED' && oth.state !== 'ORPHANED') continue;
      fails += '<div class="r' + (oth.state === 'FAILED' ? ' hot' : '') + '"><span class="ts">' + (oth.updatedAgo >= 0 ? oth.updatedAgo + 's' : '-') + '</span><span><b>' + esc(oth.id) + '</b> ' + (pill(oth.state) || '<span class="pill block">' + oth.state.toLowerCase() + '</span>') + ' ' + esc(oth.title).slice(0,60) + (oth.note ? ' <span class="rq">' + esc(oth.note).slice(0,80) + '</span>' : '') + '</span></div>';
    }
  document.getElementById('fails').innerHTML = fails || '<div class="r"><span class="ts">-</span><span>(none)</span></div>';
  var nN = 0; for (var s2 in (d.needs||{})) nN += d.needs[s2].length;
  var nn = document.getElementById('needsn');
  nn.textContent = nN ? nN + ' forks need you' : '';
  var cl = '';
  for (var i = 0; i < d.claims.length; i++) {
    var x = d.claims[i];
    cl += '<div class="r' + (x.hot ? ' hot' : '') + '"><span class="ts">' + x.tsAgo + 's</span><span><b>' + esc(d.labels[x.sid] || x.sid.slice(0,10)) + '</b> ' + esc(x.scope) + (x.intent ? ' — ' + esc(x.intent).slice(0,44) : '') + '</span></div>';
  }
  document.getElementById('claims').innerHTML = cl;
  var filts = ['all','landed','blocked','need','checkpoint','alert','answer'];
  var fh = '';
  for (var f = 0; f < filts.length; f++) fh += '<button class="' + (evFilter===filts[f]?'on':'') + '" onclick="setFilt(\'' + filts[f] + '\')">' + filts[f] + '</button>';
  document.getElementById('filters').innerHTML = fh;
  var ev = '';
  for (var j = d.events.length - 1; j >= 0; j--) {
    var e = d.events[j];
    var kl = e.kind.toLowerCase();
    if (evFilter !== 'all' && kl.indexOf(evFilter) < 0) continue;
    ev += '<div class="r"><span class="ts">' + e.tsAgo + 's</span><span>#' + e.id + ' <b>' + esc(e.kind) + '</b> ' + esc(e.source).slice(0,12) + (e.target ? ' → ' + esc(e.target).slice(0,10) : '') + (e.note ? ' — ' + esc(e.note).slice(0,56) : '') + '</span></div>';
  }
  document.getElementById('events').innerHTML = ev || '<div class="r"><span class="ts">—</span><span>(none match)</span></div>';
  if (document.getElementById('needsPanel').style.display === 'block') renderForks();
}
function setFilt(f){ evFilter = f; if (lastData) render(lastData); }
function forkList(d){
  var needs = d.needs || {};
  var out = [];
  for (var s in needs)
    for (var i = 0; i < needs[s].length; i++)
      if (!needFilter || s === needFilter) out.push({ sid: s, n: needs[s][i] });
  return out;
}
function renderForks() {
  var d = lastData; if (!d) return;
  var all = forkList(d);
  // advice job reconcile: the fact landed, stop the spinner (poll-driven)
  for (var ri = 0; ri < all.length; ri++) if (all[ri].n.advice || all[ri].n.adviceError) delete advising[all[ri].n.id];
  var list = document.getElementById('nList');
  var want = {};
  for (var wi = 0; wi < all.length; wi++) want[all[wi].n.id] = true;
  for (var ci = list.children.length - 1; ci >= 0; ci--) {
    var kid = list.children[ci];
    if (!want[kid.getAttribute('data-id')]) kid.remove();
  }
  document.getElementById('nEmpty').style.display = all.length ? 'none' : 'block';
  for (var fi = 0; fi < all.length; fi++) forkNode(all[fi].sid, all[fi].n);
}
function forkNode(sid, n) {
  var d = lastData;
  var list = document.getElementById('nList');
  var q = list.querySelector('.q[data-id="' + n.id + '"]');
  var src = n.source;
  if (!q) {
    q = document.createElement('div');
    q.className = 'q';
    q.setAttribute('data-id', n.id);
    q.innerHTML = '<div class="who"></div><div class="txt"></div><div class="opts"></div><div class="adv"></div>' +
      '<div class="ans"><input placeholder="type your decision..."><button class="send">send</button>' +
      '<button class="advice">Advice me!</button><button class="dismiss">dismiss</button></div>';
    var inp0 = q.querySelector('input');
    inp0.addEventListener('input', function(){ drafts[n.id] = inp0.value; });
    inp0.addEventListener('keydown', function(e){ if (e.key === 'Enter') q.querySelector('.send').click(); });
    q.addEventListener('click', function(e){
      var t = e.target;
      if (!t.classList) return;
      var inp = q.querySelector('input');
      if (t.classList.contains('send')) sendAns(q, src, n.id);
      else if (t.classList.contains('advice')) askAdvice(n.id, q);
      else if (t.classList.contains('dismiss')) ackEv(n.id, q);
      else if (t.classList.contains('use')) useAdvice(n.id, q);
      else if (t.parentNode && t.parentNode.classList.contains('opts')) {
        inp.value = t.textContent; drafts[n.id] = inp.value; inp.focus();
      }
    });
    if (drafts[n.id]) inp0.value = drafts[n.id];
    list.appendChild(q);
  }
  var inp = q.querySelector('input');
  var who = (d.labels[sid] || sid.slice(0, 10)) + ' · ' + n.tsAgo + 's ago · event #' + n.id;
  setText(q.querySelector('.who'), who);
  setText(q.querySelector('.txt'), n.note || '(no note)');
  var optEl = q.querySelector('.opts');
  var osig = JSON.stringify(n.options || []);
  if (optEl.getAttribute('data-sig') !== osig) {
    optEl.setAttribute('data-sig', osig);
    optEl.innerHTML = '';
    var opts = n.options || [];
    for (var oi = 0; oi < opts.length; oi++) {
      var b = document.createElement('button');
      b.textContent = opts[oi];
      optEl.appendChild(b);
    }
  }
  var adv = q.querySelector('.adv');
  if (advising[n.id]) {
    if (adv.getAttribute('data-sig') !== 'busy') {
      adv.setAttribute('data-sig', 'busy');
      adv.style.display = 'block';
      adv.style.borderColor = '';
      adv.innerHTML = '<span class="r">advising... </span><span class="t"></span> (llm analyzing the fork)';
    }
    setText(adv.querySelector('.t'), Math.max(0, Math.round((Date.now() - advising[n.id]) / 1000)) + 's');
  } else if (n.adviceError) {
    var esig = 'err:' + n.adviceError;
    if (adv.getAttribute('data-sig') !== esig) {
      adv.setAttribute('data-sig', esig);
      adv.style.display = 'block';
      adv.style.borderColor = '#af2f12';
      adv.innerHTML = '<span class="risk">advise failed: ' + esc(n.adviceError) + '</span>';
    }
  } else if (n.advice) {
    var asig = 'adv:' + JSON.stringify(n.advice);
    if (adv.getAttribute('data-sig') !== asig) {
      adv.setAttribute('data-sig', asig);
      adv.style.display = 'block';
      adv.style.borderColor = '';
      adv.innerHTML = '<span class="mdl">' + esc(n.advice.model) + '</span><span class="r">ADVICE:</span> ' + esc(n.advice.rec) +
        (n.advice.rationale ? '<div class="why">' + esc(n.advice.rationale) + '</div>' : '') +
        (n.advice.risk ? '<div class="risk">risk: ' + esc(n.advice.risk) + '</div>' : '') +
        ' <button class="use">use this</button>';
    }
  } else if (adv.getAttribute('data-sig') !== null) {
    adv.setAttribute('data-sig', '');
    adv.style.display = 'none';
    adv.style.borderColor = '';
    adv.innerHTML = '';
  }
  q.querySelector('.advice').disabled = !!advising[n.id];
  q.querySelector('.send').disabled = !!answering[n.id];
}
function setText(el, v){ if (el.textContent !== v) el.textContent = v; }
function sendAns(q, src, id) {
  if (answering[id]) return; // in flight — never resubmit
  var inp = q.querySelector('input');
  var btn = q.querySelector('.send');
  var note = (inp.value || '').trim();
  if (!note) { inp.placeholder = 'type an answer first'; return; }
  answering[id] = true;
  btn.disabled = true;
  fetch('/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: src, note: note, forEvent: id }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      delete answering[id];
      if (d.ok) {
        inp.value = '';
        delete drafts[id];
        btn.textContent = 'sent';
      } else {
        btn.disabled = false;
        btn.title = d.output || d.error || '';
        inp.placeholder = String(d.output || d.error || 'failed').slice(0, 60);
      }
      setTimeout(tick, 300);
    })
    .catch(function(){ delete answering[id]; btn.disabled = false; });
}
function askAdvice(id, q) {
  if (advising[id]) return;
  advising[id] = Date.now();
  q.querySelector('.advice').disabled = true;
  renderForks(); // spinner + timer immediately, not on the next poll
  fetch('/api/advise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) { delete advising[id]; renderForks(); alert(d.error || 'advise failed to start'); }
      // ok: the flag stays until the advice.<id> (or .error) fact lands via poll
    })
    .catch(function(){ delete advising[id]; renderForks(); });
}
function useAdvice(id, q) {
  var inp = q.querySelector('input');
  var d = lastData; if (!inp || !d) return;
  var all = forkList(d);
  for (var i = 0; i < all.length; i++)
    if (all[i].n.id === id && all[i].n.advice) { inp.value = all[i].n.advice.rec; drafts[id] = inp.value; inp.focus(); return; }
}
function ackEv(id, q) {
  fetch('/api/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.ok && q) q.style.opacity = '.35';
      setTimeout(tick, 300);
    });
}
// --- decision panel: one open/close path (buttons; Enter/Space native) ---
var panel = document.getElementById('needsPanel');
function openNeeds(filter){
  document.getElementById('nCtx').style.display = 'none';
  needFilter = filter || null;
  panel.style.display = 'block';
  if (lastData) renderForks();
}
function closeNeeds(){ panel.style.display = 'none'; }
document.getElementById('needsn').addEventListener('click', function(){
  panel.style.display === 'block' ? closeNeeds() : openNeeds(null);
});
document.getElementById('nClose').addEventListener('click', closeNeeds);
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeNeeds(); });
function findItem(d, id){
  var cols = ['todo','gated','inflight','done','other'];
  for (var p = 0; p < d.projects.length; p++)
    for (var ci = 0; ci < cols.length; ci++)
      for (var i = 0; i < (d.projects[p][cols[ci]] || []).length; i++)
        if (d.projects[p][cols[ci]][i].id === id) return d.projects[p][cols[ci]][i];
  return null;
}
// blocked/gated item opened from the board: anchor to its fork when one
// exists (scope or note mentions the item id), otherwise show its blockers
function openItem(id){
  var d = lastData; if (!d) return;
  needFilter = null;
  var it = findItem(d, id);
  var ctx = '';
  var fork = null;
  var fks = d.needs || {};
  for (var s in fks)
    for (var i = 0; i < fks[s].length; i++) {
      var n = fks[s][i];
      if (n.scope === id || (n.note && n.note.indexOf(id) >= 0)) { fork = n; break; }
    }
  if (it) {
    if (fork) ctx = 'fork #' + fork.id + ' for ' + id;
    else if (it.deps && it.deps.length) ctx = id + ' blocked by ' + it.deps.join(', ');
    else ctx = id + ' is ' + String(it.state || '').toLowerCase();
  }
  var ctxEl = document.getElementById('nCtx');
  ctxEl.textContent = ctx;
  ctxEl.style.display = ctx ? 'block' : 'none';
  panel.style.display = 'block';
  renderForks();
  if (fork) setTimeout(function(){
    var q = document.querySelector('#nList .q[data-id="' + fork.id + '"]');
    if (q) { q.scrollIntoView({ block: 'center' }); q.classList.add('flash'); }
  }, 0);
}
function openDispatch(el){
  var v = el.getAttribute('data-open').split(':');
  if (v[0] === 'need') openNeeds(v[1]);
  else openItem(v[1]);
}
var boardEl = document.getElementById('board');
boardEl.addEventListener('click', function(e){
  var el = e.target.closest && e.target.closest('[data-open]');
  if (el) openDispatch(el);
});
boardEl.addEventListener('keydown', function(e){
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var el = e.target.closest && e.target.closest('[data-open]');
  if (el) { e.preventDefault(); openDispatch(el); }
});
function tick() {
  fetch('/api/data?session=' + encodeURIComponent(sel.value)).then(function(r){return r.json();}).then(render).catch(function(){});
}
setInterval(tick, 1000);
sel.addEventListener('change', tick);
tick();
if (new URLSearchParams(location.search).get('open') === 'forks') openNeeds(null);
</script></body></html>`);