// hooks/board-html/orch.ts — orchestrate box (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const ORCH = String.raw`// --- W57 orchestrate box: LLM proposes a plan + parallel children from a
// goal; the human registers it as a plan-gated work split (POST
// /api/orchestrate → /api/orchestrate/register). Target = the global project
// filter; the proposal is read-only until registered.
var orch = { busy: false, regBusy: false, err: null, prop: null, model: '', ms: 0, proj: '' };
// W163 composer suggest: draft -> brief-shaped prompt via /api/suggest
var sugg = { busy: false };
function orchProject(){
  var v = sel.value;
  return v && v !== 'all' ? v : null;
}
function renderOrch(){
  var errEl = byId('orchErr');
  if (orch.err) errBanner(errEl, orch.err, function(){ orch.err = null; renderOrch(); });
  else clearErr(errEl);
  var go = byId('orchGo');
  if (go) { go.disabled = orch.busy; setText(go, orch.busy ? 'proposing…' : 'orchestrate'); }
  var sb = byId('orchSuggest');
  if (sb) { sb.disabled = sugg.busy; setText(sb, sugg.busy ? 'suggesting…' : 'suggest'); }
  var out = byId('orchOut');
  if (!out) return;
  if (!orch.prop) { sigSet(out, 'idle', ''); return; }
  var h = '<div class="orchplan">';
  h += '<div class="orchtitle">' + esc(orch.prop.title) + '</div>';
  h += '<div class="orchmeta dim">proposed by ' + esc(orch.model || 'llm') + ' in ' + (orch.ms/1000).toFixed(1) + 's · ' + esc(projShort(orch.proj)) + '</div>';
  for (var i = 0; i < orch.prop.children.length; i++) {
    var c = orch.prop.children[i];
    h += '<div class="orchkid"><span class="orchkidn">' + (i+1) + '.</span> ' + esc(c.title) +
      (c.brief ? '<div class="orchbrief dim">' + esc(c.brief) + '</div>' : '') + '</div>';
  }
  h += '<div class="orchactions">' +
    '<button type="button" class="kstart" id="orchReg">register plan split</button> ' +
    '<button type="button" class="orchdisc" id="orchDisc">discard</button></div></div>';
  sigSet(out, JSON.stringify(orch.prop) + orch.busy + orch.regBusy, h);
}
function doOrchestrate(){
  if (orch.busy || orch.regBusy) return;
  var proj = orchProject();
  if (!proj) { orch.err = 'pick a project in the header filter first'; orch.prop = null; renderOrch(); return; }
  var goal = (byId('orchGoal').value || '').trim();
  if (!goal) { orch.err = 'type a goal first'; renderOrch(); return; }
  orch.busy = true; orch.err = null; renderOrch();
  fetch('/api/orchestrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: proj, goal: goal }), signal: AbortSignal.timeout(130000) })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      j = j || {};
      if (j.ok) {
        orch.prop = j.proposal; orch.model = j.model || ''; orch.ms = j.ms || 0; orch.proj = proj;
      } else {
        orch.err = String(j.error || 'orchestrate failed (HTTP ' + r.status + ')');
      }
      renderOrch();
    })
    .catch(function(e){ orch.busy = false; orch.err = String((e && e.message) || e); renderOrch(); });
}
function orchExpanded(){ var i = byId('orchGoal'); return !!i && i.rows > 1; }
// W163: click expands the goal input to 4 rows + reveals the suggest button;
// blur collapses again when the draft is empty (and no suggest in flight)
function orchExpand(on){
  var i = byId('orchGoal'); if (!i || orchExpanded() === on) return;
  i.rows = on ? 4 : 1;
  var sb = byId('orchSuggest'); if (sb) sb.hidden = !on;
  var box = byId('orch'); if (box) box.classList.toggle('expanded', on);
}
function doSuggest(){
  if (sugg.busy || orch.busy) return;
  var proj = orchProject();
  if (!proj) { orch.err = 'pick a project in the header filter first'; orch.prop = null; renderOrch(); return; }
  var draft = (byId('orchGoal').value || '').trim();
  if (draft.length < 8) { orch.err = 'draft too short — type a few words, then suggest'; renderOrch(); return; }
  sugg.busy = true; orch.err = null; renderOrch();
  fetch('/api/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: proj, draft: draft }), signal: AbortSignal.timeout(95000) })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      j = j || {}; sugg.busy = false;
      if (j.ok) {
        byId('orchGoal').value = j.prompt;
        if (j.cached) toast('suggest: cached');
      } else {
        orch.err = String(j.error || 'suggest failed (HTTP ' + r.status + ')');
      }
      renderOrch();
    })
    .catch(function(e){ sugg.busy = false; orch.err = String((e && e.message) || e); renderOrch(); });
}
function orchReg(){
  if (!orch.prop || orch.busy || orch.regBusy) return;
  orch.regBusy = true;
  postJSON('/api/orchestrate/register', { project: orch.proj, title: orch.prop.title, children: orch.prop.children.map(function(c){ return { title: c.title }; }) }).then(function(j){
    orch.regBusy = false;
    if (j && j.ok) {
      toast('registered ' + j.plan + ' → ' + (j.children || []).length + ' children');
      orch.prop = null; byId('orchGoal').value = '';
      pollTasks();
    } else {
      orch.err = String((j && j.error) || 'register failed');
    }
    renderOrch();
  });
}
function orchDisc(){ if (orch.busy || orch.regBusy) return; orch.prop = null; renderOrch(); }
(function(){
  var inp = byId('orchGoal');
  if (inp) {
    inp.addEventListener('focus', function(){ orchExpand(true); });
    inp.addEventListener('blur', function(){
      setTimeout(function(){
        if (!(byId('orchGoal').value || '').trim() && !sugg.busy) orchExpand(false);
      }, 120);
    });
    // collapsed Enter = orchestrate (the old single-line habit); expanded,
    // Enter inserts a newline and Cmd/Ctrl+Enter orchestrates
    inp.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); doOrchestrate(); return; }
      if (!orchExpanded()) { e.preventDefault(); doOrchestrate(); }
    });
  }
  var go = byId('orchGo');
  if (go) go.addEventListener('click', doOrchestrate);
  var sb = byId('orchSuggest');
  if (sb) sb.addEventListener('click', doSuggest);
  document.addEventListener('click', function(e){
    var t = e.target.closest && e.target.closest('#orchReg');
    if (t) { orchReg(); return; }
    var d = e.target.closest && e.target.closest('#orchDisc');
    if (d) orchDisc();
  });
})();

`;
