# Belt-native enterprise router (W131 design sketch)

Date: 2026-10-01 · Lane: w131-sketch · Status: designed, zero production
code. Companion inputs: W124's landed policy (belt
`bin/routing-policy.yaml` + `router-policy.ts` + `gateway-config.ts`), the
W126 LiteLLM audit (`docs/research/litellm-enterprise-audit-2026-10-01.md`),
W92's store port (`hooks/lib/govdb.ts` openStore), W125's servicemon
(`hooks/lib/servicemon.ts`), the W89/W89.1 ingress specs. Cross-checks
pending: W129 (LiteLLM internals map) and W130 (build-base evaluation) are
sibling lanes — this doc frames the decision rule both feed into.

## 0. Mission

Owner directive: copy what LiteLLM is doing for us into our own router, add
everything LiteLLM charges for on top. One belt-native process, Bun/TS,
composing what the fleet already built: the W124 policy file and ladder, the
W92 store seam, the W125 observability standard, the W89/W89.1 ingress
precedents, the deltas audit log. LiteLLM leaves; the address, the policy
file, and the owner directives stay.

Why this is tractable for us and not a madness: LiteLLM carries 100+
provider adapters because the world speaks many dialects. We speak exactly
two — OpenAI-shape and Anthropic-shape. Every upstream in our pool is one of
those two dialects. The router is therefore a two-dialect transport with a
governance layer, not a universal adapter framework.

## 1. Architecture

One `Bun.serve` process. Belt gateway :4100 stays the address — zero client
changes (resolveBelt, ANTHROPIC_BASE_URL cutovers, virtual keys all keep
their current shape during migration).

    clients (claude, lanes, belt consumers)
        │  Anthropic /v1/messages · OpenAI /v1/chat/completions
        ▼
    ┌───────────────────────────── :4100 ─────────────────────────┐
    │ servicemon (W125) → GET /status · GET /metrics              │
    │ auth middleware → key lookup, budget + rpm/tpm gates        │
    │ wire handlers → 2 shapes (anthropic, openai)                │
    │ policy engine → routing-policy.yaml (W124 file, unchanged)  │
    │ ladder walker → retry → cooldown state → next group         │
    │ adapters → anthropic↔anthropic, openai↔openai, x-transform  │
    │ SSE pass-through → tee for usage extraction only            │
    └─────────────────────────────────────────────────────────────┘
        │                        │                    │
        ▼                        ▼                    ▼
    local swarm              cloud (z.ai,         degradation ingress
    MLX :8901–:8906          OpenAI, Anthropic)   :4000 shim (W89.1)

### Wire shapes

- `POST /v1/messages` and `POST /v1/messages/count_tokens` — the W89.1
  acceptance bar: `claude -p` end-to-end through belt, thinking param intact,
  count_tokens answered. Missing count_tokens broke sessions once; it ships
  in slice 1, not later.
- `POST /v1/chat/completions` — OpenAI-shape ingress for belt consumers and
  anything that speaks OpenAI today against LiteLLM.
- `GET /v1/models` — merged group list (the discovery loop already exists in
  gateway-config.ts; it becomes startup discovery instead of yaml emission).

### Streaming: pass-through with a usage tee

The load-bearing decision. The router never re-parses or re-serializes the
SSE body. The upstream response `ReadableStream` is piped to the client
verbatim; a `tee()` branch feeds a line-splitter that only watches for
usage-shaped lines and terminal sentinels:

- Anthropic upstream: `event: message_start` carries
  `usage.input_tokens` (+ `cache_read_input_tokens`,
  `cache_creation_input_tokens`); `event: message_delta` carries cumulative
  `usage.output_tokens`.
- OpenAI upstream: usage arrives in the final chunk only when the request
  carried `stream_options: {include_usage: true}` — the router injects that
  field toward openai-dialect upstreams. Local MLX servers may ignore it;
  absent usage is recorded honestly as unknown (servicemon doctrine: omit
  the family, never fake zeros), never estimated into the ledger.

Fallback happens only before the first upstream byte: response status is
decided before the stream is returned to the client, so a group failover
never duplicates content. If an upstream dies mid-stream (HTTP 200 already
sent), the router emits an SSE `event: error` per the Anthropic spec and
closes — no re-route after first byte, same limitation LiteLLM lives with.
Client disconnect aborts the upstream via AbortController.

### Upstream pool and the ladder

Same pool as today (gateway-config.ts is the inventory, minus the yaml
projection): four MLX specialists (:8901 coder, :8902 extract, :8903 reason,
:8906 general — discovered from `/v1/models` at startup, never invented),
the LAN box, z.ai in both dialects, OpenAI (dormant until its key lands),
Anthropic public API, and the :4000 shim as the `local-swarm` degradation
group. The W124 ladder is the policy file's, verbatim:

    num_retries: 1 · allowed_fails: 3 · cooldown_time: 30
    glm-5.3-flash → [local-swarm, gpt-5.2, claude-sonnet-5] · NEVER flashx

Same ladder semantics LiteLLM gave us (pinned-source verified in W126):
ordered group fallback after per-group retries, `allowed_fails` passive
outlier ejection into a cooldown window. Two belt-specific upgrades:

- Resolution order stays: `BELT_POLICY` env → runtime copy in
  `~/.claude/local-llm/` → committed default. Operators edit the YAML, never
  code.
- LiteLLM's reload story is `launchctl kickstart -k` — it drops in-flight
  streams (the between-fan-outs rule from lesson.fanout-rate-budget exists
  because of that). The native router watches the policy file and hot-swaps
  the parsed policy atomically; no restart, no dropped streams. The
  between-fan-outs discipline remains the rule until this ships, then
  retires with the kickstart.

What stays belt's own (W126 division of labor, unchanged): resolveBelt
resolution chain, route-policy scoring (proven-latency from belt's
metrics.db — replaces LiteLLM's `latency-based-routing` with our own
scoring), complexity tiers, allow_cloud gating, the audit trail for allowed
AND denied route decisions. The native router collapses the projection layer
(belt scores → gateway-config emits yaml → LiteLLM enforces) into one
process where scoring and enforcement are the same code path.

## 2. The LiteLLM-essential list

What we must reimplement, honestly. These are the free-tier capabilities the
W126 audit confirmed we actually use; anything LiteLLM ships that is not on
this list is something we do not use and do not build (semantic cache,
guardrails/PII, multi-region, Redis-coordinated multi-instance).

1. **Transport adapters per provider** — but per DIALECT is the honest unit.
   Three adapters cover the whole pool: openai-shape pass-through (MLX,
   Ollama NAS, OpenAI, z.ai OpenAI endpoint), anthropic-shape pass-through
   (Anthropic, z.ai Anthropic endpoint), and one cross-dialect transform
   (anthropic request → openai upstream, ~90-line prior art in the :4000
   shim, extended with streaming + tool blocks + thinking→reasoning_effort
   translation where supported, honest degradation where not).
2. **Retry/timeout with retry-after honoring + jitter** — per-call retries
   (policy `num_retries: 1`), backoff = upstream `retry-after` header when
   present with added jitter, capped exponential when absent. The W126
   lesson stands: a 429 with no retry group kills lanes; the retry is the
   cheap half of the fix, the ladder is the other half.
3. **Fallback ladder walk** — ordered group list from the policy file after
   retries exhaust on a group. Skip-empty-groups (a dormant tier with no key
   is a skip, not a failure — today's ladder already relies on this for the
   OpenAI tier).
4. **Cooldown / outlier ejection** — in-memory per-group failure counters;
   `allowed_fails` consecutive failures eject the group for
   `cooldown_time` seconds. Single-process, single-node: no Redis. Honest
   scale note: a second router instance would need shared ejection state —
   the same seam argument as the store (Postgres binding later if ever).
5. **Usage accounting from streamed responses** — the tee above; per-request
   row (group, model, dialect, status, latency, stream flag, tokens
   in/out/cache_read/cache_create, key id, error). Feeds servicemon token
   counters, budget decrement, and the audit ledger in one write.
6. **Config load** — routing-policy.yaml via the existing parsePolicy shape,
   plus model-list discovery at startup. The policy file does not change
   shape in the migration; belt's `bin/gateway-config.ts` yaml emission is
   what retires.

## 3. The enterprise layer on top

The part LiteLLM gates behind `LITELLM_LICENSE` (W126: audit logs, orgs and
RBAC, JWT auth, key rotation, SSO/SCIM) — rebuilt as fleet composition.

### Virtual keys, budgets, rpm/tpm — stored via the W92 seam

New tables (`router_keys`, `router_teams`, `router_usage`) accessed through
`openStore()` from govdb.ts: the same statement-shaped port that lets work
verbs run in-process or over HTTP. Postgres-optional-later is the identical
argument W92 made — swap the binding, keep the statements. rpm/tpm enforced
by an in-process sliding-window counter keyed on key id (single-node is the
honest scale; `lesson.fanout-rate-budget` caps fan-outs at ~6 anyway — the
enforcement exists so a runaway key degrades, not the fleet).

Schema ownership note (integration step, needs a suspenders lane): the
deltas trigger generator covers tables declared in govdb.ts. Declaring the
router tables there is what makes the audit trail free — which is the next
point.

### Org/team model

Teams own keys; budgets check at team level before key level (team
`monthly_budget_usd` gate, then key `max_budget_usd`). Agents, not humans,
hold keys — W126's verdict: the free tier is arguably sufficient for an
agent fleet because LiteLLM's paid line is human identity; teams-over-orgs
is all an agent fleet needs, and here it is just two tables.

### Auth middleware — JWT/OIDC-ready, store token as the seed

Interface: `authenticate(req) → { key, team, claims }`. First
implementation: bearer virtual key → hash lookup in router_keys (the W92
x-governor-token mechanism is the seed precedent — static token, hashed
comparison, revoke by row). Second slot: JWT bearer — verify against an
OIDC JWKS, map claims to team. The middleware boundary is the design
commitment; the static-key impl ships first and the JWT impl changes nothing
behind it. Key rotation = insert new row, grace window on the old row's
`revoked_at` — a query, not a feature.

### Audit trail = the deltas log (exists)

governor.db AFTER triggers already append row images to `deltas` for every
declared table (the `--since <event-id>` machinery rides it). Router key,
team, and usage mutations flow through the same triggers the moment the
tables are declared — the audit capability LiteLLM sells is, here, the log
we already run and prune (W33 ring retention). Route decisions (allowed and
denied) keep landing in belt's route-policy audit table; the deltas log is
the control-plane trail, belt's table is the decision trail.

### Observability — servicemon standard (W125)

Two-line wiring: `sm.fetch(routes)` answers `/status` and `/metrics` and
instruments everything else. Token counters use the existing kinds
(`in|out|cache_read|cache_create`) — the tee is the feed. Ladder events
(group failover, cooldown start/end) get a counter so the board can show
degradation, not just totals. Scrub rule applies to any error text (no
`/Users/…` paths through observability payloads).

### Admin surface = the board

No new admin UI. Fleet-board (:7799) gains router routes behind the existing
x-governor-token precedent: issue/revoke/list keys, team budgets, live
degradation view (cooldowns, fallback rates) from the counters. The board is
already the fleet's control surface; router governance is a panel, not a
product.

## 4. Effort estimate and build order

Sizes: S ≤ ~150 LOC, M ~150–400, L > 400. LOC ranges are implementation +
inline tests, Bun/TS, no framework. Honesty note up front: the two real
works are SSE pass-through/tee and the cross-dialect adapter; everything
else composes from things the fleet already runs.

| Component                                       | Size | LOC           |
| ----------------------------------------------- | ---- | ------------- |
| Config load + startup model discovery           | S    | 100–200       |
| OpenAI wire handler (non-streaming + stream)    | S    | 60–100        |
| Anthropic handler (messages + count_tokens)     | S–M  | 100–150       |
| openai-shape pass-through adapter               | S    | 40–60         |
| anthropic-shape pass-through adapter            | S    | 40–60         |
| Cross-dialect transform (anthropic→openai)      | M    | 150–250       |
| SSE pass-through + usage tee                    | L    | 200–350       |
| Retry/timeout (retry-after + jitter)            | S–M  | 80–150        |
| Fallback ladder walk                            | S    | 60–100        |
| Cooldown/outlier ejection                       | S    | 50–80         |
| Usage ledger writes + servicemon wiring         | S    | 80–120        |
| Keys/teams/budgets schema + middleware          | M–L  | 300–450       |
| rpm/tpm sliding window                          | S    | 60–100        |
| Auth middleware (static-key impl)               | S    | 60–100        |
| Board admin routes (keys, budgets, degradation) | M    | 150–250       |
| Shadow-diff harness (phase-1 test rig)          | M    | 150–250       |
| **Total**                                       |      | **~1.7–2.9k** |

Roughly half of that total is the governance layer LiteLLM charges annual
fees for. The thin slice is under 1k LOC.

### Build order

1. **Phase 1 — the thin slice (the LiteLLM 20%)**: config load + discovery,
   both wire handlers, pass-through adapters, SSE pass-through with the
   usage tee, ladder walk with retry-after-aware single retry, usage ledger
   writes. This is ~900–1.3k LOC and it replaces ~80% of what :4100 does for
   us by traffic. Acceptance test is the W89.1 bar: real `claude -p` session
   through the router end-to-end, thinking intact, count_tokens answered.
2. **Phase 2 — reliability polish**: jittered backoff refinement, cooldown
   ejection, latency scoring wired to belt's metrics.db (replaces
   `latency-based-routing` with our proven-latency scoring in-process).
3. **Phase 3 — governance**: router tables in govdb schema (suspenders lane)
   - keys/teams/budgets + rpm/tpm + auth middleware + board admin routes.
4. **Phase 4 — retirement**: gateway-config.ts yaml emission and the
   gateway.ts Python wrapper retire; the policy file, the address, and the
   clients do not.

### Migration plan (shadow, then cut)

- **Shadow**: native router on :4101, same policy file, mirrored or sampled
  live traffic; the phase-1 harness diffs status codes, latency, token
  counts, and ladder behavior against :4100 for a week of real fan-outs.
- **Cut**: flip :4100 to the native process (launchd label swap). The
  address does not move; clients re-auth only when virtual keys activate
  (master-key compat accepted during the window, as LiteLLM accepts its
  master key).
- **Rollback**: until Phase 4 deletes the Python runtime, rollback is
  re-pointing the label — the decision is reversible up to the last step.

## 5. Risk register

### SSE and streaming edge cases

| Risk                                       | Design answer                                         |
| ------------------------------------------ | ----------------------------------------------------- |
| Upstream dies after first byte             | SSE `event: error`, no re-route (would dupe content)  |
| Client disconnect mid-stream               | AbortController aborts upstream; tee stops            |
| MLX ignores `stream_options.include_usage` | usage unknown → honest omission, flagged in ledger    |
| Anthropic keep-alive comments (`: ping`)   | pass through verbatim; tee's line filter ignores      |
| Non-SSE error body on a stream request     | status pre-check before returning stream              |
| count_tokens (no stream)                   | separate plain handler, translate both dialects       |
| Backpressure on slow clients               | native ReadableStream pipe handles it; tee is passive |

### Provider quirks

- MLX port assignments are unreliable (router-swarm prior art): discovery at
  startup plus periodic re-scan, never trust the configured port.
- z.ai behavior on 429 without `retry-after`: unverified (W126
  could-not-verify). The retry design handles both; the shadow week will
  confirm which branch fires.
- The `[1m]` id question has two conflicting notes in the fleet record (W89.1
  says never strip/rewrite; gateway-config.ts says Claude strips it
  client-side so the bare id hits the wire). Pass-through on both dialects
  makes this a non-issue for cloud tiers (nothing is rewritten); the shim
  tier already handles both. Pin it with one shadow test.
- Thinking/reasoning translation: preserve the Anthropic thinking param
  verbatim toward Anthropic-dialect upstreams; translate to
  `reasoning_effort` toward OpenAI-dialect where supported, degrade honestly
  where not (W89.1 requirement 3).

### What LiteLLM handles that we would discover the hard way

- **Tool-call translation across dialects** — the single largest hidden
  surface: tool_use/tool_result blocks, tool_choice, parallel tool calls,
  and streaming tool-call deltas differ per dialect. The cross-dialect
  adapter estimate above carries this; it is also the item most likely to
  bust the M estimate. Mitigation: cross-check W129's internals map when it
  lands for what LiteLLM's transformer tests cover, and steal the test
  matrix shape even where we write our own code.
- **Param long tail** — response_format, logprobs, n>1, multi-part content
  (images) per dialect. We use a narrow slice today; the router should
  reject-verbose what it does not translate rather than silently mangle.
- **Spend tracking with cache tokens** — pricing cache_read vs cache_create
  differently per model; only matters once budgets go live (Phase 3), can
  ship with flat per-token costs first and honest TODO pricing.
- **Model alias resolution** — LiteLLM maps consumer names to groups. We
  already have the convention (group name == wire id, two dialects per
  group); formalize, don't reinvent.
- **Multi-instance state** — cooldowns and rate windows are in-process.
  Single-node is the honest scale; the store seam is the escape hatch.

### Operational risks

- Config reload: solved by file-watch hot-swap (no restart), but the
  between-fan-outs rule stays until Phase 4.
- The launchd cutover touches com.belt.gateway — the W101 class of
  ship-vs-daemon races says: one label owns the port, kickstart discipline,
  never two writers on :4100.

## 6. Verdict input — the decision rule, not the decision

Three live paths: build native (this doc), fork a base (W130: one-api,
Helicone-class), stay on LiteLLM and buy the license for the enterprise
tier. The rule set:

1. **Count dialects, not providers.** Two wire dialects is the build case;
   it stays true as long as the pool is OpenAI-shape + Anthropic-shape. A
   third dialect (Bedrock, Vertex) in the pool flips this rule toward fork
   or LiteLLM — that is the trigger to watch, not model count.
2. **The paid line is human identity.** W126: quota, ladders, budgets are
   free in LiteLLM; SSO/SCIM/JWT-for-humans is the license. If the
   requirement is identity for humans, buying is honest and cheap
   (usage-sized annual). If the consumers are agents with static keys —
   which this fleet is — the paid line buys nothing we need, and the
   governance layer is tables we already know how to run (W92 precedent).
3. **Fork when the adapter matrix, not the governance, is the cost.** If
   W130's evaluation finds a base whose adapter + streaming code is
   battle-tested in exactly our two dialects, patching it may beat
   greenfield on the riskiest component (cross-dialect tool calls) while we
   still own the governance layer. Fork kills the config-projection and
   Python-runtime cost too; it adds upstream-tracking cost. The comparison
   line: whose test suite would we rather inherit.
4. **Charge the operational surface honestly.** LiteLLM-as-is = uv tool +
   Python runtime + generated yaml projection + license boundary + kickstart
   reload semantics. Native = one Bun process in a fleet that already runs
   Bun everywhere, one policy file it already edits, reload without dropped
   streams. That difference is real but small at fleet scale — it decides
   ties, not wars.
5. **Stay reversible until the last step.** Shadow-then-cut works for all
   three paths; nothing is irreversible until Phase 4 deletes the Python
   runtime. Defer the final call until W129 (does the internals map surface
   streaming/translation cases our tee misses?) and W130 (is there a fork
   base that already passed the W89.1 acceptance bar?) land.

One-line decision rule: **build native while the transport is two dialects
and the consumers are agents; fork when the transport long tail outgrows
us; buy when humans need identity at the API surface.**

## 7. Could-not-verify / pending cross-checks

- W129 internals map (sibling lane, in flight): verify the tee covers
  LiteLLM's streaming edge cases; revisit the tool-call test matrix.
- W130 build-base evaluation: the fork branch of the decision rule needs its
  numbers.
- z.ai 429 `retry-after` presence: needs a live 429 (shadow week will show
  it).
- `[1m]` wire-id note conflict: one shadow test pins it.
- Cache-token pricing granularity: deferred to Phase 3; flat costs first.
