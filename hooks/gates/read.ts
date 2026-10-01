// hooks/gates/read.ts — PreToolUse(Read) fat-read + re-read guard (W110).
// Two context-economy gates on Read, one O(1) process:
//   1. FAT-READ DENY: a no-limit Read of a file > SUSPENDERS_MAX_READ bytes
//      (default 40KB) is denied BEFORE the harness reads it — W109 measured
//      23 results >60KB in 7d (max 122KB) from 1,412 no-offset reads. The
//      deny reason carries the size and the bounded retry (limit/offset or
//      rg), so the model re-issues a bounded read instead of eating the blob.
//      Media extensions are exempt (Read has no limit for images/PDFs).
//   2. RE-READ NUDGE: 3rd+ Read of the same path in one session gets a
//      non-blocking additionalContext nudge (the fleet-loop.ts 37x case).
//      Advisory: SUSPENDERS_REREAD_NUDGE=0 disables.
import { deny, nudge, type HookInput } from "../lib/hookio.ts";
import { bumpPathCount } from "../lib/gatestate.ts";
import { statSync } from "node:fs";

export const DEFAULT_MAX_READ = 40 * 1024;

const MEDIA_RE = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff|pdf|avif)$/i;

/** SUSPENDERS_MAX_READ parsing — same contract as mutationCap: unset/blank →
 * default; a positive integer is the cap in bytes; 0, negatives, garbage →
 * disabled (the knob was touched deliberately). */
export function readCapBytes(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_READ;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Pure core of the fat-read deny: null = allow, else the deny reason. */
export function fatReadDeny(
	size: number,
	hasLimit: boolean,
	cap: number,
	path: string,
): string | null {
	if (cap === 0 || hasLimit || size <= cap) return null;
	if (MEDIA_RE.test(path)) return null;
	const kb = Math.round(size / 1024);
	return `read-gate: ${path} is ${kb}KB — a no-limit Read pulls it ALL into context. Re-issue with limit (e.g. limit: 400) and offset, or rg for a targeted search. Escape hatch: SUSPENDERS_MAX_READ=<bytes> raises the cap, 0 disables.`;
}

/** 3rd+ same-path read in a session → advisory nudge, read proceeds. */
export function rereadNudge(sid: string, F: string, label: string): void {
	if (process.env.SUSPENDERS_REREAD_NUDGE === "0") return;
	const n = bumpPathCount("reads", sid, F);
	if (n < 3 || n % 3 !== 0) return;
	nudge(
		`read-gate: read #${n} of ${label} this session — it is already in context. If the file changed under you, the anchor-gate denial carries the current text; prefer rg/offset+limit over full re-reads.`,
	);
}

export function readGate(hook: HookInput): void {
	if (hook.tool_name !== "Read") return;
	const ti = (hook.tool_input ?? {}) as {
		file_path?: string;
		limit?: number | string;
	};
	const F = ti.file_path ?? "";
	if (!F) return;
	const hasLimit = ti.limit !== undefined && ti.limit !== null;
	let size: number;
	try {
		size = statSync(F).size;
	} catch {
		return; // missing/unreadable → harness's own error, precise and cheap
	}
	const reason = fatReadDeny(
		size,
		hasLimit,
		readCapBytes(process.env.SUSPENDERS_MAX_READ),
		F,
	);
	if (reason) deny(reason);
	const sid = (hook as HookInput & { session_id?: string }).session_id;
	if (!sid) return;
	rereadNudge(sid, F, F.slice(F.lastIndexOf("/") + 1));
}
