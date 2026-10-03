#!/usr/bin/env bun
import {
	existsSync,
	readdirSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

const HOME = process.env.HOME ?? "";
const BUN = process.execPath;
const GATE = `${import.meta.dir}/../../gate.ts`;
const MARK = "gate.ts cline ";
const PRESERVED = ".suspenders-preserved";
const SUPPORTED_EXTS = new Set([
	"",
	".sh",
	".bash",
	".zsh",
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts",
	".py",
	".ps1",
]);

const EVENTS = [
	{ name: "TaskStart", mode: "task-start" },
	{ name: "TaskResume", mode: "task-resume" },
	{ name: "PreToolUse", mode: "pre-tool" },
	{ name: "PostToolUse", mode: "post-tool" },
	{ name: "SessionShutdown", mode: "session-shutdown" },
] as const;

type Scope = "cli" | "vscode" | "both";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const scope = (process.argv.find((a) => a.startsWith("--scope="))?.slice(8) ??
	"both") as Scope;
const dirs =
	scope === "cli"
		? [process.env.SUSPENDERS_CLINE_HOOKS_DIR ?? `${HOME}/.cline/hooks`]
		: scope === "vscode"
			? [
					process.env.SUSPENDERS_CLINE_VSCODE_HOOKS_DIR ??
						`${HOME}/Documents/Cline/Hooks`,
				]
			: [
					process.env.SUSPENDERS_CLINE_HOOKS_DIR ?? `${HOME}/.cline/hooks`,
					process.env.SUSPENDERS_CLINE_VSCODE_HOOKS_DIR ??
						`${HOME}/Documents/Cline/Hooks`,
				];

const managed = (path: string): boolean => {
	try {
		return readFileSync(path, "utf8").includes(MARK);
	} catch {
		return false;
	}
};

function matchingFiles(dir: string, base: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => {
			const ext = extname(entry).toLowerCase();
			if (!SUPPORTED_EXTS.has(ext)) return false;
			return (
				entry === base || entry.slice(0, entry.length - ext.length) === base
			);
		})
		.map((entry) => join(dir, entry));
}

function wrapper(event: (typeof EVENTS)[number], dir: string): string {
	const preservedDir = join(dir, PRESERVED, event.name).replaceAll(
		"\\",
		"\\\\",
	);
	const gate = GATE.replaceAll("\\", "\\\\");
	const bun = BUN.replaceAll("\\", "\\\\");
	return `#!/usr/bin/env bun
// ${MARK}${event.mode}
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const payload = await new Response(Bun.stdin.stream()).text();
const preservedDir = ${JSON.stringify(preservedDir)};
const gateCmd = ${JSON.stringify(bun)};
const gateArgs = [${JSON.stringify(gate)}, "cline", ${JSON.stringify(event.mode)}];

function parseOutput(stdout) {
	const trimmed = String(stdout ?? "").trim();
	if (!trimmed) return {};
	const lines = trimmed
		.split("\\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const prefixed = lines
		.filter((line) => line.startsWith("HOOK_CONTROL\\t"))
		.map((line) => line.slice("HOOK_CONTROL\\t".length));
	const candidate = prefixed.length > 0 ? prefixed[prefixed.length - 1] : trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		return {};
	}
}

function run(command, args = []) {
	const proc = spawnSync(command, args, {
		input: payload,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (proc.stderr) process.stderr.write(proc.stderr);
	return parseOutput(proc.stdout);
}

function merge(current, next) {
	const nextContext =
		typeof next.contextModification === "string"
			? next.contextModification
			: typeof next.context === "string"
				? next.context
				: "";
	const currentContext =
		typeof current.contextModification === "string"
			? current.contextModification
			: typeof current.context === "string"
				? current.context
				: "";
	const joinedContext = [currentContext, nextContext].filter(Boolean).join("\\n\\n");
	const cancel = current.cancel === true || next.cancel === true;
	const review = current.review === true || next.review === true;
	const errorMessage =
		(cancel && typeof current.errorMessage === "string" && current.errorMessage) ||
		(typeof next.errorMessage === "string" && next.errorMessage) ||
		current.errorMessage ||
		next.errorMessage;
	return {
		...(cancel ? { cancel: true } : {}),
		...(review ? { review: true } : {}),
		...(joinedContext ? { contextModification: joinedContext } : {}),
		...(errorMessage ? { errorMessage } : {}),
		...(Object.hasOwn(next, "overrideInput")
			? { overrideInput: next.overrideInput }
			: Object.hasOwn(current, "overrideInput")
				? { overrideInput: current.overrideInput }
				: {}),
	};
}

let result = run(gateCmd, gateArgs);
if (existsSync(preservedDir)) {
	for (const entry of readdirSync(preservedDir).sort()) {
		result = merge(result, run(join(preservedDir, entry)));
	}
}
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;
}

function ensureEvent(dir: string, event: (typeof EVENTS)[number]): boolean {
	mkdirSync(dir, { recursive: true });
	const wrapperPath = join(dir, event.name);
	const preserveDir = join(dir, PRESERVED, event.name);
	mkdirSync(preserveDir, { recursive: true });
	let changed = false;
	for (const file of matchingFiles(dir, event.name)) {
		if (file === wrapperPath && managed(file)) continue;
		const target = join(preserveDir, file.slice(file.lastIndexOf("/") + 1));
		if (!existsSync(target)) {
			renameSync(file, target);
			changed = true;
		} else if (file !== wrapperPath) {
			renameSync(file, `${target}.${Date.now()}`);
			changed = true;
		}
	}
	const next = wrapper(event, dir);
	if (!existsSync(wrapperPath) || readFileSync(wrapperPath, "utf8") !== next) {
		writeFileSync(wrapperPath, next, { mode: 0o755 });
		changed = true;
	}
	return changed;
}

function isWired(dir: string): boolean {
	return EVENTS.every((event) => {
		const path = join(dir, event.name);
		return existsSync(path) && managed(path);
	});
}

if (check) {
	const ok = dirs.every(isWired);
	console.log(
		ok ? `wired: ${dirs.join(", ")}` : `not wired: ${dirs.join(", ")}`,
	);
	process.exit(ok ? 0 : 1);
}

let changed = false;
for (const dir of dirs) {
	for (const event of EVENTS) changed = ensureEvent(dir, event) || changed;
}
console.log(
	changed
		? `wired ${EVENTS.length} cline hook events -> ${dirs.join(", ")}`
		: `already wired: ${dirs.join(", ")}`,
);
