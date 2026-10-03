// hooks/lib/copilot.ts — the Copilot CLI dialect layer (W296, sibling to the
// W73 codex adapter — this is the module that fixes the original bug: a
// manually-started/renamed Copilot CLI session was invisible to the fleet's
// coordination bus because Copilot had zero hooks wiring into governor.db).
// Gates keep ZERO copilot knowledge: this module owns payload validation
// (Zod, lib/copilot-schemas.ts), payload normalization (normalizeCopilot*),
// identity resolution (resolveCopilotSid), and decision translation
// (buildCopilotDecision) — the same four responsibilities codex's adapter
// has, composed behind the shared `CliDialect` contract (lib/dialect.ts).
//
// Surface facts (verified against docs.github.com/en/copilot/reference/
// hooks-reference, fetched 2026-10-03 — docs-tier, not binary-verified
// against an installed Copilot CLI binary the way codex's module is; the
// per-tool tool_input FIELD NAMES below are a second, weaker tier — inferred
// from this agent's own tool-call schema, not from a captured live payload;
// normalizeCopilotToolInput is deliberately tolerant of both the inferred
// names AND the Claude-shaped alternatives so a wrong guess never produces
// an incorrect gate decision, only a redundant accepted field):
//   - Hooks load from (in order, later entries added, never replacing):
//     /etc/github-copilot/policy.d/*.json → .github/hooks/*.json (repo) →
//     ~/.copilot/hooks/*.json (user, or $COPILOT_HOME/hooks/) → inline
//     `hooks` field in settings.json → plugin-contributed hooks.
//   - Two payload dialects, selected by event-name CASING: camelCase event
//     name → camelCase fields; PascalCase event name → "VS Code compatible"
//     snake_case fields AND tool_name already remapped to Claude's own tool
//     vocabulary (bash→Bash, edit/apply_patch/str_replace_editor→Edit,
//     create→Write, view→Read, grep/rg→Grep, glob→Glob, …). This adapter
//     ONLY wires the PascalCase dialect (bin/gate-wire-copilot.ts) — one
//     dialect, one schema, no runtime branching on event-name casing.
//   - Unlike codex's session_id (a THREAD id — W66 — so codex's adapter
//     skips registration when no fleet sid resolves), Copilot's sessionId
//     is the SESSION's own stable id: a resumed session fires SessionStart
//     again with the SAME sessionId and source:"resume" (architecturally
//     like Claude's own session_id). So the identity invariant here is
//     Claude's, not codex's: an unresolved interactive session registers
//     under its OWN sessionId rather than being skipped — the entire point
//     of this adapter is making manually-started copilot sessions
//     discoverable, so "no fleet lane" must never mean "no registration."
//   - Decision wire formats are FLAT JSON, NOT wrapped in Claude's
//     `hookSpecificOutput` — see buildCopilotDecision below for the exact
//     per-event shape. PreToolUse natively supports "ask" (unlike codex,
//     which must degrade ask→deny) — Copilot's own permission-prompt UI
//     handles it, so this adapter passes "ask" straight through.
import { resolveFleetLane } from "../../lib/fleetlane.ts";
import type { HookInput } from "../../lib/hookio.ts";
import type {
	CliDialect,
	DialectDecisionOut,
	DialectKind,
	NormalizedSession,
	ToolMode,
} from "../../lib/dialect.ts";
import {
	CopilotSessionStartSchema,
	CopilotSessionEndSchema,
	CopilotBashInputSchema,
	CopilotEditInputSchema,
	CopilotCreateInputSchema,
	CopilotReadInputSchema,
} from "./schemas.ts";

// ---- fleet identity resolution ----

export type SidResolution = { sid: string; source: "env" | "lanes" | "own" };

// resolveCopilotSid: fleet identity first (env override, then lanes.json via
// pid-ancestry — the SAME resolver codex uses), falling back to the
// session's OWN id. Never returns "" — see the module note above on why
// skip-when-unresolved (codex's policy) is wrong for copilot's stable ids.
export function resolveCopilotSid(
	cwd: string,
	ownSessionId: string,
): SidResolution {
	const env = process.env.SUSPENDERS_SID;
	if (env) return { sid: env, source: "env" };
	const lane = resolveFleetLane(cwd);
	if (lane) return { sid: lane.sid, source: "lanes" };
	return { sid: ownSessionId, source: "own" };
}

// ---- session payload normalization (Zod-validated) ----

// normalizeCopilotSession: safeParse-validated — a malformed/future-shape
// payload degrades to an empty sessionId (caller drift-journals and
// fail-opens) rather than throwing and crashing the hook process.
export function normalizeCopilotSession(raw: unknown): NormalizedSession {
	const parsed = CopilotSessionStartSchema.safeParse(raw);
	if (!parsed.success)
		return { sessionId: "", cwd: process.cwd(), source: "startup" };
	const d = parsed.data;
	// copilot's "new" source has no claude-side equivalent (claude is
	// startup|resume); session-start.ts only branches on "resume", so "new"
	// rides through as "startup" — same non-resume registration path.
	const source = d.source === "resume" ? "resume" : "startup";
	return { sessionId: d.session_id, cwd: d.cwd ?? process.cwd(), source };
}

export function normalizeCopilotSessionEnd(raw: unknown): string {
	const parsed = CopilotSessionEndSchema.safeParse(raw);
	return parsed.success ? parsed.data.session_id : "";
}

// ---- tool-event normalization ----

// Claude's own tool vocabulary — PascalCase Copilot payloads already remap
// tool_name to these (per the docs), but this table also accepts copilot's
// NATIVE lowercase names defensively (undocumented edge case: a future CLI
// version or a misconfigured camelCase hook entry could leak the raw name).
const TOOL_NAME_TABLE: Record<string, "Bash" | "Edit" | "Write" | "Read"> = {
	bash: "Bash",
	powershell: "Bash",
	Bash: "Bash",
	edit: "Edit",
	apply_patch: "Edit",
	str_replace_editor: "Edit",
	Edit: "Edit",
	create: "Write",
	Write: "Write",
	view: "Read",
	Read: "Read",
};

function firstString(...vals: unknown[]): string | undefined {
	for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
	return undefined;
}

// normalizeCopilotToolInput: maps copilot's native per-tool tool_input shape
// to the HookInput.tool_input the core gates read. Tolerant of both the
// inferred copilot field names (path/file_text/old_str/new_str) and the
// Claude-shaped alternatives (file_path/content/old_string/new_string) —
// see the module header's verification-tier note.
export function normalizeCopilotToolInput(
	claudeTool: "Bash" | "Edit" | "Write" | "Read",
	rawInput: unknown,
): HookInput["tool_input"] {
	if (claudeTool === "Bash") {
		const parsed = CopilotBashInputSchema.safeParse(rawInput ?? {});
		const d = parsed.success ? parsed.data : {};
		return { command: firstString(d.command, d.cmd) ?? "" };
	}
	if (claudeTool === "Edit") {
		const parsed = CopilotEditInputSchema.safeParse(rawInput ?? {});
		const d = parsed.success ? parsed.data : {};
		return {
			file_path: firstString(d.path, d.file_path),
			old_string: firstString(d.old_str, d.old_string),
			new_string: firstString(d.new_str, d.new_string),
		};
	}
	if (claudeTool === "Write") {
		const parsed = CopilotCreateInputSchema.safeParse(rawInput ?? {});
		const d = parsed.success ? parsed.data : {};
		return {
			file_path: firstString(d.path, d.file_path),
			content: firstString(d.file_text, d.content),
		};
	}
	// Read
	const parsed = CopilotReadInputSchema.safeParse(rawInput ?? {});
	const d = parsed.success ? parsed.data : {};
	return { file_path: firstString(d.path, d.file_path) };
}

// normalizeCopilotTool: the PreToolUse/PostToolUse envelope → HookInput.
// `mode` picks the gate (bound by wiring/argv, never content-sniffed — the
// matcher-based wiring in bin/gate-wire-copilot.ts means we already KNOW
// which tool family invoked this mode).
export function normalizeCopilotTool(
	raw: Record<string, unknown>,
	mode: ToolMode,
): HookInput {
	const toolNameRaw = typeof raw.tool_name === "string" ? raw.tool_name : "";
	const claudeTool = TOOL_NAME_TABLE[toolNameRaw] ?? inferToolFromMode(mode);
	const base: HookInput = {
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		hook_event_name: mode === "post-files" ? "PostToolUse" : "PreToolUse",
		tool_name: claudeTool,
		tool_input: normalizeCopilotToolInput(claudeTool, raw.tool_input),
	};
	return base;
}

function inferToolFromMode(mode: ToolMode): "Bash" | "Edit" | "Write" | "Read" {
	if (mode === "pre-bash") return "Bash";
	if (mode === "pre-read") return "Read";
	// pre-files/post-files: Edit vs Write is disambiguated by payload shape
	// at the call site (chain.ts gates read both fields safely either way);
	// default to Edit, the more common case for an already-existing file.
	return "Edit";
}

// ---- decision builder (the output-translation table) ----
// Copilot's wire format is FLAT JSON per event — no hookSpecificOutput
// wrapper. "ask" is natively supported on PreToolUse (unlike codex).

export function buildCopilotDecision(
	kind: DialectKind,
	event: string,
	arg: string,
): DialectDecisionOut {
	switch (kind) {
		case "allow":
			return { stdout: "{}", exit: 0 };
		case "deny":
			return {
				stdout: JSON.stringify({
					permissionDecision: "deny",
					permissionDecisionReason: arg || "denied",
				}),
				exit: 0,
			};
		case "ask":
			return {
				stdout: JSON.stringify({
					permissionDecision: "ask",
					permissionDecisionReason: arg || "confirm before proceeding",
				}),
				exit: 0,
			};
		case "nudge":
			// PreToolUse additionalContext — flat, no decision field (allow + note)
			return {
				stdout: JSON.stringify({ additionalContext: arg }),
				exit: 0,
			};
		case "context":
			if (event === "PostToolUse")
				return { stdout: JSON.stringify({ additionalContext: arg }), exit: 0 };
			// SessionStart
			return { stdout: JSON.stringify({ additionalContext: arg }), exit: 0 };
		case "feedback":
			// PostToolUse/Stop non-blocking note — additionalContext, no block
			return { stdout: JSON.stringify({ additionalContext: arg }), exit: 0 };
		default:
			return { stdout: "{}", exit: 0 };
	}
}

// ---- drift journal (degradation is logged, never silent) ----
// Same registry dir as the gates (governor.ts REG). One JSONL line per gap.
export function drift(
	note: string,
	sid: string,
	regDir = `${process.env.HOME}/.cache/claude-governor`,
): void {
	try {
		using f = Bun.file(`${regDir}/copilot-drift.jsonl`).writer({
			append: true,
		});
		f.write(
			`${JSON.stringify({ ts: Date.now(), kind: "copilot-drift", sid, note })}\n`,
		);
	} catch {
		// a dead journal never blocks a lane (fail-open doctrine)
	}
}

// ---- CliDialect conformance wrapper (W296) ----
// Used by gates/copilot.ts directly (unlike codex's wrapper, which is
// test-only) — copilot's dispatch is new, so it is built straight on the
// generalized contract rather than mirroring codex's pre-contract shape.
export const copilotDialect: CliDialect = {
	name: "copilot",
	resolveSid: resolveCopilotSid,
	normalizeSession: normalizeCopilotSession,
	normalizeSessionEnd: normalizeCopilotSessionEnd,
	normalizeToolEvent: (raw, mode) =>
		normalizeCopilotTool(raw as Record<string, unknown>, mode),
	buildDecision: buildCopilotDecision,
};
