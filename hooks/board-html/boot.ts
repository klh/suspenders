// hooks/board-html/boot.ts — boot (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const BOOT = String.raw`function renderAll(){
  renderConn();
  renderFleet();
  renderDecisions();
  renderTab();
}
function setCollapsed(v){
  decCollapsed = v;
  renderDecisions();
}
setInterval(tick, 1000);
pollExecutors(); // belt targets for the dispatch dropdown (page-load, not polled)
if (!location.hash) history.replaceState(null, '', '#decisions');
setTab(TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'decisions', true);
applyHashFilter(); // honor #filter=<text> on first paint (deep-link from the statusline)
applyHashTask(); // honor #task=<id> on first paint (lane reports, terminal links)
tick();
renderAll();
</script></body></html>`;
