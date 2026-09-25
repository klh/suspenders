// hooks/gates/mutation-size.ts — PreToolUse(Edit|Write): deny oversized
// generated payloads on EXISTING files. Raw mutations >40 changed lines are
// the emission-corruption hazard (CLAUDE.md File-Editing-Rules): a garbled
// 60-line Edit lands silently and disk stays wrong until a re-read. New files
// are exempt (nothing on disk to corrupt). SUSPENDERS_MAX_MUTATION=<N> sets
// the cap; 0 disables the gate.
import { deny, type HookInput } from "../lib/hookio.ts";
import { existsSync, readFileSync } from "node:fs";

type EditWriteInput = {
  file_path?: string;
  notebook_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
};

export const DEFAULT_CAP = 40;

/** Payload line count: "" is 0 lines; a trailing \n does not open a new one. */
export function countLines(s: string): number {
  return s === "" ? 0 : s.replace(/\n$/, "").split("\n").length;
}

/** The metric: both sides of the mutation are fresh emissions, so a payload
 * "changes" max(old, new) lines — a 45-line replacement of a 5-line block is
 * 45 changed lines, not 40 lines of drift. */
export function changedLines(oldText: string, newText: string): number {
  return Math.max(countLines(oldText), countLines(newText));
}

/** SUSPENDERS_MAX_MUTATION: unset/empty → 40; a positive integer is the cap;
 * 0, negatives, and garbage all disable (the knob was touched deliberately). */
export function mutationCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Fails OPEN: unreadable targets and odd inputs never block an edit. */
export function mutationSizeGate(hook: HookInput): void {
  const tool = hook.tool_name;
  if (tool !== "Edit" && tool !== "Write") return;
  const cap = mutationCap(process.env.SUSPENDERS_MAX_MUTATION);
  if (cap === 0) return;
  const ti = (hook.tool_input ?? {}) as EditWriteInput;
  const F = ti.file_path ?? ti.notebook_path ?? "";
  if (!F) return;

  let old = "";
  let newContent: string | undefined;
  if (tool === "Write") {
    if (!existsSync(F)) return; // new files exempt
    try {
      old = readFileSync(F, "utf8");
    } catch {
      return; // unreadable → fail open
    }
    newContent = ti.content;
  } else {
    old = ti.old_string ?? "";
    newContent = ti.new_string ?? "";
  }
  if (typeof newContent !== "string") return;

  const changed = changedLines(old, newContent);
  if (changed > cap)
    deny(
      `mutation-size: this payload changes ~${changed} lines (> cap ${cap}) on an existing file. ` +
        `Long generated mutations are the emission-corruption hazard — split the change into smaller anchored edits, ` +
        `or use a mechanical transform (sd / ast-grep / bun -e splice). ` +
        `Escape hatch: SUSPENDERS_MAX_MUTATION=<N> raises the cap (0 disables the gate).`,
    );
}
