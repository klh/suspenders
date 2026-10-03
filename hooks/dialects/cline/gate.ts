import { allow, context, setDialect } from "../../lib/hookio.ts";
import {
	buildDecision,
	normalizeCline,
	normalizeClineSession,
	resolveClineSid,
	drift,
} from "./lib.ts";
import {
	transcriptPathFor,
	spawnSessionEnd,
	spawnSessionStart,
} from "../../lib/session-bridge.ts";
import { bashGate } from "../../gates/bash.ts";
import { preFilesChain } from "../../gates/chain.ts";
import { filesGate } from "../../gates/files.ts";
import { readGate } from "../../gates/read.ts";

type Mode =
	| "pre-tool"
	| "post-tool"
	| "task-start"
	| "task-resume"
	| "session-shutdown";

export async function clineGate(
	modeArg: string,
	raw: Record<string, unknown>,
): Promise<never> {
	const mode = modeArg as Mode;
	setDialect({
		decide: (kind, _event, arg) =>
			buildDecision(kind as Parameters<typeof buildDecision>[0], modeArg, arg),
	});
	if (mode === "task-start" || mode === "task-resume") {
		return sessionGate(raw, mode === "task-resume" ? "resume" : "startup");
	}
	if (mode === "session-shutdown") {
		return sessionEndGate(raw);
	}
	if (mode !== "pre-tool" && mode !== "post-tool") {
		drift(`unknown cline mode "${modeArg}" - allowing`, "");
		allow();
	}

	const norm = normalizeCline(raw, mode);
	const cwd = norm.hook.cwd ?? process.cwd();
	const resolved = resolveClineSid(cwd, raw);
	if (!resolved.sid) {
		drift(
			`identity unresolved for ${mode} - allowing without session binding`,
			"",
		);
	}
	const hook = { ...norm.hook, session_id: resolved.sid };

	if (mode === "post-tool") {
		if (norm.hook.tool_name === "Edit" || norm.hook.tool_name === "Write") {
			return filesGate(hook);
		}
		allow();
	}

	if (norm.gate === "pre-bash") return bashGate(hook);
	if (norm.gate === "pre-read") {
		readGate(hook);
		allow();
	}
	if (norm.gate === "pre-files") return preFilesChain(hook);
	allow();
}

function sessionGate(
	raw: Record<string, unknown>,
	source: "startup" | "resume",
): never {
	const norm = normalizeClineSession(raw, source);
	const resolved = resolveClineSid(norm.cwd, raw);
	const sid = resolved.sid || norm.sessionId;
	if (!sid) {
		drift(`session start without a resolvable sid (${source})`, "");
		allow();
	}
	const out = spawnSessionStart({
		session_id: sid,
		transcript_path: transcriptPathFor(norm.cwd, sid),
		source: norm.source,
	});
	if (out) context(out, "SessionStart");
	allow();
}

function sessionEndGate(raw: Record<string, unknown>): never {
	const cwd = normalizeClineSession(raw, "startup").cwd;
	const resolved = resolveClineSid(cwd, raw);
	if (resolved.sid) spawnSessionEnd(resolved.sid);
	allow();
}
