# Dosu knowledge mechanism — how stored knowledge converts to token savings (source trace, 2026-09-30)

Companion to `dosu-token-savings-2026-09-29.md` (architecture overview + feature
plan — do not duplicate that doc's scope). This pass answers one question: what
is the MECHANISM that turns dosu's knowledge store into token savings — when is
knowledge injected, what triggers retrieval, and how does knowledge substitute
for work instead of adding context on top. Read against the live source today;
the 09-29 doc's clone predates a same-day restructure of `dosu-cli`, so file
paths cited here supersede that doc's.

Method: `dosu-ai/dosu-cli` @ `0d7111c` (main, pushed 2026-09-29T23:18Z) and
`dosu-ai/decant` (Apache-2.0, main) read directly from
`raw.githubusercontent.com/.../main/...` on 2026-09-30. Tier marks: **T1** =
source file read; **T2** = dosu.dev pages/blogs; **UNVERIFIED** = no traceable
source. The MCP server behind `read_knowledge` is closed source; where the
client contracts prove what the server must do, that is marked (T1-derived).

---

## 1. The lifecycle, end to end

Dosu does NOT proxy the user's agent. Nothing sits between the user's coding
agent and the model API. Every piece of the mechanism is (a) a static rule
file, (b) a remote MCP tool the agent calls at its own discretion, and (c)
a session-end capture pipeline. Two install steps and one standing rule carry
the whole mechanism:

1. **MCP wiring** (`src/mcp/providers/claude.ts`, T1): setup writes the remote
   MCP server into each agent config —
   `{backend}/v1/mcp/deployments/{deploymentID}`, `X-Dosu-API-Key` header auth,
   launched through `npx mcp-remote@0.1.38`. All knowledge tools are remote;
   retrieval, ranking, and any result-shaping live server-side (closed).
2. **Standing rule** (`src/rules/installer.ts`, T1): setup installs
   `rules/dosu.md` (fetched from GitHub raw with a bundled fallback) to
   `~/.claude/rules/dosu.md` (Claude), `~/.cursor/rules/dosu.mdc` (Cursor,
   frontmatter), and marker-delimited AGENTS.md sections (codex, opencode).
   This file is the mechanism's load-bearing part — full contract below.
3. **Skill** (`skills/dosu/SKILL.md`, T1): CLI-operating skill; also documents
   the review queue ("items pending approval: pending doc changes and draft
   replies") — the human gate on the write path.
4. **Session-end hooks** (`src/hooks/agents.ts`, T1): the ONLY hooks dosu
   installs are capture triggers — Claude Code `SessionEnd`, Codex `Stop`,
   Cursor `stop` — running `dosu knowledge sync --quiet --detach`. No
   UserPromptSubmit, no SessionStart, no proxy middleware. Capture is off the
   critical path by construction.

### The rule text is the trigger mechanism

`rules/dosu.md` (T1, fetched raw; key sentences quoted):

> When `read_knowledge` is listed, call it **before non-trivial code or
> documentation work** involving architecture, conventions, prior decisions,
> gotchas, incidents, ownership, or branch history. **If unsure whether
> relevant context exists, read first.** Pass `repo` and `branch` when
> available. **Skip generic questions, trivial or self-contained edits, and
> context already injected by Dosu.**

> When `write_knowledge` is listed, use it after the task for durable,
> non-obvious knowledge that future work would otherwise have to rediscover.
> … **If nothing durable was learned, do not write.**

Three mechanical properties:

- **The trigger taxonomy is exclusive.** "Before non-trivial work" names
  exactly the categories that decant measured as the spend (context gathering
  ≈ 67% of dollars — their research, T2) and excludes everything else
  (trivial edits, generic questions). The rule is engineered to fire only
  where a read is cheaper than re-derivation.
- **repo/branch scoping at query time.** The agent passes `repo`/`branch`
  when available — retrieval is scoped to the change context, which shrinks
  the candidate set and keeps cross-branch noise out.
- **Anti-double-injection clause.** "Skip … context already injected by
  Dosu" — the rule itself prevents the hub adding cost on top of context the
  agent already has. This is the exact failure mode our A/B measured (§2).

### How knowledge substitutes for work

The substitution is at the DECISION level, not the prompt level:

- **One read replaces exploration turns.** Because the read fires BEFORE
  exploration begins (trigger: "before non-trivial work" on the taxonomy),
  the returned answer removes the grep/read/exploration turns the agent would
  have spent re-learning architecture, conventions, decisions, gotchas.
  Savings = avoided turns (their worked example: 2,137 vs 47,215 tokens —
  T2, self-reported), not compressed prompts. No prompt compression exists
  anywhere in the stack.
- **Returns are precision-filtered.** Per their search-and-retrieval post
  (T2): per-question method selection, a second selection pass on the read
  path, "even accurate-but-loose context causes scope creep". The server
  returns agent-facing curated cards (read cards showing sources/notes —
  sept-2026 drop, T2), not a raw envelope. (T1-derived: the client cannot be
  doing this filtering — it is a pass-through to the remote server.)
- **Capture is budgeted at the tool layer.** The learner (headless distill
  run) reads sessions through an in-process MCP server whose `read_session`
  pages are hard-capped at `MAX_READ_CHARS = 30_000` with offset pagination,
  every page through `redactSecrets()` (`src/learner/tools.ts`, T1). The run
  itself is capped: `maxTurns`, a per-run note cap enforced as "the single
  hard gate" in `canUseTool`, deliberately no `allowedTools` shortcuts, 30-min
  wall-clock abort, `settingSources: []` (`src/learner/runner.ts`, T1).
- **The write-side dedup rides the same read path.** The learner's rule 1
  (`src/learner/prompt-core.ts`, T1): call `read_knowledge` with the candidate
  topic BEFORE writing; skip duplicates/near-duplicates; write updates when
  superseded; "Only restatements of already-recorded facts are duplicates".
  And the store never duplicates in-repo docs: rule 2 excludes "facts readable
  from a single file without investigation" — dosu does not store what the
  repo already teaches.
- **Attribution by pipeline construction.** "Each note is attributed to the
  session you read just before writing it" (`src/learner/prompt.ts`, T1) —
  provenance is not a field the model fills in; it is an ordering property of
  the pipeline (read one session, write its notes, then move on).

### What makes the knowledge trusted enough to act on

No re-verification instruction exists in the rule — agents are told to build
on knowledge directly. The trust is manufactured upstream:

1. **Human review gate on the write path.** `write_knowledge` returns
   `receipt_item_id`s; `finalize_session_knowledge` settles the turn (exactly
   once, only when receipts exist). Items land in a review queue of "pending
   doc changes and draft replies" (`skills/dosu/SKILL.md`, T1; `review
list/approve/reject` CLI commands). What reaches the Library is
   human-approved.
2. **Monitor keeps it fresh.** Monitor is per-Library/per-source and "reviews
   pull requests to keep the Library's knowledge up to date" (SKILL.md, T1).
   Freshness is maintained by external events (merged PRs), not by asking the
   reader to re-verify.
3. **Branch scoping** at query time (rule text) prevents stale cross-branch
   contamination.
4. **Dosu's own caveat** (T2, webinar): stale knowledge makes agents spend
   MORE verifying; they cite memory systems that were net-negative. The trust
   model is the product; without it the mechanism inverts.

Marked UNVERIFIED: whether the remote server proactively injects knowledge
into tool results beyond the requested read (the rule's "context already
injected by Dosu" hints at it, but any such shaping is inside the closed
server; no client-side injection hook exists — T1).

---

## 2. Why our hub adds cost where dosu saves

Our A/B (W94, DONE): comprehension task, hub-equipped agent 92k tok / 5.4min
vs blind agent 63.6k tok / 2.6min (+45% raw token delta; +38% as reported).
The hub is at :7795 over governor.db (W91/W99 moves it to knowledge.db).

Mechanism-for-mechanism:

| Axis              | Dosu                                                          | W91 hub today                                                                  |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Injection point   | Standing rule + agent-initiated MCP read at task start        | Tool exists; nothing tells the agent WHEN                                      |
| Trigger           | Exclusive taxonomy (before non-trivial work; skip trivial)    | "BEFORE non-trivial work" is in the tool description only                      |
| Result shape      | Precision-filtered agent-facing cards                         | `JSON.stringify({ query, hits })` — parse overhead, no precision pass          |
| Query scoping     | repo/branch passed when available                             | domain/area filters exist but nothing builds the habit                         |
| Store content     | Durable-only; excludes what a single file teaches             | W93 seeder distilled architecture facts docs/ already teach                    |
| Anti-double-spend | "Skip … already injected" clause; excludes docs-covered facts | Hub duplicates docs/; agent re-verifies hits against files anyway              |
| Trust posture     | Human review queue + Monitor freshness + branch scoping       | Provenance/staleness fields exist; nothing tells the agent it may ACT on a hit |
| Capture cost      | Session-end, detached, Haiku-class model, hard caps           | Worker + queue exists; no turn-role filter/redaction/caps on consumer sessions |

Reading the A/B through this table: the hub agent's extra spend is (a) query
turns the blind agent never spent, (b) the JSON parse-and-rerender overhead,
and (c) re-verification — because the store duplicated what `docs/` already
teach, the agent paid twice: once to the hub, once to the files. Dosu's design
makes each of those three impossible at the contract level: (a) the read
REPLACES exploration rather than preceding it (it fires at the same moment
exploration would, and removes its cause), (b) returns are prose cards, (c)
the store excludes docs-covered facts and the rule tells the agent to skip
reads it does not need.

One uncomfortable implication: our repo is small and `docs/` already teach the
codebase well. For THIS repo, the dosu pattern would store little — pointers
into docs/ plus gotchas that cost real rediscovery. The hub's value case is
cross-machine fleet knowledge (per-machine quirks, incident learnings), which
is exactly the `origin_system` axis we already model.

---

## 3. What the W91 hub must change

Concrete, buildable deltas. Original code only — mechanism descriptions, no
dosu code. All on the existing seams (knowledge-ports, knowledge-mcp,
knowledge-worker, session hooks).

### 3.1 Install a standing rule with an exclusive trigger taxonomy (S, days)

Ship a rule file at install (parallel of their `rules/dosu.md`):
`hooks/rules/fleet-knowledge.md`, installed to `~/.claude/rules/` (marker
sections in AGENTS.md for codex lanes). Contract:

- Call `read_knowledge` before non-trivial work involving incidents, fleet
  lessons, machine-specific quirks, prior decisions, ownership — the
  categories decant-class metrics say dominate our spend.
- **Skip** when: the edit is trivial/self-contained; `docs/` already covers
  the question; context is already in hand. (The docs-covered skip is the
  single highest-leverage sentence for this repo — it would have prevented
  the W94 failure mode by contract.)
- Pass `domain`/`origin_system` when known.

### 3.2 Substitution contract on the store side: never duplicate the repo (S)

Ingest-side filter in the worker + `hooks/knowledgeworker.md`: reject
candidates restating what a single file (or docs/ page) already teaches.
Where docs cover the topic, store a POINTER (path + section + non-obvious
residue), not a restatement. Our `source_hash` drift check already exists —
a pointer row is cheap to verify mechanically. Target store shape: gotchas
with measured rediscovery cost, incident learnings, per-machine quirks,
decision rationale that is NOT in docs/ (or links the docs row it extends).

### 3.3 Return prose cards, not JSON (S)

`hooks/bin/knowledge-mcp.ts` renders hits as compact text cards — one line
per hit: glyph + topic + one-sentence fact + source pointer + age + hit
count. JSON keys/braces/escaping are pure overhead and force the model to
re-render. Keep the JSON face on the HTTP API (:7795) for programmatic
consumers; the MCP face is for models.

### 3.4 Trust markers on every hit (S)

Surface the axes the schema already carries as a mechanical trust line, so
the agent can act without re-derivation: `age_days`, source_hash verified
(verify is a one-call `knowledge-verify`), contributor count, prior hits.
Rule text pairs it: hits with verified provenance may be acted on; DRIFT or
stale hits must be re-checked. That converts provenance from metadata into
permission-to-act.

### 3.5 Hard-capped session-end capture (M)

Mirror the learner budget on our SessionEnd → worker path (queue exists):

- User/assistant turns only, tool output and sidechains dropped (their
  `src/sessions/read.ts` contract), `redactSecrets()` before anything
  persists — we have the redactor; apply it at the tool/turn boundary.
- Per-run caps: max notes per run, max turns, wall-clock abort — enforced in
  the worker gate (our equivalent of their canUseTool note cap), not in
  prompt text alone.
- Read-before-write dedup THROUGH the search path (worker searches the store
  for the candidate topic before INSERT), updates-not-restatements, and a
  run-level note cap as the volume guard.

### 3.6 Honest metering: count turns saved, not token ratios (S)

Extend the W94/W97 A/B discipline into a standing gate: track per-task
exploration-turn count and hub-query count (both derivable from session
JSONL / consult counters), and ship the hub only if A/B stays non-negative.
Dosu's own webinar discipline (T2): bare token ratios lie; publish outcomes.

### 3.7 Reaffirmed non-goal: proxy-side injection

Dosu does not proxy the user's agent (T1: no injection hooks, remote MCP
tools only). The prior doc's Phase-3 belt assembly middleware stays a shelf
item — it is not their mechanism, and our A/B shows premature injection ADDS
cost. First make the read path substitution-grade (3.1–3.4), re-run the A/B,
then revisit.

## 4. Could not verify

- Server-side retrieval/ranking/precision pass and any proactive injection:
  closed source (`api.dosu.dev/v1/mcp` behind API-key auth). The client
  contracts prove only that the agent initiates reads and passes repo/branch.
- The 50% savings figure: self-reported, gateway-metered, no third-party
  audit; local token math is chars/4 in both repos (T1). Decant's category
  split (context 67%) is real and local, but the savings number itself is
  unverifiable.
- Whether the review queue auto-promotes in some modes (auto-approval rules
  for the Library) — the client shows the queue; promotion policy is
  server-side.
- Whether "context already injected by Dosu" refers to a live injection
  surface (GitHub/Slack agent replies, or MCP-result shaping) — no client
  code implements proactive injection for coding agents (T1 absence of
  evidence); treat any proactive-injection claim as unverified.

## 5. Source register

All T1 reads 2026-09-30 from `dosu-ai/dosu-cli` @ `0d7111c` (main) and
`dosu-ai/decant` (main, Apache-2.0):

| File                                                                             | What it establishes                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/mcp/providers/claude.ts`                                                    | Remote MCP server, mcp-remote, API-key header auth                                   |
| `src/mcp/constants.ts`                                                           | `MCP_PROVIDER_SLUG = "dosu_mcp"`                                                     |
| `src/rules/installer.ts`                                                         | Rule install targets; rule text fetched from GitHub with bundled fallback            |
| `rules/dosu.md`                                                                  | The standing rule — trigger taxonomy, exclusions, receipt/finalize contract          |
| `skills/dosu/SKILL.md`                                                           | Review queue semantics, Monitor, Library/Agent/deployment model                      |
| `src/hooks/agents.ts` + `src/hooks/formats.ts`                                   | Session-end-only hooks; `dosu knowledge sync --quiet --detach`                       |
| `src/commands/knowledge.ts`                                                      | sync/backlog/watermark/backoff pipeline, OSS-mode gate, statusline                   |
| `src/learner/tools.ts`                                                           | In-process session-read MCP; 30k-char pages; redaction at tool layer                 |
| `src/learner/prompt-core.ts` + `prompt.ts`                                       | Write contract: read-before-write dedup, durable-only taxonomy, attribution ordering |
| `src/learner/runner.ts`                                                          | maxTurns/note cap/timeout; canUseTool as single hard gate; no settings leakage       |
| `src/sessions/read.ts`                                                           | user/assistant turns only; tool output, thinking, sidechains dropped                 |
| dosu.dev/llms.txt, /for-agents, search-and-retrieval + sept-2026 drop posts (T2) | Marketing-surface corroboration; savings numbers self-reported                       |
