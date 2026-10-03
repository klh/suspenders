// hooks/gates/grok.ts - the grok-cli dispatch (W296, from the W68 spec).
// `bun gate.ts grok <mode>` is the grok wiring's single entrypoint; this
// module normalizes the payload, resolves the fleet sid, binds the dialect,
// then hands the SAME gates the Claude path runs. Gates keep zero grok
// knowledge; degradation (unresolved identity, unknown tool names) is
// drift-journaled, never silent and never a block on infrastructure.
import { allow, context, setDialect } from "../../lib/hookio.ts";
import { buildDecision, normalizeGrok, resolveGrokSid, drift } from "./lib.ts";
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

const EVENT = {
	"pre-bash": "PreToolUse",
	"pre-files": "PreToolUse",
	"pre-read": "PreToolUse",
	"post-files": "PostToolUse",
	session: "SessionStart",
	"session-end": "SessionEnd",
	stop: "Stop",
} as const;
type Mode = keyof typeof EVENT;

export async function grokGate(
	modeArg: string,
	raw: Record<string, unknown>,
): Promise<never> {
	const mode = (modeArg || "") as Mode;
	if (!(mode in EVENT)) {
		drift(
			`unknown grok mode "${modeArg}" - allowing (wiring bug, visible)`,
			"",
		);
		allow();
	}
	const event = EVENT[mode];
	setDialect({ decide: (kind, _e, arg) => buildDecision(kind, event, arg) });
	const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
	const resolved = resolveGrokSid(cwd);
	// Identity posture mirrors codex (W66): grok-cli's own session_id is not
	// documented as durable fleet identity, so unresolved runs fail open. Tool
	// events may still carry the raw grok session id as laneId for uniqueness,
	// but SessionStart/SessionEnd never register governor rows under it.
	const sid =
		resolved.sid || (typeof raw.session_id === "string" ? raw.session_id : "");
	if (!resolved.sid) {
		drift(
			`identity unresolved (mode ${mode}) - laneId may carry an undocumented grok session id`,
			sid,
		);
	}

	if (mode === "session") {
		return sessionGate(sid, cwd, raw);
	}
	if (mode === "session-end") {
		return sessionEndGate(sid);
	}
	if (mode === "stop") {
		return stopGate({
			session_id: sid,
			cwd,
			stop_hook_active: raw.stop_hook_active === true,
			hook_event_name: "Stop",
		});
	}

	const tool = typeof raw.tool_name === "string" ? raw.tool_name : "";
	const norm = normalizeGrok(raw, tool, event);
	const hook = { ...norm.hook, session_id: sid };

	switch (norm.gate) {
		case "pre-bash":
			return bashGate(hook);
		case "pre-files":
			return preFilesChain(hook);
		case "pre-read":
			readGate(hook);
			return allow();
		case "post-files":
			return filesGate(hook);
		case "allow":
			drift(
				`unhandled grok tool "${tool}" during ${event} - allowing (adapter drift)`,
				sid,
			);
			return allow();
		default:
			return allow();
	}
}

async function sessionGate(
	sid: string,
	cwd: string,
	raw: Record<string, unknown>,
): Promise<never> {
	const transcript = transcriptPathFor(cwd, sid);
	if (!sid) {
		drift(
			"session start without resolvable sid - no governor.db registration",
			"",
		);
		allow();
	}
	const source =
		raw.source === "resume"
			? "resume"
			: raw.source === "clear"
				? "clear"
				: "startup";
	const out = spawnSessionStart({
		session_id: sid,
		transcript_path: transcript,
		source,
	});
	if (out) context(out, "SessionStart");
	allow();
}

async function sessionEndGate(sid: string): Promise<never> {
	if (!sid) allow();
	spawnSessionEnd(sid);
	allow();
}
