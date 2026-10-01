// hooks/board-html/ship.ts — one-click ship + message-to-lane (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const SHIP = String.raw`// --- 4c: one-click ship (W64, /api/ship) — ladder+merge from the diff bar ---
// Ship runs detached on the board: the POST returns the resolved ladder while
// the child runs. Outcome rides the /api/diff poll: once the branch retires,
// /api/diff 404s ("no branch ...") — that 404 is the shipped signal.
var shipView = { phase: null, ladder: '', at: 0 };
function shipReset(){
  shipView = { phase: null, ladder: '', at: 0 };
}
function sendLaneMsg(){
  if (!task.id) return;
  var note = (tailView.draft || '').trim();
  if (!note) { tailView.msg = 'type a message first'; tailView.msgErr = true; renderTaskTail(); return; }
  tailView.msg = 'sending…'; tailView.msgErr = false;
  renderTaskTail();
  postJSON('/api/message', { id: task.id, note: note })
    .then(function(res){
      if (res && res.ok) {
        tailView.msg = 'sent to ' + (res.to || 'the lane') + ' as ' + (res.as || 'the coordinator');
        tailView.draft = ''; tailView.msgErr = false;
      } else {
        tailView.msg = (res && (res.error || res.output)) || 'send failed — retry';
        tailView.msgErr = true;
      }
      renderTaskTail();
    })
    .catch(function(e){
      tailView.msg = String((e && e.message) || e) + ' — retry';
      tailView.msgErr = true;
      renderTaskTail();
    });
}
function shipItem(){
  if (!task.id || !diffView.data || shipView.phase) return;
  var proj = task.proj || (task.data && task.data.task && task.data.task.project);
  if (!proj) { diffView.msg = 'ship: no project on the open task'; diffView.msgErr = true; renderTaskDiff(); return; }
  shipView = { phase: 'post', ladder: '', at: Date.now() };
  diffView.msg = 'ship: dispatching...'; diffView.msgErr = false;
  renderTaskDiff();
  postJSON('/api/ship', { project: proj, id: task.id })
    .then(function(res){
      if (res && res.ok) {
        shipView = { phase: 'run', ladder: res.ladder || '', at: Date.now() };
        diffView.msg = 'shipping via ' + (res.ladder || 'the repo ladder') + ' — the branch retires when it lands';
        fetchDiff();
      } else {
        shipReset();
        diffView.msg = (res && res.error) || 'ship failed — retry';
        diffView.msgErr = true;
        // the branch may have merged while the drawer sat open — refresh
        fetchDiff();
      }
    })
    .catch(function(e){
      shipReset();
      diffView.msg = String((e && e.message) || e) + ' — retry';
      diffView.msgErr = true;
      renderTaskDiff();
    });
}

`;
