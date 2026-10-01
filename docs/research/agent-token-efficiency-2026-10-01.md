# Agent token efficiency — empirical literature dig (2026-10-01, W121)

Research lane deliverable. Question: where do agent tokens actually go, and which
interventions have measured effects? Every number below is tier-marked: **T1** =
primary source fetched this pass (arXiv full text/abstract or vendor engineering
post); **T2** = search-result summary only, not independently fetched; **ours** =
measured in this repo (W109/W111/injection cells, see companion docs). Baselines
this dig compares against: `token-patterns-journals-2026-09-30.md` (W109),
`decant-benchmark-2026-09-30.md` (W111), `dosu-token-savings-2026-09-29.md`.

## 1. Where tokens go

| Sink                                                      | Number                                                                                                                                                                                                                               | Source                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Trajectory composition, coding agent (SWE-bench Verified) | avg 48.4K tokens / 40 steps per issue: tool messages 30.4K (63%), assistant 13.7K — of which **11.9K are tool-call arguments**, system/user 4.4K. Accumulates to **~1.0M tokens per issue** across context replay                    | AgentDiet, arXiv:2509.23586 (T1)                                       |
| Input dominance                                           | 99% of daily Claude-4-Sonnet tokens on OpenRouter are input, 1% output; "input tokens drive ~93% of repair cost" in one-shot repair                                                                                                  | AgentDiet + state-in-context replication arXiv:2606.01326 (T1)         |
| Activity split, real coding sessions                      | planning + context gathering = **67% of dollars**, code 26%; **46% of spend before the first line of code**; Claude Code reads ~198 tokens per 1 written (Codex 134:1), 112 replayed sessions                                        | Dosu/decant methodology (T1, their post; replicated shape in our W111) |
| Activity split, decant demo archive                       | context 68%, planning 22%, communicating 7%, code 3% (119 sessions, 24.2M in / 9.3M out)                                                                                                                                             | decant demo (T1, fetched 2026-09-29, our Dosu doc)                     |
| Activity split, our fleet                                 | context 51.9% cache-aware / 58.4% standard-rate; lanes worst at 61.2%; planning = 59.4% of output tokens but 8.9% of cost                                                                                                            | ours, W111 (counted, 833 files/7d)                                     |
| Multi-agent overhead                                      | multi-agent ≈ **15x** chat tokens; single agent ≈ **4x** chat; token usage alone explains **80%** of performance variance (BrowseComp)                                                                                               | Anthropic multi-agent research system (T1)                             |
| Tool-call arguments are the assistant-side sink           | 11.9K of 13.7K assistant tokens per trajectory are tool-call args, not prose                                                                                                                                                         | AgentDiet (T1)                                                         |
| Failed-edit prevalence                                    | 51.7% of GPT-4 Turbo trajectories contain ≥1 failed edit; edit success falls **90.5% → 57.2%** after one failure; 23.4% of failures cascade into further failed edits; resolved runs median $1.21/12 steps vs unresolved $2.52/21    | SWE-agent, arXiv:2405.15793 §5.2 (T1)                                  |
| Step repetition is the top multi-agent failure mode       | FM-1.3 step repetition = 15.7% of annotated failures (largest of 14 modes); system-design ~44% / inter-agent misalignment ~32% / verification ~23% of modes (sums computed from per-mode prevalences, not stated as category totals) | MAST, arXiv:2503.13657 (T1)                                            |
| Error rates in our own fleet                              | 1,932 Edit-attributed tool errors/7d (490 anchor-class); lane tool-error rate 15.1% vs main 6.6%; 1,412 full-file reads; 90 auto-compacts                                                                                            | ours, W109 (counted, 293 transcripts)                                  |

Headline convergence: three independent measurements (decant, AgentDiet, our W111)
put **context/input accumulation, not generation, at roughly 50-70% of agent
spend**, and the assistant-side share is dominated by tool-call arguments rather
than prose. Nobody's tokens mainly go to "writing code".

## 2. Interventions with measured effects

| Intervention                                                                                    | Measured effect                                                                                                                                                                                                                                                                                                    | Source                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Interface design (ACI)** — edit command with linting guardrail                                | Removing it is the single worst ablation: 18.0% → 10.3% resolved (−7.7pp); edit without linting −3.0pp. Full-file viewer instead of 100-line window: −5.3pp. Full history instead of last-5-observations: −3.0pp. Guardrails "prevent wasted steps"                                                                | SWE-agent Table 3 (T1)                                                                                                    |
| **Pipeline instead of agent loop** (decompose→localize→repair→validate)                         | 32.0% resolved at **$0.70 / 78K tokens** vs SWE-agent 18-23% at **$2.51-2.53 / 245-521K tokens** (SWE-bench Lite) — ~3.6x cheaper per instance at higher resolve rate. Reproduction-test validation: 77 → 96 fixes (+7pp) for $0.25                                                                                | Agentless, arXiv:2407.01489 Table 1 (T1)                                                                                  |
| **Edit format as interface** — unified diffs for GPT-4 Turbo                                    | Laziness benchmark score 20% → **61%**; 3x fewer lazy-comment outputs. "Whole file" format is easiest but token-heaviest                                                                                                                                                                                           | Aider unified-diffs writeup (T1: aider.chat/docs/unified-diffs.html via search summary, figures from their own benchmark) |
| **Concise tool responses**                                                                      | 206 → 72 tokens (~1/3) for the same payload; Claude Code truncates tool responses at 25K tokens by default; recommend `response_format` enum, pagination, actionable error text                                                                                                                                    | Anthropic "Writing effective tools for agents" (T1)                                                                       |
| **Self-improving tool descriptions**                                                            | 40% decrease in task completion time (internal eval)                                                                                                                                                                                                                                                               | Anthropic multi-agent post (T1)                                                                                           |
| **Induced workflow reuse** (AWM)                                                                | WebArena +51.1% relative SR (35.5 vs 15.0 baseline), success steps 5.9 vs 7.9; Mind2Web +24.6% relative. **Correction: the AWM paper has NO SWE-bench experiments** — web navigation only                                                                                                                          | AWM, arXiv:2409.07429 v1 (T1)                                                                                             |
| **Insight/experience reuse without fine-tuning** (ExpeL)                                        | ALFWorld 40.0 → 59.0 (+19) over ReAct; HotpotQA 28.0 → 39.0 (+11); matches Reflexion at R3 **without retries**; transfer HotpotQA→FEVER +7                                                                                                                                                                         | ExpeL, arXiv:2308.10144 Tables 2/3/5 (T1)                                                                                 |
| **State-conditioned guidelines** (AutoGuide)                                                    | ALFWorld 54.5 → 79.1; WebArena-Reddit 8.0 → 43.7; WebShop 38 → 46 (all vs ReAct). Concise retrieved guidelines avoid the context overload of many-shot prompts                                                                                                                                                     | AutoGuide, arXiv:2403.08978 (T1)                                                                                          |
| **Workflow/state-machine scaffolding** (StateFlow)                                              | +13%/+28% success over ReAct (InterCode SQL / ALFWorld) at **5x/3x less cost**                                                                                                                                                                                                                                     | StateFlow, arXiv:2403.11322 abstract (T1)                                                                                 |
| **Retrieve-when-needed vs always-preload** (Self-Route)                                         | Route RAG-vs-long-context per query: cost −39% (GPT-4o) / −65% (Gemini 1.5 Pro) at ≈equal quality (46.83 vs 47.04); 63% of queries get identical predictions via RAG; routing step costs ~1.5K tokens vs 10-100K full contexts                                                                                     | Self-Route, arXiv:2407.16833 (T1)                                                                                         |
| **Retrieval timing** (FLARE/DRAGIN)                                                             | DRAGIN (entropy×attention trigger) beats FLARE: HotpotQA EM 0.314 vs 0.180; ~2.5-4.8 retrievals/query, fewer than fixed-frequency baselines on most cells — when-to-retrieve beats always-retrieve                                                                                                                 | DRAGIN, arXiv:2403.10081 Table 2/3 (T1)                                                                                   |
| **Prompt/context compression** (LLMLingua)                                                      | up to 20x compression with little performance loss (GSM8K, BBH, ShareGPT, Arxiv)                                                                                                                                                                                                                                   | LLMLingua, arXiv:2310.05736 abstract (T1)                                                                                 |
| **Source-code minification before the prompt**                                                  | 42% context-length reduction cost 12pp absolute (50.0 → 38.0 resolved); docstring-removal alone −27% cost at <5pp loss; 100K-token repair context caps target-file recall ~91% (20K cap → <70%)                                                                                                                    | state-in-context replication, arXiv:2606.01326 (T1)                                                                       |
| **Loop-level trajectory pruning** (AgentDiet: small-model reflection module rewrites old steps) | agent-step cost **−28.6% to −44.1%** at −1.0 to +2.0pp pass-rate change; prunes 69-77% of processed step content; also cuts steps 57.2 → 43.9 on one benchmark. Key negative result: **self-managed cleanup fails** — agents told to call an erase tool "often persist on the original task without calling erase" | AgentDiet, arXiv:2509.23586 (T1)                                                                                          |
| **Model routing** (RouteLLM)                                                                    | >2x cost reduction without quality compromise (abstract figure; the often-cited "95% of GPT-4 quality at 85% saving" is NOT in the abstract)                                                                                                                                                                       | RouteLLM, arXiv:2406.18665 (T1)                                                                                           |
| **Parallel sub-agent dispatch**                                                                 | 3-5 parallel subagents + 3+ parallel tools per subagent cut research latency up to 90%; subagents should explore in tens of thousands of tokens but return 1,000-2,000-token summaries                                                                                                                             | Anthropic multi-agent post (T1)                                                                                           |
| **Knowledge push at entry vs pull mid-work**                                                    | PUSH (inject at brief assembly) −33% tokens / −25% turns vs blind; pull-style hub queries neutral-to-negative; value rides **file-level pointer density**, not distillation                                                                                                                                        | ours, injection-final + W113 cells (n=1 each, directional)                                                                |
| **Hook-enforced guardrails** (our analog of SWE-agent linting)                                  | 31 edit-enforce/content-gate denials in 7d, each naming the fix — the ACI "guardrail prevents wasted steps" result already implemented as gates                                                                                                                                                                    | ours, W109 (counted)                                                                                                      |

## 3. Literature vs our measurements

| Axis                         | Published state of the art                                                                                        | Ours                                                                                                                                         | Verdict                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context share of spend       | Dosu claims 38-58% band (T2, unverified); decant demo 68%; planning+context 67% of dollars (their T1 methodology) | 51.9% cache-aware / 58.4% standard — **inside the band**; lanes 61.2% exceed it                                                              | At parity with what's published; our measurement is more conservative (cache-aware) and better cited than the vendor claim                                                                                                 |
| Edit-failure quantification  | SWE-agent: 51.7% trajectories with ≥1 failed edit, 90.5→57.2% success after a failure, 23.4% cascade (§5.2)       | 1,932 Edit errors/7d, 490 **anchor-class**; 15.1% lane error rate; edit churn = #1 waste sink (~1.5-2M tok/day)                              | **We are ahead**: no published source isolates anchor-miss ("string not found") as a class — W109 appears to be the first measurement of it                                                                                |
| Guardrails on edits          | SWE-agent linting ablation −7.7pp = guardrails prevent wasted steps                                               | content-gate parse-checks pre-write; 31 denials/7d naming the fix                                                                            | At/past published practice — our gates are the SWE-agent result operationalized as hooks; the **missing half** is the anchor-existence check (their edit command checks validity; ours doesn't yet check anchor existence) |
| Context pruning of old turns | AgentDiet: −28.6 to −44.1% step cost at ≈equal quality, via a small-model reflection module                       | **Nothing equivalent** — we compact (90 auto-compacts/7d) but have no step-level pruning                                                     | **Gap** — the largest measured intervention we have not built                                                                                                                                                              |
| Tool-result size discipline  | Claude Code truncates at 25K tokens; Anthropic recommends pagination + concise formats (206→72 tokens)            | Prescription only (auto-clamp 40KB) — not implemented; 23 oversized pulls >60KB and 1,412 full reads in 7d                                   | **Gap**, cheap to close                                                                                                                                                                                                    |
| JIT retrieval vs preload     | Self-Route −39/−65% cost; DRAGIN beats FLARE on retrieval timing                                                  | Our rg-first habit (6,345 rg vs 497 ls-walk) is the behavioral version; no enforcement                                                       | Partially there culturally, unenforced mechanically                                                                                                                                                                        |
| Guidance/experience reuse    | ExpeL +19/+11, AutoGuide up to +35.7pp, AWM +51.1% relative (quality, not tokens)                                 | PUSH injection −33% tokens / −25% turns (measured for tokens, which the academic line does not report); W113: pointer density is the carrier | Ahead on the token dimension and on honest n=1 method; behind on automation (capture is not yet session-end automatic)                                                                                                     |
| Interface design for tools   | Anthropic: concise responses ~1/3 tokens; self-improving tool descriptions −40% completion time                   | Brief-quality lever identified (median 17 vs 35 tools to first edit) but briefs still lack file-maps/line-anchors                            | **Gap**, template-level fix                                                                                                                                                                                                |
| Multi-agent overhead         | 15x chat tokens, token use = 80% of variance (Anthropic T1)                                                       | 3 orchestrators + 290 subagents + lanes with per-layer splits (W111)                                                                         | We measure the overhead more finely than the published numbers                                                                                                                                                             |

## 4. Ranked experiment backlog for our harness

Each: expected saving grounded in our numbers, cost to run, falsification
condition. Ranked by (expected saving / cost).

1. **Anchor-existence PreToolUse gate with nearest-match denial.** Before Edit
   applies, verify the anchor string exists in the target file; on miss, deny with
   the nearest matching 3-line context (auto-rg in the denial text).
   Expected: 490 anchor-class errors/7d, each costing a re-read (8-15K tokens) +
   1-2 retry turns ≈ 0.5-1.0M tok/day of the 1.5-2M edit-churn sink; grounded by
   SWE-agent's edit-guardrail ablation (−7.7pp when absent) — validity checking is
   the single most valuable interface element in the literature.
   Cost: ~1 day (extend content-gate).
   Falsify: anchor-class rate does not drop over the next 7d window, or denial
   text adds more tokens than the saved retries (measure retries per anchor
   denial before/after).
2. **Tool-result auto-clamp at 40KB (head+tail elision) + data-file read rule.**
   Expected: the 0.4-0.8M tok/day full-read sink (1,412 offset-less reads, 23
   pulls >60KB); grounded by Claude Code's own 25K-token truncation default and
   AgentDiet's finding that tool messages are 63% of trajectory tokens.
   Cost: small (gate on tool_result size; CLAUDE.md rule for .jsonl/.log reads).
   Falsify: clamp triggers an immediate full re-read more than half the time
   (net tokens rise) — then clamp only data files, not source.
3. **Compact checkpoint rule (rolling STATE.md + post-compact first action =
   read checkpoint).** Expected: ~0.6-1.0M tok/day of the 1.3M compact-amnesia
   sink (90 auto-compacts/7d); grounded by Anthropic's compaction/note-taking
   guidance (Pokémon tallies) and our own T2 re-derivation observation.
   Cost: trivial (CLAUDE.md rule + SessionStart/compact hook nudge).
   Falsify: post-compact re-read spikes do not fall (W109's re-derivation was
   T2-inferred; this experiment is also the honest test of that inference).
4. **Dispatch-brief file-maps with line anchors (pointer-grade injection).**
   Expected: subagent exploration calls fall toward the main-session pattern
   (17 vs 35 median tools to first edit); on nav-heavy repos this replicated as
   −33% tokens in the injection cell; W113 says value = file-level pointers, so
   briefs should carry paths + anchors, not summaries.
   Cost: template change in orchestrator dispatch.
   Falsify: the W113 small-repo tax replicates (+26.7% on the small repo) —
   gate injection on repo size / existing file-map coverage.
5. **Loop-level trajectory pruning with a belt local model (AgentDiet analog).**
   Expected: 20-35% of lane input tokens (AgentDiet: −28.6 to −44.1% at ≈equal
   quality); lanes are our worst context-share layer (61.2%).
   Cost: multi-week (gateway middleware + a local reflection model + eval).
   Falsify: task success drops >2pp on replayed work items, or reflection
   overhead exceeds 15% of savings. Note AgentDiet's negative result: this must
   be hook/gateway-enforced, not agent-initiated — agents under-call erase tools.
6. **Gate/classifier calls to local models + exact-match cache.** Expected:
   mostly wall-clock (86 429/classifier stalls/7d), not tokens; removes
   self-competition between orchestrator classifier and lanes.
   Cost: config (belt routing).
   Falsify: classifier block/error rate rises materially.
7. **Session-end knowledge capture (ExpeL/Dosu pattern, our phase-2 item).**
   Expected: quality-bearing more than token-bearing at first (ExpeL/AWM report
   success-rate wins, not token wins; Dosu's own webinar warns naive ratios
   lie and stale knowledge costs more than it saves).
   Cost: 1-2 weeks.
   Falsify: post-capture verification spend (agents re-checking served facts)
   exceeds re-discovery savings — exactly Dosu's documented failure mode.

## 5. Could-not-verify

- **Dosu "50% fewer tokens"** — marketing landing-page figure; produced behind
  their closed gateway; their own head of research calls naive memory-ratio
  claims invalid. The 38-58% context band in our W111 doc is likewise their T2
  claim, not an audited number.
- **AWM on SWE-bench** — the lead hinted at SWE-bench wins; the paper
  (v1, T1) contains only Mind2Web/WebArena. Any SWE-bench AWM numbers
  circulating come from elsewhere.
- **RouteLLM "95% GPT-4 quality at 85% cost cut"** — commonly quoted; abstract
  states only ">2x cost reduction" (T1). Per-benchmark tradeoffs are in the PDF,
  not fetched.
- **TRAIL "841 errors in 148 traces"** — 148 traces confirmed (T1 abstract); the
  841-errors figure and per-category counts appear only in search summaries (T2).
- **FLARE numeric confidence threshold** — not in the abstract (T1); DRAGIN's
  comparison table is the quantitative source for FLARE's retrieval behavior.
- **Self-RAG quantitative wins** — abstract is qualitative ("outperforms
  ChatGPT and retrieval-augmented Llama2-chat"); no numbers fetched.
- **MAST 41-86.7% failure rates** — verified in full-text intro (T1), but
  per-system rates live only in Figure 5 (image, not parsed); category shares in
  §3 above are sums of per-mode prevalences, our arithmetic, not their claim.
- **Anchor-miss Edit failures in the literature** — nothing published measures
  string-not-found anchor failures as a class. SWE-agent §5.2 (failed-edit
  cascades) is the nearest neighbor. Our W109 count appears to be the first.
