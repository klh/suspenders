# buckle federation — the at-scale shape (2026-10-01)

Owner decision sketch, recorded as architecture. One-line: **spokes run the
work; the hub governs and sees the sum.**

## Roles

| plane | runs                                                                | sees                                                             |
| ----- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| spoke | local-llm swarm + belt (client) + suspenders (work graph, lanes)    | everything local; hub-reachable or not                           |
| hub   | buckle (identity, policy, catalog, ledger) + global belt/suspenders | every spoke's hub-routed traffic, work logs, lane view — the SUM |

- **buckle (hub)**: keys/teams/budgets (W141), policy distribution (routing
  YAML, config-over-code; spoke-side apply = the W147 settings writer),
  catalog of every model usable THROUGH buckle — self-hosted pools, on-prem,
  cloud (W150 catalog as the seed) — plus route_audit/usage rollup.
- **global suspenders**: work-log + lane view across ALL users and teams —
  a rollup over the spokes' graph deltas (v8 deltas already emit the rows).
- **global belt**: the all-LLMs overview reading buckle's catalog + rollups.

## Visibility boundary (the law)

The hub sees what transits it, and nothing else. **Spoke-local LLMs are
invisible to the hub** — ports, models, counts, costs stay on the machine.
A spoke MAY self-report privacy-preserving aggregates (tokens by model
class, no model names, no content) so global dashboards stay complete;
default OFF, per-team opt-in alongside the routing policy. This is a
boundary law, not an implementation gap.

## Degradation law

Hub-unreachable ≠ down. Spokes keep: local ladder + last-known policy +
cached catalog. Only hub-routed rungs fail (must-cloud 503s honestly).
The store (:7794) and board (:7799) stay up on any machine, isolated.

## Why the pieces already fit

- W149 issuer/validator split = hub issues, spokes validate (RP mode
  config-only — authentik or any corporate IdP can front the hub later).
- v8 `route_audit`/deltas = the up-feed; W127 usage surfaces = the
  rollup renderers.
- W150 catalog = the hub's all-LLM view source of truth.
- Zero-LLM local routing (<1ms, W140) keeps the hub out of the hot path —
  latency stays spoke-local by construction.

## Sequencing

Phase 1 (post-W144 cut-over): hub policy distribution + spoke pull.
Phase 2: work-delta up-feed → global lane view. Phase 3: aggregate
self-report (opt-in) + global usage/aid dashboards (W152 renders them).
Nothing here re-opens W141-W143; federation is a phase, not a rewrite.
