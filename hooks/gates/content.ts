// hooks/gates/content.ts — PreToolUse(Write|Edit) payload parse gate.
// The post-files gate catches syntax errors AFTER they land on disk; this
// gate denies the corrupted payload BEFORE it is written (2026-09-29: two
// corrupted JSON schema writes landed in one hour — prevention belongs at
// emission time, not cleanup time). For Write, the payload is the content;
// for Edit, the spliced result of old_string → new_string on the current
// file. Parse is by target extension: .json → JSON.parse; .ts/.tsx/.js →
// Bun.Transpiler. Prose and unknown extensions pass (post-files owns them).
import { deny, type HookInput } from "../lib/hookio.ts";
import { readFileSync } from "node:fs";

const CODE_RE = /\.(tsx?|mts|cts|mjs|cjs|jsx)$/;
const JSON_RE = /\.json$/;
const MAX_BYTES = 512 * 1024;

const transpileError = (content: string, path: string): string | null => {
	try {
		const loader =
			path.endsWith(".tsx") || path.endsWith(".jsx") ? "tsx" : "ts";
		new Bun.Transpiler({ loader }).transformSync(content);
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
};

export function contentGate(hook: HookInput): void {
	const ti = hook.tool_input as Record<string, string> | undefined;
	if (!ti) return;
	const path = String(ti.file_path ?? "");
	if (!path || path.length > 1024) return;
	const isWrite = hook.tool_name === "Write";
	const isEdit = hook.tool_name === "Edit";
	if (!isWrite && !isEdit) return;
	if (!CODE_RE.test(path) && !JSON_RE.test(path)) return;

	let after: string;
	if (isWrite) {
		after = String(ti.content ?? "");
	} else {
		const oldS = String(ti.old_string ?? "");
		if (!oldS) return; // replace-all edge: post-files owns it
		let cur: string;
		try {
			cur = readFileSync(path, "utf8");
		} catch {
			return; // missing/unreadable: never block on read failure
		}
		if (cur.length > MAX_BYTES) return;
		if (cur.split(oldS).length - 1 !== 1) return; // ambiguous anchor: not a parse question
		after = cur.replace(oldS, String(ti.new_string ?? ""));
	}
	if (after.length > MAX_BYTES) return;

	if (JSON_RE.test(path)) {
		try {
			JSON.parse(after);
		} catch (e) {
			deny(
				`content-gate: ${path} would not parse as JSON after this ${hook.tool_name} — corrupted payload denied BEFORE write. ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}. Re-emit in chunks of ≤35 lines, validating each chunk.`,
			);
		}
		return;
	}
	const err = transpileError(after, path);
	if (err)
		deny(
			`content-gate: ${path} would not transpile after this ${hook.tool_name} — corrupted payload denied BEFORE write. ${err.slice(0, 300)}. Re-emit in chunks of ≤35 lines, validating each chunk.`,
		);
}
