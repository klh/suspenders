# buckle master build plan (2026-10-01)

Synthesis of W126/W128/W129/W130/W131/W134/W135/W136/W137. Verdict: **build
native** — two-dialect transport today, adapters as config for the long tail,
~550–770 LOC buys the enterprise clouds, control plane was always ours.

## Build order (children registered on the graph, dep-blocked)

| #   | child                                 | depends   | content                                                                                                                                                                    |
| --- | ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | W133 thin slice (DONE)                | —         | two-dialect handlers, SSE tee + usage, ladder walk, ledger (:4101 shadow)                                                                                                  |
| 2   | W139 adapters tier-1 + error taxonomy | W133      | ChatAdapter interface, openai-compat/anthropic/local, 7-class RouterError, tool_calls↔tool_use transform (W134 §5)                                                         |
| 3   | W140 routing laws                     | W133      | x-belt-hint parser (W96 port), candidate table (bg-refreshed), must→503, flashx structurally absent, route_audit rows (W136)                                               |
| 4   | W132 govdb router tables              | —         | keys/teams/budgets/usage + deltas triggers (suspenders side)                                                                                                               |
| 5   | W141 governance                       | W132+W133 | virtual keys, teams, rpm/tpm budgets, JWT-ready auth middleware, audit (deltas)                                                                                            |
| 6   | W142 knowledge aids                   | W133+W132 | metering FIRST, then preseed, cache-align; compress default-off (W137)                                                                                                     |
| 7   | W143 speed pass + bench               | W139+W140 | pooling, O(1) budgets + async flush, warm-rate gate, 8-scenario bench incl. LiteLLM baseline (W135)                                                                        |
| 8   | W144 shadow → cut                     | all       | :4101 shadow week vs :4100 (scenario-8 compare), acceptance = W89.1 claude -p e2e + p50<5ms/p95<15ms + byte-identity, then label swap; LiteLLM stays installed as fallback |

Status at registration close (2026-10-01, W138): W133 thin slice **DONE** ·
W132 govdb router tables **DONE** (govdb v8, e7be0fc) · W139 adapters + W140
routing laws **CLAIMED**, in flight · W141 governance + W142 knowledge aids
**READY**, deps met · W143 bench + W144 cut-over **QUEUED** behind W139/W140.

## Standing laws baked into every child

- never flashx (structurally absent from candidates) · flash→local→openai→claude ladder
- policy in YAML (runtime override chain), never code
- must-no-match = machine-readable ERROR, never silent substitution
- zero LLM in the routing path; decision <1ms p50; router overhead p50 <5ms
- pass-through doctrine: hints in headers, bodies never mutated
- aids must meter tokens-saved or get retired
- MIT porting with NOTICE attribution; litellm_enterprise code never read/copied

## Contracts between children

- policy file: belt's `routing-policy.yaml` + `upstreams.yaml` adapter field (W134)
- ledger: govdb-shaped tables; W92 openStore binding swap when remote
- observability: servicemon /status + /metrics on :4101 (then :4100)
- aid events: `aid_events(sid, work_item)` join `usage_rollup(actor, hour)` via sessions sid→actor

Detail lives in the nine source docs under docs/design/buckle/ + docs/research/.
