// hooks/board-html/activity.ts — activity feed (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const ACTIVITY = String.raw`// --- 5: activity feed (Activity tab, /api/activity, newest first) ---
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
`;
