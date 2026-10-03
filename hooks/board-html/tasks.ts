// hooks/board-html/tasks.ts — tasks table + kanban + drawer (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
export const TASKS = String.raw`// --- 4: tasks table (Tasks tab, /api/tasks) + drawer (/api/task) ---
// view state: session filter + column sort, persisted per browser (owner
// asked: filter tasks by owning session, sortable table, fragments grouped)
var taskSort = {key: 'id', dir: 1};
var taskOwner = 'all';
var taskProj = 'all';
try {
  var savedSort = JSON.parse(localStorage.getItem('sb.taskSort') || 'null');
  if (savedSort && savedSort.key) taskSort = savedSort;
  var savedOwner = localStorage.getItem('sb.taskOwner');
  if (savedOwner) taskOwner = String(savedOwner);
  var savedProj = localStorage.getItem('sb.taskProj');
  if (savedProj) taskProj = String(savedProj);
} catch (e) {}
function saveTaskView(){
  try { localStorage.setItem('sb.taskSort', JSON.stringify(taskSort)); localStorage.setItem('sb.taskOwner', taskOwner); localStorage.setItem('sb.taskProj', taskProj); } catch (e) {}
}
function projShort(p){ return String(p || '').replace(/\/\.git$/, '').split('/').pop() || '—'; }
function ownerKey(t){ return t.owner_sid ? String(t.owner_sid) : 'unclaimed'; }
var ownerDisp = {}; // sid → display label, rebuilt per poll; shared intent labels get the sid appended
function ownerName(t){
  var s = t.owner_sid ? String(t.owner_sid) : '';
  if (s && ownerDisp[s]) return ownerDisp[s];
  return t.owner_label || (s ? s.slice(0, 10) : '') || 'unclaimed';
}
function buildOwnerDisp(ts){ // seven lanes all claiming "work-graph" must stay distinguishable
  var sidLabel = {}, byLabel = {};
  for (var i = 0; i < ts.length; i++){
    var s = ts[i].owner_sid ? String(ts[i].owner_sid) : '';
    if (!s) continue;
    var l = ts[i].owner_label || s.slice(0, 10) || 'unclaimed';
    sidLabel[s] = l;
    (byLabel[l] || (byLabel[l] = {}))[s] = 1;
  }
  ownerDisp = {};
  for (var s2 in sidLabel){
    var l2 = sidLabel[s2];
    var n = 0; for (var x in byLabel[l2]) n++;
    ownerDisp[s2] = n > 1 ? l2 + ' (' + s2.slice(0, 12) + ')' : l2;
  }
}
function taskSortVal(t, k){
  if (k === 'age') return Number(t.age_s || 0);
  if (k === 'decisions') return Number(t.open_decisions || 0);
  if (k === 'owner') return ownerName(t).toLowerCase();
  if (k === 'proj') return projShort(t.project).toLowerCase();
  var s2 = String(k === 'title' ? t.title : k === 'state' ? t.state : t.id || '');
  return s2.toLowerCase();
}
function sortTasks(arr){
  var k = taskSort.key, d = taskSort.dir;
  arr.sort(function(a, b){
    var va = taskSortVal(a, k), vb = taskSortVal(b, k);
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
  });
}
function taskGroups(ts){ // dotted fragments (W138.1) nest under their parent row
  var byIdMap = {}, roots = [], kids = {};
  for (var i = 0; i < ts.length; i++) byIdMap[String(ts[i].id)] = ts[i];
  for (var j = 0; j < ts.length; j++){
    var t = ts[j], id = String(t.id), dot = id.lastIndexOf('.');
    var pid = dot > 0 ? id.slice(0, dot) : null;
    if (pid && byIdMap[pid]) (kids[pid] || (kids[pid] = [])).push(t);
    else roots.push(t);
  }
  return {roots: roots, kids: kids};
}
function renderTaskProjOptions(ts){
  var sel = byId('taskProj');
  var seen = {}, names = [];
  for (var i = 0; i < ts.length; i++){
    var p = projShort(ts[i].project);
    if (!seen[p]) { seen[p] = 1; names.push(p); }
  }
  names.sort();
  var html = '<option value="all">all projects</option>';
  for (var j = 0; j < names.length; j++) html += '<option value="' + esc(names[j]) + '">' + esc(names[j]) + '</option>';
  if (sel.dataset.sig === html) return;
  sel.innerHTML = html;
  sel.dataset.sig = html;
  var has = false;
  for (var o = 0; o < sel.options.length; o++) if (sel.options[o].value === taskProj) has = true;
  if (!has) { taskProj = 'all'; saveTaskView(); }
  sel.value = taskProj;
}
function renderTaskOwnerOptions(ts){
  var sel = byId('taskOwner');
  var seen = {}, names = [];
  for (var i = 0; i < ts.length; i++){
    var k = ownerKey(ts[i]);
    if (!seen[k]) { seen[k] = ownerName(ts[i]); names.push([k, seen[k]]); }
  }
  names.sort(function(a, b){ return a[1].localeCompare(b[1]); });
  var html = '<option value="all">all sessions</option>';
  for (var j = 0; j < names.length; j++) html += '<option value="' + esc(names[j][0]) + '">' + esc(names[j][1]) + '</option>';
  if (sel.dataset.sig === html) return;
  sel.innerHTML = html;
  sel.dataset.sig = html;
  var has = false;
  for (var o = 0; o < sel.options.length; o++) if (sel.options[o].value === taskOwner) has = true;
  if (!has) { taskOwner = 'all'; saveTaskView(); }
  sel.value = taskOwner;
}
function paintSort(){
  var ths = document.querySelectorAll('#tasksTbl th');
  for (var i = 0; i < ths.length; i++){
    var th = ths[i], k = th.getAttribute('data-k');
    var b = th.querySelector('.thsort');
    if (!k || !b) continue;
    var active = k === taskSort.key;
    th.setAttribute('aria-sort', active ? (taskSort.dir === 1 ? 'ascending' : 'descending') : 'none');
    b.textContent = (b.getAttribute('data-label') || '') + (active ? (taskSort.dir === 1 ? ' \u25B4' : ' \u25BE') : '');
  }
}
function pollTasks(){
  if (tasksBusy || (curTab !== 'tasks' && curTab !== 'lanes')) return;
  tasksBusy = true;
  fetch('/api/tasks' + projQuery(), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.tasks)) throw new Error('bad /api/tasks payload');
      tasksData = j; tasksOkAt = Date.now(); tasksErr = null; tasksLoaded = true;
      noteProjects(j.projects);
    })
    .catch(function(e){ tasksErr = String((e && e.message) || e); })
    .finally(function(){ tasksBusy = false; renderTasks(); renderKanban(); });
}
function taskRow(t, parentId){
  var owner = ownerName(t);
  var od = t.open_decisions || 0;
  var kid = parentId ? '<span class="kidmark">↳</span>' : '';
  var ub = (t.state === 'READY' && t.unblocked_by) ? '<span class="dim" title="unblocked by ' + esc(t.unblocked_by) + ' — startable">▶ </span>' : '';
  return '<tr data-tid="' + esc(t.id) + '"><td>' + kid + ub + '<button type="button" class="tidbtn mono" data-task="' + esc(t.id) + '" data-proj="' + esc(t.project || '') + '" aria-haspopup="dialog">' + esc(t.id) + '</button></td>' +
    '<td class="mono dim">' + esc(projShort(t.project)) + '</td>' +
    '<td class="ttitle">' + esc(String(t.title || '(untitled)')).slice(0, 120) +
      (t.tail && t.tail.text ? '<div class="tail dim">' + esc(t.tail.text) + '</div>' : '') + '</td>' +
    '<td>' + taskPill(t.state) + '</td>' +
    '<td>' + esc(owner) + '</td>' +
    '<td class="num">' + agoShort(t.age_s) + '</td>' +
    '<td class="num' + (od ? ' rq' : '') + '">' + (od || '-') + '</td></tr>';
}
function renderTasks(){
  var errEl = byId('tasksErr');
  var body = byId('tasksBody');
  if (!tasksLoaded && !tasksErr) {
    clearErr(errEl);
    sigSet(body, 'loading', '<tr><td colspan="6" class="dim">loading tasks...</td></tr>');
    return;
  }
  if (tasksErr) {
    var when = tasksOkAt ? ago(Math.round((Date.now() - tasksOkAt) / 1000)) : 'never';
    errBanner(errEl, 'task list unavailable — last good ' + when, function(){ tasksErr = null; pollTasks(); });
  } else {
    clearErr(errEl);
  }
  if (!tasksData) return; // nothing good yet — keep loading/error row
  var ts = tasksData.tasks;
  buildOwnerDisp(ts);
  renderTaskProjOptions(ts);
  renderTaskOwnerOptions(ts);
  var byProj = taskProj === 'all' ? ts : ts.filter(function(t){ return projShort(t.project) === taskProj; });
  var own = taskOwner === 'all' ? byProj : byProj.filter(function(t){ return ownerKey(t) === taskOwner; });
  // #filter= deep-link narrows rows to an id/owner/session substring (case-insensitive)
  if (hashFilter) own = own.filter(function(t){ return hashMatch([t.id, ownerKey(t), ownerName(t)]); });
  // completed items are opt-in (a healthy fleet buries live work under DONE rows)
  var showDone = false;
  try { showDone = localStorage.getItem('taskShowDone') === '1'; } catch(e) {}
  var cb = byId('taskDone'); if (cb) cb.checked = showDone;
  var pool = showDone ? own : own.filter(function(t){ return t.state !== 'DONE'; });
  var g = taskGroups(pool); // fragments nest under their parent row
  sortTasks(g.roots);
  var html = '';
  for (var i = 0; i < g.roots.length; i++){
    var r = g.roots[i];
    html += taskRow(r);
    var kids = g.kids[r.id];
    if (kids) { sortTasks(kids); for (var c = 0; c < kids.length; c++) html += taskRow(kids[c], r.id); }
  }
  if (!html) html = '<tr><td colspan="7" class="dim">' + (ts.length ? '(no tasks match the filters)' : '(no tasks)') + '</td></tr>';
  var cnt = byId('taskCount');
  if (cnt) cnt.textContent = pool.length === ts.length ? pool.length + ' tasks' : pool.length + ' of ' + ts.length + ' tasks';
  sigSetKeep(body, html, html, 'data-task'); // rebuild only on real change; refocus the row button if the table swapped under it
}
// --- W65 lanes kanban: work items as cards in state columns; active cards
// carry the owner lane's live transcript tail (1s poll). A card click expands
// straight into the task drawer (diff + comments); unclaimed READY cards get
// a start button that POSTs /api/start (fleet-loop dispatch).
var KCOLS = [
  { key: 'READY', label: 'ready', states: ['READY'] },
  { key: 'ACTIVE', label: 'working', states: ['CLAIMED', 'RUNNING'] },
  { key: 'BLOCKED', label: 'blocked', states: ['BLOCKED', 'PAUSED'] },
  { key: 'FAILED', label: 'failed', states: ['FAILED'] },
  { key: 'DONE', label: 'done', states: ['DONE'], cap: 12 }
];
var starting = {}; // 'proj\u0000id' -> start POST in flight (rebuild-proof)
var execPick = {}; // 'proj\u0000id' -> chosen executor (survives card rebuilds)
var execOpts = [
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'copilot', label: 'copilot' }
];
function pollExecutors(){
  fetch('/api/executors', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.executors)) return;
      var opts = [];
      for (var i = 0; i < j.executors.length; i++) {
        var x = j.executors[i];
        if (x && x.value) opts.push({ value: String(x.value), label: String(x.label || x.value) });
      }
      if (opts.length >= 2) execOpts = opts;
      renderKanban(); // repaint cards with the live belt targets
    })
    .catch(function(){}); // dropdown falls back to claude/codex/copilot only
}
function startItem(id, proj, btn, agent){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  postJSON('/api/start', { project: proj, id: id, agent: agent || 'claude' }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('dispatching ' + id + ' on ' + (agent || 'claude') + ' — lane ' + String(j.sid || ''));
    else toast('start failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
function kanbanCard(t){
  var od = t.open_decisions || 0;
  var startable = t.state === 'READY' && !t.owner_sid;
  var html = '<div class="kcard" data-kid="' + esc(t.id) + '" data-kproj="' + esc(t.project || '') + '" title="open details">';
  html += '<div class="krow">' + taskPill(t.state) +
    '<button type="button" class="tidbtn mono" data-task="' + esc(t.id) + '" data-proj="' + esc(t.project || '') + '" aria-haspopup="dialog">' + esc(t.id) + '</button>' +
    (od ? '<span class="kdec">needs you</span>' : '') +
    '<span class="kage dim">' + agoShort(t.age_s) + '</span></div>';
  html += '<div class="ktitle">' + esc(String(t.title || '(untitled)')).slice(0, 140) + '</div>';
  html += '<div class="klane dim">lane ' + esc(t.owner_label || t.owner_sid || 'unclaimed') + (t.origin ? ' · ' + esc(String(t.origin)) : '') + '</div>';
  if (t.model) html += '<span class="kmodel' + (t.locality === 'local' ? ' loc' : '') + '" title="model running this lane">' + esc(String(t.model)) + (t.locality ? ' (' + esc(String(t.locality)) + ')' : '') + '</span>';
  if (t.tail && t.tail.text) html += '<div class="ktail">' + esc(t.tail.text) + '</div>';
  if (startable) {
    var pick = execPick[t.project + '\u0000' + t.id] || (function(){
      var prefs = (window.__execPrefs && window.__execPrefs.length) ? window.__execPrefs : ['glm-5.3-flash'];
      for (var pi = 0; pi < prefs.length; pi++) for (var di = 0; di < execOpts.length; di++)
        if (String(execOpts[di].value || '').indexOf(prefs[pi]) >= 0) return execOpts[di].value;
      return 'claude';
    })();
    var opts = '';
    for (var xi = 0; xi < execOpts.length; xi++) {
      var xo = execOpts[xi];
      opts += '<option value="' + esc(xo.value) + '"' + (xo.value === pick ? ' selected' : '') + '>' + esc(xo.label) + '</option>';
    }
    html += '<div class="kexec"><select class="kexecsel" aria-label="executor for ' + esc(t.id) + '">' + opts + '</select>' +
      '<button type="button" class="kstart" data-start="' + esc(t.id) + '" data-startproj="' + esc(t.project || '') + '" title="dispatch on the chosen executor">▶</button></div>';
  }
  return html + '</div>';
}
function renderKanban(){
  if (curTab !== 'lanes') return;
  var el = byId('kanban');
  if (!el) return;
  if (!tasksLoaded && !tasksErr) { sigSet(el, 'loading', '<div class="state dim">loading lanes...</div>'); return; }
  if (tasksErr) {
    errBanner(byId('kanbanErr'), 'lane board unavailable' + (tasksOkAt ? ' — last good ' + ago(Math.round((Date.now() - tasksOkAt) / 1000)) : ''), function(){ tasksErr = null; pollTasks(); });
    if (!tasksData) return; // nothing good yet — banner instead of stale cards
  } else {
    clearErr(byId('kanbanErr'));
  }
  if (!tasksData) return;
  var ts = tasksData.tasks;
  buildOwnerDisp(ts);
  if (hashFilter) ts = ts.filter(function(t){ return hashMatch([t.id, t.title, ownerKey(t), ownerName(t), t.project]); });
  var html = '<div class="kanban">';
  var shownAll = [];
  for (var c = 0; c < KCOLS.length; c++) {
    var col = KCOLS[c];
    var items = ts.filter(function(t){ return col.states.indexOf(t.state) >= 0; });
    items.sort(function(a, b){ return (a.age_s || 0) - (b.age_s || 0); }); // newest activity first
    var shown = col.cap ? items.slice(0, col.cap) : items;
    shownAll = shownAll.concat(shown);
    html += '<div class="kcol"><h3>' + esc(col.label) + '<span class="kcount">' + items.length + '</span></h3>';
    for (var i = 0; i < shown.length; i++) html += kanbanCard(shown[i]);
    if (!items.length) html += '<div class="kempty dim">(empty)</div>';
    else if (col.cap && items.length > col.cap) html += '<div class="kempty dim">+' + (items.length - col.cap) + ' older — the table has all</div>';
    html += '</div>';
  }
  html += '</div>';
  // W104: the card html embeds per-second data (age ticks, live tails) — a
  // full sigSet at 1Hz destroys an open executor dropdown mid-pick. Rebuild
  // only when the STRUCTURE changed; refresh ages + tails in place otherwise.
  var kstruct = html.replace(/<span class="kage dim">[^<]*<\/span>/g, '').replace(/<div class="ktail">[^<]*<\/div>/g, '');
  var prevStructural = el.getAttribute('data-ksig') || '';
  if (prevStructural === kstruct) { updateKanbanVolatile(el, shownAll); return; }
  if (el.contains(document.activeElement) && document.activeElement.classList.contains('kexecsel')) return; // picking — defer the swap, next render applies it
  el.setAttribute('data-ksig', kstruct);
  sigSet(el, kstruct, html);
  updateKanbanVolatile(el, shownAll);
}
function updateKanbanVolatile(el, shownAll){
  var cards = el.querySelectorAll('.kcard');
  for (var i = 0; i < shownAll.length && i < cards.length; i++) {
    var t = shownAll[i], c = cards[i];
    if (c.getAttribute('data-kid') !== t.id) continue;
    var ageEl = c.querySelector('.kage');
    if (ageEl) ageEl.textContent = agoShort(t.age_s);
    var tailEl = c.querySelector('.ktail');
    if (tailEl) tailEl.textContent = (t.tail && t.tail.text) ? t.tail.text : '';
  }
}
function openTask(id, proj, trigger){
  task.id = id; task.proj = proj || null; task.data = null; task.err = null; task.okAt = 0; task.trigger = trigger || null;
  byId('drawer').hidden = false;
  setText(byId('drawerTitle'), 'task ' + id);
  sigSet(byId('drawerBody'), '', '<div class="state dim">loading task...</div>');
  resetDiff();
  resetTail();
  pollTask(true);
  byId('drawerClose').focus();
}
function closeTask(){
  byId('drawer').hidden = true;
  var t = task.trigger;
  var id = task.id;
  task.id = null; task.trigger = null; task.data = null;
  if (t && document.contains(t)) { t.focus(); return; }
  var b = id ? document.querySelector('#tasksBody [data-task="' + id + '"]') : null;
  if (b) b.focus(); // row was re-rendered while open — refocus its button
}
function pollTask(force){
  if (!task.id || task.busy) return;
  if (!force && task.okAt && Date.now() - task.okAt < 5000) return; // drawer refresh throttle
  task.busy = true;
  // the task's own project beats the global filter — 'all' must still resolve
  var qp = task.proj ? '?project=' + encodeURIComponent(task.proj) : projQuery();
  fetch('/api/task' + qp + (qp ? '&' : '?') + 'id=' + encodeURIComponent(task.id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false) throw new Error((j && j.error) || 'bad /api/task payload');
      if (!j.task || !Array.isArray(j.events)) throw new Error('bad /api/task payload');
      task.data = j; task.err = null; task.okAt = Date.now();
    })
    .catch(function(e){ task.err = String((e && e.message) || e); })
    .finally(function(){ task.busy = false; renderDrawer(); });
}
function renderDrawer(){
  if (!task.id) return;
  var d = task.data;
  setText(byId('drawerTitle'), d ? d.task.id + ' — ' + String(d.task.title || '').slice(0, 70) : 'task ' + task.id);
  var body = byId('drawerBody');
  if (!d) {
    if (!task.err) return; // keep the loading row
    body.setAttribute('data-sig', '');
    body.innerHTML = '<div class="derr">task unavailable — ' + esc(String(task.err).slice(0, 120)) + '</div>' +
      '<button class="retry" id="taskRetry" type="button">retry</button>';
    byId('taskRetry').addEventListener('click', function(){ task.err = null; pollTask(true); });
    return;
  }
  var t = d.task;
  var meta = '<div class="r"><span class="dim">state</span> ' + taskPill(t.state) + '</div>' +
    '<div class="r"><span class="dim">owner</span> ' + esc(t.owner_label || (t.owner_sid ? String(t.owner_sid).slice(0, 12) : '') || 'unclaimed') + '</div>' +
    (t.origin ? '<div class="r"><span class="dim">origin</span> <span class="mono">' + esc(String(t.origin)) + '</span></div>' : '') +
    '<div class="r"><span class="dim">project</span> <span class="mono">' + esc(t.project || '?') + '</span></div>' +
    (t.requires ? '<div class="r"><span class="dim">needs</span> <span class="rq mono">' + esc(String(t.requires)) + '</span></div>' : '') +
    (t.scope ? '<div class="r"><span class="dim">scope</span> <span class="mono">' + esc(String(t.scope)) + '</span></div>' : '') +
    (t.parent_id ? '<div class="r"><span class="dim">parent</span> ' + esc(t.parent_id) + '</div>' : '') +
    '<div class="r"><span class="dim">age</span> ' + ago(t.age_s) + '</div>' +
    '<div class="r"><span class="dim">open decisions</span> ' + (t.open_decisions || 0) + '</div>';
  var decs = '';
  var dl = d.decisions || [];
  for (var i = 0; i < dl.length; i++) {
    var dd = dl[i] || {};
    decs += '<div class="dd"><span class="pill hst' + (dd.state === 'OPEN' ? ' open' : '') + '">' + esc(String(dd.state || '?').toLowerCase()) + '</span> ' +
      '<span class="hq">' + esc(String(dd.question || '').slice(0, 120)) + '</span>' +
      (dd.answer_note ? '<span class="hans">' + esc(String(dd.answer_note).slice(0, 160)) + '</span>' : '') + '</div>';
  }
  if (!decs) decs = '<div class="r"><span class="dim">(none)</span></div>';
  var tl = '';
  var evs = d.events || [];
  for (var j = 0; j < evs.length; j++) {
    var e = evs[j] || {};
    tl += '<div class="r"><span class="ts">' + agoShort(msAgo(e.ts)) + '</span><span><span class="akind">' + esc(String(e.kind || '?')) + '</span> ' +
      '<span class="mono">' + esc(String(e.source || '').slice(0, 16)) + '</span>' +
      (e.note ? ' — ' + esc(String(e.note).slice(0, 90)) : '') +
      (e.sha ? ' <span class="mono">@' + esc(String(e.sha).slice(0, 7)) + '</span>' : '') + '</span></div>';
  }
  if (!tl) tl = '<div class="r"><span class="dim">(no events)</span></div>';
  var html = '<div class="feed"><h2>Details</h2>' + meta + '</div>' +
    '<div class="feed"><h2>Linked decisions</h2>' + decs + '</div>' +
    '<div class="feed"><h2>Timeline</h2>' + tl + '</div>';
  if (task.err) html += '<div class="derr">refresh failed — ' + esc(String(task.err).slice(0, 120)) + '</div>';
  sigSet(body, String(task.okAt) + '|' + (task.err || ''), html);
  renderTaskDiff();
  renderTaskTail();
}
`;
