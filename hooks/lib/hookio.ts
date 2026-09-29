// hooks/lib/hookio.ts — the ONE definition of hook input/output contracts.
// Every gate imports from here; no gate builds its own JSON or exit codes.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type HookInput = {
	tool_name?: string;
	tool_input?: {
		command?: string;
		file_path?: string;
		notebook_path?: string;
		old_string?: string;
		new_string?: string;
	};
	cwd?: string;
	stop_hook_active?: boolean;
	hook_event_name?: string;
};

// Codex dialect seam (W73): gates keep ZERO codex knowledge — helpers route
// through the installed dialect when gate.ts binds one (`bun gate.ts codex
// <event>`); Claude behavior is the default (null).
export type DialectDecision = {
	stdout?: string;
	stderr?: string;
	exit: number;
};
export type HookDialect = {
	decide(kind: string, event: string, arg: string): DialectDecision;
};
let DIALECT: HookDialect | null = null;
export function setDialect(d: HookDialect): void {
	DIALECT = d;
}

function outD(d: DialectDecision): never {
	if (d.stdout !== undefined) process.stdout.write(d.stdout);
	if (d.stderr !== undefined) process.stderr.write(d.stderr);
	process.exit(d.exit);
}

// The current hook input, stashed by readHook() so the decision helpers
// (deny/audit) can see what is being decided without a signature change at
// 17 call sites. Direct-lib callers (unit tests) leave it empty — audit
// fields then degrade to "" honestly.
let HOOK: HookInput = {};

export async function readHook(): Promise<HookInput> {
	try {
		HOOK = JSON.parse(await new Response(Bun.stdin).text());
	} catch {
		HOOK = {};
	}
	return HOOK;
}

// ---- denied-call audit (W80) ----
// Every gate denial lands here: one JSONL line, fire-and-forget, in the
// global cache (same dir as govdb REG and the motd). Evidence, not a gate:
// an append failure must never break the deny path. Sensitivity: cmd
// snippets are truncated, NOT redacted — the log inherits transcript-level
// sensitivity and is a strict subset of what the transcript already records.
export function auditPath(): string {
	return `${process.env.HOME ?? ""}/.cache/claude-governor/denied-calls.jsonl`;
}

export function auditDeny(reason: string): void {
	try {
		const file = auditPath();
		mkdirSync(dirname(file), { recursive: true });
		const ti = HOOK.tool_input ?? {};
		const line = {
			at: new Date().toISOString(),
			event: process.argv[2] ?? "",
			tool: HOOK.tool_name ?? "",
			cmd: (ti.command ?? "").slice(0, 200),
			path: (ti.file_path ?? ti.notebook_path ?? "").slice(0, 300),
			cwd: process.cwd(),
			reason: reason.slice(0, 300),
		};
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		// fire-and-forget: audit failures never break the deny path
	}
}

export function allow(): never {
	if (DIALECT) outD(DIALECT.decide("allow", "", ""));
	process.stdout.write("{}");
	process.exit(0);
}
export function deny(reason: string): never {
	auditDeny(reason); // evidence before exit — codex dialect denials land here too
	if (DIALECT) outD(DIALECT.decide("deny", "", reason));
	out({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	});
}
export function ask(reason: string): never {
	if (DIALECT) outD(DIALECT.decide("ask", "", reason));
	out({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: reason,
		},
	});
}
export function nudge(message: string): never {
	if (DIALECT) outD(DIALECT.decide("nudge", "", message));
	out({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			additionalContext: message,
		},
	});
}
export function context(message: string, event = "SessionStart"): never {
	if (DIALECT) outD(DIALECT.decide("context", event, message));
	out({
		hookSpecificOutput: { hookEventName: event, additionalContext: message },
	});
}
export function feedback(message: string): never {
	// PostToolUse / Stop: exit 2 feeds stderr back to the agent (non-blocking,
	// the tool already ran) — the ONE definition of the feedback channel.
	if (DIALECT) outD(DIALECT.decide("feedback", "", message));
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function out(obj: unknown): never {
	process.stdout.write(JSON.stringify(obj));
	process.exit(0);
}
