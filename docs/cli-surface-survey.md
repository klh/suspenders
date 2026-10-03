# CLI surface survey

This survey covers every surface named in W296: Claude Code, Codex CLI,
Copilot CLI, grok-cli, Cline, Hermes, and VS Code.

## Executive summary

| Surface | What it is | Hook / lifecycle surface | Suspenders adapter status |
| --- | --- | --- | --- |
| Claude Code | Anthropic's coding agent for terminal, IDE, desktop, and cloud sessions | Native hook system with session, turn, tool, subagent, and worktree events | Built already; existing native baseline |
| Codex CLI | OpenAI's local coding agent CLI | Native hooks in `~/.codex/hooks.json` | Built already in W73 |
| Copilot CLI | GitHub Copilot coding agent CLI | Native hooks in policy, repo, user, settings, and plugin locations | In progress in this worktree; gate entry reserved to parent session |
| grok-cli | Community Grok API coding agent CLI (`grok-dev`) | Native hooks in `~/.grok/user-settings.json` | In progress in sibling lane |
| Cline | Cline agent runtime surfaced as VS Code extension, CLI, desktop, and SDK | Real file-hook lifecycle exists in both CLI and extension paths | Built in this lane; pending parent `gate.ts` case |
| Hermes | Nous Research's `hermes` agent CLI / TUI / gateway product | Real lifecycle hook surface exists | No suspenders adapter built in this lane |
| VS Code | Shared host for Local harness and Agent Host provider harnesses | Mixed: local VS Code hooks plus provider-specific harness hooks | Partly covered by provider adapters, partly separate |

## 1. Claude Code

### What it is

Anthropic's coding agent for terminal sessions, IDE extensions, desktop app,
and cloud sessions.

Source:
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks

### Hook capability

Claude Code has a first-class hooks system with command, HTTP, MCP-tool,
prompt, and subagent hooks. The docs list per-session events
(`SessionStart`, `SessionEnd`), per-turn events (`UserPromptSubmit`, `Stop`,
`StopFailure`), and per-tool / subagent / worktree events including
`PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`,
`WorktreeCreate`, and `WorktreeRemove`.

This is the reference surface suspenders was originally built around.

### Adapter status in this repo

Built already. This is the native path behind `hooks/gate.ts` and the current
Claude-oriented gates.

### Why no new adapter work here

Not needed. Claude Code is the baseline dialect.

## 2. Codex CLI

### What it is

OpenAI's local coding agent CLI, installable from OpenAI's installer, npm
(`@openai/codex`), or Homebrew.

Sources:
- Codex README: https://raw.githubusercontent.com/openai/codex/main/README.md
- Local repo verification: `.research/codex` at commit `b741e480e203`
- Local config doc verification: `.research/codex/docs/config.md`

### Hook capability

Codex has real lifecycle hooks. The local source tree's config docs explicitly
include a "Lifecycle hooks" section, and the existing suspenders W73 adapter
was verified earlier against the live Codex install.

### Adapter status in this repo

Built already in W73.

Relevant files:
- `hooks/lib/codex.ts`
- `hooks/gates/codex.ts`
- `hooks/bin/gate-wire-codex.ts`
- `test/hook-adapter.test.ts`

### Why no new adapter work here

Already shipped.

## 3. Copilot CLI

### What it is

GitHub Copilot's coding agent CLI and related cloud agent surface.

Sources:
- Copilot hooks reference: https://docs.github.com/en/copilot/reference/hooks-reference
- VS Code hooks note referencing same Copilot SDK implementation:
  https://code.visualstudio.com/docs/agent-customization/hooks

### Hook capability

Copilot CLI has a real hooks system. The GitHub docs describe hook loading from
policy files, repo `.github/hooks/*.json`, user `~/.copilot/hooks/*.json`,
inline settings, and plugin-contributed hooks. The same reference documents the
command hook schema and lifecycle behavior.

### Adapter status in this repo

In progress in the parent session. This worktree already contains partial
adapter files, but the reserved `gate.ts` entrypoint and final integration are
owned elsewhere.

Observed in this worktree:
- `hooks/lib/copilot.ts`
- `hooks/lib/copilot-schemas.ts`

### Why no new adapter work here

Reserved by the parent session. This lane did not modify Copilot files.

## 4. grok-cli

### What it is

A community-built Grok API coding agent CLI, published as `grok-dev`.

Sources:
- grok-cli README: https://raw.githubusercontent.com/superagent-ai/grok-cli/main/README.md
- Local repo verification: `.research/grok-cli` at commit `fb97af83f06d`

### Hook capability

The README documents a real hook system in `~/.grok/user-settings.json`, with
matcher-based command hooks, JSON stdin / stdout, exit-code semantics, and a
broad lifecycle list including `PreToolUse`, `PostToolUse`, `SessionStart`,
`SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `TaskCreated`, and
`TaskCompleted`.

### Adapter status in this repo

In progress in a sibling lane, not in this lane.

### Why no new adapter work here

Reserved by the sibling background agent working on grok-cli.

## 5. Cline

### What it is

Cline is an agent runtime exposed as a VS Code extension, JetBrains plugin,
Desktop app, CLI (`npm i -g cline`), and SDK (`@cline/sdk`).

Sources:
- CLI docs: https://docs.cline.bot/usage/cli-overview
- SDK docs: https://docs.cline.bot/sdk/overview
- Local repo verification: `.research/cline` at commit `39ff2359f7e0`
- CLI reference in repo: `.research/cline/docs/cli/cli-reference.mdx`
- Hook examples in repo: `.research/cline/sdk/examples/hooks/README.md`
- Extension hook notes: `.research/cline/.clinerules/hooks/README.md`

### Hook capability

Cline does have a genuine hook surface.

Direct evidence:
- CLI docs expose `cline hook` and `--hooks-dir`.
- The docs and SDK examples document file hooks in `.cline/hooks/` with named
  files such as `PreToolUse`, `PostToolUse`, `TaskStart`, and `TaskResume`.
- The extension docs document parallel extension hook locations in
  `.clinerules/hooks/` and `~/Documents/Cline/Hooks/`.
- The SDK examples explicitly map file-hook names onto runtime lifecycle hooks:
  `PreToolUse -> tool_call -> beforeTool`, `PostToolUse -> tool_result -> afterTool`,
  `TaskStart -> agent_start -> beforeRun`, `TaskResume -> agent_resume -> beforeRun`.
- Source inspection shows the CLI generates `hookName: "tool_call"` and
  `hookName: "tool_result"` payloads, plus compatibility payloads under
  `preToolUse` / `postToolUse`.

Important limitation discovered during source review:
- Cline file hooks do not expose a Claude/Copilot-style blocking `Stop` event.
  `TaskComplete` / `agent_end` and `SessionShutdown` are post-run surfaces, and
  run-start hooks are only blocking when the host enables `blockingRunStartHooks`.
  That means suspenders can reliably cover pre-tool / post-tool gates and
  session registration, but not a perfect analogue of the Claude stop gate.

### Adapter status in this repo

Built in this lane.

Files added:
- `hooks/lib/cline.ts`
- `hooks/gates/cline.ts`
- `hooks/bin/gate-wire-cline.ts`
- `test/hook-adapter-cline.test.ts`

What it covers:
- `TaskStart` / `TaskResume` -> suspenders session registration
- `SessionShutdown` -> session close
- `PreToolUse` -> bash, read, and file pre-gates
- `PostToolUse` -> post-file validation gate
- User-hook preservation when wiring Cline hook files

What it does not cover:
- No direct equivalent of the Claude `Stop` gate because Cline's file-hook
  surface does not provide a matching blocking end-of-turn event.

### Why an adapter is being built

Because the hook system is real, documented, and source-verified. The earlier
"no real hook surface" conclusion was incorrect.

## 6. Hermes

### What it is

The official Nous Research `hermes` agent product: CLI, TUI, gateway, and
Desktop companion ecosystem.

Sources:
- GitHub repo search found the official project: `NousResearch/hermes-agent`
- Local repo verification: `.research/hermes-agent` at commit `98d8ea79afce`
- README: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md
- Plugin / hook references in repo: `.research/hermes-agent/plugins/AGENTS.md`

### Hook capability

The preliminary "Hermes is only a model name" conclusion was wrong.

There is a real standalone product, Hermes Agent, with a real lifecycle hook
surface.

Direct evidence:
- The official GitHub repository exists and is active:
  `NousResearch/hermes-agent`.
- The in-repo plugin guidance documents native plugin hook names such as
  `pre_tool_call`, `post_tool_call`, `on_session_start`, and `on_session_end`.
- Plugin examples in the tree register those hooks directly, for example the
  `disk-cleanup`, `google_meet`, and `observability/langfuse` plugins.

### Adapter status in this repo

No suspenders Hermes adapter was built in this lane.

### Why no adapter is being built here

Hermes is now clearly in scope as a distinct product, but this lane did not
complete a safe Hermes adapter implementation. The source verification here
proved a native plugin hook surface, not a fully reviewed external shell-hook
contract with documented payload and decision JSON comparable to Claude /
Copilot / Cline / grok-cli. The survey should therefore be read as a
correction of scope, not as a claim of existing Hermes coverage.

Operationally: Hermes is a future adapter target, not "already covered by some
other CLI because Hermes is only a model name." That earlier conclusion should
be retired.

## 7. VS Code

### What it is

VS Code is not one agent surface. It is a host that can run:
- the VS Code Local harness,
- Agent Host provider harnesses such as Copilot, Claude, and Codex,
- cloud-provider agent targets.

Sources:
- Harness concepts: https://code.visualstudio.com/docs/agents/concepts/agent-harnesses
- Customization overview: https://code.visualstudio.com/docs/agent-customization/overview
- VS Code hooks: https://code.visualstudio.com/docs/agent-customization/hooks
- Agent plugins: https://code.visualstudio.com/docs/agent-customization/agent-plugins

### Hook capability

VS Code has two materially different stories:

1. Agent Host provider harnesses
   - VS Code docs state that Copilot sessions on Agent Host use the same SDK
     hook implementation as Copilot CLI.
   - The hooks page also warns that shared hook-file compatibility does not mean
     identical behavior across harnesses.
   - The customization overview says Agent Host sessions read user-level
     customizations from provider folders like `~/.copilot` and `~/.claude`.

2. VS Code Local harness
   - VS Code has its own preview hook system for the Local harness.
   - Those hooks live in `.github/hooks/*.json`, optionally `.claude/settings.json`,
     user `~/.copilot/hooks/*.json`, custom agents, and plugins.
   - The Local harness has its own event list and its own output semantics.

### Adapter status in this repo

No separate VS Code adapter is being built in this lane.

### Why no single adapter is being built

Because "VS Code" is partly redundant and partly distinct:
- Copilot-on-Agent-Host is effectively covered by the Copilot adapter once that
  adapter lands.
- Claude and Codex harnesses appear intended to use their own provider hook
  semantics inside VS Code, but this lane did not live-test those code paths.
- VS Code Local is a separate hook surface and is not transparently covered by
  the CLI adapters.

So the safe conclusion is:
- VS Code is not a single extra adapter target.
- Provider-harness sessions are mostly provider-adapter territory.
- Local harness sessions are their own future surface if suspenders chooses to
  support them.

### Concrete operator verification steps

If an operator wants to verify the Copilot-harness path in a real VS Code
session:
1. Create a repo hook in `.github/hooks/` or a user hook in `~/.copilot/hooks/`.
2. Select the Copilot session target in VS Code Agent Host.
3. Start a session that uses a tool.
4. Confirm the hook fires in Agent Debug Logs.
5. Confirm the suspenders registration side-effect appears in `governor.db`.

Do not infer coverage from model choice alone; select the actual session target
/ harness named in VS Code.

## Practical status by surface

- Claude Code: supported now.
- Codex CLI: supported now.
- Copilot CLI: adapter in progress elsewhere in W296.
- grok-cli: adapter in progress elsewhere in W296.
- Cline: real hook surface confirmed; adapter built in this lane, pending
  parent `gate.ts` entrypoint.
- Hermes: real standalone product and real hook surface confirmed; no
  suspenders adapter landed in this lane.
- VS Code: not one surface; provider-harness coverage depends on the provider
  adapter, while Local harness remains separate.
