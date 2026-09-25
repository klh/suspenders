const unesc = (s) => s.split("\\u2014").join(String.fromCharCode(0x2014));
// fleet-board-html.ts — the fleet board page, split from the server so the
// HTML payload stays reviewable. Pure string; served by fleet-board.ts.
export const HTML = unesc(String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>FLEET BOARD</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background:#141413; color:#e8e6e1; font:13px/1.4 ui-monospace,Menlo,monospace; margin:0; padding:16px 20px 20px; }
header { display:flex; align-items:baseline; gap:16px; margin-bottom:12px; }
header .mark { font-size:13px; font-weight:600; letter-spacing:.08em; }
header .right { margin-left:auto; display:flex; align-items:center; gap:12px; }
#stamp { font-size:11px; color:#8a8781; font-variant-numeric:tabular-nums; }
#blockedn { color:#af2f12; font-size:11px; font-variant-numeric:tabular-nums; }
#needsn { color:#af2f12; font-size:11px; font-weight:600; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
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
#needsPanel h2 span { cursor:pointer; color:#8a781; }
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
#needsPanel .dismiss { color:#8a8781; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
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
    <span id="needsn"></span>
    <select id="sess"><option value="">— all —</option></select>
  </div>
</header>
<div id="lanes"></div>
<div id="wrap">
  <div id="board"></div>
  <div id="rail">
    <div class="feed"><h2>Claims</h2><div id="claims"></div></div>
    <div class="feed"><h2>Event stream</h2><div class="filters" id="filters"></div><div id="events"></div></div>
  </div>
</div>
<div id="needsPanel"><h2>DECISION FORKS <span id="nClose">&times; close</span></h2><div id="nList"></div></div>
<script>
var sel = document.getElementById('sess');
var sessLoaded = false;
var prev = {};
var lastData = null;
var evFilter = 'all';
var advising = {};
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
  return '<div class="' + cls + '"' + (needsIt ? ' onclick="openNeeds(\'' + w.owner + '\')"' : '') + '><span class="id">' + esc(w.id) + '</span>' + pill(w.state) + '<div class="t">' + esc(w.title).slice(0,90) + '</div><div class="m">' + m + '</div></div>';
}
function zombieFor(sid, zombies){
  for (var z = 0; z < zombies.length; z++) if (zombies[z].label.indexOf(sid.slice(0,10)) === 0) return true;
  return false;
}
function chipHtml(s, zombies){
  var z = zombieFor(s.sid, zombies);
  return '<span class="chip' + (z?' zombie':'') + '" title="' + esc(s.sid) + '"><b>' + esc(s.label) + '</b> · <span class="st">' + esc(s.state.toLowerCase()) + '</span> · hb ' + s.hbAgo + 's</span>';
}
function render(d) {
  lastData = d;
  if (!sessLoaded) {
    for (var i = 0; i < d.sessions.length; i++) {
      var s = d.sessions[i];
      var o = document.createElement('option');
      var flagged = d.needs && d.needs[s.sid] && d.needs[s.sid].length;
      o.value = s.sid; o.textContent = s.label + ' · ' + s.role + ' · ' + s.state + (flagged ? '  ⚑ NEEDS ANSWER' : '');
      sel.appendChild(o);
    }
    sessLoaded = true;
  }
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
  var cols = [['01 / TODO','todo'],['02 / IN-FLIGHT','inflight'],['03 / DONE','done']];
  var html = '';
  var blocked = 0;
  for (var c = 0; c < cols.length; c++) {
    html += '<div class="col"><h2>' + cols[c][0] + '</h2>';
    for (var p = 0; p < proj.length; p++) {
      var list = proj[p][cols[c][1]].concat(cols[c][1] === 'todo' ? proj[p].gated : []);
      blocked += proj[p].gated.length;
      if (proj.length > 1) html += '<div class="pname">' + esc(proj[p].name) + ' <span class="pct">— ' + proj[p].doneN + '/' + proj[p].total + ' (' + proj[p].pct + '%)</span></div>';
      else if (c === 0) document.title = proj[p].name.toUpperCase() + ' · FLEET BOARD';
      for (var k = 0; k < list.length; k++) html += card(list[k], focus, d.labels, d.needs || {});
    }
    html += '</div>';
  }
  document.getElementById('board').innerHTML = html;
  document.getElementById('stamp').textContent = 'updated ' + Math.max(0, Math.round((Date.now() - d.ts)/1000)) + 's ago';
  document.getElementById('blockedn').textContent = blocked ? blocked + ' blocked' : '';
  var nN = 0; for (var s2 in (d.needs||{})) nN += d.needs[s2].length;
  var nn = document.getElementById('needsn');
  nn.textContent = nN ? nN + ' forks need you' : '';
  nn.onclick = function(){ openNeeds(null); };
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
function renderForks() {
  var d = lastData; if (!d) return;
  var needs = d.needs || {};
  var rows = '';
  for (var s in needs) {
    for (var i = 0; i < needs[s].length; i++) {
      var n = needs[s][i];
      rows += '<div class="q"><div class="who">' + esc(d.labels[s] || s.slice(0,10)) + ' · ' + n.tsAgo + 's ago · event #' + n.id + ' · <span class="dismiss" onclick="ackEv(' + n.id + ', this)">dismiss</span></div><div class="txt">' + esc(n.note || '(no note)') + '</div>';
      if (n.options && n.options.length) {
        rows += '<div class="opts">';
        for (var oi = 0; oi < n.options.length; oi++) rows += '<button onclick="pickOpt(this, ' + n.id + ')">' + esc(n.options[oi]) + '</button>';
        rows += '</div>';
      }
      if (advising[n.id]) {
        rows += '<div class="adv" style="display:block">advising… (llm analyzing the fork — this panel updates when the recommendation lands)</div>';
      } else if (n.adviceError) {
        rows += '<div class="adv" style="display:block;border-color:#af2f12"><span class="risk">advise failed: ' + esc(n.adviceError) + '</span></div>';
      } else if (n.advice) {
        rows += '<div class="adv" style="display:block"><span class="mdl">' + esc(n.advice.model) + '</span><span class="r">ADVICE:</span> ' + esc(n.advice.rec) +
          (n.advice.rationale ? '<div class="why">' + esc(n.advice.rationale) + '</div>' : '') +
          (n.advice.risk ? '<div class="risk">risk: ' + esc(n.advice.risk) + '</div>' : '') +
          ' <button class="use" onclick="useAdvice(' + n.id + ')">use this</button></div>';
      }
      rows += '<div class="ans"><input placeholder="type your decision…" data-to="' + esc(n.source) + '" id="fin-' + n.id + '"><button onclick="sendAns(this, \'' + esc(n.source) + '\', ' + n.id + ')">send</button><button class="advice" onclick="askAdvice(' + n.id + ', this)">Advice me!</button></div></div>';
    }
  }
  document.getElementById('nList').innerHTML = rows || '<div class="q"><div class="txt">nothing waiting — lanes are autonomous</div></div>';
}
function pickOpt(btn, id) {
  var inp = document.getElementById('fin-' + id);
  if (inp) { inp.value = btn.textContent; inp.focus(); }
}
function useAdvice(id) {
  var inp = document.getElementById('fin-' + id);
  var d = lastData; if (!inp || !d) return;
  for (var s in (d.needs||{})) for (var i = 0; i < d.needs[s].length; i++)
    if (d.needs[s][i].id === id) { inp.value = d.needs[s][i].advice.rec; inp.focus(); return; }
}
function askAdvice(id, btn) {
  if (advising[id]) return;
  advising[id] = true;
  btn.disabled = true; btn.textContent = '…';
  fetch('/api/advise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.ok) { renderForks(); }
      else { advising[id] = false; btn.disabled = false; btn.textContent = 'Advice me!'; alert(d.error || 'advise failed to start'); }
    })
    .catch(function(){ advising[id] = false; btn.disabled = false; btn.textContent = 'Advice me!'; });
}
function sendAns(btn, to, forEvent) {
  var inp = btn.parentNode.querySelector('input');
  var note = inp.value.trim();
  if (!note) { inp.placeholder = 'type an answer first'; return; }
  btn.disabled = true; btn.textContent = '…';
  fetch('/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: to, note: note, forEvent: forEvent }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      btn.textContent = d.ok ? '✓ sent' : '✗ failed';
      if (d.ok) { inp.value = ''; inp.disabled = true; inp.placeholder = 'sent → ' + (d.to || to); }
      else { btn.disabled = false; btn.title = d.output || d.error || ''; inp.placeholder = (d.output || d.error || 'failed').slice(0, 60); }
      setTimeout(tick, 300);
    })
    .catch(function(){ btn.textContent = '✗ failed'; btn.disabled = false; });
}
function ackEv(id, el) {
  fetch('/api/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
    .then(function(){ if (el) { var q = el.closest('.q'); if (q) q.style.opacity = '.35'; } setTimeout(tick, 300); });
}
document.getElementById('nClose').onclick = function(){ document.getElementById('needsPanel').style.display = 'none'; };
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') document.getElementById('needsPanel').style.display = 'none'; });
function tick() {
  fetch('/api/data?session=' + encodeURIComponent(sel.value)).then(function(r){return r.json();}).then(render).catch(function(){});
}
setInterval(tick, 1000);
sel.addEventListener('change', tick);
tick();
if (new URLSearchParams(location.search).get('open') === 'forks') {
  // open immediately; the 1s render loop keeps the panel populated
  document.getElementById('needsPanel').style.display = 'block';
}
</script></body></html>`);