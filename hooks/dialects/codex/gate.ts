// hooks/gates/codex.ts — the codex dispatch (W73, from the W68 spec).
// `bun gate.ts codex <mode>` is the codex wiring's single entrypoint; this
// module normalizes the payload, resolves the fleet sid, binds the dialect,
// then hands the SAME gates the Claude path runs. Gates keep zero codex
// knowledge; degradation (unresolved identity, file-less patches) is
// drift-journaled, never silent and never a block on infrastructure.
import { allow, context, setDialect } from "../../lib/hookio.ts";
import {
	buildDecision,
	normalizeCodex,
	resolveCodexSid,
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
import { stopGate } from "../../gates/stop.ts";

// wiring-time event per mode (spec: dialect bound by argv, not sniffed)
const EVENT = {
	"pre-tool": "PreToolUse",
	"post-tool": "PostToolUse",
	session: "SessionStart",
	"session-end": "SessionEnd",
	stop: "Stop",
} as const;
type Mode = keyof typeof EVENT;

export async function codexGate(
	modeArg: string,
	raw: Record<string, unknown>,
): Promise<never> {
	const mode = (modeArg || "") as Mode;
	if (!(mode in EVENT)) {
		drift(
			`unknown codex mode "${modeArg}" — allowing (wiring bug, visible)`,
			"",
		);
		allow();
	}
	const event = EVENT[mode];
	setDialect({ decide: (kind, _e, arg) => buildDecision(kind, event, arg) });
	const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
	const resolved = resolveCodexSid(cwd);
	// invariant: fleet sid on every governor row. Unresolved → fail-open with
	// the codex thread id as laneId (still unique) + a drift line — never a
	// thread-id row that LOOKS fleet-owned, never a block on infrastructure.
	const sid =
		resolved.sid || (typeof raw.session_id === "string" ? raw.session_id : "");
	if (!resolved.sid) {
		drift(
			`identity unresolved (mode ${mode}) — laneId may carry a codex thread id`,
			sid,
		);
	}

	if (mode === "session") {
		return sessionGate(sid, cwd);
	}
	if (mode === "session-end") {
		return sessionEndGate(sid);
	}

	if (mode === "pre-tool" || mode === "post-tool") {
		const norm = normalizeCodex(
			raw,
			typeof raw.tool_name === "string" ? raw.tool_name : "",
			event,
		);
		const hook = { ...norm.hook, session_id: sid };
		if (mode === "post-tool") return filesGate(hook);
		return norm.gate === "pre-bash" ? bashGate(hook) : preFilesChain(hook);
	}

	// stop: the claim-done gate over the lane worktree
	return stopGate({
		session_id: sid,
		cwd,
		stop_hook_active: raw.stop_hook_active === true,
		hook_event_name: "Stop",
	});
}

// session: the session-start.ts analog — synthesize the payload the script
// already consumes (session_id + transcript_path), spawn it, inject its
// bootstrap packet + RULES as SessionStart additionalContext. transcript_path
// is the lane log — the zombie sweep's transcript-liveness rule stays
// meaningful for non-claude transcripts (lesson.zombie-session-hygiene).
async function sessionGate(sid: string, cwd: string): Promise<never> {
	const transcript = transcriptPathFor(cwd, sid);
	if (!sid) {
		drift(
			"session start without resolvable sid — no governor.db registration",
			"",
		);
		allow();
	}
	const out = spawnSessionStart({
		session_id: sid,
		transcript_path: transcript,
		source: "startup",
	});
	if (out) context(out, "SessionStart");
	allow();
}

// session-end: codex HAS the event (binary-verified) — parity accounting.
async function sessionEndGate(sid: string): Promise<never> {
	if (!sid) allow();
	spawnSessionEnd(sid);
	allow();
}
