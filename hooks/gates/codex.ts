// hooks/gates/codex.ts — the codex dispatch (W73, from the W68 spec).
// `bun gate.ts codex <mode>` is the codex wiring's single entrypoint; this
// module normalizes the payload, resolves the fleet sid, binds the dialect,
// then hands the SAME gates the Claude path runs. Gates keep zero codex
// knowledge; degradation (unresolved identity, file-less patches) is
// drift-journaled, never silent and never a block on infrastructure.
import { allow, context, setDialect } from "../lib/hookio.ts";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	buildDecision,
	normalizeCodex,
	resolveCodexSid,
	drift,
} from "../lib/codex.ts";
import { lanesFileFor } from "../lib/fleetlane.ts";
import { bashGate } from "./bash.ts";
import { filesGate } from "./files.ts";
import { preFilesChain } from "./chain.ts";
import { stopGate } from "./stop.ts";

// wiring-time event per mode (spec: dialect bound by argv, not sniffed)
const EVENT = {
	"pre-tool": "PreToolUse",
	"post-tool": "PostToolUse",
	session: "SessionStart",
	"session-end": "SessionEnd",
	stop: "Stop",
} as const;
type Mode = keyof typeof EVENT;

// Bun's spawnSync drops the `input` option — stdin rides a temp file
// (the gates.test.ts lesson, reused here and in the adapter tests).
const payloadFile = (json: string): string => {
	const f = `${tmpdir()}/gate-codex-payload-${process.pid}-${Date.now()}.json`;
	writeFileSync(f, json);
	return f;
};

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
	const lanesFile = lanesFileFor(cwd);
	const transcript = lanesFile
		? `${lanesFile.slice(0, lanesFile.lastIndexOf("/"))}/lane-${sid}.log`
		: "";
	if (!sid) {
		drift(
			"session start without resolvable sid — no governor.db registration",
			"",
		);
		allow();
	}
	const pf = payloadFile(
		JSON.stringify({
			session_id: sid,
			transcript_path: transcript,
			source: "startup",
		}),
	);
	const proc = Bun.spawnSync(
		[process.execPath, `${import.meta.dir}/../session-start.ts`],
		{
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	rmSync(pf, { force: true });
	const out = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
	if (out) context(out, "SessionStart");
	allow();
}

// session-end: codex HAS the event (binary-verified) — parity accounting.
async function sessionEndGate(sid: string): Promise<never> {
	if (!sid) allow();
	const pf = payloadFile(JSON.stringify({ session_id: sid }));
	Bun.spawnSync([process.execPath, `${import.meta.dir}/../session-end.ts`], {
		stdin: Bun.file(pf),
		stdout: "ignore",
		stderr: "ignore",
	});
	rmSync(pf, { force: true });
	allow();
}
