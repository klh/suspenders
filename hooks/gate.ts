#!/usr/bin/env bun
// ~/.claude/hooks/gate.ts — THE single hook entrypoint.
// Every hook registration is `bun gate.ts <event>`; this file owns stdin,
// dispatch, and nothing else. Gate logic lives in gates/*.ts, contracts in
// lib/hookio.ts, execution in lib/run.ts. One pattern everywhere.
//
//   bun gate.ts pre-bash    PreToolUse  (Bash: secrets/governor-lease/edit/skill/tool gates)
//   bun gate.ts pre-files   PreToolUse  (Edit|Write|NotebookEdit: leases → mutation-size →
//                            operational-marker → config-guard — ONE process, W14)
//   bun gate.ts post-files  PostToolUse (Edit|Write: syntax gate + md-format)
//   bun gate.ts governor    PreToolUse  (standalone lease check; pre-files chains it
//                            in-process, so the separate registration is now redundant)
//   bun gate.ts stop        Stop        (claim-done gate)
//   bun gate.ts session     SessionStart (optional operator motd)
import { readHook, allow } from "./lib/hookio.ts";
import { bashGate } from "./gates/bash.ts";
import { filesGate } from "./gates/files.ts";
import { governorGate } from "./gates/governor.ts";
import { readGate } from "./gates/read.ts";
import { stopGate } from "./gates/stop.ts";
import { preFilesChain } from "./gates/chain.ts";

const hook = await readHook();
const event = process.argv[2] ?? "";

switch (event) {
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: gates are `: never` — the call ends the case
	case "pre-bash":
		bashGate(hook); // exits: single-gate event (deny/nudge/allow)
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: preFilesChain is `: never` — the call ends the case
	case "pre-files":
		preFilesChain(hook); // W14 chain — one process, allow() closes
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: filesGate is `: never` — the call ends the case
	case "post-files":
		filesGate(hook);
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: allow() is `: never` — the case always exits
	case "pre-read":
		readGate(hook); // W110: void — fat-read deny / re-read nudge, else falls through
		allow();
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: governorGate is `: never` — the call ends the case
	case "governor":
		governorGate(hook); // standalone registration (MultiEdit matcher) — no longer chains
		allow();
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: stopGate is `: never` — the call ends the case
	case "stop":
		stopGate(hook);
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: codexGate never resolves — await parks the case
	case "codex": {
		// W73 codex adapter — dialect bound by argv (`gate.ts codex <mode>`):
		// payload normalization + decision translation + fleet sid resolution
		// live in gates/codex.ts + lib/codex.ts; gates keep zero codex knowledge.
		const { codexGate } = await import("./gates/codex.ts");
		await codexGate(process.argv[3] ?? "", hook as Record<string, unknown>);
	}
	// biome-ignore lint/suspicious/noFallthroughSwitchClause: context()/exit is `: never` — the case always exits
	case "session": {
		// optional operator motd — drop a file at ~/.cache/claude-governor/motd.md
		// and it surfaces at every session start; absent file = silent no-op
		const { existsSync, statSync, readFileSync } = await import("node:fs");
		const motd = `${process.env.HOME ?? ""}/.cache/claude-governor/motd.md`;
		if (existsSync(motd) && statSync(motd).size > 0) {
			const { context } = await import("./lib/hookio.ts");
			context(readFileSync(motd, "utf8").slice(0, 2000), "SessionStart");
		} else {
			process.stdout.write("{}");
			process.exit(0);
		}
	}
	default:
		process.stdout.write("{}");
		process.exit(0);
}
