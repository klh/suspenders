// hooks/lib/grok.ts - the grok-cli dialect layer (W296, from the W68 spec).
// Gates keep ZERO grok knowledge: this module owns the two translations -
// payload in (normalizeGrok) and decision out (buildDecision) - plus fleet
// identity resolution (resolveGrokSid) and the drift journal. Dialect is
// bound at wiring time by argv (`bun gate.ts grok <event>`), never sniffed.
//
// Surface facts this layer encodes, and their tier (first-tier,
// binary-verified against grok-cli main in 2026 by source read, not docs):
//   - Hook config: ~/.grok/user-settings.json, top-level hooks map with the
//     same matcher/hooks array shape Claude uses.
//   - Hook events used here: PreToolUse, PostToolUse, SessionStart,
//     SessionEnd, Stop.
//   - Payload: stdin JSON with hook_event_name, optional session_id, cwd,
//     and tool_name/tool_input for tool events.
//   - Decisions: flat JSON ({ decision, reason, additionalContext,
//     stopReason, continue }) plus exit code 0 or 2. There is NO ask mode:
//     ask degrades to block, never silently allow.
//   - Tools: bash, read_file, write_file, edit_file. Other grok-native
//     tools stay out of scope and fail open with a drift line.
//   - Identity: grok-cli does not document session_id as a durable fleet
//     identity, so this adapter follows the codex W66 precedent: resolve the
//     fleet sid first and never register governor.db rows under a raw grok
//     session id when the fleet identity is unresolved.
import type { HookInput } from "../../lib/hookio.ts";
import { resolveFleetLane } from "../../lib/fleetlane.ts";
import type {
	CliDialect,
	NormalizedSession,
	ToolMode,
} from "../../lib/dialect.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type GrokDecision = { stdout?: string; stderr?: string; exit: number };
export type GrokKind =
	| "allow"
	| "deny"
	| "ask"
	| "nudge"
	| "context"
	| "feedback";

const grokEvent = (event: string): string => {
	const m = event.toLowerCase().replaceAll("_", "");
	const table: Record<string, string> = {
		pretooluse: "PreToolUse",
		posttooluse: "PostToolUse",
		sessionstart: "SessionStart",
		sessionend: "SessionEnd",
		stop: "Stop",
	};
	return table[m] ?? "PreToolUse";
};

export function buildDecision(
	kind: GrokKind,
	event: string,
	arg: string,
): GrokDecision {
	const ev = grokEvent(event);
	switch (kind) {
		case "allow":
			return { stdout: "{}", exit: 0 };
		case "deny":
		case "ask": {
			if (kind === "ask") {
				drift("ask decision unsupported by grok-cli - degrading to block", "");
			}
			const reason = arg || "denied by suspenders gate";
			return {
				stdout: JSON.stringify({
					decision: "block",
					reason,
					stopReason: reason,
				}),
				exit: 2,
			};
		}
		case "nudge":
		case "context":
			return {
				stdout: JSON.stringify({ additionalContext: arg }),
				exit: 0,
			};
		case "feedback": {
			if (ev === "Stop") {
				const reason = arg || "stopped by suspenders gate";
				return {
					stdout: JSON.stringify({
						decision: "block",
						reason,
						stopReason: reason,
					}),
					exit: 2,
				};
			}
			return {
				stdout: JSON.stringify({ additionalContext: arg }),
				exit: 0,
			};
		}
	}
}

const readBound = (
	startLine: unknown,
	endLine: unknown,
): number | undefined => {
	const start = typeof startLine === "number" ? startLine : null;
	const end = typeof endLine === "number" ? endLine : null;
	if (start !== null && end !== null && end >= start) return end - start + 1;
	if (start !== null || end !== null) return 1;
	return undefined;
};

export type Normalized = {
	hook: HookInput;
	gate: "pre-bash" | "pre-files" | "pre-read" | "post-files" | "allow";
	provenance: string;
};

export function normalizeGrok(
	raw: Record<string, unknown>,
	grokTool: string,
	fallbackEvent: string,
): Normalized {
	const ti = (raw.tool_input ?? {}) as Record<string, unknown>;
	const base: HookInput = {
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		hook_event_name: grokEvent(
			typeof raw.hook_event_name === "string"
				? raw.hook_event_name
				: fallbackEvent,
		),
	};
	if (typeof raw.stop_hook_active === "boolean") {
		base.stop_hook_active = raw.stop_hook_active;
	}

	const tool = grokTool.toLowerCase();
	const path = typeof ti.path === "string" ? ti.path : "";
	const isPost = base.hook_event_name === "PostToolUse";

	if (tool === "bash") {
		return {
			hook: {
				...base,
				tool_name: "Bash",
				tool_input: {
					command: typeof ti.command === "string" ? ti.command : "",
				},
			},
			gate: "pre-bash",
			provenance: grokTool,
		};
	}

	if (tool === "edit_file") {
		return {
			hook: {
				...base,
				tool_name: "Edit",
				tool_input: {
					file_path: path,
					old_string:
						typeof ti.old_string === "string" ? ti.old_string : undefined,
					new_string:
						typeof ti.new_string === "string" ? ti.new_string : undefined,
				},
			},
			gate: isPost ? "post-files" : "pre-files",
			provenance: grokTool,
		};
	}

	if (tool === "write_file") {
		const toolInput: HookInput["tool_input"] & Record<string, unknown> = {
			file_path: path,
		};
		if (typeof ti.content === "string") toolInput.content = ti.content;
		return {
			hook: {
				...base,
				tool_name: "Write",
				tool_input: toolInput,
			},
			gate: isPost ? "post-files" : "pre-files",
			provenance: grokTool,
		};
	}

	if (tool === "read_file") {
		const toolInput: HookInput["tool_input"] & Record<string, unknown> = {
			file_path: path,
		};
		const limit = readBound(ti.startLine, ti.endLine);
		if (limit !== undefined) toolInput.limit = limit;
		if (typeof ti.startLine === "number") toolInput.startLine = ti.startLine;
		if (typeof ti.endLine === "number") toolInput.endLine = ti.endLine;
		return {
			hook: {
				...base,
				tool_name: "Read",
				tool_input: toolInput,
			},
			gate: "pre-read",
			provenance: grokTool,
		};
	}

	return {
		hook: base,
		gate: "allow",
		provenance: grokTool,
	};
}

export type SidResolution = {
	sid: string;
	source: "env" | "lanes" | "unresolved";
};

export function resolveGrokSid(cwd: string): SidResolution {
	const env = process.env.SUSPENDERS_SID;
	if (env) return { sid: env, source: "env" };
	const lane = resolveFleetLane(cwd);
	if (lane) return { sid: lane.sid, source: "lanes" };
	return { sid: "", source: "unresolved" };
}

export function drift(
	note: string,
	sid: string,
	regDir = `${process.env.HOME}/.cache/claude-governor`,
): void {
	try {
		const file = `${regDir}/grok-drift.jsonl`;
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(
			file,
			`${JSON.stringify({ ts: Date.now(), kind: "grok-drift", sid, note })}\n`,
		);
	} catch {
		// a dead journal never blocks a lane (fail-open doctrine)
	}
}

const toolModeEvent: Record<ToolMode, string> = {
	"pre-bash": "PreToolUse",
	"pre-files": "PreToolUse",
	"pre-read": "PreToolUse",
	"post-files": "PostToolUse",
	stop: "Stop",
};

export const grokDialect: CliDialect = {
	name: "grok",
	resolveSid: (cwd: string, _ownSessionId: string) => resolveGrokSid(cwd),
	normalizeSession: (raw: unknown): NormalizedSession => {
		const r = (raw ?? {}) as Record<string, unknown>;
		return {
			sessionId: typeof r.session_id === "string" ? r.session_id : "",
			cwd: typeof r.cwd === "string" ? r.cwd : "",
			source:
				r.source === "resume"
					? "resume"
					: r.source === "clear"
						? "new"
						: "startup",
		};
	},
	normalizeSessionEnd: (raw: unknown): string => {
		const r = (raw ?? {}) as Record<string, unknown>;
		return typeof r.session_id === "string" ? r.session_id : "";
	},
	normalizeToolEvent: (raw: unknown, mode: ToolMode): HookInput => {
		const r = (raw ?? {}) as Record<string, unknown>;
		if (mode === "stop") {
			return {
				cwd: typeof r.cwd === "string" ? r.cwd : "",
				stop_hook_active: r.stop_hook_active === true,
				hook_event_name: "Stop",
			};
		}
		return normalizeGrok(
			r,
			typeof r.tool_name === "string" ? r.tool_name : "",
			toolModeEvent[mode],
		).hook;
	},
	buildDecision,
};
