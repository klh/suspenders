// hooks/board-html/core.ts — hash filter, esc/sig helpers, polling loop (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const CORE = String.raw`// --- #filter=<text> deep-link (statusline worker indicators link here) ---
var hashFilter = ''; // raw needle from the hash; '' = no filtering
function hashNeedle(){
  var m = (location.hash || '').match(/^#filter=([^&]*)/);
  if (!m || !m[1]) return '';
  try { return decodeURIComponent(m[1]); } catch (e2) { return m[1]; }
}
function hashMatch(parts){
  if (!hashFilter) return true;
  var f = hashFilter.toLowerCase();
  for (var i = 0; i < parts.length; i++) {
    if (String(parts[i] == null ? '' : parts[i]).toLowerCase().indexOf(f) >= 0) return true;
  }
  return false;
}
function applyHashFilter(){
  hashFilter = hashNeedle();
  var bar = byId('hashChipBar');
  if (bar) sigSet(bar, hashFilter, hashFilter ? '<span class="chip">filtered by <b>' + esc(hashFilter) + '</b> · <button type="button" class="hfclear">clear</button></span>' : '');
  renderTasks();
  renderKanban();
  renderDecisions();
}
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
// board write auth (W188): the token rides Authorization (localStorage) or
// the board_token cookie; a 401 prompts once, stores, retries once
function authHdr(){
  var t = null;
  try { t = localStorage.getItem('boardToken'); } catch (e0) {}
  return t ? { 'authorization': 'Bearer ' + t } : {};
}
function authFix(j, r, redo){
  if (!r || r.status !== 401 || j.authTried) return Promise.resolve(j);
  var t = prompt('Board writes are token-gated — paste SUSPENDERS_BOARD_TOKEN:');
  if (!t) { j.error = 'board token required'; return Promise.resolve(j); }
  j.authTried = true;
  return fetch('/console/token', { method: 'POST', headers: { 'authorization': 'Bearer ' + t } })
    .then(function(r2){
      if (!r2.ok) { j.error = 'board token rejected'; return j; }
      try { localStorage.setItem('boardToken', t); } catch (e1) {}
      return redo ? redo() : j;
    });
}
function postJSON(url, body, tmo, authRedo){
  return fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, authHdr()), body: JSON.stringify(body), signal: AbortSignal.timeout(tmo || 8000) })
    .then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        j = j || {};
        if (!r.ok && !j.error && !j.output) j.error = 'HTTP ' + r.status;
        if (r.status === 401) return authFix(j, r, function(){ return postJSON(url, body, tmo, true); });
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
function tick(){ pollData(); pollDec(); pollActiveTab(); if (task.id) { pollTask(false); pollTail(); } }
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
`;
