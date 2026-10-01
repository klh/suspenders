// hooks/lib/gatestate.ts — per-session advisory counters for gate nudges.
// Two consumers (files.ts edit-streak, read.ts re-read nudge): one counter
// shape — JSON map path → count in $TMPDIR, keyed `claude-<scope>-<sid>.json`.
// Advisory only: a state failure must never change a gate verdict.
import { readFileSync, writeFileSync } from "node:fs";

/** Bump and return the per-(session, path) counter. Corrupt/missing state
 * counts from zero; write failures are swallowed (nudges are advisory). */
export function bumpPathCount(
	scope: string,
	sid: string,
	path: string,
): number {
	const statePath = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/claude-${scope}-${sid}.json`;
	let counts: Record<string, number> = {};
	try {
		counts = JSON.parse(readFileSync(statePath, "utf8")) as Record<
			string,
			number
		>;
	} catch {}
	counts[path] = (counts[path] ?? 0) + 1;
	try {
		writeFileSync(statePath, JSON.stringify(counts));
	} catch {}
	return counts[path];
}
