// hooks/lib/codex.ts — the codex dialect layer (W73, from the W68 spec).
// Gates keep ZERO codex knowledge: this module owns the two translations —
// payload in (normalizeCodex) and decision out (buildDecision) — plus fleet
// identity resolution (resolveCodexSid) and the drift journal. Dialect is
// bound at wiring time by argv (`bun gate.ts codex <event>`), never sniffed.
//
// Surface facts this layer encodes, and their tier (verified against the
// installed codex 0.158.0 on 2026-09-28; exec was permission-blocked in the
// implementing session, so "live" = installed-binary strings + the working
// user hooks.json on the implementing machine — first-tier, not docs-tier):
//   - Hook events: PreToolUse, PermissionRequest, PostToolUse, PreCompact,
//     PostCompact, SessionStart, SessionEnd, UserPromptSubmit,
//     SubagentStart, SubagentStop, Stop, Interrupt. SessionEnd EXISTS.
//   - Config: ~/.codex/hooks.json, Claude-style matcher/hooks arrays (the
//     emitter, bin/gate-wire-codex.ts, merges into it).
//   - Payload: Claude-shaped fields — session_id, transcript_path, cwd,
//     hook_event_name, permission_mode, stop_hook_active, tool_name,
//     tool_input; session_id is codex's THREAD id (W66), so the fleet sid
//     overrides it (the spec's identity invariant).
//   - Decisions: hookSpecificOutput{hookEventName, permissionDecision,
//     permissionDecisionReason, additionalContext}; "ask" is UNSUPPORTED on
//     PreToolUse (binary: "unsupported permissionDecision:ask") — the spec's
//     degradation rule: ask → deny, never silently allow.
//   - Codex edits via apply_patch, not Edit/Write — unverified payload
//     shape, so the normalizer also parses patch text; file-less edits
//     ride command-level inspection (the spec's fallback posture).
import type { HookInput } from "../../lib/hookio.ts";
import { resolveFleetLane } from "../../lib/fleetlane.ts";
import type {
	CliDialect,
	NormalizedSession,
	ToolMode,
} from "../../lib/dialect.ts";

// ---- decision builders (pure — the output-translation table) ----

export type CodexDecision = { stdout?: string; stderr?: string; exit: number };
export type CodexKind =
	| "allow"
	| "deny"
	| "ask"
	| "nudge"
	| "context"
	| "feedback";

const codexEvent = (event: string): string => {
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
	kind: CodexKind,
	event: string,
	arg: string,
): CodexDecision {
	const ev = codexEvent(event);
	switch (kind) {
		case "allow":
			return { stdout: "{}", exit: 0 };
		case "deny":
		case "ask":
			// ask degrades to deny: codex PreToolUse has no ask decision, and
			// the spec's rule is deny, never silently allow. Deny REQUIRES a
			// non-empty reason (binary: "deny without a non-empty …Reason").
			return {
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: ev,
						permissionDecision: "deny",
						permissionDecisionReason: arg || "denied by suspenders gate",
					},
				}),
				exit: 0,
			};
		case "nudge":
		case "context":
			// additionalContext is the same wire key codex reads (binary struct
			// fields + the working user hook that emits it).
			return {
				stdout: JSON.stringify({
					hookSpecificOutput: { hookEventName: ev, additionalContext: arg },
				}),
				exit: 0,
			};
		case "feedback":
			// harness-cloned exit-code semantics: exit 2 + stderr feeds back
			// (Claude parity — the ONE definition of the feedback channel).
			return { stderr: arg, exit: 2 };
	}
}

// ---- payload normalization (codex → HookInput) ----

// Edit-style tool names (docs-tier) — only these (or a patch body) route to
// the pre-files chain; every other tool rides command-level inspection, so a
// renamed/unknown tool never silently skips a gate.
const EDIT_TOOLS = new Set([
	"apply_patch",
	"edit",
	"write",
	"str_replace",
	"multiedit",
	"notebookedit",
]);

export type Normalized = {
	hook: HookInput;
	gate: "pre-bash" | "pre-files";
	provenance: string; // the codex tool name the payload actually carried
};

// normalizeCodex maps a raw codex PreToolUse/PostToolUse payload to the
// HookInput the gates consume. Edit-style tools lift the FIRST file of an
// apply_patch body (the chain gates key leases on file_path); anything else
// rides as Bash command-level inspection.
export function normalizeCodex(
	raw: Record<string, unknown>,
	codexTool: "apply_patch" | (string & {}),
	fallbackEvent: string,
): Normalized {
	const ti = (raw.tool_input ?? {}) as Record<string, unknown>;
	const base: HookInput = {
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		hook_event_name: codexEvent(
			typeof raw.hook_event_name === "string"
				? raw.hook_event_name
				: fallbackEvent,
		),
	};
	if (typeof raw.stop_hook_active === "boolean")
		base.stop_hook_active = raw.stop_hook_active;

	const tool = codexTool.toLowerCase();
	const cmd = [ti.command, ti.cmd].find(
		(v): v is string => typeof v === "string",
	);

	// edit-style only when the tool name says so OR a patch body is present;
	// everything else is command-level inspection.
	const blob = [ti.patch, ti.input, ti.diff, cmd].find(
		(v): v is string => typeof v === "string" && v.includes("*** Begin Patch"),
	);
	if (EDIT_TOOLS.has(tool) || blob !== undefined) {
		const file = blob
			?.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1]
			?.trim();
		if (file) {
			const olds =
				[...(blob ?? "").matchAll(/^-([^\n].*)$/gm)]
					.map((l) => l[1])
					.join("\n") || undefined;
			const news =
				[...(blob ?? "").matchAll(/^\+([^\n].*)$/gm)]
					.map((l) => l[1])
					.join("\n") || undefined;
			return {
				hook: {
					...base,
					tool_name: "Edit",
					tool_input: { file_path: file, old_string: olds, new_string: news },
				},
				gate: "pre-files",
				provenance: codexTool,
			};
		}
		// patch-shaped but file-less: not silently allowed — falls through to
		// command-style so bash.ts inspects the raw body as a command.
	}

	// command-style: any string command field rides as Bash — the secret /
	// lease / push-guard teeth all inspect tool_input.command.
	return {
		hook: {
			...base,
			tool_name: "Bash",
			tool_input: { command: cmd ?? blob ?? "" },
		},
		gate: "pre-bash",
		provenance: codexTool,
	};
}

// ---- fleet identity resolution (the correctness invariant) ----

export type SidResolution = {
	sid: string;
	source: "env" | "lanes" | "unresolved";
};

// resolveCodexSid resolves the FLEET sid (autow<n>) for a codex hook run.
// Every governor.db row written through the adapter must use the fleet sid —
// a thread-id-derived laneId would split lease ownership from work ownership
// (the spec's identity invariant). Order: SUSPENDERS_SID env (dispatch sets
// it) → ppid-walk into lanes.json (lib/fleetlane.ts) → unresolved (the
// caller fail-opens and drift-journals; never a silent thread-id row).
export function resolveCodexSid(cwd: string): SidResolution {
	const env = process.env.SUSPENDERS_SID;
	if (env) return { sid: env, source: "env" };
	const lane = resolveFleetLane(cwd);
	if (lane) return { sid: lane.sid, source: "lanes" };
	return { sid: "", source: "unresolved" };
}

// ---- drift journal (degradation is logged, never silent) ----

// Same registry dir as the gates (governor.ts REG). One JSONL line per gap —
// visible on the machine, one `tail` from the gate registry dir.
export function drift(
	note: string,
	sid: string,
	regDir = `${process.env.HOME}/.cache/claude-governor`,
): void {
	try {
		using f = Bun.file(`${regDir}/codex-drift.jsonl`).writer({ append: true });
		f.write(
			`${JSON.stringify({ ts: Date.now(), kind: "codex-drift", sid, note })}\n`,
		);
	} catch {
		// a dead journal never blocks a lane (fail-open doctrine)
	}
}

// ---- CliDialect conformance wrapper (W296) ----
// gates/codex.ts does NOT use this object — its production dispatch calls
// the functions above directly, unchanged, to keep the binary-verified
// codex behavior byte-for-byte stable. This wrapper exists ONLY so
// test/dialect-conformance.ts can run the same mechanical suite against
// codex and copilot: one generic harness, every dialect proven to the same
// bar, without forcing codex's already-shipped dispatch through a new
// indirection layer it doesn't need.
const toolModeEvent: Record<ToolMode, string> = {
	"pre-bash": "PreToolUse",
	"pre-files": "PreToolUse",
	"pre-read": "PreToolUse",
	"post-files": "PostToolUse",
	stop: "Stop",
};

export const codexDialect: CliDialect = {
	name: "codex",
	resolveSid: (cwd: string) => resolveCodexSid(cwd),
	normalizeSession: (raw: unknown): NormalizedSession => {
		const r = (raw ?? {}) as Record<string, unknown>;
		return {
			sessionId: typeof r.session_id === "string" ? r.session_id : "",
			cwd: typeof r.cwd === "string" ? r.cwd : "",
			source: "startup",
		};
	},
	normalizeSessionEnd: (raw: unknown): string => {
		const r = (raw ?? {}) as Record<string, unknown>;
		return typeof r.session_id === "string" ? r.session_id : "";
	},
	normalizeToolEvent: (raw: unknown, mode: ToolMode): HookInput => {
		const r = raw as Record<string, unknown>;
		return normalizeCodex(
			r,
			typeof r.tool_name === "string" ? r.tool_name : "",
			toolModeEvent[mode],
		).hook;
	},
	buildDecision,
};
