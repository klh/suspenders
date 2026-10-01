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

## Identity plane separation (owner directive, 2026-10-01)

Users, teams, api_keys, auth_events and team ceilings move OUT of
governor.db into their own **identity.db** (same store-port pattern:
`openIdentity()`, served beside `/rpc` on :7794). Rationale: different
lifecycle (work graph is per-project churn; identity is fleet-global,
long-lived, security-sensitive), independent backup/retention/audit, and
it makes the federation split physical: **identity.db is hub-plane data;
governor.db is spoke-plane.** Spokes keep validating tokens offline
(W149/W141 verifier seams) — the DB split does not put the hub in the
request path. `budget_state` (runtime counters) stays with the ledger;
team ceilings (policy) go with identity. Migration = v9-era move of the
five tables + lib re-binding; sequenced behind the in-flight lanes.

**Signing keys are hub-only (owner law):** private/signing keys never
exist on individual spoke machines — only the central hub holds them.
Consequence: federation issuance is asymmetric (RS256/EdDSA) with a JWKS
endpoint on the hub; spokes hold only the public key and validate via the
existing W141 RP-mode seam (issuer allowlist + JWKS cache). The W149
HS256 local key remains only for the single-machine dev case where hub
and spoke are the same box, and even there the key moves into identity.db
under the hub's secrets home. Rotation is a hub operation; spoke config
never changes on rotation (JWKS fetch).

## Spoke install baseline (owner law, 2026-10-01)

Installing suspenders ALWAYS installs the local-llm swarm: smallest models
that fit the bill (the registry tier system — `BELT_TIER=minimal` = ≤4GB
residents), downloaded at install time. belt/suspenders/buckle/local wire
so that **every response traverses the local belt**, which routes to local
LLMs first and echoes what the CENTRAL belt says this user may see and
choose from (entitlements differ per user/team — the spoke menu is the
hub menu plus the spoke-private local entries). Hub-defined visibility,
spoke-executed routing; local models never appear in the hub menu.

## Two-stage fit (routing, owner law)

The quick regexp check (W96 grammar, W140 parseHint, <1ms) ALWAYS sits in
front. Behind it, a reclassifier refines fit for ambiguous cases — ideally
a small local LLM — used for LONG-RUNNING task placement so heavy work
lands where it does not overtax the user's system (the classifier runs on
the spoke's smallest capable model, caches its verdict per task, never
sits in the per-request hot path).

## Session-end knowledge settle

At session end, the local system contributes what it learned to the
knowledge store. This is the write-back half of the knowledge-aids
architecture (decision recap: W118-W121 research → W142 outcome —
verified-only preseed IN, metered tokens-saved law, doc-covered ground
gets pointer rows or rejection at ingest, never duplicate copies). The
write-back exists as coord facts/`knowledge-enqueue` today; the settle
step makes it a standard session phase: durable, non-obvious learnings
only, deduped against the store, same verification bar as preseed.

## Sequencing

Phase 1 (post-W144 cut-over): hub policy distribution + spoke pull (the
echo model is phase 1: spoke belt mirrors hub entitlements). Phase 2:
work-delta up-feed → global lane view. Phase 3: aggregate self-report
(opt-in) + global usage/aid dashboards (W152 renders them). Nothing here
re-opens W141-W143; federation is a phase, not a rewrite.
