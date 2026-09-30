# Magnitude — benchmark vs our QA setup (2026-09-30)

Research note. Tiers: T1 = read in source/registry, T2 = docs/community statements, UNVERIFIED = not confirmable.
Researched by a fleet lane; landed by the coordinator after the lane's session lacked file tools.

## Summary

`magnitudedev/magnitude` no longer hosts the AI test agent — the repo was deleted and recreated 2026-06-12 and is now an Apache-2.0 local-model **inference engine** (`@magnitudedev/cli`, 0.2.0/0.2.1 released 2026-09-30) with OpenAI- and Anthropic-compatible localhost endpoints (T1: repo API metadata, README, LICENSE, releases, tags). The test agent survives as `magnitudedev/browser-agent` (4.1k stars, Apache-2.0, last push 2026-02-08, no releases; npm `magnitude-test@0.3.13` / `magnitude-core@0.3.1`) — a vision-first agent grounding natural-language steps to **pixel coordinates** via a visually-grounded LLM (Claude Sonnet 4 recommended, Qwen2.5-VL 72B as OSS option, official `openai-generic` provider with custom baseUrl), Playwright underneath, with a two-phase post-action stability wait (network-idle filtering analytics, then sharp pixel-diff visual settle) as its main flake-reduction mechanism (T1: `planner.baml`, `web/stability.ts`, docs). The launch-era headline — natural-language plan caching for deterministic replay — **never shipped**: the README still marks caching "(in progress)", so every run re-plans through the LLM (T1/T2).

## 1. Architecture / mechanism (T1 unless noted)

- Tests: `test('name', async (agent) => { await agent.act('Log in'); await agent.check('Dashboard is visible') })` in `.mag.ts` files; `magnitude.config.ts` (url, Playwright contextOptions, webServer autostart, continueAfterFailure, telemetry:false). NL data per step via `{ data }`.
- Grounding: pure vision — a visually-grounded LLM returns pixel coordinates from screenshots; explicitly not DOM/set-of-marks. Requires Sonnet-4-class or Qwen2.5-VL 72B/32B, UI-TARS, Molmo; `openai-generic` provider with custom baseUrl is officially supported (OpenAI-compatible endpoints work; belt-routable in principle). OpenAI/Gemini/Llama models flagged NOT grounded.
- Agent loop (`baml_src/planner.baml`): plan-ahead — "plan as many actions as possible, stopping at the point where you will need to observe"; execute serially; screenshot observation; repeat. Prompt caching: Anthropic `cache_control` cycling with a 4-point budget and retention-masked observation window. Quirk: prompts spoof "You are Claude Code" (`includeClaudeSpoof`).
- Flake reduction (`web/stability.ts`): after EVERY action — network-idle wait (filters analytics/ads/streaming/websocket, 500ms idle, 5s cap) then visual settle: sharp raw-pixel mean diff < 0.01 across 3 consecutive 100ms checks.
- Determinism: the HN-era plan cache (NL action structs, confidence-drift re-planning, no cached coordinates) never shipped. Every run re-plans via the LLM (T1/T2).
- Runner: Playwright underneath (rebrowser-playwright), worker pool, webServer autostart, GitHub Actions example needs Xvfb (headful) + API keys. `magnitude-mcp` exposes open_browser/act/screenshot for any MCP agent.

## 2. Benchmark vs gaps QA

| Axis                     | Magnitude / browser-agent                                                                               | gaps qa (Playwright + lanes)                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Authoring cost           | Very low per test (NL `act`/`check` steps) (T1 docs)                                                    | Higher per test (locators + pend triage), but zero per-run model cost (T1 report)                             |
| Determinism / replay     | Plan cache promised, never shipped — re-plans via LLM each run (T1 README; T2 HN)                       | Locators replay exactly; 7/232 flaky explicitly tracked (T1)                                                  |
| CI fit                   | Headful browser (Xvfb), API keys in CI, fail-fast default (T1 ci.mdx)                                   | Headless on the fleet against the packaged artifact (T1)                                                      |
| Model cost per run       | Grounding-capable model (Sonnet-4 class / Qwen2.5-VL-72B) per step; WebVoyager avg 15.5 steps/task (T2) | Zero tokens; 232 tests in ~19.4 min (T1)                                                                      |
| Maintenance on UI change | Self-healing — NL steps survive re-layout silently (T2)                                                 | Explicit RE-POINTED/RETIRED-SURFACE pend discipline; silent adaptation treated as masking, not a feature (T1) |
| Reporting                | Terminal UI + pass/fail (T1)                                                                            | REPORT.md + ALERT + pend taxonomy with owner gates (T1)                                                       |

## 3. Verdict

**(b) steal mechanisms — do not adopt the executor.**

- **Not adoptable as a test executor:** the project is abandoned in that form (upstream repo deleted; browser-agent dormant since 2026-02-08; no tagged releases; deterministic cache never shipped; requires a visually-grounded frontier model per step). It would put an unmaintained LLM dependency into a QA path our data-* locator law already beats on determinism, cost, and speed.
- **Steal list (concrete):**
  1. **Post-action two-phase stability wait** (T1, `browser-agent/.../web/stability.ts`): after each action — network-idle wait (ignore analytics/ads/streaming/websocket, 500ms idle, 5s cap) then visual settle (pixel mean-diff < 0.01, 3 consecutive 100ms checks) before screenshot/observation. Port shape: into the gaps qa driver used by `qa_run_control`/`qa_screenshot` — attacks exactly our 7 "flaky-ok" entries. ~80 lines of TypeScript; `sharp` the only new dep (or reuse Playwright's screenshot-diff machinery).
  2. **Confidence-escalation shape** (T2, founder statements): cheap executor handles replay; escalate to the expensive model only when confidence drops. Maps 1:1 onto our local-swarm-first/cloud-escalate doctrine (:8901-8903 routing) — local model proposes the re-pointed locator, cloud only on drift. Doctrine note, no code.
  3. **Plan-ahead prompt lesson** (T1, `planner.baml`): "plan as many safe actions as possible, stop where you must observe"; they _simplified_ chain-of-thought after it caused underplanning. One line for QA-repair lane prompts.
- **The modern inference engine**: Apache-2.0, macOS/Linux, OpenAI-compatible (`/inference/v1`) + Anthropic-compatible localhost endpoints, hardware profiling + model recommendations (llama.cpp-based, Rust). Belt could route a swarm lane at it as an alternative backend — we already run a local swarm; watch item, not adoption.
- **qlty gate fit:** the stability-wait port lands in the gaps repo (own its qlty spec first), not suspenders.

## Sources

browser-agent repo files (stability.ts, planner.baml, package.json, docs/*), magnitude repo (README/LICENSE/docs/releases/tags), GitHub API repo/org meta, npm registry metadata, news.ycombinator.com/item?id=43796003, github.com/magnitudedev/webvoyager, local gaps-qa report 2026-09-30.

## Could not verify

1. Exact npm publish dates for `magnitude-test` versions (npm `time` object unreachable) — dating rests on browser-agent's last push (2026-02-08) and the 0.3.13 manifest in that tree.
2. Whether the hosted "Magnitude testing platform" (0.3.x pivot) still operates — `docs.magnitude.run` DNS-dead from here; no deprecation notice found.
3. Per-run token cost figures — no public numbers exist.
4. Port `:10100` for the inference server endpoints — from an AI-generated page citing `icn-api/src/lib.rs` (T2); surfaces confirmed, port unconfirmed in primary docs read.
