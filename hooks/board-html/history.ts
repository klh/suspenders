// hooks/board-html/history.ts — decision history (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const HISTORY = String.raw`// --- 3: decision history (collapsed under OPEN, /api/decisions&history=1) ---
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
`;
