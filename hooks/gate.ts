#!/usr/bin/env bun
// ~/.claude/hooks/gate.ts — THE single hook entrypoint.
// Every hook registration is `bun gate.ts <event>`; this file owns stdin,
// dispatch, and nothing else. Gate logic lives in gates/*.ts, contracts in
// lib/hookio.ts, execution in lib/run.ts. One pattern everywhere.
//
//   bun gate.ts pre-bash    PreToolUse  (Bash: secrets/edit/skill/tool gates)
//   bun gate.ts pre-files   PreToolUse  (Edit|Write: config-guard)
//   bun gate.ts post-files  PostToolUse (Edit|Write: syntax gate + md-format)
//   bun gate.ts governor    PreToolUse  (Edit|Write|NotebookEdit|MultiEdit: file-lease governor)
//   bun gate.ts stop        Stop        (claim-done gate)
//   bun gate.ts session     SessionStart (optional operator motd)
import { readHook } from "./lib/hookio.ts";
import { bashGate } from "./gates/bash.ts";
import { configGate } from "./gates/config.ts";
import { filesGate } from "./gates/files.ts";
import { governorGate } from "./gates/governor.ts";
import { stopGate } from "./gates/stop.ts";

const hook = await readHook();
const event = process.argv[2] ?? "";

switch (event) {
  case "pre-bash": bashGate(hook);
  case "pre-files": configGate(hook);
  case "post-files": filesGate(hook);
  case "governor": governorGate(hook);
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
