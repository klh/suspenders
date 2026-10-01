// hooks/board-html/tail.ts — live lane tail (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const TAIL = String.raw`// --- 4d: live lane tail + message-to-lane (W76, /api/tail + /api/message) ---
// #taskTail sits outside the sigSet'd drawer body like #taskDiff: the tail
// rebuilds on its own signature so the poll never blows away the message
// input mid-typing. Sources, server-chosen: the lane log (complete after the
// run finishes; streaming for codex lanes) and the transcript's recent
// assistant blocks (live for RUNNING claude lanes whose stdout buffers).
var tailView = { open: false, busy: false, err: null, data: null, okAt: 0, at: 0, msg: '', msgErr: false, draft: '', pin: true };
function resetTail(){
  tailView = { open: false, busy: false, err: null, data: null, okAt: 0, at: 0, msg: '', msgErr: false, draft: '', pin: true };
}
function toggleTail(){
  tailView.open = !tailView.open;
  if (tailView.open) { tailView.pin = true; if (!tailView.data && !tailView.err) fetchTail(); }
  renderTaskTail();
}
function fetchTail(){
  if (tailView.busy || !task.id) return;
  tailView.busy = true; tailView.err = null;
  fetch('/api/tail?id=' + encodeURIComponent(task.id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { status: r.status, j: j || {} }; }); })
    .then(function(res){
      tailView.busy = false; tailView.at = Date.now();
      if (res.status === 200 && res.j && res.j.ok) { tailView.data = res.j; tailView.okAt = Date.now(); }
      else tailView.err = (res.j && res.j.error) || 'HTTP ' + res.status;
      renderTaskTail();
    })
    .catch(function(e){ tailView.busy = false; tailView.err = String((e && e.message) || e); renderTaskTail(); });
}
function pollTail(){
  if (!tailView.open || tailView.busy || !task.id) return;
  if (Date.now() - tailView.at < 2000) return;
  fetchTail();
}
function renderTaskTail(){
  var el = byId('taskTail');
  if (!task.id) { sigSet(el, 'idle', ''); return; }
  var d = tailView.data;
  var lg = d && d.log;
  var rc = d && d.recent;
  var sig = [task.id, tailView.open, tailView.busy, tailView.err || '', tailView.okAt ? (lg && lg.size != null ? lg.size + '@' + lg.mtime : 'nolog') + (rc && rc.length ? '|r' + rc.length : '') : 'idle', tailView.msg ? (tailView.msgErr ? 'e' : 'o') + tailView.msg : ''].join('|');
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    var h = '<div class="tailbar"><button type="button" class="tailbtn' + (tailView.open ? ' on' : '') + '">' + (tailView.busy ? 'tail…' : 'tail') + '</button>';
    if (tailView.open) {
      var txt = null; var cap = '';
      var tr = d && d.transcript;
      if (lg && String(lg.text || '').trim()) {
        txt = String(lg.text); cap = 'lane-' + esc(d.sid) + '.log · ' + lg.size + 'B' + (lg.truncated ? ' · truncated' : '');
      } else if (rc && rc.length) {
        txt = rc.map(function(r){ return String(r.text || ''); }).join('\n');
        cap = 'transcript · live';
      } else if (tr && tr.text) {
        txt = tr.text; cap = 'transcript ' + (tr.ts ? agoShort(msAgo(Date.parse(tr.ts))) : '?') + ' ago — stdout buffers until the lane finishes';
      }
      if (txt != null) h += '<div class="tailwrap"><pre class="tailview mono">' + esc(txt.slice(-40000)) + '</pre></div>';
      else h += '<div class="tailwrap"><pre class="tailview mono"><span class="dim">(no lane output yet)</span></pre></div>';
      h += '<div class="dnote"><input class="lanemsg" placeholder="message the lane — sent as the coordinator"><button type="button" class="lanesend">send</button></div>';
      if (tailView.msg) h += '<div class="tailmsg' + (tailView.msgErr ? ' risk' : '') + '">' + esc(tailView.msg) + '</div>';
      var inp = el.querySelector('.lanemsg');
      if (inp && tailView.draft) inp.value = tailView.draft;
    }
    el.innerHTML = h;
  } else if (tailView.open) {
    var keep = el.querySelector('.lanemsg');
    if (keep && document.activeElement !== keep && keep.value !== tailView.draft) keep.value = tailView.draft;
  }
  tailScroll(el);
}
function tailScroll(el){
  var pre = el.querySelector('.tailview');
  if (!pre) return;
  if (!pre._pinwired) {
    pre._pinwired = true; // the pre is replaced on each sig rebuild — listeners never stack
    pre.addEventListener('scroll', function(){
      tailView.pin = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    });
  }
  if (tailView.pin) pre.scrollTop = pre.scrollHeight;
}

`;
