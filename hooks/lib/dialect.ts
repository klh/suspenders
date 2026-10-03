// hooks/lib/dialect.ts — the ONE contract every non-Claude CLI adapter
// implements (W296, generalized from the W73 codex adapter once copilot
// needed the identical seam). Claude Code needs no dialect at all — gates
// ARE its native wire format. Every OTHER harness is "translate the raw CLI
// payload IN, translate the gate's control decision OUT," nothing more:
//
//   CLI-native payload → normalizeSession/normalizeToolEvent (IN)
//                              ↓
//        CORE: gate.ts dispatch → gates/*.ts (bash/files/governor/stop) →
//              session-bridge.ts (session-start.ts/session-end.ts)
//        — dialect-agnostic, never touched when a CLI #4 is added —
//                              ↓
//              resolveSid + buildDecision (OUT)
//                              ↓
//                  CLI-native hook response
//
// A new CLI (pi, hermes, grok, vscode, …) is a new hooks/lib/<cli>.ts that
// implements CliDialect, a ~20-line hooks/gates/<cli>.ts dispatcher that
// wires it into gate.ts the way codex/copilot do, and a
// hooks/bin/gate-wire-<cli>.ts that merges hook registrations into that
// CLI's own config file. The core (gate.ts, gates/bash.ts, gates/files.ts,
// gates/governor.ts, gates/stop.ts, lib/session-bridge.ts, govdb.ts) never
// changes. test/dialect-conformance.ts runs the SAME mechanical suite
// against every dialect implementation — one test harness, N adapters.
import type { HookInput } from "./hookio.ts";

export type SidResolution = { sid: string; source: string };

export type DialectKind =
	| "allow"
	| "deny"
	| "ask"
	| "nudge"
	| "context"
	| "feedback";

export type DialectDecisionOut = {
	stdout?: string;
	stderr?: string;
	exit: number;
};

export type NormalizedSession = {
	sessionId: string;
	cwd: string;
	source: "startup" | "resume" | "new";
};

// The full tool-event surface a dialect can be asked to normalize. Modes
// mirror gate.ts's own event vocabulary (pre-bash/pre-files/pre-read/
// post-files/stop) so a dialect's wiring can matcher-route per tool name —
// exactly like Claude's own settings.example.json does — instead of
// content-sniffing at normalize time (the W73 codex fallback, kept there
// for codex's own reasons, not inherited by new dialects by default).
export type ToolMode =
	| "pre-bash"
	| "pre-files"
	| "pre-read"
	| "post-files"
	| "stop";

export interface CliDialect {
	readonly name: string;
	// resolveSid: fleet identity first (every dialect shares this policy via
	// lib/fleetlane.ts), then a dialect-specific fallback — codex fails
	// "unresolved" (its session_id is a THREAD id, not a stable identity;
	// W66), copilot and any future stable-session-id CLI fall back to its
	// own session id so an interactive session is NEVER left unregistered.
	resolveSid(cwd: string, ownSessionId: string): SidResolution;
	normalizeSession(raw: unknown): NormalizedSession;
	normalizeSessionEnd(raw: unknown): string; // -> sessionId, "" if absent
	normalizeToolEvent(raw: unknown, mode: ToolMode): HookInput;
	buildDecision(
		kind: DialectKind,
		event: string,
		arg: string,
	): DialectDecisionOut;
}
