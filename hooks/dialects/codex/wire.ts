#!/usr/bin/env bun
// hooks/bin/gate-wire-codex.ts — merge-not-clobber codex hook wiring (W73).
// Merges the five suspenders gate registrations into ~/.codex/hooks.json
// (or $SUSPENDERS_CODEX_HOOKS), preserving every entry that isn't ours.
// Managed entries are recognized by their `gate.ts codex ` marker, so
// re-running upgrades the command lines; user entries are never touched.
// Per-lane `-c` overrides were the spec's preference but remain unverified
// (codex exec was permission-blocked in the implementing session); the
// hooks.json merge is the proven, working surface on this machine.
//
//   bun gate-wire-codex.ts           # merge the wiring (idempotent)
//   bun gate-wire-codex.ts --check   # exit 0 wired / 1 not
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME ?? "";
const FILE = process.env.SUSPENDERS_CODEX_HOOKS ?? `${HOME}/.codex/hooks.json`;
const MARK = "gate.ts codex ";
const BUN = process.execPath;
const GATE = `${import.meta.dir}/../../gate.ts`;

// event → gate.ts codex <mode>: the adapter's one switch (gates/codex.ts)
const WIRING: Array<[string, string]> = [
	["PreToolUse", "codex pre-tool"],
	["PostToolUse", "codex post-tool"],
	["SessionStart", "codex session"],
	["Stop", "codex stop"],
	["SessionEnd", "codex session-end"],
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
	const wiredNow = WIRING.every(([event]) =>
		(hooks[event] ?? []).some(managed),
	);
	let changed = false;
	for (const [event, mode] of WIRING) {
		const list = Array.isArray(hooks[event]) ? hooks[event] : [];
		const want = `${BUN} ${GATE} ${mode}`;
		const kept = list.filter((e) => !managed(e)); // strip our stale entries
		const next = [...kept, { hooks: [{ type: "command", command: want }] }];
		// change = the final list differs from the initial one (strip-readd of
		// an identical entry is a no-op, not a change)
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
			`wired ${WIRING.length} codex hook events → ${FILE} (user entries preserved)`,
		);
	} else {
		console.log(`already wired: ${FILE}`);
	}
	return 0;
};

process.exit(run());
