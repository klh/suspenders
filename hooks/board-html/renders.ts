// hooks/board-html/renders.ts — conn/fleet/llm/claims/done/events renders (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const RENDERS = String.raw`// --- 1: overall status + connection health (live / stale / error) ---
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
// W105 model badge: which model runs the lane + local/remote marker
function lanesBadge(s){
  if (!s.model) return '';
  return ' · <span class="lmodel' + (s.locality === 'local' ? ' loc' : '') + '">' + esc(String(s.model)) + (s.locality ? ' (' + esc(String(s.locality)) + ')' : '') + '</span>';
}
function chipHtml(s, zombies, needs){
  var z = zombieFor(s.sid, zombies);
  var flagged = !!(needs && needs[s.sid] && needs[s.sid].length);
  var bits = '<b>' + esc(s.label) + '</b> · <span class="st">' + esc(stateLabel(s.state, flagged)) + '</span> · heartbeat ' + ago(s.hbAgo);
  if (s.progressAgo != null) bits += ' · progress ' + ago(s.progressAgo);
  if (s.project) bits += ' · <span class="mono">' + esc(s.project) + lanesBadge(s) + '</span>';
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
// --- W28 LLM telemetry (Governor tab): per-model token sums vs budgets + routing log ---
function renderLlm(d){
  var el = byId('llmview');
  if (!d.llm) { el.innerHTML = '<div class="dim">no llm telemetry in payload (older board build)</div>'; return; }
  var h = '';
  var u = d.llm.usage || [];
  if (!u.length) h += '<div class="dim">no llm.call events today — advise round-trips will appear here</div>';
  for (var i = 0; i < u.length; i++) {
    var m = u[i];
    var pct = m.budget ? Math.min(100, Math.round(m.tokens / m.budget * 100)) : null;
    h += '<div class="llmrow"><b>' + esc(m.model) + '</b> · ' + m.tokens + ' tok · ' + m.calls + ' call' + (m.calls === 1 ? '' : 's') + (m.budget ? ' · budget ' + m.budget + ' <span class="dim">(' + pct + '%)</span><div style="height:4px;background:var(--ink-faint,#888);border-radius:2px;margin-top:2px"><div style="height:4px;width:' + pct + '%;background:var(--accent,#2c7);border-radius:2px"></div></div>' : ' · <span class="dim">no llm.budget.' + esc(m.model) + ' fact set</span>') + '</div>';
  }
  var calls = d.llm.calls || [];
  if (calls.length) {
    h += '<div class="dim" style="margin-top:8px">recent calls:</div>';
    for (var j = 0; j < calls.length; j++) {
      var c = calls[j];
      h += '<div class="mono">' + esc(String(c.model)) + ' · ' + (c.error ? '<span style="color:var(--bad,#c33)">ERR ' + esc(String(c.error)) + '</span>' : c.tt + ' tok · ' + c.ms + 'ms') + ' · ' + new Date(c.ts).toLocaleTimeString() + '</div>';
    }
  }
  el.innerHTML = h;
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
`;
