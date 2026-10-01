// hooks/board-html/decisions.ts — decisions tab (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const DECISIONS = String.raw`// --- 2: decisions needed (Decisions tab, /api/decisions) ---
function openDecs(){
  var ds = (lastDec && lastDec.decisions) || [];
  var out = [];
  for (var i = 0; i < ds.length; i++) {
    if (!ds[i].state || ds[i].state === 'OPEN') out.push(ds[i]);
  }
  return out;
}
function decById(id){
  var ds = (lastDec && lastDec.decisions) || [];
  for (var i = 0; i < ds.length; i++) {
    if (ds[i].id === id) return ds[i];
  }
  return null;
}
function decNodeEl(id){ return document.querySelector('.dec[data-id="' + id + '"]'); }
// recommendation: /api/decisions record when the backend adds it there,
// else the /api/data needs map (the advice.<id> fact written by advise.ts)
function adviceFor(id){
  var d = decById(id);
  if (d && (d.advice || d.adviceError)) return d;
  var nd = (lastData && lastData.needs) || {};
  for (var s in nd) {
    var arr = nd[s];
    for (var j = 0; j < arr.length; j++) {
      if (arr[j].id === id) return arr[j];
    }
  }
  return null;
}
function decAge(d){
  if (d.age_s != null) return d.age_s;
  if (d.created_ts) return Math.max(0, Math.round((Date.now() - d.created_ts) / 1000));
  return null;
}
// feed failure banner (sig-guarded; never rendered as "0 pending")
function showDecFeedError(errEl){
  var when = decOkAt ? ago(Math.round((Date.now() - decOkAt) / 1000)) : 'never';
  var sig = 'unavailable|' + when;
  if (errEl.getAttribute('data-sig') !== sig) {
    errEl.setAttribute('data-sig', sig);
    errEl.textContent = 'decision feed unavailable — last good ' + when;
    var rb = document.createElement('button');
    rb.className = 'retry';
    rb.type = 'button';
    rb.textContent = 'retry';
    rb.addEventListener('click', function(){ decErr = null; pollDec(); });
    errEl.appendChild(rb);
  }
  errEl.style.display = 'block';
}
// one explicit state, never render failure as zero pending
function renderDecisions(){
  try {
    renderDecisionsInner();
  } catch (e) {
    var errEl = byId('decErr');
    errEl.textContent = 'decision render failed — last good data kept';
    errEl.style.display = 'block';
  }
}
function projBase(){
  if (!sel.value || sel.value === 'all') return null;
  var b = String(sel.value).split('/').pop() || sel.value;
  return b.replace(/\.git$/, '');
}
function renderDecisionsInner(){
  var all = openDecs();
  var live = {};
  for (var i = 0; i < all.length; i++) live[all[i].id] = true;
  // request-state cleanup for decisions that left the list
  for (var k in advising) if (!live[k]) delete advising[k];
  for (var k2 in advErr) if (!live[k2]) delete advErr[k2];
  for (var k3 in answering) if (!live[k3]) delete answering[k3];
  for (var k4 in sentOk) if (!live[k4]) delete sentOk[k4];
  // header state: loading / N need you / none / feed unavailable
  var st = byId('decState');
  var errEl = byId('decErr');
  if (!decLoaded) {
    setText(st, 'loading decisions...');
    errEl.style.display = 'none';
  } else if (decErr) {
    setText(st, '');
    showDecFeedError(errEl);
  } else if (all.length) {
    setText(st, all.length + ' decision' + (all.length === 1 ? '' : 's') + ' need you');
    errEl.style.display = 'none';
  } else {
    setText(st, 'No pending decisions · checked ' + ago(Math.round((Date.now() - decOkAt) / 1000)));
    errEl.style.display = 'none';
  }
  // badge always visible while pending; "(N)" in title while collapsed
  var badge = byId('needsn');
  var btxt = all.length ? all.length + ' need you' : '';
  if (badge.textContent !== btxt) badge.textContent = btxt;
  var pb = projBase();
  var base = pb ? String(pb).toUpperCase() + ' · FLEET BOARD' : 'FLEET BOARD';
  var ttl = decCollapsed && all.length ? base + ' (' + all.length + ')' : base;
  if (document.title !== ttl) document.title = ttl;
  byId('decisions').classList.toggle('closed', decCollapsed);
  byId('decisions').classList.toggle('has', all.length > 0);
  setText(byId('decCaret'), decCollapsed ? '+' : '-');
  // keyed nodes: create once per decision id, remove + clean up on exit
  var list = byId('decList');
  var want = {};
  for (var wi = 0; wi < all.length; wi++) want[all[wi].id] = true;
  for (var ci = list.children.length - 1; ci >= 0; ci--) {
    var kid = list.children[ci];
    var kidId = kid.getAttribute('data-id');
    if (!want[kidId]) {
      kid.remove();
      delete drafts[kidId]; delete selOpt[kidId]; delete ansErr[kidId];
      delete sentOk[kidId];
    }
  }
  for (var di = 0; di < all.length; di++) {
    decNode(all[di]);
    var dq = decNodeEl(all[di].id);
    if (dq) dq.style.display = hashMatch([all[di].id, all[di].asked_by, all[di].asked_by_label]) ? '' : 'none';
  }
}
function decNode(d){
  var list = byId('decList');
  var q = decNodeEl(d.id);
  if (!q) {
    q = document.createElement('div');
    q.className = 'dec';
    q.setAttribute('data-id', d.id);
    q.innerHTML =
      '<div class="dhead"><span class="dproj mono"></span><span class="dwho"></span><span class="dage dim"></span></div>' +
      '<div class="dq"></div>' +
      '<div class="dblocks"></div>' +
      '<div class="dopts"></div>' +
      '<div class="dadv"></div>' +
      '<div class="dans"><input class="ans" placeholder="your decision...">' +
      '<button class="send" type="button">Send</button>' +
      '<button class="getrec" type="button">Get recommendation</button>' +
      '<button class="dismiss" type="button">cancel</button></div>' +
      '<div class="derr" role="alert"></div>';
    list.appendChild(q);
  }
  var inp = q.querySelector('input.ans');
  if (document.activeElement !== inp && inp.value !== (drafts[d.id] || '')) {
    inp.value = drafts[d.id] || '';
  }
  if (!q.getAttribute('data-wired')) {
    q.setAttribute('data-wired', '1');
    inp.addEventListener('input', function(){ drafts[d.id] = inp.value; });
    inp.addEventListener('keydown', function(e){
      if (e.key === 'Enter') {
        e.preventDefault();
        sendAns(d.id);
      }
    });
    q.addEventListener('click', function(e){
      var t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('send')) sendAns(d.id);
      else if (t.classList.contains('getrec') || t.classList.contains('advretry')) askAdv(d.id);
      else if (t.classList.contains('dismiss')) cancelDec(d.id);
      else if (t.classList.contains('use')) useRec(d.id);
      else if (t.classList.contains('opt')) pickOpt(d.id, t);
    });
  } else if (drafts[d.id] != null && inp.value !== drafts[d.id] && document.activeElement !== inp) {
    inp.value = drafts[d.id];
  }
  q.classList.toggle('sent', !!sentOk[d.id]);
  setText(q.querySelector('.dproj'), d.project || '(unknown project)');
  setText(q.querySelector('.dwho'), (d.asked_by_label || d.asked_by || '?') + ' · #' + d.id);
  setText(q.querySelector('.dage'), ago(decAge(d)));
  setText(q.querySelector('.dq'), d.question || '(no question text)');
  var blocks = 'blocks: ' + (d.task_title || (d.task_id ? 'task ' + d.task_id : 'no linked task'));
  setText(q.querySelector('.dblocks'), blocks);
  var errEl2 = q.querySelector('.derr');
  var errTxt = ansErr[d.id] || (d.delivery === 'FAILED' ? 'delivery failed — press Send to retry' : '');
  if (errEl2.getAttribute('data-sig') !== errTxt) {
    errEl2.setAttribute('data-sig', errTxt);
    errEl2.textContent = errTxt;
  }
  var sb = q.querySelector('.send');
  sb.disabled = !!answering[d.id];
  setText(sb, sentOk[d.id] ? 'Sent' : 'Send');
  q.querySelector('.getrec').disabled = !!advising[d.id];
  var optEl = q.querySelector('.dopts');
  var opts = Array.isArray(d.options) ? d.options : [];
  var osig = JSON.stringify(opts) + '|' + (selOpt[d.id] || '');
  if (optEl.getAttribute('data-sig') !== osig) {
    optEl.setAttribute('data-sig', osig);
    optEl.innerHTML = '';
    for (var oi = 0; oi < opts.length; oi++) {
      var o = opts[oi] || {};
      var row = document.createElement('div');
      row.className = 'optrow' + (selOpt[d.id] === o.label ? ' sel' : '');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', selOpt[d.id] === o.label ? 'true' : 'false');
      var tr = document.createElement('span');
      tr.className = 'trade dim';
      tr.textContent = o.tradeoff || '';
      row.appendChild(b);
      row.appendChild(tr);
      optEl.appendChild(row);
    }
  }
  var advEl = q.querySelector('.dadv');
  if (advising[d.id] && adviceFor(d.id)) delete advising[d.id]; // fact landed
  var a = advising[d.id] ? null : adviceFor(d.id);
  var asig;
  if (advising[d.id]) asig = 'busy:' + Math.round((Date.now() - advising[d.id]) / 1000);
  else if (advErr[d.id]) asig = 'adverr:' + advErr[d.id];
  else if (a && a.adviceError) asig = 'aerr:' + a.adviceError;
  else if (a && a.advice) asig = 'adv:' + JSON.stringify(a.advice);
  else asig = '';
  if (advEl.getAttribute('data-sig') !== asig) {
    advEl.setAttribute('data-sig', asig);
    advEl.innerHTML = '';
    if (asig === '') {
      advEl.style.display = 'none';
    } else if (advising[d.id]) {
      advEl.style.display = 'block';
      var secs = Math.round((Date.now() - advising[d.id]) / 1000);
      advEl.innerHTML = '<span class="dim">getting recommendation... ' + secs + 's</span>';
    } else if (advErr[d.id]) {
      advEl.style.display = 'block';
      advEl.innerHTML = '<span class="risk">advice request failed: ' + esc(advErr[d.id]) + '</span>' +
        ' <button class="advretry" type="button">retry</button>';
    } else if (a && a.adviceError) {
      advEl.style.display = 'block';
      advEl.innerHTML = '<span class="risk">advice failed: ' + esc(a.adviceError) + '</span>' +
        ' <button class="advretry" type="button">retry</button>';
    } else if (a && a.advice) {
      var ac = a.advice;
      var rhead = '<div class="rhead">RECOMMENDATION' + (ac.model ? ' <span class="dim">' + esc(ac.model) + '</span>' : '') + '</div>';
      var rbody = '<div class="rec">' + esc(ac.rec || '') + '</div>';
      if (ac.rationale) rbody += '<div class="why">' + esc(ac.rationale) + '</div>';
      if (ac.risk) rbody += '<div class="risk">risk: ' + esc(ac.risk) + '</div>';
      advEl.innerHTML = rhead + rbody + ' <button class="use" type="button">use</button>';
    }
  }
}
function pickOpt(id, btn){
  var d = decById(id);
  if (!d) return;
  var opts = Array.isArray(d.options) ? d.options : [];
  for (var i = 0; i < opts.length; i++) {
    var o = opts[i] || {};
    if (o.label === btn.textContent) {
      selOpt[id] = o.label;
      var q = decNodeEl(id);
      var inp = q && q.querySelector('input.ans');
      if (inp) {
        inp.value = o.label;
        drafts[id] = o.label;
        inp.focus();
      }
      renderDecisions();
      return;
    }
  }
}
function sendAns(id){
  if (answering[id]) return; // in flight — never resubmit
  var d = decById(id);
  var q = decNodeEl(id);
  if (!d || !q) return;
  var inp = q.querySelector('input.ans');
  var note = (inp.value || '').trim();
  if (!note) {
    ansErr[id] = 'type an answer first';
    renderDecisions();
    return;
  }
  answering[id] = true;
  delete ansErr[id];
  q.querySelector('.send').disabled = true;
  // contract POST /api/answer: token the client read + note; to/forEvent kept
  // for backward compatibility with the pre-contract backend
  postJSON('/api/answer', { id: id, token: d.answer_token, note: note, to: d.asked_by, forEvent: id })
    .then(function(res){
      delete answering[id];
      if (res && res.ok) {
        sentOk[id] = true;
        delete drafts[id];
        inp.value = '';
        delete selOpt[id];
      } else {
        var stale = res && res.error === 'stale';
        ansErr[id] = stale ? 'stale — changed elsewhere, reloading' : ((res && (res.error || res.output)) || 'send failed — press Send to retry');
      }
      renderDecisions();
      tick();
    })
    .catch(function(e){
      delete answering[id];
      ansErr[id] = String((e && e.message) || e) + ' — press Send to retry';
      renderDecisions();
    });
}
function askAdv(id){
  if (advising[id]) return;
  delete advErr[id];
  advising[id] = Date.now();
  renderDecisions();
  postJSON('/api/advise', { id: id })
    .then(function(res){
      if (!res || !res.ok) {
        delete advising[id];
        advErr[id] = (res && res.error) || 'advise failed to start';
      }
      renderDecisions();
    })
    .catch(function(e){
      delete advising[id];
      advErr[id] = String((e && e.message) || e) + ' — retry';
      renderDecisions();
    });
}
function useRec(id){
  var a = adviceFor(id);
  var q = decNodeEl(id);
  if (!a || !a.advice || !q) return;
  var inp = q.querySelector('input.ans');
  inp.value = a.advice.rec || '';
  drafts[id] = inp.value;
  inp.focus();
}
function cancelDec(id){
  if (!window.confirm('Cancel this decision? The asking lane will see it as cancelled.')) return;
  postJSON('/api/ack', { id: id })
    .then(function(res){
      if (!res || !res.ok) {
        ansErr[id] = (res && (res.error || res.output)) || 'cancel failed — retry';
        renderDecisions();
      }
      tick();
    })
    .catch(function(e){
      ansErr[id] = String((e && e.message) || e) + ' — retry';
      renderDecisions();
    });
}
`;
