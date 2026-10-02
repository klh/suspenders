// hooks/board-html/orch.ts — orchestrate box (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const ORCH = String.raw`// --- W57 orchestrate box: LLM proposes a plan + parallel children from a
// goal; the human registers it as a plan-gated work split (POST
// /api/orchestrate → /api/orchestrate/register). Target = the global project
// filter; the proposal is read-only until registered.
var orch = { busy: false, regBusy: false, err: null, prop: null, model: '', ms: 0, proj: '' };
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
  postJSON('/api/orchestrate', { project: proj, goal: goal }, 130000)
    .then(function(j){
      if (j.ok) {
        orch.prop = j.proposal; orch.model = j.model || ''; orch.ms = j.ms || 0; orch.proj = proj;
      } else {
        orch.err = String(j.error || 'orchestrate failed');
      }
      orch.busy = false;
      renderOrch();
    })
    .catch(function(e){ orch.busy = false; orch.err = String((e && e.message) || e); renderOrch(); });
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
  if (inp) inp.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); doOrchestrate(); } });
  var go = byId('orchGo');
  if (go) go.addEventListener('click', doOrchestrate);
  document.addEventListener('click', function(e){
    var t = e.target.closest && e.target.closest('#orchReg');
    if (t) { orchReg(); return; }
    var d = e.target.closest && e.target.closest('#orchDisc');
    if (d) orchDisc();
  });
})();

`;
