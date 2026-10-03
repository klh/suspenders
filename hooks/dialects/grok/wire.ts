#!/usr/bin/env bun
// hooks/bin/gate-wire-grok.ts - merge-not-clobber grok-cli hook wiring (W296).
// Merges the suspenders registrations into ~/.grok/user-settings.json (or
// $SUSPENDERS_GROK_SETTINGS), preserving every entry that is not ours.
// Managed entries are recognized by their `gate.ts grok ` marker, so re-runs
// upgrade command lines in place; user entries are never touched.
//
//   bun gate-wire-grok.ts           # merge the wiring (idempotent)
//   bun gate-wire-grok.ts --check   # exit 0 wired / 1 not
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME ?? "";
const FILE =
	process.env.SUSPENDERS_GROK_SETTINGS ?? `${HOME}/.grok/user-settings.json`;
const MARK = "gate.ts grok ";
const BUN = process.execPath;
const GATE = `${import.meta.dir}/../../gate.ts`;

type HookCmd = { type: string; command: string; timeout?: number };
type HookEntry = { matcher?: string; hooks: HookCmd[] };
type Wiring = { event: string; mode: string; matcher?: string };

const WIRING: Wiring[] = [
	{ event: "PreToolUse", mode: "grok pre-bash", matcher: "bash" },
	{
		event: "PreToolUse",
		mode: "grok pre-files",
		matcher: "edit_file|write_file",
	},
	{ event: "PreToolUse", mode: "grok pre-read", matcher: "read_file" },
	{
		event: "PostToolUse",
		mode: "grok post-files",
		matcher: "edit_file|write_file",
	},
	{ event: "SessionStart", mode: "grok session" },
	{ event: "SessionEnd", mode: "grok session-end" },
	{ event: "Stop", mode: "grok stop" },
];

const read = (): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
};

const managed = (entry: HookEntry): boolean =>
	Array.isArray(entry.hooks) &&
	entry.hooks.some(
		(hook) => typeof hook?.command === "string" && hook.command.includes(MARK),
	);

const desiredEntry = ({ matcher, mode }: Wiring): HookEntry => ({
	...(matcher ? { matcher } : {}),
	hooks: [{ type: "command", command: `${BUN} ${GATE} ${mode}` }],
});

const wiredEntry = (entry: HookEntry, wiring: Wiring): boolean => {
	const want = `${BUN} ${GATE} ${wiring.mode}`;
	const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
	return (
		matcher === wiring.matcher &&
		Array.isArray(entry.hooks) &&
		entry.hooks.some((hook) => hook.command === want)
	);
};

const run = (): number => {
	const doc = read();
	const hooks = (doc.hooks ?? {}) as Record<string, HookEntry[]>;
	const check = process.argv[2] === "--check";
	const wiredNow = WIRING.every((wiring) =>
		(hooks[wiring.event] ?? []).some((entry) => wiredEntry(entry, wiring)),
	);
	let changed = false;
	const events = [...new Set(WIRING.map((wiring) => wiring.event))];
	for (const event of events) {
		const list = Array.isArray(hooks[event]) ? hooks[event] : [];
		const kept = list.filter((entry) => !managed(entry));
		const wanted = WIRING.filter((wiring) => wiring.event === event).map(
			desiredEntry,
		);
		const next = [...kept, ...wanted];
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
			`wired ${WIRING.length} grok hook entries -> ${FILE} (user entries preserved)`,
		);
	} else {
		console.log(`already wired: ${FILE}`);
	}
	return 0;
};

process.exit(run());
