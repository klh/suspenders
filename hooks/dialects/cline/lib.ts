import { resolveFleetLane } from "../../lib/fleetlane.ts";
import type { HookInput } from "../../lib/hookio.ts";

export type ClineDecision = { stdout?: string; stderr?: string; exit: number };
export type ClineKind =
	| "allow"
	| "deny"
	| "ask"
	| "nudge"
	| "context"
	| "feedback";

const BASH_TOOLS = new Set(["run_commands", "terminal", "bash"]);
const READ_TOOLS = new Set(["read_files", "read_file", "view"]);
const EDIT_TOOLS = new Set([
	"editor",
	"replace_in_file",
	"write_to_file",
	"apply_patch",
	"str_replace_editor",
	"write",
	"create",
]);

export type Normalized = {
	hook: HookInput;
	gate: "pre-bash" | "pre-files" | "pre-read" | "skip";
	provenance: string;
};

export type SidResolution = { sid: string; source: "env" | "lanes" | "own" };

const firstString = (...vals: unknown[]): string | undefined => {
	for (const v of vals) {
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
};

const maybeJson = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
};

const clineEvent = (mode: string): string => {
	const key = mode.toLowerCase();
	if (key === "post-tool") return "PostToolUse";
	if (key === "session-shutdown") return "SessionEnd";
	return "PreToolUse";
};

export function buildDecision(
	kind: ClineKind,
	_event: string,
	arg: string,
): ClineDecision {
	switch (kind) {
		case "allow":
			return { stdout: "{}", exit: 0 };
		case "deny":
			return {
				stdout: JSON.stringify({
					cancel: true,
					errorMessage: arg || "blocked by suspenders gate",
				}),
				exit: 0,
			};
		case "ask":
			return {
				stdout: JSON.stringify({
					review: true,
					contextModification: arg || "review required before proceeding",
				}),
				exit: 0,
			};
		case "nudge":
		case "context":
			return {
				stdout: JSON.stringify({ contextModification: arg }),
				exit: 0,
			};
		case "feedback":
			return {
				stdout: JSON.stringify({
					cancel: true,
					errorMessage: arg || "post-tool validation failed",
				}),
				exit: 0,
			};
	}
}

function toolName(raw: Record<string, unknown>): string {
	return (
		firstString(
			raw.tool_name,
			(raw.tool_call as Record<string, unknown> | undefined)?.name,
			(raw.preToolUse as Record<string, unknown> | undefined)?.toolName,
			(raw.postToolUse as Record<string, unknown> | undefined)?.toolName,
		) ?? ""
	).toLowerCase();
}

function toolInput(raw: Record<string, unknown>): unknown {
	return maybeJson(
		(raw.tool_call as Record<string, unknown> | undefined)?.input ??
			(raw.preToolUse as Record<string, unknown> | undefined)?.parameters ??
			(raw.postToolUse as Record<string, unknown> | undefined)?.parameters ??
			{},
	);
}

function workspaceRoot(raw: Record<string, unknown>): string {
	const roots = raw.workspaceRoots;
	if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) {
		return roots[0];
	}
	return typeof raw.cwd === "string" && raw.cwd ? raw.cwd : process.cwd();
}

function ownSessionId(raw: Record<string, unknown>): string {
	const taskId = typeof raw.taskId === "string" ? raw.taskId : "";
	const agentId = typeof raw.agent_id === "string" ? raw.agent_id : "";
	const parent = raw.parent_agent_id;
	return taskId && parent !== null && parent !== undefined && agentId
		? `${taskId}#${agentId}`
		: taskId;
}

function commandText(input: unknown): string {
	if (typeof input === "string") return input;
	if (Array.isArray(input)) {
		return input.map(commandText).filter(Boolean).join("; ");
	}
	if (!input || typeof input !== "object") return "";
	const record = input as Record<string, unknown>;
	if (Array.isArray(record.commands)) {
		return record.commands.map(commandText).filter(Boolean).join("; ");
	}
	const command = firstString(record.command, record.cmd);
	const args = Array.isArray(record.args)
		? record.args
				.map((v) => (typeof v === "string" ? v : String(v ?? "")))
				.filter(Boolean)
		: [];
	if (!command) return "";
	return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function firstPathFromList(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	for (const item of value) {
		const parsed = maybeJson(item);
		if (typeof parsed === "string" && parsed.length > 0) return parsed;
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			const hit = firstString(record.path, record.file_path, record.filePath);
			if (hit) return hit;
		}
	}
	return undefined;
}

function parsePatch(blob: string): {
	file?: string;
	oldText?: string;
	newText?: string;
} {
	const file = blob
		.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1]
		?.trim();
	if (!file) return {};
	const oldText = [...blob.matchAll(/^-([^\n].*)$/gm)]
		.map((m) => m[1])
		.join("\n");
	const newText = [...blob.matchAll(/^\+([^\n].*)$/gm)]
		.map((m) => m[1])
		.join("\n");
	return {
		file,
		oldText: oldText || undefined,
		newText: newText || undefined,
	};
}

function normalizeRead(input: unknown): HookInput["tool_input"] {
	const record = (
		input && typeof input === "object" ? (input as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const filePath =
		firstString(record.path, record.file_path, record.filePath) ??
		firstPathFromList(record.files) ??
		firstPathFromList(record.file_paths) ??
		firstPathFromList(record.paths);
	const limit =
		record.limit ??
		record.end_line ??
		(Array.isArray(record.line_range) ? record.line_range[1] : undefined);
	return { file_path: filePath, limit };
}

function normalizeEdit(
	input: unknown,
	name: string,
): { tool_name: "Edit" | "Write"; tool_input: HookInput["tool_input"] } {
	const raw = maybeJson(input);
	if (typeof raw === "string") {
		const patch = parsePatch(raw);
		if (patch.file) {
			return {
				tool_name: patch.oldText ? "Edit" : "Write",
				tool_input: {
					file_path: patch.file,
					old_string: patch.oldText,
					new_string: patch.newText,
				},
			};
		}
		return { tool_name: "Edit", tool_input: { command: raw } };
	}
	const record = (
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const patchBlob = firstString(record.input, record.patch, record.diff);
	if (patchBlob?.includes("*** Begin Patch")) {
		const patch = parsePatch(patchBlob);
		if (patch.file) {
			return {
				tool_name: patch.oldText ? "Edit" : "Write",
				tool_input: {
					file_path: patch.file,
					old_string: patch.oldText,
					new_string: patch.newText,
				},
			};
		}
	}
	const filePath = firstString(record.file_path, record.filePath, record.path);
	const oldText = firstString(record.old_string, record.old_text);
	const newText = firstString(
		record.new_string,
		record.new_text,
		record.content,
	);
	const createText = firstString(
		record.file_text,
		record.content,
		record.new_text,
	);
	if (
		name === "write_to_file" ||
		name === "create" ||
		record.file_text !== undefined
	) {
		return {
			tool_name: "Write",
			tool_input: { file_path: filePath, content: createText ?? "" },
		};
	}
	return {
		tool_name:
			oldText === undefined && newText !== undefined ? "Write" : "Edit",
		tool_input: {
			file_path: filePath,
			old_string: oldText,
			new_string: newText,
			content: createText,
		},
	};
}

export function normalizeCline(
	raw: Record<string, unknown>,
	fallbackEvent: string,
): Normalized {
	const provenance = toolName(raw);
	const input = toolInput(raw);
	const base: HookInput = {
		cwd: workspaceRoot(raw),
		hook_event_name: clineEvent(fallbackEvent),
	};
	if (BASH_TOOLS.has(provenance)) {
		return {
			hook: {
				...base,
				tool_name: "Bash",
				tool_input: { command: commandText(input) },
			},
			gate: "pre-bash",
			provenance,
		};
	}
	if (READ_TOOLS.has(provenance)) {
		return {
			hook: { ...base, tool_name: "Read", tool_input: normalizeRead(input) },
			gate: "pre-read",
			provenance,
		};
	}
	if (EDIT_TOOLS.has(provenance)) {
		const edit = normalizeEdit(input, provenance);
		return {
			hook: { ...base, ...edit },
			gate: "pre-files",
			provenance,
		};
	}
	return { hook: base, gate: "skip", provenance };
}

export function normalizeClineSession(
	raw: Record<string, unknown>,
	source: "startup" | "resume",
): { sessionId: string; cwd: string; source: "startup" | "resume" } {
	return {
		sessionId: ownSessionId(raw),
		cwd: workspaceRoot(raw),
		source,
	};
}

export function resolveClineSid(
	cwd: string,
	raw: Record<string, unknown>,
): SidResolution {
	const env = process.env.SUSPENDERS_SID;
	if (env) return { sid: env, source: "env" };
	const lane = resolveFleetLane(cwd);
	if (lane) return { sid: lane.sid, source: "lanes" };
	return { sid: ownSessionId(raw), source: "own" };
}

export function drift(
	note: string,
	sid: string,
	regDir = `${process.env.HOME}/.cache/claude-governor`,
): void {
	try {
		using f = Bun.file(`${regDir}/cline-drift.jsonl`).writer({ append: true });
		f.write(
			`${JSON.stringify({ ts: Date.now(), kind: "cline-drift", sid, note })}\n`,
		);
	} catch {
		// fail-open: journaling never blocks the hook path
	}
}
