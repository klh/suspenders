// hooks/gates/ledger.ts — PreToolUse(Edit|Write): deny edits that INTRODUCE
// TODO/IN-FLIGHT/BLOCKED/NEXT-style markers into known operational ledgers.
// Operational state belongs in governor.db (coord/claim, Work Graph), never in
// Markdown — a TODO in a ledger rots because no lane owns it. Only NEW markers
// count (the exact line must not exist in the old content), so reformatting,
// quoting, or moving existing markers never trips. The ledger list is small
// and CODE-DEFINED: *LEDGER*.md, TODO.md, and any doc carrying a "retired
// ledger" header (the tombstone pattern from the 2026-09 ledger purge). A
// HISTORICAL banner on the line marks a durable tombstone and is allowed.
import { deny, type HookInput } from "../lib/hookio.ts";
import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";

type EditWriteInput = {
  file_path?: string;
  notebook_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
};

// Shouted markers only, word-bounded — lowercase prose ("todo list") and
// substrings ("nextdoor", "blocked-in") must never trip.
export const MARKER = /\b(TODO|FIXME|IN-FLIGHT|BLOCKED|NEXT)\b/;

// The tombstone banner: a line shouting HISTORICAL is a durable rationale,
// not live operational state.
export const BANNER = /\bHISTORICAL\b/;

/** Lines in `text` carrying an operational marker (tombstones excluded). */
export function markerLines(text: string): string[] {
  return text.split("\n").filter((l) => MARKER.test(l) && !BANNER.test(l));
}

/** Markers INTRODUCED by a mutation: marker lines in the new content that do
 * not exist verbatim in the old content. */
export function newMarkerLines(oldText: string, newText: string): string[] {
  const old = new Set(oldText.split("\n"));
  return markerLines(newText).filter((l) => !old.has(l));
}

/** The code-defined ledger list: *LEDGER*.md, TODO.md (both case-insensitive),
 * or a document whose content carries a "retired ledger" markdown heading. */
export function isLedgerFile(path: string, content: string): boolean {
  const b = basename(path);
  if (/ledger/i.test(b) && /\.md$/i.test(b)) return true;
  if (/^todo\.md$/i.test(b)) return true;
  if (/^#{1,6}[ \t]+.*retired[ \t-]+ledger/im.test(content)) return true;
  return false;
}

function diskContent(F: string): string {
  try {
    return existsSync(F) ? readFileSync(F, "utf8") : "";
  } catch {
    return ""; // unreadable → treat as empty; the path checks still apply
  }
}

/** Fails OPEN: unreadable/odd inputs never block an edit. */
export function ledgerGate(hook: HookInput): void {
  const tool = hook.tool_name;
  if (tool !== "Edit" && tool !== "Write") return;
  const ti = (hook.tool_input ?? {}) as EditWriteInput;
  const F = ti.file_path ?? ti.notebook_path ?? "";
  if (!F) return;

  let old = "";
  let neu = "";
  if (tool === "Edit") {
    old = ti.old_string ?? "";
    neu = ti.new_string ?? "";
  } else {
    if (!existsSync(F)) return; // brand-new file: nothing to preserve, gate off
    old = diskContent(F);
    neu = ti.content ?? "";
  }

  if (!isLedgerFile(F, tool === "Write" ? neu : diskContent(F))) return;
  const intro = newMarkerLines(old, neu);
  if (intro.length === 0) return;
  deny(
    `operational-marker gate: ${F} is an operational ledger ` +
      `(code-defined list: *LEDGER*.md, TODO.md, or a "retired ledger" header) and this edit ` +
      `introduces ${intro.length} new TODO/IN-FLIGHT/BLOCKED/NEXT-style marker${intro.length > 1 ? "s" : ""}: ` +
      `${intro.map((l) => JSON.stringify(l.trim())).join(", ")}. ` +
      `Operational state belongs in governor.db (coord/claim + Work Graph), not Markdown. ` +
      `Move it to the work graph, or shout HISTORICAL on the line if it is a durable tombstone.`,
  );
}
