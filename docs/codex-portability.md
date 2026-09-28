# Codex CLI portability assessment (W66)

How far the fleet's agent-CLI coupling — currently hardwired to `claude` —
would stretch to the OpenAI `codex` CLI, across the repo quartet:
**speedy-claude** (config layer), **belt** (LLM fleet), **suspenders**
(control plane), **klh/local** (LAN serving).

- 2026-09-28, lane autow66 (Work Graph W66)
- Method: suspenders source read first-hand in this worktree (first-tier).
  Codex capabilities verified against the official docs the same day —
  `developers.openai.com/codex` + `openai/codex` repo docs (first-tier, but
  docs-tier only: **the codex binary is not installed here, nothing was run**).
  speedy-claude / belt / klh-local internals are **secondary** (role docs in
  this repo's README + fleet doctrine) — marked as such below.

## Verdict

**Port feasible, not free.** The headless dispatch path ports in about a day;
the real cost sits in three places:

1. **Hook contract** — suspenders' quality gates ride Claude Code's hook
   system (`settings.json` → `gate.ts`). Codex now has lifecycle hooks with
   nearly identical event names (PreToolUse, PostToolUse, SessionStart,
   Stop, SubagentStart…), but a different wire format (TOML config, its own
   stdin/stdout JSON dialect, `output.json` control schema). One adapter
   layer in `gate.ts` bridges both.
2. **Wire API** — codex custom `model_providers` speak **only the Responses
   API** wire protocol. Belt's endpoints are OpenAI **chat-completions**
   compatible, and its Anthropic shim on :4000 serves the claude CLI. Codex
   cannot point at belt today; codex runs against OpenAI's API directly
   until belt (or a shim) speaks Responses.
3. **Identity + rule injection** — session identity comes from Claude Code's
   hook `session_id`; codex lanes need the sid delivered another way (the
   brief already carries it: `You are lane "autow66"`), and the
   CLAUDE.md-injected fleet rules must reach codex via AGENTS.md (repo has
   none; codex's `project_doc_fallback_filenames = ["CLAUDE.md"]` bridges
   in one line).

Everything agent-agnostic already survives unchanged: governor.db work
graph, coord/claim/work CLIs, `lanes.json` (sids + pids, no CLI semantics),
the board (:7799, reads the plane, not the agent), and qlty gates themselves.

## What the fleet uses the claude CLI for (suspenders, first-hand)

| Coupling point                                                                                                            | Where                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Headless lane spawn: `claude -p <brief> --allowedTools … --permission-mode acceptEdits`                                   | `hooks/bin/fleet-loop.ts:330-341`                                             |
| Env hygiene: deletes `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` so lanes don't inherit the interactive router            | `hooks/bin/fleet-loop.ts:327-329`                                             |
| Brief as prompt text + `Read <file> and execute it fully`                                                                 | `hooks/bin/fleet-loop.ts:310-334`                                             |
| Lane identity `autow<n>` derived from item id; `lanes.json` pid registry                                                  | `hooks/bin/fleet-loop.ts:240-241,343-353`                                     |
| Hook gates: 5 events wired (SessionStart, SessionEnd, PreToolUse ×3, PostToolUse, Stop), one entrypoint `gate.ts <event>` | `settings.example.json`, `hooks/gate.ts:7-14`                                 |
| Session identity from hook stdin `session_id`; subagents inherit parent's id                                              | `hooks/session-start.ts:24`                                                   |
| Paths/naming: `~/.claude/hooks/suspenders`, `~/.cache/claude-governor`, `~/.claude-insights`                              | `install.sh:10`, `hooks/gates/governor.ts:31`, `hooks/lib/approvals.ts:14-15` |
| Skills/approval gates keyed on `~/.claude/skills` paths                                                                   | `hooks/gates/bash.ts:32`, `hooks/lib/approvals.ts:45`                         |

The `~/.claude` paths are **naming, not semantics** — no gate logic depends
on the CLI being claude. The two semantic couplings are the hook wire
format and the spawn flags.

## Codex surface relevant to fleet use (docs-verified, 2026-09)

| Fleet need                       | Codex equivalent                                                                                          | Fit                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `claude -p` headless lane        | `codex exec "<brief>"` — final message to stdout, progress to stderr                                      | Direct                       |
| Machine-readable lane transcript | `codex exec --json` (JSONL events: thread.started, item.*, turn.completed)                                | Direct                       |
| DONE `<sha>` line parse          | `-o <file>` / `--output-last-message`                                                                     | Direct                       |
| `--permission-mode acceptEdits`  | `--sandbox workspace-write` + `approval_policy = "never"` (exec defaults to read-only — must be explicit) | Direct, flags differ         |
| Env isolation                    | `--ephemeral`, `--ignore-user-config` — stronger than today's env-deletion hack                           | Better                       |
| Resume mid-flight                | `codex exec resume --last <brief>`                                                                        | Direct                       |
| Project rules                    | AGENTS.md; `project_doc_fallback_filenames = ["CLAUDE.md"]`                                               | One-liner                    |
| Hook gates                       | `[hooks]` in config with same-named events; command hooks supported; output JSON can deny/block           | Adapter needed               |
| Session identity                 | `thread.started` event carries thread id; no Claude `session_id` in hook payloads                         | Adapter                      |
| Belt as model backend            | `model_providers` = Responses wire only; belt is chat-completions (+Anthropic shim :4000)                 | **Blocked**                  |
| MCP servers                      | `mcp_servers` stdio + streamable HTTP; `required` flag honored in exec                                    | Direct                       |
| Multi-lane subagents             | built-in multi-agent (`features.multi_agent`, spawn_agent tools, max_threads default 6)                   | Surplus — fleet does its own |

## Per-repo coupling inventory

### suspenders (first-hand)

See table above. Port work is two files: `fleet-loop.ts` spawn block (new
backend branch: command, flags, output capture) and `gate.ts` (a codex
stdin/stdout dialect adapter beside the Claude one). Plus one config
emitter for codex hook wiring (TOML) next to `settings.example.json`.

### speedy-claude (secondary — role docs)

The config layer: hook wiring, permissions, statusline, skills, bin/ CLIs,
CLAUDE.md. The **CLIs port as-is** (agent-agnostic bun). The **statusline
and skills have no codex counterpart** — a codex lane runs "thin": no
skill routing, no nudge hooks unless the codex hook adapter lands. The
brief inlines the critical rules already (dispatch writes them per lane),
so the thinness costs capability, not correctness.

### belt (secondary — role docs)

Chat-completions-compatible local fleet endpoints (:8901-8903) plus an
Anthropic-API shim (:4000) that serves the claude CLI through outages.
Codex needs a **Responses-API** endpoint: either belt grows one (adapter
project, days) or codex runs cloud-only initially. `advise.ts` traffic to
:8901 is a server-side HTTP call independent of the agent CLI — unaffected.

### klh/local (secondary — role docs)

Caddy `*.local` names and the board are agent-CLI-agnostic. No port work;
only operational docs would name a second agent binary.

## Port plan (smallest honest sequence)

1. **Dispatch backend flag** (fleet-loop.ts, ~1 day): `--agent codex` →
   spawn `codex exec --json -o <last-message-file> --sandbox
workspace-write --ephemeral` (approval policy never via config or flag),
   brief as prompt, parse final line from the output file. lanes.json
   unchanged (sid/pid already agent-agnostic).
2. **AGENTS.md bridge** (30 min): thin AGENTS.md → CLAUDE.md content, or
   `project_doc_fallback_filenames` in the repo's codex config.
3. **Hook adapter** (gate.ts, 2-3 days with tests): accept both stdin
   dialects, emit both control JSONs; emit codex TOML wiring. Gates
   restored to full strength for codex lanes; until then codex lanes run
   gate-less on writes — acceptable only for the pilot.
4. **Belt Responses adapter** (optional, 2-5 days): only if local-model
   codex lanes matter (blackout resilience). Skip for the pilot.
5. **Pilot**: one low-risk item, codex lane, cloud API, all gates via
   adapter, then compare against a claude lane on the same item.

## Risks / open questions

- **All codex facts are docs-tier** — no binary was executed here. Before
  writing any code, re-verify against the installed codex (`codex exec
--help`, hooks example in the docs) — the surface moves fast.
- `SessionEnd` did not appear in codex's hook event list — session-end
  accounting (lane liveness) may need the Stop event or transcript probing.
  Unverified.
- `--sandbox workspace-write` denies network by default; lanes push to git
  remotes — enable `network_access` for the lane profile or the push step
  fails. Docs-tier, verify live.
- Hook output semantics differ (codex `output.json` decision schema vs
  Claude's exit-2 + JSON stdout). The adapter must translate block/approve
  precisely or the gates lose teeth silently.
- Two agent binaries double the "which agent owns this lane" surface —
  lanes.json gains an `agent` field, and the board should show it.

## Recommendation

Port the dispatch path, adapter the hooks, pilot one lane. Do **not**
migrate wholesale: claude stays the default backend; codex earns lanes by
surviving the pilot. The control plane (work graph, coord, board, gates'
policy) is already agent-agnostic — that was the design that makes this a
days-long job instead of a rewrite.

## Sources

- suspenders source at this worktree, branch suspenders/W66 (first-hand)
- Codex docs, fetched 2026-09-28: developers.openai.com/codex
  (noninteractive, config-reference, config-basic, sandbox, auth) and
  openai/codex repo docs (exec.md, advanced.md, hooks.md)
- speedy-claude / belt / klh-local roles: this repo's README.md
  (companions table) + docs/coordination-protocol.md — secondary sources
