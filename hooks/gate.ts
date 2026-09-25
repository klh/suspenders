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
import { configGate } from "./gates/config.ts";
import { filesGate } from "./gates/files.ts";
import { governorGate } from "./gates/governor.ts";
import { stopGate } from "./gates/stop.ts";
import { mutationSizeGate } from "./gates/mutation-size.ts";
import { ledgerGate } from "./gates/ledger.ts";

const hook = await readHook();
const event = process.argv[2] ?? "";

switch (event) {
  case "pre-bash": bashGate(hook); // exits: single-gate event (deny/nudge/allow)
  case "pre-files": {
    // W14: one bun process per Edit/Write — gates chain in-process; each
    // exits on deny/ask, returning falls through to the next; allow() closes.
    governorGate(hook);
    mutationSizeGate(hook); // W5: payload cap on existing files (SUSPENDERS_MAX_MUTATION)
    ledgerGate(hook); // W8: no NEW TODO/IN-FLIGHT/BLOCKED/NEXT markers in ledgers
    configGate(hook);
    allow();
  }
  case "post-files": filesGate(hook);
  case "governor":
    governorGate(hook); // standalone registration (MultiEdit matcher) — no longer chains
    allow();
  case "stop": stopGate(hook);
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
