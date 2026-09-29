# Dosu token savings — research digest & klh-stack plan (2026-09-29)

Method: primary sources first (dosu.dev engineering posts fetched in full, the
dosu-ai GitHub org, LiteLLM and Anthropic official docs). Tier marks: T1 =
primary fetched; T1s = primary seen only via search snippet; T2 = second-hand
corroboration; UNVERIFIED = claim could not be traced to any source. Scope per
owner correction: Dosu alone (no LiteLLM angle) — the savings claim is about
their knowledge amassing; the open parts of their stack (dosu-cli, decant)
were shallow-cloned and read directly — see "What the source shows".

## 1. What Dosu actually is

Dosu (dosu.dev, formerly dosu.com) is a hosted "knowledge infrastructure for
agents and humans": it watches a team's coding-agent sessions and support
surfaces, distills what agents learn into a curated knowledge layer (markdown,
"Open Knowledge Format" compatible, synced to GitHub/Confluence/Notion), and
serves it back to coding agents through an MCP server and a bundled agent
skill. Tagline: "One agent learns. All agents know." (T1: dosu.dev/)

Important scope correction for the enterprise eval: **the Dosu product is not
FOSS** — it is SaaS (free tier for public repos; the OSS unlimited tier ended
2026-09-01, T1: dosu.dev/blog/oss-has-changed-so-has-dosu). What IS open
(github.com/dosu-ai, T1):

- `decant` — local-first token/cost analytics over Claude Code / Codex /
  Gemini CLI session JSONL into SQLite; Apache-2.0, TypeScript on Bun.
- `dosu-cli` — MIT, TypeScript on Bun; writes the MCP server into every agent
  config, bundles the agent skill, ships `knowledge hooks enable`,
  `knowledge statusline`, `/dosu-incognito` (mark sessions off-limits).
- `abbs` — "Agent Bulletin Board System" (Go, Apache-2.0); auto-label and
  better-stale-bot built on GitHub Agentic Workflows.

Open but client-side only: the capture/study client (the `learner` module in
dosu-cli — headless Claude Code subprocess, prompt, model pinning, redaction)
and the token analytics (decant). Not open: the LLM gateway behind
`api.dosu.dev/v1/llm-gateway`, the MCP server (retrieval/ranking/dedup at
query time), the LanceDB knowledge graph, and the review agent. We can read
exactly what gets captured, under which model, and how agents are instructed
to consume — not how retrieval ranks or how the 50% is metered.

## 2. The savings claim — verification status

- Owner claim: "Dosu achieves 30-40% token savings by running this on prem as
  a proxy" — **UNVERIFIED. No Dosu source (site, docs, GitHub, HN) states
  30-40%, and nothing about the claim involves an on-prem proxy.** Two
  plausible conflation sources: (a) Dosu's May 2024 post "How Dosu Used
  LangSmith to Achieve a **30% Accuracy** Improvement" (accuracy, not tokens,
  T1s: dosu.dev/blog/how-dosu-used-langsmith-...); (b) the landing page's
  round "50% fewer tokens" figure.
- Dosu's own published numbers (T1, self-reported, no third-party audit):
  - Landing page: "50% Fewer tokens burned by AI coding agents working with
    accurate documentation"; worked example 2,137 tokens (Dosu-equipped) vs
    47,215 tokens (baseline); "2x faster iterations, ~3x more consistent."
  - Blog (agent-budgets post): knowledge infrastructure "can cut cost and
    latency in half."
  - Note the worked example's 95% delta is a single showcase; the honest
    headline they sell is 50%.
- Dosu's own research is the credible backbone (T1, methodology published via
  Decant): 112 agent sessions re-implementing 60 cal.diy PRs — **planning +
  context gathering = 67% of dollars**; writing code only 26%; Claude Code
  reads ~198 tokens per 1 written, Codex 134:1; 46% of spend lands before the
  first line of code. Decant demo archive (119 sessions, 24.2M in / 9.3M out
  tokens, ~$1,252 est): context 68%, planning 22%, communicating 7%, code 3%.
- Dosu's own caution against their marketing (T1: dosu.dev/webinars/
  agent-memory-what-happens-when-its-wrong): head of research Michael Mangus
  explicitly calls out vendors who "report the ratio of tokens stored in
  memory versus the input and call that a token saving"; savings depend on
  maintenance (stale knowledge makes agents spend MORE verifying); cites
  studies where memory systems were net-negative. This is the right frame for
  any number we publish.

## 3. Mechanisms — how they actually reduce tokens

Ranked by weight of evidence in their writing. Every claim T1 unless noted.

1. **Kill re-discovery, not verbosity.** Their thesis: agent spend goes to
   context gathering, and most of that is re-learning things the team already
   knows ("agents tend to relearn things our team already has information
   about" — introducing-decant). Knowledge is "explored once and reused
   everywhere." No prompt compression anywhere in their stack — the savings
   come from not doing the work twice, not from shrinking prompts.
2. **Capture at session end.** A session-end hook queues finished sessions;
   a "study" pass runs on user/assistant turns only (tool output dropped,
   secrets redacted) and writes notes into a team Library, branch-tied until
   the PR merges, then promoted to a candidate Topic. Bulk backfill: the
   `log-to-dosu-knowledge` skill reads the 50 most recent sessions and reports
   "an estimate of the tokens you won't spend on capturing it again."
   (episodic-memory post, august-2026 drop)
3. **Serve back with a standing read rule.** The MCP server exposes
   `read_knowledge`; read cards show the agent exactly which sources/notes
   were returned (sept-2026 drop). A bundled skill instructs agents to read
   shared knowledge before non-trivial work so teammates' agents reuse rather
   than relearn (episodic-memory post).
4. **Precision-over-recall retrieval.** Per-question method selection:
   grep/regex for exact symbols, semantic search when wording differs, graph
   traversal for relationships, agentic retrieval for multi-step work
   ("fusion retrieval"). Procedural notes (how to accomplish a task) beat
   descriptive summaries; even accurate-but-loose context causes scope creep,
   so the read path does a second selection pass. (search-and-retrieval post)
5. **Maintenance as the compounding lever.** Five triggers: time-based decay,
   TTL/LRU eviction, scheduled consolidation ("dreaming" — dedupe/conflict/
   merge, scoped to relevant subsets so cost doesn't explode), update-on-
   insert, and external events (merged PRs update knowledge). Principles:
   localize update blast radius; keep raw episodes immutable with a thin
   semantic layer on top — avoids "context collapse" from repeated lossy
   summarization (ACE paper: 18,282 tokens at 66.7 accuracy collapsed to 122
   tokens at 57.1, below the no-adaptation baseline). (maintenance + episodic
   posts)
6. **Cheap-model gating of expensive work.** On their own pipeline (not the
   user's agent): PRs touching only CI config/lockfiles/generated files skip
   knowledge review entirely (0 credits); everything else gets a cheap
   relevance check first (2 credits) and only then a full review. Tiered
   triage before big-model spend. (sept-2026 drop)
7. **Hybrid vector store under the knowledge graph.** pgvector → LanceDB for
   hybrid vector + full-text search with time-travel versioning; millisecond
   search over millions of vectors. (lancedb-supercharged post; LanceDB case
   study metrics — 90% label accuracy, 70% less manual triage — T2 snippet)
8. **Measure first.** Decant categorizes every session into context /
   planning / communicating / code from raw session JSONL — the baseline that
   makes any savings claim checkable. (decant repo, introducing-decant)

Panel corroboration (T1: agentic-infrastructure post): CodeRabbit keeps
graph-based knowledge that updates from each PR and prefers "less context of
higher quality"; CrewAI's Slack bots prompted "are we paying tokens for the
sake of paying tokens?"; embeddings held up as the durable layer.

## What the source shows (that the blogs don't say out loud)

Shallow clones examined 2026-09-29: `dosu-ai/dosu-cli` (MIT) and
`dosu-ai/decant` (Apache-2.0). Paths are repo-relative; all T1 (read from
source).

1. **The distillation model is a small model, pinned.**
   `src/learner/model.ts:7`: `DEFAULT_LEARNER_MODEL = "claude-haiku-4-5"` —
   session study (the extraction LLM call) defaults to Haiku, resolved at
   runtime from the gateway's `/capabilities`. Blogs never name a model. This
   is the small-model-for-maintenance pattern, in code.
2. **The study run is a headless Claude Code subprocess through Dosu's own
   gateway, metered per run.** `src/learner/env.ts:52-55`: `ANTHROPIC_BASE_URL`
   = `https://api.dosu.dev/v1/llm-gateway`, `ANTHROPIC_AUTH_TOKEN` = user key,
   `ANTHROPIC_MODEL` = pinned model, attribution headers `x-dosu-run-id`,
   `x-dosu-trigger: bootstrap|hook|manual`. Output capped at 32,000 tokens
   (env.ts:59). Triggers: hook, bootstrap, or manual.
3. **Misbilling isolation by env stripping.** `env.ts:25-28`: every
   `ANTHROPIC_*` / `CLAUDE_CODE_*` var is stripped from the subprocess env so
   a study run cannot be rerouted or billed to the wrong account. (Same
   disease our W39/W90 fleet-loop lessons treated: stray model-env vars
   breaking lanes.)
4. **The dedup contract is prompt-level, not client-side code.**
   `src/learner/prompt-core.ts:4-34` (`LEARNER_CORE_RULES`): rule 1 — call
   `read_knowledge` with the candidate topic before writing; skip duplicates
   and near-duplicates; write updates, never restatements. The semantic dedup
   itself runs server-side (closed); the client enforces it by instruction.
   Rule 2: durable-only (decisions+rationale, non-obvious constraints, gotchas
   "that caused real rediscovery cost"). Rule 3: excludes in-flight state,
   test results, PR summaries. Rule 4: walk every user turn —
   "Under-extracting is the failure mode" — with a per-run note cap as volume
   guard. Rule 7: never quote credentials, never long verbatim spans.
5. **The standing rule ships as an installed file with marker sections and a
   bundled fallback.** `src/rules/installer.ts:41-50`: "call `read_knowledge`
   before non-trivial code or documentation work… If unsure whether relevant
   context exists, read first"; `write_knowledge` after the task;
   `finalize_session_knowledge` once per turn with receipt ids. Installed to
   `~/.claude/rules/dosu.md` (Claude), marker-delimited sections in
   AGENTS.md/GEMINI.md, alwaysApply frontmatter for Cursor; rule text fetched
   from GitHub with a bundled copy so offline install never blocks.
6. **Incognito is a transcript marker, not a permission.**
   `src/incognito/agents.ts`: `/dosu-incognito` writes `INCOGNITO_MARKER` into
   the session transcript; the sync filter and statusline read it; the command
   body also tells the model to refuse all Dosu MCP tools for the session.
   Privacy boundary = convention in the transcript.
7. **Redaction is client-side, pattern-based, before anything leaves.**
   `src/sessions/redact.ts` (+ tests): PEM private-key blocks, URL credentials
   (keeps user and host), counted redactions; combined with the prompt rule
   against verbatim spans.
8. **decant's analytics are LLM-free static classification.**
   `decant/src/buckets.ts:3-70`: `ACTIVITY_BUCKETS = [context, planning,
code, communicating]`; static tool-name sets (Read/Grep/Glob/WebFetch to
   context; Edit/Write/apply_patch to code; TodoWrite/plan tools to planning),
   readonly bash/git lists, and search-statement counting that splits
   compounds on `;`/`&&`/`||`/newline but never on `|` (a pipeline tail
   filters output rather than searching). Methodology doc: "does not call a
   model or upload transcripts."
9. **Even Dosu's local token math is chars/4.** `CHARS_PER_TOKEN = 4`
   (digest.ts in both repos): local token "measurements" are estimates;
   precise metering lives at their gateway. Their own webinars say ratios
   from such counts are not savings.
10. **Client-side gap.** The retrieval/ranking/dedup inside the MCP server's
    `read_knowledge`, the relevance gating that picks which sessions get
    studied, and the credit-tiering engine are server-side (closed). The open
    client shows what is captured and how agents are told to consume; it
    cannot show how returns are ranked or how the 50% is metered.

Net: the savings architecture is three moving parts a control plane can copy
verbatim — (a) a small-model, hook-triggered capture loop with
read-before-write dedup and a note cap, (b) a standing read rule plus an MCP
tool that makes consulting cheaper than re-discovering, (c) gateway-side
metering so savings claims are auditable. Blogs round (c) to "50%"; the code
shows that number is produced behind their closed gateway — unverifiable.

## Features for the klh stack

Ranked. Effort: S = days, M = ~1-2 wks, L = multi-wk. Dependencies reference
what exists today: governor.db `facts` (key/value/source/version/ts),
`consult_kb` (problem/solution/hits/last_hit_at), `events` + per-agent
cursors, `deltas` row-image log, the hooks/gates pipeline, belt's router
(LiteLLM gateway + local MLX specialists), fleet session JSONL under
`~/.claude/projects`.

1. **Adopt decant as the fleet token ledger (S).** Run their Apache-2.0 tool
   against fleet lane session JSONL — instant category breakdown (context vs
   planning vs code) and per-model economics. Why first: Dosu's whole thesis
   is measured, not asserted; every later feature needs this baseline.
   Deps: none (reads ~/.claude/projects; lanes already produce it). Store
   rollups in `facts` (`metrics.tokens.*` keys already exist in govdb.ts).
2. **Prompt-caching hygiene at the belt gateway (S).** Verify LiteLLM
   passes through Anthropic `cache_control`; make lane system prompts +
   tool definitions byte-stable prefixes; pre-warm with `max_tokens: 0`.
   Why: cache reads cost 0.1x base input (90% discount, Anthropic docs T1) —
   with 198:1 read:write ratios this is the largest mechanical win available
   without new features. Deps: belt LiteLLM config only.
3. **`read_knowledge` MCP tool over governor.db (M).** Expose facts +
   consult_kb + curated lessons to lanes via MCP with hybrid retrieval
   (SQLite FTS5 first; sqlite-vec/LanceDB only if needed). consult_kb already
   tracks hits — reuse it as the usage counter. Why: this is Dosu's core move
   — agents consult before re-discovering. Deps: govdb schema (exists), an
   MCP server shell, coord auth model.
4. **Session-end study hook (M).** Suspenders Stop/SessionEnd hook queues
   finished lane sessions; a cheap-model pass distills candidate facts with
   provenance (source sid, episode pointer), branch-scoped until the PR
   merges (work graph `result_sha` gates promotion). Secrets redaction and
   user/assistant-only scope, copying Dosu's pipeline. Deps: hooks/ gates,
   facts table, belt local models for cheap distillation.
5. **Cheap-model triage routing in belt (S/M).** Route classification-shaped
   calls (gate advice, event dedup, relevance checks) to belt's MLX
   specialists; reserve big models for final answers — Dosu's credit-tiering
   generalized to our traffic. Deps: belt router classes (exists), per-class
   routing rules.
6. **Exact-match response cache at the gateway (S).** LiteLLM `cache: True`
   (Redis past one worker) for deterministic repeat calls — gate evaluations,
   advice on unchanged diffs. Note LiteLLM's own warning: semantic caching
   "goes badly wrong on agentic traffic" — exact-match only in phase 1.
   Deps: belt LiteLLM config + Redis.
7. **Impact measurement harness (S/M).** Fork-comparison A/B: same task with
   and without knowledge injection; track consult_kb hits vs tokens spent per
   task in facts. Dosu's webinar (T1) is explicit that naive token ratios
   lie — this is the honest-metrics feature that makes the enterprise pitch
   defensible. Deps: feature 3, decant ledger.
8. **Knowledge maintenance job ("dreaming") (M).** Scheduled consolidation:
   dedupe/merge conflicting facts, decay-weight retrieval, update-on-insert
   when work items complete (events bus already carries merge-shaped facts).
   Localized blast radius per project. Deps: features 3-4.
9. **Proxy-side context assembly in belt (L).** Belt injects top-k relevant
   facts into lane requests before dispatch — the full Dosu posture with the
   proxy doing assembly. Only after 3+4 prove hit rates; cache-prefix
   stability (feature 2) constrains where injection may happen.
10. **Context-editing policy for long lanes (M).** Anthropic context
    management (`clear_tool_uses_20250919`) via belt for marathon sessions;
    docs (T1) warn each clear invalidates cached prefixes — tune with
    `clear_at_least`, pair with the memory tool. Deps: belt passthrough,
    feature 2 interplay.

Shelf items deliberately not ranked: LLMLingua/prompt compression (T2,
llmlingua.com / arXiv 2310.05736) and GPTCache (T2, zilliztech/GPTCache) —
Dosu uses neither and our savings thesis (kill re-discovery) doesn't need
them; revisit only for fixed-prompt classification endpoints.

## Work required

### Phase 1 — measure + mechanical wins on the existing gateway (days)

1. Install decant, sync fleet lanes, record baseline: category split, $/task,
   read:write ratio per lane type (decant economics). Publish numbers to
   facts so later claims are auditable.
2. Belt config pass: confirm `cache_control` passthrough end-to-end; freeze
   system-prompt prefix bytes (no timestamps in prefixes); enable
   exact-match Redis cache for gate/advice endpoints; add cache-hit-rate and
   saved-$ readout from LiteLLM spend tracking to the fleet board.
3. Belt routing rules: classification/relevance calls → local specialists.
4. Exit criteria: baseline dashboard live; cache hit rate visible; per-class
   model mix recorded.

### Phase 2 — knowledge-store retrieval over governor.db (1-2 wks)

1. `read_knowledge` MCP server (TypeScript/Bun): FTS5 index over facts +
   consult_kb + lessons; hit counters on every read (reuse consult_kb.hits).
2. Session-end study hook: distill lane sessions into candidate facts with
   provenance; branch-scoped promotion on merge via work graph result_sha;
   secrets redaction; `/incognito` equivalent for sensitive lanes.
3. Standing rule distributed via AGENTS.md/CLAUDE.md plumbing: consult
   knowledge before non-trivial work; return source references, not
   paraphrases (Dosu's evidence-preservation rule).
4. Read transparency: log which facts were served into which request (the
   read-card equivalent) — also the audit trail an enterprise buyer expects.
5. Exit criteria: measurable drop in context-phase tokens on tasks matching
   existing knowledge, from the phase-1 ledger.

### Phase 3 — proxy-layer context assembly (multi-wk)

1. Belt assembly middleware: request-time injection of top-k facts with
   decay weighting; injection point chosen to preserve cache prefixes.
2. Dreaming job: scheduled consolidation (dedupe/conflict-scope/merge) per
   project; update-on-insert wired to work-item completion events; decay
   scoring (Generative-Agents-style recency x importance x relevance is the
   documented starting recipe — episodic-memory post).
3. A/B harness: forked-session comparisons with/without injection; publish
   task-level outcomes (accuracy + tokens + time), never bare ratios (Dosu
   webinar discipline). This artifact is the enterprise sales asset.
4. Optional: sqlite-vec/LanceDB embeddings over facts when FTS5 recall
   becomes the bottleneck — Dosu only moved to vector hybrid at millions of
   notes; don't start there.

### Explicit non-goals (evidence-based)

- Prompt compression (LLMLingua et al): no evidence Dosu uses it; orthogonal
  to the re-discovery thesis.
- On-prem proxy as a savings mechanism: the owner's original framing —
  nothing in Dosu's material supports proxy placement as the source of
  savings; the knowledge layer is the mechanism.
- Semantic caching for agentic traffic in phase 1: LiteLLM docs' own warning.
