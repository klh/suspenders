# CLI dialect pattern (W296)

How a non-native CLI (anything other than Claude Code itself) gets full
parity with suspenders' gates, governor.db session registration, and the
cross-CLI addressing layer — without a single line of the shared core gates
(`hooks/gates/bash.ts`, `files.ts`, `chain.ts`, `read.ts`, `stop.ts`) ever
knowing that CLI exists.

## The seam: `CliDialect`

`hooks/lib/dialect.ts` defines the formal contract every adapter implements:

```ts
interface CliDialect {
	resolveSid(cwd: string, ownSessionId: string): SidResolution;
	normalizeSession(raw: unknown): NormalizedSession;
	normalizeSessionEnd(raw: unknown): { sessionId: string };
	normalizeToolEvent(raw: unknown, mode: ToolMode): { hook: HookInput; ... };
	buildDecision(kind: DecisionKind, event: string, arg: string): DialectDecisionOut;
}
```

The core gates only ever see a `HookInput` (Claude's own shape:
`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`). An adapter's
entire job is translating its CLI's wire format into that shape going in, and
translating the gate's allow/deny/ask/context/feedback decision back into its
CLI's wire format going out.

## Folder layout

Every CLI gets its own subfolder under `hooks/dialects/<cli>/`:

```
hooks/dialects/<cli>/
  lib.ts      — normalization, sid resolution, buildDecision, drift journal
  gate.ts     — thin dispatcher: argv mode → core gate function
  wire.ts     — merge-not-clobber installer for that CLI's own hook config
  schemas.ts  — (optional) Zod schemas for that CLI's payload shapes
```

`hooks/gate.ts` (the one shared entrypoint every hook command actually
invokes) dispatches on the first argv token:

```ts
case "<cli>": {
	const { <cli>Gate } = await import("./dialects/<cli>/gate.ts");
	await <cli>Gate(process.argv[3] ?? "", hook as Record<string, unknown>);
}
```

`<cli>Gate` is a thin mode-router into the shared core gates
(`bashGate`, `filesGate`, `preFilesChain`, `readGate`, `stopGate`) and the
session-bridge primitives (`hooks/lib/session-bridge.ts`:
`transcriptPathFor`/`spawnSessionStart`/`spawnSessionEnd`) — it holds zero
business logic of its own.

## The two identity policies

1. **Unstable thread id (Codex)** — `resolveSid` may legitimately return
   `{ sid: "", source: "unresolved" }` when no fleet lane claims the cwd,
   because the CLI's own session id is NOT guaranteed stable across resumes.
   The caller then SKIPS governor.db registration entirely rather than
   registering transient garbage.
2. **Stable session id (Copilot, Cline, grok-cli)** — `resolveSid` NEVER
   returns empty. It falls back, in order: `$SUSPENDERS_SID` env → fleet
   lane ppid-walk (`hooks/lib/fleetlane.ts`) → the CLI's own stable session
   id. This is the fix for the W296 root-cause bug: a manually-started
   session with no fleet lane must still be discoverable, never silently
   dropped.

Pick policy 2 unless you have hard evidence (like Codex's W66 finding) that
the CLI's own id is a rotating/unstable thread id rather than a true session
id.

## Wire-format differences, by example

| CLI | Shape | Ask support | Matcher routing |
| --- | --- | --- | --- |
| Claude (native) | `hookSpecificOutput{...}` wrapper | yes | yes (settings.json matchers) |
| Codex (W73) | Claude-shaped wrapper, content-sniffed (no discrete Edit/Write tool) | no — degrades to deny | no — gate dispatcher sniffs payload content |
| Copilot (W296) | flat JSON, no wrapper | yes — native | yes — payload already reports correct tool names |
| grok-cli (W296) | flat JSON + exit-code semantics (0=allow, 2=block) | no — degrades to deny | yes |
| Cline (W296) | file-hook JSON (`cancel`/`errorMessage`/`contextModification`/`review`) | yes (`review: true`) | n/a — file-hook names are already lifecycle-exact |

Prefer matcher-based wiring (`wire.ts` installs one hook entry per
Claude-vocabulary tool name) whenever the CLI's own payload already names
tools correctly. Content-sniffing (Codex's approach) is a fallback for CLIs
whose edits don't arrive as discrete Edit/Write tool calls.

## Verification tiers — never fabricate a hook surface

Before writing an adapter, confirm the CLI actually has a programmatic
lifecycle hook system. Acceptable evidence, strongest first:

1. **Binary-verified**: cloned the CLI's own source and read the hook
   executor/types code directly (see `.research/<cli>` clones used for
   grok-cli, Cline, Hermes in `docs/cli-surface-survey.md`).
2. **Docs-tier**: the CLI's own published reference docs describe the hook
   schema in enough detail to implement against (Copilot CLI, Codex CLI).
3. **Insufficient**: a surface with no hooks page and no lifecycle event
   list is NOT a dialect target — document the honest "no adapter built,
   here's why" conclusion instead of fabricating one (see the VS Code Local
   harness and Hermes sections of `docs/cli-surface-survey.md`).

## Testing a new dialect

Mirror `test/hook-adapter-copilot.test.ts` / `test/hook-adapter-grok.test.ts`
/ `test/hook-adapter-cline.test.ts`:

- schema/normalization unit tests (accept valid, degrade-not-throw on
  malformed input)
- `buildDecision` translation table (one test per `DecisionKind`)
- `resolveSid` policy tests (env wins, lanes resolves, unresolved/own-id
  fallback per your chosen identity policy)
- `wire.ts` emitter tests (merges into a fixture config, preserves user
  entries, idempotent re-run, `--check` exit codes)
- `gate.ts <cli> <mode>` integration tests, spawned as a real subprocess,
  asserting the exact wire-format JSON (not just allow/deny but the literal
  shape) and a real governor.db session-registration row

Run the new suite together with every existing dialect suite
(`bun test test/hook-adapter*.test.ts`) before landing — zero cross-dialect
regressions is the bar, not just "my new tests pass."

## Adding CLI #N

1. Verify the hook surface (see tiers above) — do this first, it may
   disqualify the CLI.
2. `mkdir hooks/dialects/<cli>`, write `lib.ts` + `gate.ts` + `wire.ts`
   (+ `schemas.ts` if the payload needs Zod-validated narrowing).
3. Add the `case "<cli>":` dispatch in `hooks/gate.ts`.
4. Write the test file, run it standalone, then with every other dialect
   suite together.
5. `qlty fmt` + `qlty check` on every new/changed file — must be clean.
6. Document the CLI in `docs/cli-surface-survey.md` if not already covered.
7. If the fleet can dispatch lanes on this CLI (not just manually-started
   sessions), add dispatch-time wiring in `hooks/bin/fleet-loop.ts`
   mirroring the existing `AGENT === "codex"` wire-before-dispatch call.
