// hooks/gates/copilot.ts — the Copilot CLI dispatch (W296). `bun gate.ts
// copilot <mode>` is the copilot wiring's single entrypoint; this module
// validates+normalizes the payload, resolves the fleet sid, binds the
// dialect, then hands the SAME gates the Claude path runs. Gates keep zero
// copilot knowledge; degradation (unresolved identity beyond the own-id
// fallback) is drift-journaled, never silent and never a block on
// infrastructure.
//
// Unlike codex's single pre-tool/post-tool pair (content-sniffed per call),
// copilot's wiring (bin/gate-wire-copilot.ts) registers PER-TOOL matcher
// entries — exactly like Claude's own settings.example.json — so the MODE
// already tells us which gate family to run; normalizeCopilotTool never
// needs to sniff tool_input content to pick a gate.
import { allow, context, setDialect } from "../../lib/hookio.ts";
import {
	copilotDialect,
	resolveCopilotSid,
	normalizeCopilotSession,
	normalizeCopilotSessionEnd,
	normalizeCopilotTool,
	buildCopilotDecision,
	drift,
} from "./lib.ts";
import {
	transcriptPathFor,
	spawnSessionStart,
	spawnSessionEnd,
} from "../../lib/session-bridge.ts";
import { bashGate } from "../../gates/bash.ts";
import { filesGate } from "../../gates/files.ts";
import { preFilesChain } from "../../gates/chain.ts";
import { readGate } from "../../gates/read.ts";
import { stopGate } from "../../gates/stop.ts";
import type { ToolMode } from "../../lib/dialect.ts";

// wiring-time event per mode (dialect bound by argv, not sniffed)
const EVENT: Record<Mode, string> = {
	"pre-bash": "PreToolUse",
	"pre-files": "PreToolUse",
	"pre-read": "PreToolUse",
	"post-files": "PostToolUse",
	session: "SessionStart",
	"session-end": "SessionEnd",
	stop: "Stop",
};
type Mode =
	| "pre-bash"
	| "pre-files"
	| "pre-read"
	| "post-files"
	| "session"
	| "session-end"
	| "stop";

export async function copilotGate(
	modeArg: string,
	raw: Record<string, unknown>,
): Promise<never> {
	const mode = (modeArg || "") as Mode;
	if (!(mode in EVENT)) {
		drift(
			`unknown copilot mode "${modeArg}" — allowing (wiring bug, visible)`,
			"",
		);
		allow();
	}
	const event = EVENT[mode];
	setDialect({
		decide: (kind, _e, arg) => buildCopilotDecision(kind, event, arg),
	});

	const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
	const ownSessionId = typeof raw.session_id === "string" ? raw.session_id : "";
	const resolved = resolveCopilotSid(cwd, ownSessionId);
	const sid = resolved.sid;
	if (resolved.source === "own" && !ownSessionId) {
		// no fleet lane AND no copilot session id at all — genuinely nothing
		// to register under; journal it, never crash, never a fake identity.
		drift("identity unresolved — no fleet lane and no copilot session_id", "");
	}

	if (mode === "session") return sessionGate(raw, sid, cwd);
	if (mode === "session-end") return sessionEndGate(raw, sid);

	if (
		mode === "pre-bash" ||
		mode === "pre-files" ||
		mode === "pre-read" ||
		mode === "post-files"
	) {
		const hook = {
			...normalizeCopilotTool(raw, mode as ToolMode),
			session_id: sid,
		};
		if (mode === "pre-bash") return bashGate(hook);
		if (mode === "pre-read") {
			readGate(hook);
			allow();
		}
		if (mode === "post-files") return filesGate(hook);
		return preFilesChain(hook); // pre-files
	}

	// stop: the claim-done gate over the lane worktree
	return stopGate({
		session_id: sid,
		cwd,
		stop_hook_active: raw.stop_hook_active === true,
		hook_event_name: "Stop",
	} as Parameters<typeof stopGate>[0]);
}

// session: the session-start.ts analog — synthesize the payload the script
// already consumes (session_id + transcript_path), spawn it, inject its
// bootstrap packet + RULES as SessionStart additionalContext.
async function sessionGate(
	raw: Record<string, unknown>,
	sid: string,
	cwd: string,
): Promise<never> {
	const norm = normalizeCopilotSession(raw);
	const transcript = transcriptPathFor(cwd, sid);
	if (!sid) {
		drift(
			"session start without ANY resolvable id — no governor.db registration",
			"",
		);
		allow();
	}
	const out = spawnSessionStart({
		session_id: sid,
		transcript_path: transcript,
		source: norm.source === "resume" ? "resume" : "startup",
	});
	if (out) context(out, "SessionStart");
	allow();
}

async function sessionEndGate(
	raw: Record<string, unknown>,
	sid: string,
): Promise<never> {
	// prefer the validated payload id when the resolver fell through, but the
	// resolved fleet/own sid always wins when present (identity invariant).
	const payloadSid = normalizeCopilotSessionEnd(raw);
	const effective = sid || payloadSid;
	if (!effective) allow();
	spawnSessionEnd(effective);
	allow();
}

// re-exported for the generic dialect-conformance suite (test/
// dialect-conformance.ts) without pulling in the gate dispatch machinery.
export { copilotDialect };
