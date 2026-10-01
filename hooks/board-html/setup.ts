// hooks/board-html/setup.ts — setup checklist (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const SETUP = String.raw`// --- 6: setup checklist (Setup tab, /api/setup) ---
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
`;
