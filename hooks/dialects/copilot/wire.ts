#!/usr/bin/env bun
// hooks/bin/gate-wire-copilot.ts — merge-not-clobber copilot hook wiring
// (W296). Merges the suspenders gate registrations into
// ~/.copilot/settings.json's inline `hooks` field (or
// $SUSPENDERS_COPILOT_SETTINGS), preserving every entry that isn't ours.
// Managed entries are recognized by their `gate.ts copilot ` marker, so
// re-running upgrades the command lines; user entries are never touched.
//
// Unlike codex's un-matchered wiring (codex's own payload didn't reliably
// report per-tool names at the W73 implementation, so the adapter content-
// sniffs instead), copilot's PascalCase/"VS Code compatible" payload DOES
// remap tool_name to Claude's own vocabulary (docs.github.com/en/copilot/
// reference/hooks-reference) — so this wiring matcher-routes PER TOOL,
// exactly like Claude's own settings.example.json: Bash → pre-bash,
// Edit|Write → pre-files (PreToolUse) / post-files (PostToolUse), Read →
// pre-read. The gate mode is therefore selected AT WIRING TIME, never by
// content-sniffing inside the gate (gates/copilot.ts stays dialect-pure).
//
//   bun gate-wire-copilot.ts           # merge the wiring (idempotent)
//   bun gate-wire-copilot.ts --check   # exit 0 wired / 1 not
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME ?? "";
const FILE =
	process.env.SUSPENDERS_COPILOT_SETTINGS ?? `${HOME}/.copilot/settings.json`;
const MARK = "gate.ts copilot ";
const BUN = process.execPath;
const GATE = `${import.meta.dir}/../../gate.ts`;

// event (+ optional matcher) → gate.ts copilot <mode>: mirrors Claude's own
// settings.example.json matcher routing (Bash/Edit|Write|NotebookEdit/Read),
// minus NotebookEdit — copilot has no documented notebook-editing tool.
const WIRING: Array<[string, string | undefined, string]> = [
	["PreToolUse", "Bash", "copilot pre-bash"],
	["PreToolUse", "Edit|Write", "copilot pre-files"],
	["PreToolUse", "Read", "copilot pre-read"],
	["PostToolUse", "Edit|Write", "copilot post-files"],
	["SessionStart", undefined, "copilot session"],
	["SessionEnd", undefined, "copilot session-end"],
	["Stop", undefined, "copilot stop"],
];

type HookCmd = { type: string; command: string };
type HookEntry = { matcher?: string; hooks: HookCmd[] };

const read = (): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
};

const managed = (e: HookEntry): boolean =>
	Array.isArray(e.hooks) &&
	e.hooks.some(
		(h) => typeof h?.command === "string" && h.command.includes(MARK),
	);

const run = (): number => {
	const doc = read();
	const hooks = (doc.hooks ?? {}) as Record<string, HookEntry[]>;
	const check = process.argv[2] === "--check";
	// evaluate against the file AS IT IS — the loop below would add our
	// entries in memory and make every file look wired
	const wiredNow = WIRING.every(([event, matcher]) =>
		(hooks[event] ?? []).some(
			(e) => managed(e) && (matcher === undefined || e.matcher === matcher),
		),
	);
	let changed = false;
	// group by event so each event's array is rebuilt once, preserving the
	// relative order of untouched (non-managed) entries
	const byEvent = new Map<string, Array<[string | undefined, string]>>();
	for (const [event, matcher, mode] of WIRING) {
		if (!byEvent.has(event)) byEvent.set(event, []);
		byEvent.get(event)?.push([matcher, mode]);
	}
	for (const [event, entries] of byEvent) {
		const list = Array.isArray(hooks[event]) ? hooks[event] : [];
		const kept = list.filter((e) => !managed(e)); // strip our stale entries
		const added = entries.map(([matcher, mode]) => ({
			...(matcher !== undefined ? { matcher } : {}),
			hooks: [{ type: "command", command: `${BUN} ${GATE} ${mode}` }],
		}));
		const next = [...kept, ...added];
		if (JSON.stringify(next) !== JSON.stringify(list)) changed = true;
		hooks[event] = next;
	}
	if (check) {
		console.log(wiredNow ? `wired: ${FILE}` : `not wired: ${FILE}`);
		return wiredNow ? 0 : 1;
	}
	if (changed) {
		mkdirSync(dirname(FILE), { recursive: true });
		writeFileSync(FILE, `${JSON.stringify({ ...doc, hooks }, null, 2)}\n`);
		console.log(
			`wired ${WIRING.length} copilot hook entries → ${FILE} (user entries preserved)`,
		);
	} else {
		console.log(`already wired: ${FILE}`);
	}
	return 0;
};

process.exit(run());
