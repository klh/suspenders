# Agent memory architectures — consolidation, forgetting, re-serving (W119, 2026-10-01)

Owner directive 2026-10-01: survey what the literature does for consolidating,
deduplicating, forgetting, and re-serving distilled agent knowledge, and map it
against our knowledge-worker plane. Question set: who consolidates, when, with
what ops; who forgets and how; does any production system capture at session
end and what do they report about capture rates/noise.

Method: primary sources — arXiv full-text HTML for each system, plus one
read-into-source-code pass (mem0 OSS) and vendor docs/blogs where no paper
exists. Tier marks: **T1** = paper full text or code read directly; **T2** =
vendor blog/docs or secondhand; **UNVERIFIED** = no traceable source. Numbers
are quoted from tables, not paraphrases.

Our ground truth (T1, read for this doc): `hooks/knowledgeworker.md` (the
distill prompt), `hooks/lib/knowledge.ts` (search/dedup/substitution/trust),
`hooks/lib/knowledge-ports.ts` (queue + states + curate), `hooks/bin/knowledge-worker.ts`
(the drain loop), `hooks/lib/harvest.ts` (mechanical transcript signals),
`hooks/session-end.ts` (marks sessions CLOSED — captures nothing), and the
prior source trace `docs/research/dosu-knowledge-mechanism-2026-09-30.md`
(production session-end capture, cited from that doc's T1 reads).

Live hub stats at writing time (T1, read-only query of governor.db): 229
knowledge rows, **all** `candidate` (0 active, 0 retired); 157 rows carry
`source_ref`, 72 without; 148 rows curate-flagged; 0 supersessions ever
recorded; queue 114 done / 48 failed / 0 queued. (The W112 fact's "59/229 name
a path token, 22 with no source_ref" predates later ingest; live counts now.)

---

## 1. Taxonomy — five architecture families

### 1.1 Hierarchy family — MemGPT (Packer et al., arXiv 2310.08560) / Letta

OS-style virtual context management. **Main context** (in-prompt, "RAM") has
three parts: system instructions; a **working context** ("fixed-size
read/write block of unstructured text, writeable only via MemGPT function
calls"); and a **FIFO queue** of messages whose first slot holds "a recursive
summary of messages that have been evicted". **External context** ("disk") is
**recall storage** (every message + output, written automatically) and
**archival storage** (arbitrary-length text, PostgreSQL + pgvector, HNSW).
All movement between tiers is self-directed: the model calls functions to edit
working context, search recall/archival, and append to main context —
over-capacity errors are fed back so the model adjusts.

Two load-bearing mechanics: (a) **heartbeat** — `request_heartbeat=true` makes
the processor rerun the LLM immediately after a function result, chaining
multi-step retrieval, while a "yield" pauses until the next event; (b)
**memory pressure** — at the warning token count (~70% of window) a system
message warns of eviction, giving the model a chance to rescue facts into
working context or archival; at flush (~100%) it evicts ~50% and regenerates
the recursive summary. Evicted messages stay permanently in recall storage —
MemGPT does not forget at the store level.

Table numbers (T1): Deep Memory Retrieval accuracy — GPT-3.5-Turbo 38.7% →
66.9% with MemGPT; GPT-4 32.1% → 92.5%; GPT-4-Turbo 35.3% → 93.4%
(ROUGE-L 0.359 → 0.827). Nested-KV: GPT-3.5 drops to 0% at one nesting level;
MemGPT+GPT-4 unaffected by depth. Today's Letta renames the tiers (core
memory blocks / recall / archival — blocks "always visible - no retrieval
needed", T2 docs) and adds **sleep-time agents** (§2.1).

### 1.2 Log + reflection family — Generative Agents, Reflexion, ExpeL

**Generative Agents** (Park et al., arXiv 2304.03442). Memory stream of
observations, each with creation + last-access timestamps. Retrieval score =
α·recency + α·importance + α·relevance with "In our implementation, all αs
are set to 1" (components min-max normalized). Recency: "Our decay factor is
0.995" — exponential decay per **sandbox game hour** since last retrieval.
Importance: LLM rates 1–10 at write time ("cleaning up the room" → 2, "asking
your crush out on a date" → 8). Relevance: cosine similarity. **Reflection**
fires "when the sum of the importance scores for the latest events … exceeds
a threshold (150 in our implementation)" — in practice "roughly two or three
times a day": the 100 most recent records become prompts for the 3 most
salient questions, insights cite evidence pointers ("because of 1, 2, 8,
15") and are stored back as stream entries that can themselves be reflected
on. Ablation (TrueSkill μ): full 29.89, no-reflection 26.88, no
observation/reflection/planning 21.21; full vs fully-ablated effect size
d = 8.16 (T1).

**Reflexion** (Shinn et al., arXiv 2303.11366). Actor / Evaluator /
Self-Reflection models; reflections are stored in long-term memory ("usually
set to 1-3" experiences, ALFWorld truncates to last 3). No clearing rule and
no default max-trials is given; ALFWorld runs 12 trials. Numbers (T1):
HumanEval pass@1 91.0 vs GPT-4 80.1; ALFWorld 130/134 tasks; HotpotQA +20%
over baselines, self-reflection worth an "8% absolute boost" over episodic
memory alone.

**ExpeL** (Zhao et al., arXiv 2308.10144). Distills success/failure
trajectory pairs plus cross-task success lists (L=8 chunks) into an insight
pool managed by four operators — **ADD, EDIT, UPVOTE, DOWNVOTE** — with
deletion as pure arithmetic: a new insight gets "an initial importance count
of two"; UPVOTE/EDIT increment, DOWNVOTE decrements; "If an insight's
importance count reaches zero, it will be removed." No REMOVE operator exists
— forgetting is usage-driven decay, not a judgment call. At test time all
insights ship in-prompt while exemplars are top-k retrieved (k=6 HotpotQA,
k=2 ALFWorld/WebShop). Numbers (T1): HotpotQA SR 39.0±1.7 vs ReAct 28.0±1.4;
ALFWorld 59.0±0.3 vs 40.0±0.3; WebShop reward 0.701 vs ReAct 0.665; transfer
to FEVER 70±0.7 vs ReAct 63±0.4.

### 1.3 Extraction + update family — Mem0 (arXiv 2504.19413)

Two phases. **Extraction**: prompt P = (S, last m=10 messages, m_{t-1},
m_t) with an async-refreshed summary S; the LLM emits a set of candidate
facts Ω. **Update**: for each candidate, vector-search top-s=10 similar
memories; one LLM tool-call chooses an operation — **ADD** (new id),
**UPDATE** (keep same id, replace when InformationContent(f) >
InformationContent(m_i)), **DELETE** (contradiction removed), **NOOP**
(nothing executed). Dedup is not a separate gate — it is the update LLM's
judgment over retrieved neighbors.

LoCoMo, LLM-as-a-Judge overall (Table 2, T1): **Mem0g 68.44**, Mem0 66.88,
Zep 65.99, LangMem 58.10, OpenAI memory 52.90, A-Mem 48.38, best RAG 60.97,
full-context 72.90. The abstract's "+26% over OpenAI" = 66.88/52.90 relative.
Latency (Table 2): p95 total 1.44s (Mem0) vs 2.93s (Zep), 4.37s (A-Mem),
17.12s (full-context) — the abstract's "91% lower p95" and ">90% token
savings"; store sizes ~7k tokens/conversation (Mem0) vs "in excess of 600k"
(Zep graph). Caveat (T2, contested both directions): Zep's rebuttal ("Is Mem0
Really SOTA in Agent Memory?", blog.getzep.com, May 2025) claims Mem0
misconfigured Zep and that Zep wins by 10–24%; a third-party counter-rebuttal
claims 58.44% for Zep, not 84%. Nobody disputes the table above is what the
paper printed; the dispute is about configuration and the benchmark itself.

Code reality check (T1, mem0 OSS `mem0/configs/prompts.py` on main, 2026-10-01):
`DEFAULT_UPDATE_MEMORY_PROMPT` implements exactly the four ops above ("(1)
add into the memory, (2) update the memory, (3) delete from the memory, and
(4) no change"; UPDATE must "keep the same ID"; DELETE only "input IDs … do
not generate any new ID"). But main's `main.py` has moved to
`ADDITIVE_EXTRACTION_PROMPT` — "Your sole operation is ADD", with
`linked_memory_ids` for linking and a checklist budgeting "5-15 memories" per
10+ message conversation. The flagship platform has converged on
**append-only extraction + explicit links** — the same shape as our
supersedes_id design, minus our states and human gate.

### 1.4 Knowledge-graph family — Zep/Graphiti, HippoRAG 1+2, A-Mem

**Zep** (arXiv 2501.13956). Graphiti engine: **bi-temporal model** — each
edge carries t_valid/t_invalid (when the fact held true in the world) plus
t′_created/t′_expired (transaction time), so old facts are invalidated,
never mutated. Three subgraphs: **episodes** (raw messages — non-lossy),
**semantic entities** (1024-dim embeddings, LLM entity resolution),
**communities** (label propagation, map-reduce summaries — chosen over
Leiden for cheap dynamic extension). **Edge invalidation**: an LLM
"compare[s] new edges against semantically related existing edges to
identify potential contradictions" and sets t_invalid to the invalidating
edge's t_valid — "Graphiti consistently prioritizes new information."
Search = cosine + BM25 + BFS expansion with pluggable rerankers (RRF, MMR,
cross-encoder). Numbers (T1): DMR 94.8% (gpt-4-turbo) vs MemGPT 93.4%;
LongMemEval-S, gpt-4o: 60.2% → **71.2%** with Zep at ~1/10 latency (2.58s vs
28.9s); caveat from the same table: Zep **hurt** one axis — assistant-affect
94.6% → 80.4% (−17.7%) for gpt-4o.

**HippoRAG** (NeurIPS 2024, arXiv 2405.14831). Hippocampal indexing theory:
neocortex = LLM + OpenIE-built KG; hippocampus = Personalized PageRank seeded
by query phrases. Up to **20%** multi-hop QA improvement over prior SOTA,
single-step, "10-30 times cheaper and 6-13 times faster" than iterative
retrieval IRCoT (abstract, T1). "Personalized" means personalized to the
query's seeded nodes — spreading activation, not per-user personalization.

**HippoRAG 2** (arXiv 2502.14802). Adds **passage nodes** linked by
"contains" edges to phrases — integrating concept + context — plus
query-to-triple matching (beats NER linking by 12.5 points avg recall@5:
87.1 vs 74.6) and an LLM filter on retrieved triples before PPR. Numbers
(T1): MuSiQue F1 35.1 → **48.6** vs HippoRAG 1; recall@5 MuSiQue 74.7 vs
69.7 for NV-Embed-v2; removing passage nodes drops MuSiQue recall@5 to 63.7
— **the passage-node (pointer) edges are where the retrieval value lives**.

**A-Mem** (arXiv 2502.12110). Zettelkasten notes m_i = {c, t, K, G, X, e, L}
— content, timestamp, keywords, tags, contextual description, embedding,
links. Link generation = top-k cosine neighbors then an LLM confirms links.
**Memory evolution**: new notes trigger attribute evolution (tags_to_update)
and content evolution (rewriting neighbors' context) with actions
strengthen/merge/prune; evolved notes replace old versions. LoCoMo F1 beats
MemGPT on most cells (e.g. temporal 45.85 vs 25.52, GPT-4o-mini); per-turn
tokens 2,520 vs MemGPT's 16,977.

### 1.5 Skill-library family — Voyager (arXiv 2305.16291)

Skills = executable code + GPT-3.5 description, stored in a vector DB keyed
by the description embedding; retrieval is top-5 by similarity of
description-to-task; a skill is committed only after an environment-verified
success (max 4 rounds, self-verification critic). Complex skills compose
simpler ones, which "compounds the agent's abilities rapidly … and alleviates
catastrophic forgetting" — the library only grows; nothing is forgotten.
Numbers (T1): 63 unique items / 160 iterations, "3.3×" more than baselines;
map traversal "2.3×" longer; tech-tree speedups 15.3×/8.5×/6.4×
(wood/stone/iron), only agent to unlock diamond; ablations: random curriculum
−93% items, no self-verification −73%.

### 1.6 Forgetting-first family — MemoryBank (arXiv 2305.10250)

Ebbinghaus retention R = e^(−t/S); strength S "initialized it with 1 upon
its first mention"; on recall "We increase S by 1 and reset t to 0" — a
deliberately simplified model (the paper calls it "an exploratory and highly
simplified memory updating model"; the SM-2/Anki spacing details sometimes
attributed to it are NOT in the paper). Applied as retention probability at
retrieval, not hard deletion; retrieval itself is FAISS dual-tower dense
search plus user portrait + event summary. SiliconFriend (T1, Table 2):
retrieval accuracy 0.763–0.856 across variants; ChatGPT variant leads
correctness/coherence (0.716/0.912 English).

---

## 2. Ingest + consolidation vs ours

Ours (T1, `hooks/lib/knowledge-ports.ts`, `hooks/bin/knowledge-worker.ts`):
producers INSERT into `knowledge_queue` (SQLite/WAL); a launchd daemon drains
oldest-first, p-queue concurrency 1, MAX_ATTEMPTS 3 with poison→failed and
payload purged on success; per item: distill (knowledgeworker.md system
prompt) → mechanical secrets redaction → near-duplicate gate (FTS5
candidates, deterministic term overlap: ≥2 shared terms AND ≥60% of the
candidate's terms shared → older kept) → substitution gate (fact ≥75% covered
by ONE doc → pointer row keeps only the residue; covered with no residue →
reject) → insert as `candidate`; humans promote (`knowledge-promote`) or
retire (`knowledge-retire --superseded-by`). Search ranks bm25 + age×0.05/day,
excludes retired; trust = sha256(source_ref) vs source_hash →
verified/drift/unverified.

| Axis            | Mem0                                 | Ours                                                       |
| --------------- | ------------------------------------ | ---------------------------------------------------------- |
| Capture trigger | per message-pair, hot path           | lanes call `knowledge-enqueue` voluntarily                 |
| Extraction      | LLM extracts candidate facts         | LLM distills, impartial-indexer contract                   |
| Dedup           | update-LLM judges top-s=10 neighbors | mechanical FTS5 + 60% term-overlap gate                    |
| Update ops      | ADD/UPDATE/DELETE/NOOP (LLM deletes) | append + source-declared supersedes_id only                |
| Contradiction   | DELETE the contradicted row          | nothing fires (0 supersessions ever)                       |
| States          | none (store is flat)                 | candidate → active → retired, promoted/retired by hand     |
| Human gate      | none                                 | promote/retire exist, nobody runs them (229/229 candidate) |
| Trust           | none reported                        | source_hash drift check at read time                       |

The structural difference: Mem0 centralizes dedup + contradiction in one
update-LLM with delete rights; we split judgment (LLM extracts, never
deletes) from linking (mechanical gates). Zep is the other pole — its
invalidation LLM rewrites t_invalid on contradiction, append-only at the
storage layer. A-Mem goes further: evolution **rewrites** neighbors'
context/tags. Reflexion/ExpeL consolidate only within a task's lifetime;
Generative Agents reflect on-stream but delete nothing. No system in the set
combines (a) LLM-decides-delete with (b) append-only storage and (c) a human
disposition gate — each picks two at most. We have (b)+(c) without any
automated (a).

### 2.1 When consolidation runs — and session-end capture

- **Per-exchange, hot path**: Mem0 (extraction+update on every message pair);
  A-Mem (note + link + evolve per note). Cost lands in the interaction.
- **In-loop reflection**: Generative Agents (every ~150 importance sum, 2–3×
  daily in sim); Reflexion per trial. Tied to task lifetime.
- **Idle-time, detached**: Letta sleep-time agents — "Offloading memory to a
  sleep-time agent allows memory management to happen asynchronously"; the
  primary agent "is not provided with tools to edit its core memory", the
  sleep-time agent edits it "in an 'anytime' fashion" (T2 blog + T1 paper).
  Claimed "Pareto improvement"; sleep-time compute paper: ~5× less test-time
  compute for equal accuracy, +13–18% accuracy from scaling sleep-time
  compute (T1 abstract).
- **Session-end**: exactly one production system found — **Dosu**: Claude
  `SessionEnd` / codex `Stop` / Cursor `stop` hooks run `dosu knowledge sync
--quiet --detach`; the learner reads sessions through an MCP tool capped at
  30k-char pages, per-page `redactSecrets()`, per-run note cap as "the single
  hard gate", 30-min wall-clock abort; writes land in a **human review
  queue**, not the store (T1 reads, per our 09-30 source trace).
- **Mechanical, non-LLM**: our own `hooks/lib/harvest.ts` — quotes from real
  transcripts only, consult_kb rows, human promotes.

**Capture rates / noise**: no production system publishes capture-rate or
extraction-precision numbers — not LangMem (docs describe a "Background
memory manager that automatically extracts, consolidates, and updates agent
knowledge", zero metrics), not Mem0/Letta/Zep (papers benchmark QA accuracy,
not ingest precision/recall). The only explicit noise policy found is Mem0's
prompt checklist ("5-15 memories" per 10+ message conversation) and Dosu's
caps + review queue. **UNVERIFIED as a measured rate anywhere.**

---

## 3. Forgetting / retirement vs our retired state + curation backlog

Three distinct levels recur across the set:

1. **Context-level forgetting** (eviction from the prompt, nothing deleted):
   MemGPT (recursive summaries + recall storage keeps everything),
   Generative Agents (windowed retrieval over an ever-growing stream).
2. **Retrieval-level forgetting** (rank-down, still stored): Generative
   Agents recency decay; our own age×0.05/day bm25 penalty; MemoryBank's
   retention probability.
3. **Store-level forgetting** (rows actually retire/delete): Mem0's DELETE,
   Zep's t_invalid invalidation, ExpeL's importance-count removal at zero,
   A-Mem's evolution replacing old versions.

Our position: retirement is defined but never executed. `retire()` exists
("active/candidate → retired: exits search; superseded_by records the heir")
and curate-flag notes say "pointer-ize or retire (W103)" on 148 rows — but
live counts show 0 retires, 0 promotes, 0 supersessions. The backlog is not
a policy gap; it is an **actor gap**: ExpeL and MemoryBank automate the
disposition (vote counts, decay), Dosu routes it through a human queue, Mem0
gives the ingest LLM the delete pen. We give it to nobody. The cheapest
complete policy on our seams: usage-driven decay proposes, human disposes.

---

## 4. Steal for our stack — ranked

### 4.1 Access-time recency decay + auto-retire candidates (ExpeL/MemoryBank shape)

Our /search already ranks `rank + age_days×0.05` off `updated_at`. Steal
MemoryBank's S+1/t-reset and ExpeL's vote counts: add `accessed_at` (and a
use counter) bumped on every /search hit or prose-card render; rank by
age-since-**access** for rows that have been accessed, keep updated_at for
never-accessed rows. Then curate flips from flagging to proposing: rows not
accessed in N days AND still candidate → queue a retire proposal into the
work graph (human disposes, same as the W112 re-sweep pattern — mechanical
propose, human dispose). Directly converts the 229-candidate / 148-flagged
backlog from a dead letter into a queue. Cost: one column, one counter bump,
one SQL ORDER BY branch. Maps to W113's tax finding (stale architectural
rows injected into every session are exactly what made hub-packets lose to
docs-packets).

### 4.2 Pointer-graph 1-hop expansion at /search (HippoRAG on our existing columns)

W113 measured that injection value rides file-level pointers. HippoRAG 2's
ablation says the same structurally: removing passage nodes drops MuSiQue
recall@5 74.7 → 63.7 — pointer edges ARE the retrieval value. We already
store the graph: `knowledge.source_ref` → doc, plus domain/area. Steal the
seed-expansion mechanic (Graphiti's φbfs; HippoRAG's PPR in degenerate
form): when a hit names `source_ref = docs/emission-chunk-splice.md`, also
return rows whose source_ref names the same doc, plus rows sharing
domain/area — one SQL self-join, no LLM, no embeddings, 1-hop only. This
re-serves distilled knowledge through the pointer web instead of more bm25
weight, and is the cheapest implementation of the W113 verdict.

### 4.3 Session-end detached capture (the Dosu shape, on our hooks)

`hooks/session-end.ts` today only marks sessions CLOSED — capture depends on
lanes voluntarily calling `knowledge-enqueue` mid-session, which is why the
queue shows 114 done / 48 failed and the hub starves when lanes forget.
Dosu is the production proof that SessionEnd→detached sync works: capture is
"off the critical path by construction", learner hard-capped (30k-char read
pages, per-page redaction, per-run note cap, 30-min abort), writes land in a
human review queue. Steal the shape, not the LLM: SessionEnd hook enqueues
the session's mechanically-quotable candidates (harvest.ts already extracts
typed signals — the enqueue payload should be quotes + ledger refs, never
LLM retellings) behind the existing redact→distill pipeline. Mem0's "5-15
memories per 10+ message conversation" checklist is the noise budget to
copy into the enqueue prompt. Our origin_kind taxonomy (lesson/incident/
decision/study/fact) is the importance prior Generative Agents rate 1-10 —
we get importance scoring for free at write time.

### 4.4 Supersession that actually fires (Zep's invalidation, our columns)

supersedes_id is extraction-only by doctrine and 0 rows ever used it; the
near-dup gate silently drops contradicting candidates (older kept). Zep's
answer to the same problem: the invalidation LLM compares new vs related
edges and marks the old one invalid — new information wins, storage stays
append-only. Steal: when findNearDuplicate fires, don't just skip — append a
propose-dispose ledger row ("candidate #X near-dup of #Y; propose retire Y
superseded-by X if candidate is a correction") to the queue's result_key
ledger and emit one events row. Mechanical propose, human dispose — keeps
the impartial-indexer doctrine while the contradiction finally leaves a
trace.

### 4.5 Importance prior in /search ranking (Generative Agents, minus the LLM)

Generative Agents add an importance axis to retrieval (α·recency +
α·importance + α·relevance, all α=1). We have recency (age×0.05) and
relevance (bm25) but no importance. Ours is cheaper than their LLM-rating:
`origin_kind` is already a static importance prior — incident > lesson >
decision > study/fact by rediscovery cost — so a constant map (e.g.
incident −0.15, lesson −0.10, decision −0.05 on the rank sum) encodes
"pay-attention-first" without any extra model call. Combine with 4.1's
access-recency for a two-axis rank that mirrors Generative Agents' three
axes with zero LLM spend.

### 4.6 Explicit non-steals

- **Mem0/Zep LLM-deletes**: wrong agent holds the pen under our
  impartial-indexer + append-only doctrine. Steal their proposal flow, not
  their delete rights (see 4.4).
- **A-Mem evolution rewriting neighbors' context/tags**: mutation of stored
  facts — violates supersede-don't-mutate. Link instead.
- **Voyager skill library**: we effectively have it — pointer rows + the
  skills-available lane are a composable skill store; the missing piece is
  success-verified commits, which is a lane-harness question, not a hub one.
- **MemGPT working-context self-edit**: per-agent RAM management,
  orthogonal to a fleet hub; our CLAUDE.md + prose cards already serve that
  role.
- **Sleep-time agents for THIS repo**: the hub is already an idle-time
  daemon; the residual value would be a sleep-time curator — which is just
  4.1 + 4.4 running on a launchd timer.

---

## 5. Could-not-verify

- **Capture-rate / extraction-precision numbers**: published by no system in
  the set. Mem0's "5-15 per 10+ messages" is a prompt budget, not a measured
  rate; Dosu's caps bound cost, not accuracy; LangMem's docs carry zero
  metrics. If we ever build 4.3, our own queue ledger already measures what
  nobody publishes: written/skipped counts per job live in `result_key`.
- **Letta Filesystem 74.0% on LoCoMo** (GPT-4o mini, T2 vendor blog):
  benchmark validity disputed from both sides — Zep's "Is Mem0 Really SOTA"
  and "The Retrieval Tradeoff" rebut Mem0 AND Letta; a counter-rebuttal
  disputes Zep's 84%; Letta itself says "current memory benchmarks may not
  be very meaningful". Treat all cross-vendor LoCoMo numbers as marketing
  until reproduced.
- **Mem0 code-vs-paper drift**: LoCoMo numbers were measured with the
  four-op update pipeline; OSS main has moved to ADD-only extraction. The
  evaluated artifact is not the shipped code (flagged, not resolvable from
  here).
- **Sleep-time compute latency/context-scale figures**: abstract reports
  ~5× compute, +13–18% accuracy, 2.5× amortization; full-text v2 URL 404'd —
  latency percentages and context-length scale not verified.
- **MemGPT document-QA exact table values**: figures only — the text gives
  no table numbers (nested-KV described in prose; doc QA chart-only).
- **Dosu remote-server injection behavior**: closed server; whether it
  proactively injects beyond the requested read stays UNVERIFIED (per the
  09-30 source trace).

---

## 6. Sources

Papers (T1, arXiv HTML full text unless noted): MemGPT 2310.08560;
Generative Agents 2304.03442 (+ar5iv for the exact weights sentence);
Reflexion 2303.11366; ExpeL 2308.10144; Mem0 2504.19413; Zep/Graphiti
2501.13956; HippoRAG 2405.14831 (NeurIPS 2024); HippoRAG 2 2502.14802;
A-Mem 2502.12110; Voyager 2305.16291; MemoryBank 2305.10250; sleep-time
compute 2504.13171 (abstract). Code (T1): the mem0 OSS repo's
`mem0/configs/prompts.py` + `main.py` on main, read 2026-10-01. Vendor
(T2): letta.com blog posts (sleep-time-compute,
benchmarking-ai-agent-memory); langchain-ai.github.io/langmem;
blog.getzep.com rebuttal (as reported). Local T1:
hooks/knowledgeworker.md, hooks/lib/knowledge.ts,
hooks/lib/knowledge-ports.ts, hooks/bin/knowledge-worker.ts,
hooks/lib/harvest.ts, hooks/session-end.ts,
docs/research/dosu-knowledge-mechanism-2026-09-30.md, governor.db live
counts.
