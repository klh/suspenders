// hooks/lib/copilot-schemas.ts — Zod v4 schemas for every Copilot CLI hook
// payload this adapter consumes (W296). One source of truth for the wire
// shape: gates/copilot.ts never hand-parses `raw as SomeType` — it
// `safeParse`s through these, so a payload-shape drift in a future Copilot
// CLI release fails LOUD (a parse error, drift-journaled) instead of
// silently producing a malformed governor.db row.
//
// Dialect note: the wiring (bin/gate-wire-copilot.ts) always registers the
// PascalCase/"VS Code compatible" event names (snake_case fields, and —
// critically — `tool_name` already remapped to Claude's tool vocabulary:
// Bash, Edit, Write, Read, Grep, Glob, WebFetch, WebSearch, AskUserQuestion,
// TodoWrite, Agent — per docs.github.com/en/copilot/reference/hooks-
// reference, 2026-10-03). These schemas model ONLY that dialect; the
// camelCase dialect is intentionally never wired (one dialect, one schema,
// no runtime branching on event-name casing).
import { z } from "zod";

// ---- shared fragments ----

const sessionIdField = z.string().min(1);

// ---- sessionStart / SessionStart ----

export const CopilotSessionStartSchema = z.object({
	hook_event_name: z.literal("SessionStart").optional(),
	session_id: sessionIdField,
	timestamp: z.union([z.string(), z.number()]).optional(),
	cwd: z.string().optional(),
	source: z.enum(["startup", "resume", "new"]).optional(),
	initial_prompt: z.string().optional(),
});
export type CopilotSessionStart = z.infer<typeof CopilotSessionStartSchema>;

// ---- sessionEnd / SessionEnd ----

export const CopilotSessionEndSchema = z.object({
	hook_event_name: z.literal("SessionEnd").optional(),
	session_id: sessionIdField,
	timestamp: z.union([z.string(), z.number()]).optional(),
	cwd: z.string().optional(),
	reason: z
		.enum(["complete", "error", "abort", "timeout", "user_exit"])
		.optional(),
});
export type CopilotSessionEnd = z.infer<typeof CopilotSessionEndSchema>;

// ---- preToolUse / PreToolUse ----
// tool_input is deliberately `z.unknown()` here — its shape depends on
// tool_name (bash vs. edit vs. create vs. …) and is narrowed per-tool in
// lib/copilot.ts's normalizeCopilotToolInput, not at the envelope level.
export const CopilotPreToolUseSchema = z.object({
	hook_event_name: z.literal("PreToolUse").optional(),
	session_id: sessionIdField,
	timestamp: z.union([z.string(), z.number()]).optional(),
	cwd: z.string().optional(),
	tool_name: z.string(),
	tool_input: z.unknown().optional(),
});
export type CopilotPreToolUse = z.infer<typeof CopilotPreToolUseSchema>;

// ---- postToolUse / PostToolUse ----

export const CopilotToolResultSchema = z.object({
	result_type: z.string().optional(),
	text_result_for_llm: z.string().optional(),
});

export const CopilotPostToolUseSchema = z.object({
	hook_event_name: z.literal("PostToolUse").optional(),
	session_id: sessionIdField,
	timestamp: z.union([z.string(), z.number()]).optional(),
	cwd: z.string().optional(),
	tool_name: z.string(),
	tool_input: z.unknown().optional(),
	tool_result: CopilotToolResultSchema.optional(),
});
export type CopilotPostToolUse = z.infer<typeof CopilotPostToolUseSchema>;

// ---- agentStop / Stop ----

export const CopilotStopSchema = z.object({
	hook_event_name: z.literal("Stop").optional(),
	session_id: sessionIdField,
	timestamp: z.union([z.string(), z.number()]).optional(),
	cwd: z.string().optional(),
	transcript_path: z.string().optional(),
	stop_reason: z.string().optional(),
	stop_hook_active: z.boolean().optional(),
});
export type CopilotStop = z.infer<typeof CopilotStopSchema>;

// ---- per-tool tool_input shapes ----
// Best-available tier (2026-10-03): the CLI's hooks reference documents
// tool_input only as "parsed from JSON string when possible" — it does NOT
// publish the per-tool argument schema. These field-name sets are inferred
// from the Copilot CLI's own tool manifest (path/file_text for create,
// path/old_str/new_str for edit, command for bash) and are deliberately
// tolerant of the Claude-shaped alternative names (file_path/content/
// old_string/new_string) in case a future CLI version normalizes them —
// accepting either never produces a wrong gate decision, only a redundant
// field. Verify against a captured live payload before trusting this for
// anything higher-stakes than the current gates (drift.ts logs a mismatch
// note; nothing here is silently wrong).
export const CopilotBashInputSchema = z.looseObject({
	command: z.string().optional(),
	cmd: z.string().optional(),
});

export const CopilotEditInputSchema = z.looseObject({
	path: z.string().optional(),
	file_path: z.string().optional(),
	old_str: z.string().optional(),
	old_string: z.string().optional(),
	new_str: z.string().optional(),
	new_string: z.string().optional(),
	replace_all: z.boolean().optional(),
});

export const CopilotCreateInputSchema = z.looseObject({
	path: z.string().optional(),
	file_path: z.string().optional(),
	file_text: z.string().optional(),
	content: z.string().optional(),
});

export const CopilotReadInputSchema = z.looseObject({
	path: z.string().optional(),
	file_path: z.string().optional(),
});
