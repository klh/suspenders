# suspenders — architecture

Agent control plane: one governor database, one coord bus, one merge/dispatch
loop, hook gates, and the board/console UIs. Docs in this directory are
architecture and live API contracts only — todos live in the work graph,
point-in-time research lives in coord facts (`lesson.*` / `finding.*`).

## The stack

| Piece           | What it is                                                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| governor.db     | SQLite/WAL work graph — the ONLY operational ledger. Project-scoped per repo (`work take/done/split`, W-ids, result shas). Never reconstruct it from Markdown.                                                                                                                                                                                           |
| coord bus       | Events, NEED_DECISION, inbox, facts (`coord fact set/get lesson.<topic>`), session binding (`coord doctor-session`). SendMessage is interrupts-only.                                                                                                                                                                                                     |
| fleet-loop      | launchd `com.suspenders.fleet-loop`: `watch --repo <repo> --dispatch-cmd "bun scripts/dispatch-next.ts" --target N --every 120`. Curfews are plist edits (strip `--dispatch-cmd`) + bootout/bootstrap.                                                                                                                                                   |
| dispatch-next   | Takes READY work → worktree + branch (`suspenders/Wxxx`) → brief. Briefs are delivered INTO the worktree (`.klh-brief.md`; lanes are sandboxed — see `lesson.lane-brief-delivery`). Per-executor env insertion is data-driven: `scripts/lib/insertion.ts` (recipes + UNION_VARS, no per-executor branches).                                              |
| board + console | Lit web components + CSS tokens (never innerHTML). Surfaces: work graph, service ladder, forks/decisions, usage. Served via Caddy at `*.local` (nginx cutover done).                                                                                                                                                                                     |
| gates           | On-write qlty/biome gate (`hooks/gates/files.ts`), content gate (parse-checks Write/Edit payloads — corrupt emissions denied pre-write), 1500-line hard limit on .ts, gitleaks pre-push, push-guard lane resolution. Non-native CLIs ride a `CliDialect` adapter under `hooks/dialects/<cli>/{lib,gate,wire}.ts` (codex shipped W73; copilot/grok/cline shipped W296) at the contract boundary — no gate rewrites per CLI. See `docs/cli-dialect-pattern.md`. |

## Lanes and executors

Headless lanes run in git worktrees on `suspenders/Wxxx` branches; integration
is orchestrator-driven (test → merge → push → `work done <id> --sha`).
Executors: claude, codex (adapter above), copilot (`--allow-all-tools`,
`COPILOT_MODEL` env is honored; premium credits are cheap — the 2026-10-02
campaign cost ~4 credits), grok-cli, cline, glm via the local wire. Full
porting/install for codex lives in speedy (`bun install-codex.ts`,
docs/codex-setup.md there); user-level copilot instructions in
`~/.copilot/instructions.md`. Cross-CLI session discovery/naming/broadcast:
`docs/cross-cli-addressing.md`. Per-surface hook capability research:
`docs/cli-surface-survey.md`.

## UI surfaces (current)

- Theme: `data-theme` on `<html>` + token swap — contract in
  [theme-tokens.md](theme-tokens.md) (`hooks/lib/theme.ts` is the copy-verbatim
  source). Settings area is shared across GUIs; belt/klh-local dashboards adopt
  the same pattern (W281).
- Orchestrate prompt-transform preview (`hooks/board/prompt-transform.ts`):
  condense (deterministic, default ON) → optional local-LLM enhance → context
  injection, shown under the field when debug/log settings are on.
- Recovery UX (`hooks/lib/recovery-map.ts`): DOWN service rows show cause +
  copyable recovery commands + re-probe. Recovery map is data, keyed per
  service; commands carry no secrets or real hostnames.
- Perimeter (W264): shared `hostGuard()` (Host allowlist every request +
  Origin==Host for browsers + per-install write token `X-KLH-Write-Token`),
  loopback-default binds everywhere, `--lan` requires forward-auth.

## Belt integration points

- `:4000` belt router — Anthropic wire, `stream:true` streams (push-based SSE
  only: Bun 1.4.x serve does not pump pull()-streams, see
  `lesson.bun-serve-pull-streams-hang`). `/registry.json` is the ONE
  registration source for available LLMs (W271); emitters generate engine/
  routing/upstream config from it.
- Swarm supervision (W272): shim + :890x respawn with backoff + circuit
  breaker; litellm (:4100) joins the same set (W277). Probe-scale budgets
  (<64 tok) are exempt from the always-think min-budget raise.
- Benchmarks live in the belt repo (`benchmarks.md` at its root; the
  bench-arena harness in `bench/arena/`).

## Doc map

| File                                                                                 | Contents                                                                                                                |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [board-api.md](board-api.md)                                                         | The v3 board/task feed contract (owner_label, newest-first, project filter).                                            |
| [decisions-api.md](decisions-api.md)                                                 | Forks/decisions API incl. idempotency echo + NEED% event durability.                                                    |
| [theme-tokens.md](theme-tokens.md)                                                   | Theme token contract + settings block, copy-verbatim for other GUIs.                                                    |
| [design/knowledge-db-2026-10-01.md](design/knowledge-db-2026-10-01.md)               | Knowledge DB design; read-path FTS5 pragmas referenced by `hooks/lib/govdb.ts`.                                         |
| [design/buckle/routing-laws-2026-10-01.md](design/buckle/routing-laws-2026-10-01.md) | Owner-FINAL routing grammar, enforced by `hooks/lib/repo-laws.ts`.                                                      |
| [design/w278-landing-review-2026-10-03.md](design/w278-landing-review-2026-10-03.md) | Post-landing best-approach review (relay cancel path, two-supervisor hazard, condense semantics); fix list = W284–W292. |

## Fleet laws this repo enforces

Streams over buffers · never innerHTML · ≤1500-line .ts · one ledger (the work
graph, never `- [ ]` lists in docs) · composition over inheritance (Lit +
native elements) · secrets as `$ENV` refs, real hosts/keys only in
`~/.claude/local-llm/` (mode 600) · config over code.
