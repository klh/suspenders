# Buckle routing laws — the belt grammar, native in the router (W136)

Date: 2026-10-01 · Lane: w136-laws · Status: designed, zero code. Companion
lanes: W133 (buckle thin slice, build), W134 (adapter framework), W135
(speed), W137 (knowledge aids). Inputs: the W96 grammar record (owner FINAL:
hint := VERB LOCATION? MODEL? TAGS*), belt's W124 policy file
(`bin/routing-policy.yaml` + `bin/router-policy.ts`), belt's proven-latency
scoring (`bin/route-policy.ts` `compareCandidates`/`effMs`), belt's
complexity tiers + prefs gating (`bin/router-shim.ts`), the W131 router
sketch (`docs/design/belt-native-router-2026-10-01.md`), the W129 internals
map (`docs/research/litellm-internals-2026-10-01.md`).

## 0. Mission and the laws

Buckle's routing layer makes belt's W96 hint grammar a native, in-process
property of the router. LiteLLM's analogue is `tag_based` routing plus
router policies — a 697-file-line strategy buried in `router_strategy/`
(W129). Ours is a grammar an operator can type from memory, parsed in
microseconds, with owner laws attached. The laws, stated once:

1. **Deterministic + fast, zero LLM in the routing path.** No model call
   ever decides a route. Parsing, classification, and selection are regexps
   and table walks. Decision budget: <1ms p50.
2. **must never substitutes.** `must` with no healthy full fit is a
   machine-readable ERROR — never a silent reroute, never a "close enough"
   model. (Owner law, W96 FINAL.)
3. **prefer degrades by policy, and says so.** A soft hint ranks; when the
   winner does not fully satisfy the hint, the request still proceeds but
   the audit row reads `degraded`. Degrading is honest and visible.
4. **No hint = belt's proven default policy.** healthy → proven avg_ms →
   load — byte-for-byte the ordering belt's `/api/route` uses today.
5. **NEVER flashx.** Same upstream family saturates together, and flashx is
   too expensive (owner directive, W124). The escalation ladder is flash →
   local-swarm → OpenAI → Anthropic, verbatim from the W124 policy file.
6. **allow_cloud gates every cloud hop.** Cloud escalation fires only when
   prefs allow it, cost mode is not active, and the tier warrants it —
   SIMPLE/MEDIUM never leave the machine.
7. **Every decision is audited.** Allowed, degraded, errored, denied — one
   row each, feeding dashboards and the proven-latency feedback loop.

Everything below specifies these laws to implementation precision.

## 1. Wire contract — hints ride in a request header

One contract, chosen once:

    Request:   x-belt-hint: prefer local distill reasoning
    Response:  x-belt-route: {"rid":"...","target":{...},"decision":"policy",
                              "latency_class":"fast","tier":"MEDIUM"}

- `x-belt-hint` (request header, optional): the raw hint string, exactly as
  the W96 grammar defines it. Applies to every buckle ingress route:
  `POST /v1/messages`, `POST /v1/messages/count_tokens`, and
  `POST /v1/chat/completions`.
- `x-belt-route` (response header, set on every router-decided response,
  errors included): single-line JSON — request id, resolved target
  `{kind, host, port, model}`, decision
  (`policy | degraded | fallback | errored | denied`), latency class,
  complexity tier. Programs read the header; humans read the board.
- `x-belt-error: <code>` (response header, errors only): the machine
  error code (`bad_hint | no_healthy_fit | cloud_forbidden | no_route`).
- `x-belt-rid` (response header): short request id, stamped on the audit
  row, echoed in the header — the join key between decision row and
  outcome row.

Why a header and not a body field: the W96 body field (`hint` on
`/api/route`) stays exactly where it is — that is belt's surface, already
shipped, unchanged. Buckle's contract must cover two wire dialects
(Anthropic + OpenAI), streaming bodies, and `count_tokens`; a header rides
all of them without the router touching the body, and the pass-through
doctrine (W131: never re-parse what you can forward) stays intact. Belt
injects on dispatch: when belt's `/api/route` receives a body hint and the
chosen path exits through buckle, belt forwards the same raw string as
`x-belt-hint`. Direct clients (`ANTHROPIC_BASE_URL` at :4100, lanes, any
OpenAI-shape consumer) send the header themselves.

The response body is never mutated to carry routing metadata — not on
success (SSE pass-through must stay verbatim), and not on errors except
where an error body already exists (see §4.2).

## 2. Grammar and parser (the W96 port)

The grammar is FINAL (owner, 2026-09-30) and the reference implementation
exists: belt branch `w96-hint-grammar`, commit 47599be,
`parseHint`/`hintFit`/`hintTotal`. Buckle ports those three functions
verbatim (the functions are pure and dependency-free; the port is a copy
with a header-read wrapper — W134's transport layer calls it).

    hint := VERB LOCATION? MODEL? TAGS*
    VERB     := prefer | must
    LOCATION := local | cloud | host:<server>
    MODEL    := model:<id-or-glob>        # '*' wildcard, case-insensitive
    TAGS     := tag+                      # each tag is a regexp

Parser rules (all deterministic, all tested in the W96 branch):

- Whitespace-split tokens; 1–12 tokens; each token ≤ 64 chars; raw string
  ≤ 512 chars (header addition).
- First token must be `prefer` or `must`; anything else is a 400.
- `local`/`cloud`/`host:…` and `model:…` appear at most once; duplicates
  are a 400. `host:` and `model:` need a non-empty value.
- Every other token is a tag — a regexp source. A tag that fails to
  compile degrades to a literal substring test (belt precedent); it never
  throws, never guesses.
- Header absence or empty value = no hint. More than one `x-belt-hint`
  header = `bad_hint` 400 (duplicate ambiguity is refused, not resolved
  silently — same trust class as the duplicate-location rejection).

Rejection is a product surface: every refusal returns 400 with
`x-belt-error: bad_hint` and a `why` sentence naming the first fault
(belt's messages, kept verbatim: "hint must start with 'prefer' or 'must',
got '…'", "hint: duplicate location", …).

Glob semantics (kept from W96): only `*` is special; the rest of the token
is regexp-escaped; the regexp is matched anywhere in the model id,
case-insensitively — ids carry namespace prefixes
(`mlx-community/Qwen3.5-…`), so `model:qwen*` means "any qwen anywhere in
the id". Compiled regexps are cached per parsed hint; tag regexps are
cached per policy generation (§3), so steady-state decisions compile
nothing.

## 3. The candidate table and tag fit

### 3.1 The table

The decision path never touches the network. Buckle keeps an in-memory
candidate table, background-refreshed:

    row := {
      candidate_id,          # host:port:model
      kind,                  # local | remote | cloud
      host, port, model,     # discovery data, never invented
      dialect,               # openai | anthropic
      groups,                # W124 group names this candidate serves
      capability_text,       # the string the tag cloud regexps against
      healthy,               # background probe result
      estimate_ms, calls, load_5m, errors, last_used,
                             # proven-latency fields (belt metrics snapshot)
      latency_class,         # derived, §5.3
    }

Pool sources (W131 architecture): local specialists discovered from
`/v1/models` at startup with periodic re-scan (ports are unreliable —
router-swarm prior art), LAN remotes from belt's `remotes.json`, cloud
groups from the W124 policy file. Health probes (1.2s timeout, belt
precedent) run staggered every ~2s; the metrics fields ride the 5s-TTL
snapshot belt's `metricsSnapshot()` already computes.

Cold start: the table boots empty and the first request may trigger one
synchronous refresh round (~1 probe timeout) — the only I/O ever allowed
in the decision path, and only when the cache is cold. Steady-state
decisions are pure memory.

### 3.2 Capability text and the policy tags block

Capability text is data, and it lives with the fleet's own records:

- Locals: `role + good_at + model` (registry.ts is the single source; the
  W96 precedent — adding "knowledge distillation" to :8903's good_at so
  the distill hint fits by data — is the maintenance pattern).
- Remotes: `roles + model` from remotes.json.
- Cloud groups: NEW — `routing-policy.yaml` gains an optional per-group
  `tags:` list, merged into capability text. Operators edit the YAML,
  never code (W124 doctrine). Absent tags = empty text contribution; the
  file stays v1-compatible:

  gateway:
  num_retries: 1
  allowed_fails: 3
  cooldown_time: 30
  fallbacks:
  glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]
  tags:
  glm-5.3-flash: [fast, cheap, menial, general]
  gpt-5.2: [frontier, reasoning, code]
  claude-sonnet-5: [frontier, reasoning, code, long-context]

Tag fit is the W96 rule, kept: each tag is a regexp matched
case-insensitively against the candidate's capability text; ANY tag
matching = the tag group fits; location, model, and tag groups present in
the hint AND together (`hintFit` counts satisfied groups,
`hintTotal` = number of groups the hint actually carries; full fit =
fit == total).

## 4. Semantics — prefer, must, default

### 4.1 Selection

1. **must** (hard): the candidate set is `{c : c.healthy AND fit(c) ==
total}`. Non-empty → belt's own policy orders it
   (`compareCandidates`), the best is taken, decision `policy`. Empty →
   **machine-readable ERROR**, nothing is sent upstream (§4.2).
2. **prefer** (soft): candidates are ordered by `fit` DESC, then belt's
   policy (`compareCandidates`) breaks ties. If the head candidate's fit
   < total, the request proceeds anyway and the audit decision reads
   **degraded**.
3. **no hint** (default policy): exactly today's ordering, ported
   verbatim from belt `route-policy.ts` — healthy before unhealthy;
   proven (calls > 0, estimate_ms != null) before unproven; then
   `effMs = estimate_ms * (1 + 0.1 * load_5m)` ascending (unproven sort
   to the back via +inf, tiebroken by probe RTT); then fewer errors; then
   least-recently-used. Belt's proven-latency doctrine is the law here:
   never-measured is not fast.

`compareCandidates` and `effMs` are ports, not reinterpretations — the
no-hint path must order a fixture identically to belt's `/api/route`
(test, §7).

### 4.2 The must-error contract

When `must` finds no healthy full fit, the router answers without calling
any upstream:

    Status: 503
    x-belt-error: no_healthy_fit
    x-belt-route: {"rid":"…","decision":"errored",…}

Body — dialect envelope, code and why always inside:

- `/v1/messages` (Anthropic shape):
  `{"type":"error","error":{"type":"api_error","message":"belt: no_healthy_fit — must 'must cloud': no healthy full fit among 14 candidates — must never substitutes"}}`
- `/v1/chat/completions` (OpenAI shape):
  `{"error":{"message":"belt: no_healthy_fit — …","type":"api_error"}}`
- belt's own `/api/route` keeps the W96 body shape `{"error":"no healthy
fit","why":"…"}` — unchanged.

The machine code lives in `x-belt-error` (one place, every dialect); the
`why` sentence travels in the envelope message. `why` names the hint, the
candidate count, and the law: "must never substitutes".

Special case — `must cloud` while prefs say `allow_cloud: false`: same
503 shape, code `cloud_forbidden`, why "cloud is disabled by owner prefs —
must never substitutes". An owner gate is not a health condition; it is a
law, and must refuses loudly rather than quietly keeping the request
local.

### 4.3 Interaction with escalation and prefs (the precedence law)

Hints constrain selection; complexity gates escalation; prefs gate cloud.
The precedence order, per request:

1. allow_cloud / cost_speed prefs (owner switch — beats everything)
2. the hint (selection constraint)
3. the complexity tier (escalation warrant)

Consequences, all deterministic:

- `must local` + VERY_COMPLEX tier + allow_cloud=true → local or ERROR.
  No cloud substitution, ever — that is law 2 applied to location.
- `prefer cloud` + allow_cloud=false → degrade to the best local,
  decision `degraded`.
- `prefer local` + allow_cloud=true does not _forbid_ cloud: if the
  selected local fails twice and the tier warrants (§6), the ladder may
  still escalate — the hint ranked the start of the path, the ladder owns
  failure. The audit records `fallback` when the delivered target is not
  the hinted one.
- Hint unsatisfiable + prefer → degrade (audit `degraded`); the request
  is never refused for a soft hint.

## 5. Complexity tiers, escalation, allow_cloud

### 5.1 The classifier (ported, zero LLM)

Belt's 7-dimension regexp scorer (`scoreComplexity` in router-shim.ts)
ports verbatim: token count, code presence, reasoning markers, technical
terms, simple indicators (negative weight), multi-step markers, question
depth; weights and thresholds `SIMPLE < 0.15 ≤ MEDIUM < 0.35 ≤ COMPLEX <
0.6 ≤ VERY_COMPLEX` unchanged; the code-presence clamp (code tasks ride
MEDIUM so they reach the coder) unchanged. Input: the flattened text of
the request's user messages (belt's `blocksOf` flatten), capped at the
first 8,000 chars — deterministic, microseconds.

### 5.2 Escalation — when a tier leaves the machine

The escalation law (owner 2026-09-27, speed-first local-first; W124
ladder; router-shim gates), all conditions AND-ed:

    escalate local → cloud  iff
      prefs.allow_cloud === true            # owner switch
      AND prefs.cost_speed !== "cost"       # cost mode pins local
      AND (tier ∈ {COMPLEX, VERY_COMPLEX}   # tier warrants
           OR prefs.cost_speed === "quality")
      AND local delivery failed twice       # primary + one bounded
                                            # fallback attempted

Escalation walks the W124 ladder from the failed local group:

    glm-5.3-flash → local-swarm (the :4000 shim, W89.1)
                  → gpt-5.2     (dormant until its key lands — a dormant
                  → claude-sonnet-5  tier is a skip, not a failure)

NEVER flashx — not as a ladder rung, not as a synonym, not as a fallback
hint expansion. If a hint or future policy names flashx, the parser-level
law is: flashx is not a group in the table, so it cannot resolve; a
`model:*flashx*` must therefore errors, and a prefer degrades — the law
enforces itself through data absence. (Belt-side guard also lives in the
policy file comment; the table makes it structural.)

Retry/cooldown numbers stay W124's: `num_retries: 1`,
`allowed_fails: 3`, `cooldown_time: 30` — per-call retry with
retry-after-honoring jittered backoff, consecutive-failure ejection into
a cooldown window (W129 §2 confirms these are the only router mechanics
we actually use).

### 5.3 Latency classes

Derived from `estimate_ms` at decision time, used in the audit row and
the `x-belt-route` echo:

    unproven   estimate_ms is null        (never called — conservative)
    fast       < 500 ms                   (locals: 138–400 ms measured)
    medium     500–2000 ms                (warm cloud)
    slow       ≥ 2000 ms                  (frontier / cold)

Thresholds are data, not dogma: they live next to the policy file's tags
block and may be tuned by the operator after the shadow week.

## 6. The audit trail (the LiteLLM audit equivalent, ours)

LiteLLM sells audit logs behind the license gate (W126); ours is one
SQLite table buckle already owns, plus counters. Every request writes:

    route_audit (
      id, ts,
      rid,                # x-belt-rid — join key
      actor,              # bearer key label (W127 join key)
      dialect,            # anthropic | openai
      hint,               # raw string, '' = none
      candidates_seen,    # integer
      candidates_top,     # ordered top-3 ids, comma-joined
      target_kind, target_host, target_port, target_model,
      decision,           # policy | degraded | fallback | errored | denied
      latency_class,      # unproven | fast | medium | slow
      tier,               # SIMPLE | MEDIUM | COMPLEX | VERY_COMPLEX
      allow_cloud,        # prefs state at decision time
      why                 # one honest sentence naming what decided it
    )

Two writes per request, both O(1): the decision row INSERTed at dispatch
(target already known), and an outcome row (`status, duration_ms, ok,
err` — belt's `routes` table shape) UPDATEd/INSERTed after completion,
joined by `rid`. Writes are fire-and-forget WAL inserts; a failed audit
write never fails the route (belt precedent).

Feeds:

1. **The proven-latency feedback loop (in-process).** Outcome rows are the
   same shape belt's `routes` table ingests; the `avg_ms`/`load_5m`
   rollup that fills `estimate_ms` in the candidate table reads them —
   routing decisions make future routing decisions smarter, with no
   external mover.
2. **W127-style dashboards.** The W127 usage ledger keys on
   `(hour_bucket, actor, model)`; the audit row carries `actor` and the
   resolved `target_model`, so per-actor and per-model token/latency
   panels join on existing keys. Board panels read the table through the
   store-server seam (W92 statement-shaped port).
3. **servicemon counters (W125 standard).** `buckle_route_decisions_total
{decision, dialect}`, `buckle_route_latency_class_total {class}`,
   `buckle_ladder_events_total {event}` (failover, cooldown start/end,
   escalation) — degradation visible on the board, not just totals.
4. **Scrub rule.** Error text and `why` sentences pass the same scrub as
   observability payloads — no user paths, no hostnames beyond the pool's
   own machine names, no tokens.

Denied requests audit too (auth failures, bad hints, empty bodies) —
allowed AND denied, the belt doctrine, unchanged.

## 7. Wire contract examples

Pool for the examples: local specialists :8901 code / :8902 extract /
:8903 reason / :8906 general (healthy, proven), cloud groups glm-5.3-flash,
gpt-5.2 (dormant), claude-sonnet-5. Placeholders: `host:box` is a set
server; tokens elided.

### 7.1 `prefer local reasoning` — soft hint, full fit

    POST /v1/chat/completions
    x-belt-hint: prefer local reasoning
    {"model":"glm-5.3-flash","messages":[{"role":"user","content":"…"}]}

    200
    x-belt-route: {"rid":"r1","target":{"kind":"local","host":"local",
      "port":8903,"model":"mlx-community/Qwen3.5-35B-A3B-4bit"},
      "decision":"policy","latency_class":"fast","tier":"MEDIUM"}

Reason :8903 fits `local` AND `reasoning` (role + good_at "multi-step
reasoning…") = full fit; proven 843ms avg beats everything local. Body:
the upstream's JSON, verbatim.

### 7.2 `must cloud` — hard hint, honored

    POST /v1/messages
    x-belt-hint: must cloud
    {"model":"claude-sonnet-5","max_tokens":256,"messages":[…]}

    200
    x-belt-route: {"rid":"r2","target":{"kind":"cloud","host":"z.ai",
      "port":443,"model":"glm-5.3-flash"},"decision":"policy",
      "latency_class":"medium","tier":"COMPLEX"}

Both cloud candidates are healthy and fit `cloud`; policy ranks the
proven-faster one first. The request's `model` field is a client
convention here, not a constraint — the hint chose; the router resolved.

### 7.3 `must cloud` with cloud disabled — the error law

Same request, prefs `allow_cloud: false`:

    503
    x-belt-error: cloud_forbidden
    x-belt-route: {"rid":"r3","decision":"errored"}
    {"type":"error","error":{"type":"api_error","message":"belt:
      cloud_forbidden — must 'must cloud': cloud is disabled by owner
      prefs — must never substitutes"}}

Nothing was sent upstream. No local substitution, no silent anything.

### 7.4 `prefer host:box model:qwen*` — host + glob, degrade shown

    POST /v1/chat/completions
    x-belt-hint: prefer host:box model:qwen*

    200
    x-belt-route: {"rid":"r4","target":{"kind":"remote","host":"box",
      "port":8080,"model":"qwen2.5-0.5b"},"decision":"policy",
      "latency_class":"fast","tier":"SIMPLE"}

If instead the box is down (unhealthy): the best candidate becomes the
best remaining, and the same 200 carries
`"decision":"degraded"` — the reply is served, the audit says the hint
was not fully satisfied. If the hint had been `must`, the response would
be §7.3's error with code `no_healthy_fit`.

### 7.5 `must speed` — tag with no data fit, must errors honestly

    POST /v1/messages
    x-belt-hint: must speed

    503
    x-belt-error: no_healthy_fit
    x-belt-route: {"rid":"r5","decision":"errored"}
    {"type":"error","error":{"type":"api_error","message":"belt:
      no_healthy_fit — must 'must speed': no healthy full fit among 14
      candidates — must never substitutes"}}

`speed` is a tag regexp; no candidate's capability text contains it
(:8902 says "fast cheap drafting" — `fast`, not `speed`). The fix is
data, not code: add `speed` to the policy `tags:` block or a good_at
string (the W96 :8903 precedent). Belt's `/api/route` accepts `prefer
speed` the same way; nothing here invents a synonym at route time.

### 7.6 No hint — default policy

    POST /v1/chat/completions
    {"model":"glm-5.3-flash","messages":[…]}

    200
    x-belt-route: {"rid":"r6","target":{"kind":"local","host":"local",
      "port":8903,"model":"…"},"decision":"policy","latency_class":
      "fast","tier":"COMPLEX"}

No hint: healthy → proven avg_ms → load ordering, identical output to
belt's `/api/route` on the same fixture state. If :8903 then fails twice
on this COMPLEX request with allow_cloud=true, the ladder escalates and
the response header reads `"decision":"fallback"` with the cloud target
— that pair of rows (7.6's decision row + fallback row) is the audit
shape the ladder dashboards are built on.

### 7.7 Malformed hint — refused, never guessed

    POST /v1/chat/completions
    x-belt-hint: maybe cloud i guess
    x-belt-hint: prefer local        (second header — refusal reason)

    400
    x-belt-error: bad_hint
    {"error":{"message":"belt: bad_hint — exactly one x-belt-hint header
      allowed","type":"invalid_request_error"}}

`maybe` is not a verb (first fault named); and the duplicate header is
refused on sight. One selector at a time, deterministic.

## 8. Acceptance

1. **Decision < 1ms p50** (law 1). Bench: prebuilt candidate table (50
   rows), 10k decisions across the example hint set + no-hint; p50 < 1ms,
   p99 < 5ms for decide() alone — cache refresh and audit writes excluded
   (they are off-path by design). Regexps precompiled; zero allocations
   beyond the sort.
2. **Zero LLM in the routing path** (law 1). Structural: the decision
   module imports no fetch/client and makes no model call — grep-able,
   enforced by review; the classifier and hint engine are pure functions.
3. **Grammar table tests** (§2): every W96 example parses to the W96
   shape; every rejection case (no verb, >12 tokens, >64-char token,
   duplicate location, empty host:/model:, >512-char header, multiple
   headers) refuses with the named `why`.
4. **Semantics matrix** (§4): must-full-fit, must-empty → 503 +
   x-belt-error code; prefer-full vs prefer-degraded ordering; the
   precedence matrix (must local + VERY_COMPLEX + allow_cloud=true →
   local or error; prefer cloud + allow_cloud=false → degraded local).
5. **Default-policy parity**: no-hint ordering of a fixture equals belt
   `compareCandidates` output on the same rows (port, not drift).
6. **Audit completeness**: every request (allowed, degraded, fallback,
   errored, denied) yields exactly one decision row and one outcome row,
   joined by rid, with latency_class and tier populated.
7. **Ladder law**: flashx appears in no group, no ladder, no alias —
   asserted by a test that walks the loaded table.
8. **Shadow-week calibration**: latency-class thresholds and the tag
   blocks reviewed against real decision rows before the thresholds are
   declared final.

## 9. Sync items and could-not-verify

- **The W96 reference implementation is not on belt main.** Commit
  47599be lives on belt branch `w96-hint-grammar`; belt main is at W124
  (8d5683d) and its working `route-policy.ts` has no hint code. The
  grammar is owner-FINAL either way; buckle ports the functions from the
  branch. Belt and buckle each need the other's landed state eventually
  (belt main wants W96 hints; the branch wants W124's ladder) — a belt
  merge lane, not this one.
- **z.ai 429 `retry-after` presence** is unverified (W126/W131 carry it);
  the ladder design handles both branches. Shadow week confirms.
- **Latency-class thresholds** (§5.3) are first-pass, pending real
  decision rows.
- **`must speed`-style data gaps** (§7.5) are expected on day one; the
  fix is operator data (tags blocks, good_at), and the audit's
  `candidates_top` + `why` make each gap visible within one occurrence.

## Repo-scoped laws + BYO-LLM (owner model, 2026-10-01)

Routing law sources gain a repo layer and a user-private plane, with BOTH
configuration paths built in from day one — the `.llm` dotfile AND the
GUI settings surfaces: same grammar, same parser, same validation (one
source of truth for the grammar; two editors for the sources).

- **Repo dotfile** (`.llm` in any working-dir root): `prefer=<glob>`,
  `must=<glob>`, `tier=`, `fallback=` lines — same W96 grammar, one law
  per line, comments allowed. Belt picks it up per-project (the
  x-belt-hint header seam stays the transport; the dotfile is the
  per-repo SOURCE). Invalid lines fail loudly with the line number.
- **GUI paths built in**: /console/settings gains repo-scope editors for
  the user plane (pick a repo, edit its laws with preview→apply, the
  W147 flow); the hub's settings surface edits company-repo policies
  which ride the W154 policy pull. GUI edits a repo's dotfile by writing
  the same file (preview + diff, never silently) — dotfile and GUI are
  views over the same store, not competing formats.
- **BYO-LLM (user plane)**: a user's privately-purchased LLMs
  (ElevenLabs, personal z.ai, anything with an endpoint) register in the
  SPOKE's belt registry from the user's own config (keys in the user
  secrets home, mode 600, never committed). They appear in the spoke
  menu as user-plane entries alongside — never inside — the
  hub-entitled menu.
- **Resolution precedence + reconciliation (owner law)**: repo dotfile >
  user plane policy > central policy for company repos > install default.
  DOTFILES WIN: when an agent finds a repo, (a) dotfile + no config →
  adopt, materialize the config entry FROM the dotfile; (b) dotfile +
  config → the dotfile wins, the config entry is updated to match it
  (the config is a live mirror, the dotfile is the source); (c) no
  dotfile + config → the config governs and is written as the repo's
  effective policy; (d) neither → defaults take over. Company repos:
  central `must` wins over user `prefer` (entitlements are ceilings,
  not suggestions); private repos: the user's laws are sovereign, the
  hub is not consulted unless opted in. `must` with no fit still errors
  honestly at every layer (never silent substitution).

IKEA-shaped example (owner's): IKEA repos route to the IKEA hub's OpenAI
LLM via central policy; a private repo routes to personal glm-5.3 on
z.ai via the user plane; a text-heavy repo sends its work to a private
ElevenLabs endpoint via its dotfile. One grammar, three sources, fixed
precedence, two first-class editing paths. Registered as W164 (blocked
on W154).
