// hooks/board-html/tabs.ts — tab shell + wiring (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const TABS = String.raw`// --- 7: tab shell (location.hash driven, deep-linkable, back/forward) ---
function pollActiveTab(){
  if (curTab === 'tasks' || curTab === 'lanes') pollTasks();
  else if (curTab === 'activity') pollAct();
  else if (curTab === 'decisions') pollHist(); // no-op while history is collapsed
  // governor rides /api/data; setup fetches on activation
}
function renderTab(){
  if (curTab === 'decisions') renderHist();
  else if (curTab === 'tasks') renderTasks();
  else if (curTab === 'lanes') renderKanban();
  else if (curTab === 'activity') renderAct();
  else if (curTab === 'governor') { if (lastData) { renderFleet(); renderClaims(lastData); renderDone(lastData); renderEvents(lastData); renderLlm(lastData); } }  else if (curTab === 'setup') renderSetup();
}
var nav = document.querySelector('nav.tabs');
function setTab(id, fromHash){
  if (!TABS[id]) id = 'decisions';
  curTab = id;
  var bs = nav.querySelectorAll('button[data-tab]');
  for (var i = 0; i < bs.length; i++) {
    if (bs[i].getAttribute('data-tab') === id) bs[i].setAttribute('aria-current', 'true');
    else bs[i].removeAttribute('aria-current');
  }
  for (var name in TABS) byId('tab-' + name).hidden = name !== id;
  if (!fromHash && location.hash !== '#' + id) location.hash = id;
  pollActiveTab();
  renderTab();
}
// --- wiring ---
nav.addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('button[data-tab]');
  if (b) setTab(b.getAttribute('data-tab'));
});
window.addEventListener('hashchange', function(){
  var h = (location.hash || '').replace(/^#/, '');
  if (TABS[h]) setTab(h, true);
  applyHashFilter(); // #filter= deep-link; any other hash (incl. plain tabs) clears it
  applyHashTask();
});
// #task=<id>[&proj=<p>] deep-link — open the task drawer straight from a URL
// (lane reports, notifications, terminal links all land here)
function applyHashTask(){
  var m = (location.hash || '').match(/^#task=([^&]+)(?:&proj=([^&]*))?/);
  if (m && openTask) openTask(decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : null, null);
}
byId('hashChipBar').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.hfclear');
  if (!b) return;
  history.replaceState(null, '', location.pathname + location.search); // empty hash = no filtering
  applyHashFilter();
});
byId('tasksTbl').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('[data-task]');
  if (b) openTask(b.getAttribute('data-task'), b.getAttribute('data-proj'), b);
});
byId('kanban').addEventListener('click', function(e){
  var s = e.target.closest && e.target.closest('[data-start]');
  if (s) {
    var card = s.closest('.kcard');
    var selEl = card ? card.querySelector('.kexecsel') : null;
    startItem(s.getAttribute('data-start'), s.getAttribute('data-startproj'), s, selEl ? selEl.value : 'claude');
    return;
  }
  // executor pick — selecting a lane is not a card open (the click would
  // otherwise fall through to .kcard and pop the task drawer mid-pick)
  if (e.target.classList && e.target.classList.contains('kexecsel')) return;
  var b = e.target.closest && e.target.closest('[data-task]');
  if (b) { openTask(b.getAttribute('data-task'), b.getAttribute('data-proj'), b); return; }
  var c = e.target.closest && e.target.closest('.kcard');
  if (c) openTask(c.getAttribute('data-kid'), c.getAttribute('data-kproj'), c);
});
byId('kanban').addEventListener('change', function(e){
  var s = e.target.classList && e.target.classList.contains('kexecsel') ? e.target : null;
  if (!s) return;
  var card = s.closest('.kcard');
  if (card) execPick[(card.getAttribute('data-kproj') || '') + '\u0000' + (card.getAttribute('data-kid') || '')] = s.value;
});
var theadEl = document.querySelector('#tasksTbl thead');
if (theadEl) theadEl.addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('.thsort') : null;
  if (!b) return;
  var th = b.closest('th');
  var k = th ? th.getAttribute('data-k') : null;
  if (!k) return;
  if (taskSort.key === k) taskSort.dir = -taskSort.dir;
  else { taskSort.key = k; taskSort.dir = 1; }
  saveTaskView(); paintSort(); renderTasks();
});
var ownSel = byId('taskOwner');
if (ownSel) ownSel.addEventListener('change', function(e){
  taskOwner = e.target.value || 'all';
  saveTaskView(); renderTasks();
});
var projSel = byId('taskProj');
if (projSel) projSel.addEventListener('change', function(e){
  taskProj = e.target.value || 'all';
  saveTaskView(); renderTasks();
});
var doneCb = byId('taskDone');
if (doneCb) doneCb.addEventListener('change', function(e){
  try { localStorage.setItem('taskShowDone', e.target.checked ? '1' : '0'); } catch(err) {}
  renderTasks();
});
paintSort();
byId('drawerClose').addEventListener('click', closeTask);
var diffEl = byId('taskDiff');
diffEl.addEventListener('click', function(e){
  var sh = e.target.closest && e.target.closest('.diffbtn.ship');
  if (sh) { shipItem(); return; }
  var b = e.target.closest && e.target.closest('.diffbtn');
  if (b) { toggleDiff(); return; }
  var n = e.target.closest && e.target.closest('.dlnum[data-file]');
  if (n) { pickDiffLine(n.getAttribute('data-file'), n.getAttribute('data-line')); return; }
  var s = e.target.closest && e.target.closest('.diffsend');
  if (s) sendDiffNote();
});
diffEl.addEventListener('input', function(e){
  if (e.target.classList && e.target.classList.contains('diffnote')) diffView.draft = e.target.value;
});
diffEl.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('diffnote')) { e.preventDefault(); sendDiffNote(); }
});
var tailEl = byId('taskTail');
tailEl.addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.tailbtn');
  if (b) { toggleTail(); return; }
  var s = e.target.closest && e.target.closest('.lanesend');
  if (s) sendLaneMsg();
});
tailEl.addEventListener('input', function(e){
  if (e.target.classList && e.target.classList.contains('lanemsg')) tailView.draft = e.target.value;
});
tailEl.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('lanemsg')) { e.preventDefault(); sendLaneMsg(); }
});
byId('setupBody').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.copyfix');
  if (!b) return;
  var fix = b.getAttribute('data-fix') || '';
  navigator.clipboard.writeText(fix).then(function(){ toast('copied to clipboard'); }, function(){ toast('copy failed — select the command text'); });
});
byId('decToggle').addEventListener('click', function(){ setCollapsed(!decCollapsed); });
byId('needsn').addEventListener('click', function(){
  setTab('decisions');
  if (decCollapsed) setCollapsed(false);
  byId('decisions').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
byId('histHead').addEventListener('click', function(){
  histOpen = !histOpen;
  byId('histHead').setAttribute('aria-expanded', histOpen ? 'true' : 'false');
  setText(byId('histCaret'), histOpen ? '-' : '+');
  byId('histBody').style.display = histOpen ? 'block' : 'none';
  if (histOpen) pollHist();
  renderHist();
});
byId('fleetHead').addEventListener('click', function(){
  var b = byId('fleetBody');
  var open = b.style.display !== 'none';
  b.style.display = open ? 'none' : 'block';
  setText(byId('fleetCaret'), open ? '+' : '-');
  byId('fleetHead').setAttribute('aria-expanded', open ? 'false' : 'true');
});
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  if (task.id) { closeTask(); return; } // drawer first, then the section
  setCollapsed(true); // collapses the section, not the decisions
});
sel.addEventListener('change', function(){
  projBaseline = true; // fresh scope — re-baseline toasts
  tick();
});
`;
