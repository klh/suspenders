// hooks/board-html/diff.ts — per-item diff + inline review comments (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const DIFF = String.raw`// --- 4b: per-item diff + inline review comments (W55, /api/diff + /api/comment) ---
// #taskDiff sits OUTSIDE the sigSet'd drawer body: the drawer rebuilds on every
// good poll and would otherwise blow away the note input mid-typing. It keeps
// its own signature; only real diff/comment state changes rebuild it.
function resetDiff(){
  diffView.open = false; diffView.busy = false; diffView.err = null; diffView.data = null; diffView.okAt = 0;
  diffView.target = null; diffView.draft = ''; diffView.msg = ''; diffView.msgErr = false;
  shipReset();
}
function fetchDiff(){
  if (diffView.busy || !task.id) return;
  diffView.busy = true; diffView.err = null;
  fetch('/api/diff?id=' + encodeURIComponent(task.id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { status: r.status, j: j || {} }; }); })
    .then(function(res){
      diffView.busy = false;
      if (res.status === 200 && res.j && res.j.ok) { diffView.data = res.j; diffView.okAt = Date.now(); }
      else diffView.err = (res.j && res.j.error) || 'HTTP ' + res.status;
      // ship outcome rides this poll: the 404 (retired branch) is the
      // shipped signal; a 200 while a ship runs keeps the 2s poll alive
      if (shipView.phase === 'run') {
        if (res.status === 404) {
          diffView.msg = 'shipped — merged and the branch retired'; diffView.msgErr = false;
          shipReset();
        } else if (Date.now() - shipView.at < 10 * 60_000) {
          setTimeout(fetchDiff, 2000);
          return;
        } else {
          diffView.msg = 'ship still running after 10min — see the repo .fleet/loop.log'; diffView.msgErr = true;
          shipReset();
        }
      }
      renderTaskDiff();
    })
    .catch(function(e){ diffView.busy = false; diffView.err = String((e && e.message) || e); renderTaskDiff(); });
}
function toggleDiff(){
  diffView.open = !diffView.open;
  if (diffView.open && !diffView.data && !diffView.err) fetchDiff();
  renderTaskDiff();
}
function diffRow(cls, file, num, text){
  var attrs = 'data-line="' + num + '"';
  if (file) attrs += ' data-file="' + esc(file) + '" title="comment on ' + esc(file) + ':' + num + '"';
  return '<span class="dline ' + cls + '"><span class="dlnum" ' + attrs + '>' + num + '</span>' + esc(text) + '</span>';
}
function buildDiffRows(diffText){
  // parse the unified patch: track the current file (+++ b/<path>) and line
  // counters (@@ -o,n +n,n @@). Clickable numbers address the NEW file; on
  // removed lines the OLD number is what a reviewer references.
  var lines = String(diffText || '').split('\n');
  var file = null; var newLn = 0; var oldLn = 0; var out = '';
  var MAX = 5000;
  for (var i = 0; i < lines.length; i++){
    var ln = lines[i];
    if (i >= MAX) { out += '<span class="dline meta">… truncated at ' + MAX + ' rendered lines</span>'; break; }
    var c = ln.slice(0, 1);
    if (ln.slice(0, 4) === '+++ ') {
      file = ln.slice(6) === '/dev/null' ? null : ln.slice(6);
      out += meta(ln);
    } else if (ln.slice(0, 4) === '--- ' || ln.slice(0, 3) === 'diff' || ln.slice(0, 5) === 'index' || c === '\\') {
      out += '<span class="dline meta">' + esc(ln) + '</span>';
    } else if (ln.slice(0, 3) === '@@ ') {
      var m = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      newLn = m ? Number(m[1]) : 0;
      var mo = ln.match(/^@@ -(\d+)/);
      oldLn = mo ? Number(mo[1]) : 0;
      out += '<span class="dline hunk">' + esc(ln) + '</span>';
    } else if (c === '+') {
      out += diffRow('add', file, newLn, ln);
      newLn++;
    } else if (c === '-') {
      out += diffRow('del', file, oldLn, ln);
      oldLn++;
    } else {
      out += diffRow('ctx', file, newLn, ln);
      newLn++;
      oldLn++;
    }
  }
  return out;
}
function renderTaskDiff(){
  var el = byId('taskDiff');
  if (!task.id) { sigSet(el, 'idle', ''); return; }
  var sig = [task.id, diffView.open, diffView.busy, diffView.err, diffView.okAt,
    diffView.target ? diffView.target.file + ':' + diffView.target.line : '',
    diffView.msg ? (diffView.msgErr ? 'e' : 'o') + diffView.msg : '',
    shipView.phase].join('|');
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    var h = '<div class="diffbar"><button type="button" class="diffbtn' + (diffView.open ? ' on' : '') + '">' + (diffView.busy ? 'diff…' : 'diff') + '</button>';
    if (diffView.data) {
      var statTail = String(diffView.data.stat || '').trim().split('\n').pop() || '';
      h += '<span class="diffcap mono">' + esc(diffView.data.branch) + ' @ ' + esc(String(diffView.data.base || '').slice(0, 7)) + (statTail ? ' · ' + esc(statTail) : '') + '</span>';
      var sl = shipView.phase ? 'merging…' : 'ship';
      h += '<button type="button" class="diffbtn ship" title="ship this branch: run the repo merge ladder and merge to main">' + sl + '</button>';
    }
    if (diffView.err) h += '<span class="diffmsg risk">' + esc(diffView.err) + '</span>';
    if (diffView.msg) h += '<span class="diffmsg' + (diffView.msgErr ? ' risk' : '') + '">' + esc(diffView.msg) + '</span>';
    h += '</div>';
    if (diffView.open && diffView.busy) h += '<div class="dim">loading diff...</div>';
    if (diffView.open && diffView.data) {
      var rows = buildDiffRows(diffView.data.diff);
      if (!rows) rows = '<span class="dline meta">(no changes on the branch)</span>';
      h += '<div class="diffwrap"><pre class="diffview mono">' + rows + '</pre></div>';
    }
    if (diffView.open && diffView.target) {
      h += '<div class="dnote"><span class="dtgt mono">' + esc(diffView.target.file) + ':' + esc(String(diffView.target.line)) + '</span>' +
        '<input class="diffnote" placeholder="line note — routes to the owning lane...">' +
        '<button type="button" class="diffsend">send</button></div>';
    }
    el.innerHTML = h;
    var inp = el.querySelector('.diffnote');
    if (inp && diffView.draft) inp.value = diffView.draft;
  } else {
    var keep = el.querySelector('.diffnote');
    if (keep && document.activeElement !== keep && keep.value !== diffView.draft) keep.value = diffView.draft;
  }
}
function pickDiffLine(f, l){
  diffView.target = { file: f, line: l };
  diffView.msg = '';
  renderTaskDiff();
  var inp = byId('taskDiff').querySelector('.diffnote');
  if (inp) inp.focus();
}
function sendDiffNote(){
  if (!task.id || !diffView.target) return;
  var tgt = diffView.target;
  var note = (diffView.draft || '').trim();
  if (!note) { diffView.msg = 'type a note first'; diffView.msgErr = true; renderTaskDiff(); return; }
  diffView.msg = 'sending…'; diffView.msgErr = false;
  renderTaskDiff();
  postJSON('/api/comment', { id: task.id, file: tgt.file, line: tgt.line, note: note })
    .then(function(res){
      if (res && res.ok) {
        diffView.msg = 'comment sent to ' + (res.to || 'the owning lane') + ' (' + tgt.file + ':' + tgt.line + ')';
        diffView.target = null; diffView.draft = ''; diffView.msgErr = false;
      } else {
        diffView.msg = (res && (res.error || res.output)) || 'send failed — retry';
        diffView.msgErr = true;
      }
      renderTaskDiff();
    })
    .catch(function(e){
      diffView.msg = String((e && e.message) || e) + ' — retry';
      diffView.msgErr = true;
      renderTaskDiff();
    });
}
`;
