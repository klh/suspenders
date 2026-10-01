# LiteLLM internals — what it actually builds on (W129, 2026-10-01)

Method: T1 source dive of OUR pinned install (LiteLLM **1.103.0**, uv tool
site-packages `~/.local/share/uv/tools/litellm/...`, read-only — nothing under
site-packages touched, nothing executed). Cross-reference: W126
`docs/research/litellm-enterprise-audit-2026-10-01.md` covers capability
tiers/licensing; this doc covers anatomy and the minimal-replacement question.

## 0. The hunch, answered

"LiteLLM probably builds on something else underneath" — yes, five standard
layers plus one surprise:

1. **FastAPI + Starlette + uvicorn** — the proxy shell is a plain ASGI app
   (fastapi 0.141.1, starlette 1.7.0, uvicorn 0.54.0 in the same venv;
   gunicorn/granian as prod wrappers per the `proxy` extra).
2. **OpenAI Python SDK** — openai 2.54.0. For every `openai/*` model LiteLLM
   calls `client.chat.completions.create` (or `.with_raw_response` when it
   wants response headers) on the official SDK (`llms/openai/openai.py`).
3. **httpx + aiohttp** — a custom transport layer (`llms/custom_httpx/`,
   ~17.5k LOC) for non-OpenAI providers (Anthropic, Bedrock, Vertex, ...).
4. **Prisma Client Python on Postgres** — the virtual-key/budget store is
   **not SQLAlchemy** (common assumption, wrong): `prisma>=0.11.0` is the
   dependency, `proxy/schema.prisma` defines 15 models, and migrations run
   `prisma migrate deploy` (per the package's own METADATA).
5. **prometheus_client** — `/metrics` (lazy, function-local imports; the
   client is not even installed in our venv, so the metrics stack is optional).
6. **Surprise: a compiled Rust bridge** — `litellm/rust_bridge/` ships
   `_native.abi3.so` plus ~1.5k LOC of Python wrapper for hot-path dispatch
   (hook dispatch, chat_completions, messages, token_counter, timeouts), with
   a Python fallback via `native_bridge_available()`.

Scale: 2,471 .py files, **~834k LOC** in `litellm/` alone, plus
`litellm_enterprise` 0.1.69 (~11.4k LOC) and `litellm_proxy_extras` 0.4.100.
Biggest single files: `proxy/proxy_server.py` 19,555 lines, `router.py`
14,412 lines, `main.py` 9,193 lines, `utils.py` (top level) ~433 KB.

## 1. Anatomy map (pinned 1.103.0, LOC = `wc -l` on installed .py)

| #   | Layer              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where / approx LOC                                                                                                                                                                                                                                                                       | Deps                                                  | Would a Bun/TS replacement need it?                                                          |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Proxy shell        | FastAPI app (`app = FastAPI` at `proxy/proxy_server.py:1562`), ~103 route decorators, 7 middlewares (Prometheus auth, in-flight gauge, security headers, admission control, request-size limit, root-path), `user_api_key_auth` as the auth dependency                                                                                                                                                                                         | `proxy/proxy_server.py` 19.6k; `proxy/auth/` 20.6k (`auth_checks.py` 6.3k, `user_api_key_auth.py` 3.8k, `route_checks.py` 0.9k); `proxy/middleware/` 1.1k                                                                                                                                | fastapi, starlette, uvicorn, pyjwt, cryptography      | Yes, but ~6 routes not 103. Bun.serve + a bearer-key check function                          |
| 2   | Router             | Retry/fallback ladder, per-deployment cooldown, healthy-deployment selection, 15 routing strategies                                                                                                                                                                                                                                                                                                                                            | `router.py` 14.4k + `router_utils/` 7.2k (cooldown_handlers 660, cooldown_cache 223, get_retry_from_policy 63, response_headers, health_state_cache) + `router_strategy/` ~4.5k across 15 strategies (simple_shuffle 67 ... budget_limiter 848, tag_based 697, lowest_tpm_rpm v1+v2 856) | Redis or in-mem `DualCache` for cooldown/RPM state    | Core 20%, but one strategy + one ladder + one cooldown window replaces all fifteen           |
| 3   | Transport          | Per-provider adapters; OpenAI-shape via official SDK, non-OpenAI via custom httpx/aiohttp; SSE re-chunking                                                                                                                                                                                                                                                                                                                                     | `llms/` 208k in 950 files (bedrock 25.7k, vertex 24.6k, anthropic 21.5k, custom_httpx 17.5k incl `llm_http_handler.py` 13.7k, openai 15.3k, base_llm 9.7k) + `litellm_core_utils/streaming_handler.py` 2.5k                                                                              | openai SDK, httpx, aiohttp, tiktoken, tokenizers      | Mostly NOT: `fetch()` streaming pass-through for the two shapes we speak (OpenAI, Anthropic) |
| 4   | Key/budget store   | Virtual keys, teams, orgs, budgets, spend logs, audit log — **Prisma, not SQLAlchemy**; 15 models: VerificationToken (the keys), TeamTable, TeamMembership, UserTable, EndUserTable, OrganizationTable, BudgetTable, ProxyModelTable, ModelTable, SpendLogs, ErrorLogs, UserNotifications, InvitationLink, AuditLog, Config                                                                                                                    | `proxy/db/` 13.5k (`prisma_client.py`, `db_spend_update_writer.py`, `db_transaction_queue/`, `spend_log_batching.py`, `pgbouncer.py`), `proxy/spend_tracking/` 13.0k, `proxy/management_endpoints/` 53.8k (key_management_endpoints.py 7.7k)                                             | prisma, Postgres                                      | No: governor.db (SQLite/WAL) already plays this role in our fleet (W92)                      |
| 5   | Config machinery   | YAML load → `model_list` becomes Router deployments; `router_settings`, `litellm_settings`, `general_settings`; hot-reload via `/config/*`                                                                                                                                                                                                                                                                                                     | `proxy_cli.py` + `proxy_server.py:5763 load_config` + `proxy/utils.py` 8.5k; examples in `proxy/example_config_yaml/`                                                                                                                                                                    | pyyaml                                                | Trivial: our W124 `routing-policy.yaml` precedent                                            |
| 6   | /metrics           | Prometheus registry of **96 unique `litellm_*` series**: `litellm_proxy_total_requests_metric`, `litellm_request_total_latency_metric`, `litellm_llm_api_latency_metric`, `litellm_deployment_total_requests/success/failure_responses`, `litellm_deployment_state`, `litellm_deployment_cooled_down`, `litellm_deployment_latency_per_output_token`, `litellm_deployment_rpm/tpm_limit`, `litellm_spend_metric`, guardrail/MCP/batch counters | `integrations/prometheus.py` 4.7k (+ `prometheus_helpers/`), mounted via `PrometheusAuthMiddleware`                                                                                                                                                                                      | prometheus_client (lazy import; absent from our venv) | Yes, but ~10 series not 96; text exposition in servicemon                                    |
| 7   | Enterprise package | SSO/JWT/RBAC glue (`proxy/auth/`, `proxy/hooks/`), UI CRUD endpoints, PagerDuty + email alerts, secrets plugins, vector-store auth                                                                                                                                                                                                                                                                                                             | `litellm_enterprise/` 0.1.69, ~11.4k LOC, imports hook into OSS call sites                                                                                                                                                                                                               | license key gate at runtime (W126)                    | No                                                                                           |
| 8   | Rust bridge        | Optional native acceleration of hot paths; Python fallback                                                                                                                                                                                                                                                                                                                                                                                     | `litellm/rust_bridge/` 1.5k py + `_native.abi3.so`                                                                                                                                                                                                                                       | compiled Rust lib                                     | No                                                                                           |

## 2. Essential vs incidental for OUR use

Our shape: loopback gateway, flash ladder (2-3 local GLM/MLX deployments +
cloud escape), per-key budgets, teams, audit trail. Scale: single digits of
keys, single machine.

**Essential (the ~20% giving the 80%):**

- `model_list` → deployment table with model-name → upstream mapping
  (~50 LOC of schema logic).
- Async call loop with: retry policy **per exception type** (RetryPolicy
  resolves `default` / `timeout` / `RateLimitError` / ... per model-group —
  the whole resolver is 63 lines), retry-after honor + jitter
  (`_time_to_sleep_before_retry`, `_calculate_retry_after`), fallback ladder
  over model groups.
- Cooldown window: N allowed fails in T → deployment benched for
  `cooldown_time` seconds (`cooldown_handlers.py`, 660 lines to LiteLLM's
  generality; ~80 lines for our fixed policy).
- SSE streaming: pass bytes through, **and** sniff the final `usage` chunk —
  LiteLLM extracts usage even when the caller never asked for it
  (`stream_options.include_usage` only controls what the caller sees,
  `streaming_handler.py:1730`). That one design point is what makes per-key
  token accounting work on streamed responses.
- Virtual keys + per-key/team budget + team membership + audit rows — a
  5-table SQLite schema covers what we use (VerificationToken, Team,
  TeamMembership, Budget, SpendLog/AuditLog), vs their 15.
- Cost/spend: static price table × tokens. LiteLLM's `cost_calculator.py` is
  2,945 lines + a 2.8 MB price JSON because it prices every provider; we price
  4 models.
- Config: one YAML, loaded once.
- Metrics: ~10 counters/histograms (requests, latency, tokens, spend,
  cooldowns, fallbacks) in Prometheus text format.

**Incidental for us (the ~80% we would not copy):** 100+ provider adapters
(950 files — we speak 2 wire shapes); 103 HTTP routes (batch/ files/ realtime/
images/ MCP/ guardrails/ responses-API — we need ~6); Prisma + Postgres +
pgbouncer wrapper + spend batching; Redis DualCache; 15 routing strategies;
guardrails, caching layer, prompt management; SSO/UI/enterprise; rust bridge;
admission control; scheduler (apscheduler); fastapi-sso; rq job queue.

## 3. Bun/TS component inventory (with our existing precedents)

| Component                                                                                         | LiteLLM counterpart                                              | Our precedent                                                                                           | Est LOC (TS)      |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| Gateway shell: routes `/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/health`, `/metrics` | `proxy/proxy_server.py` (19.6k)                                  | belt `bin/anthropic-shim.ts` :4000 (W89.1), `bin/router-shim.ts`                                        | 300               |
| Config loader: policy YAML → deployments + retry/cooldown params                                  | `load_config` + pyyaml                                           | W124 `routing-policy.yaml` + belt `bin/router-policy.ts`                                                | 150               |
| Router core: pick deployment, retry ladder, cooldown window                                       | `router.py` + `router_utils/` (21.6k)                            | W124 fallback ladder + 429 backoff w/ retry-after+jitter (W126 verdict: this is the whole custom scope) | 500               |
| Transport: streaming fetch pass-through, both wire shapes                                         | `llms/` (208k) + `streaming_handler.py`                          | belt anthropic-shim transport; bare `fetch()`                                                           | 400               |
| Usage extraction: sniff final SSE chunk, attribute to key                                         | `streaming_handler.py` usage collector                           | belt `/api/route` usage accounting                                                                      | 120               |
| Key/budget/teams store + auth check                                                               | Prisma schema + `auth_checks.py` + `management_endpoints/` (67k) | governor.db (SQLite/WAL) + W92 `hooks/bin/store-server.ts` (:7794, token auth, tx-over-wire)            | 700               |
| Audit trail (per-request rows: key, model, tokens, cost, latency, fallback path)                  | `SpendLogs` + `AuditLog` models + spend_tracking (13k)           | govdb audit pattern                                                                                     | 150               |
| /metrics exposition                                                                               | `integrations/prometheus.py` (4.7k, 96 series)                   | W125 `hooks/lib/servicemon.ts` (349 LOC)                                                                | 200               |
| Price table + cost math                                                                           | `cost_calculator.py` + 2.8 MB JSON                               | new, 4-entry table                                                                                      | 150               |
| **Total**                                                                                         | **~834k LOC Python**                                             |                                                                                                         | **~2,700 LOC TS** |

Wire behaviors to copy verbatim (they are contracts, not implementation):
SSE chunk framing pass-through; `usage` sniff on the terminal chunk;
`retry-after` (and anthropic `retry-after` variants) honored before retrying;
`x-ratelimit-*` response-header propagation for upstream quota visibility
(LiteLLM captures these via `with_raw_response` / `response_headers.py`).

## 4. Effort estimate

| Slice                                                                | LOC        | Effort                                                                                                                                              |
| -------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell + config + transport + usage sniff (a working keyless gateway) | ~970       | 1-2 days (mostly a generalization of the :4000 shim)                                                                                                |
| Router core (ladder + cooldown + retry policy)                       | ~500       | 1-2 days incl. tests                                                                                                                                |
| Key/budget/teams on governor.db + auth + audit                       | ~850       | 2-3 days (schema + budget reservation semantics — the subtle part is mid-flight spend vs budget check, LiteLLM reserves in `budget_reservation.py`) |
| /metrics + price table                                               | ~350       | 0.5 day                                                                                                                                             |
| Tests + launchd + servicemon wiring                                  | —          | 1 day                                                                                                                                               |
| **Total**                                                            | **~2,700** | **~6-9 focused days**                                                                                                                               |

Against W126's verdict this confirms: LiteLLM-free quota handling is native
config there, and the belt-policy custom scope (complexity tiers, cloud
gating, proven-latency scoring, audit) is exactly the part LiteLLM's 834k LOC
does NOT give us anyway.

## 5. Could-not-verify

- Whether the Rust bridge is ACTIVE on this machine (read-only mandate: did
  not execute loader code to test `_native.abi3.so` against this platform;
  it degrades to Python either way, so behavior-relevant only for perf).
- `prometheus_client` is absent from this venv while `integrations/
prometheus.py` imports it lazily — so on this install `/metrics` presumably
  only works if the dependency is pulled in elsewhere (e.g. belt's
  deployment); did not boot the proxy to observe.
- GitHub tag-level diff of BerriAI/litellm v1.103.0 vs the installed tree not
  done (uv wheel is the source of truth for what WE run; upstream drift
  irrelevant to the replacement question).
- LOC figures are `wc -l` over installed wheels, including
  generated/serdes-heavy files — order-of-magnitude, not a decomposition
  estimate.
- Did not verify `lowest_tpm_rpm_v2` vs v1 selection logic (which one a
  config gets by default) — flag if this matters later.
