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

## Domain separation (data-egress law, owner directive 2026-10-01)

Traffic and knowledge follow the same domain boundary, bidirectionally:

1. **Spoke-private LLM traffic NEVER transits the hub.** Local-swarm and
   BYO user-plane models are routed by the local belt directly to the
   configured endpoints — the hub is not in the path, not proxied, not
   even observed. Only hub-entitled models' traffic goes through
   buckle-hub.
2. **Knowledge follows provenance.** The session-end settle contributes
   to the CENTRAL hub knowledge store only what was learned in
   hub-routed sessions. Learnings from local/BYO-LLM sessions stay on
   the spoke's local knowledge shelf — private repo code, personal
   data, and trade secrets must not leak across domains through
   knowledge write-back. Sessions touching both domains take the most
   restrictive domain (private, period).
3. Implementation shape: every session/lane carries a provenance label
   (hub | private) derived from what it actually routed through; the
   settle step sorts by label; the hub-ward feed filters on hub only.
   W159 implements the sort; the W160 CR/policy channels never carry
   private-domain content either.

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

## Hub change-request channel (push-down, owner law)

belt or central suspenders can push a CHANGE REQUEST down to spokes:
"update suspenders — new rules apply", "reconfigure belt", "adopt policy
revision N". Mechanism stays spoke-pulled (degradation law): the phase-1
policy pull payload carries a CR queue; the spoke reconciles through its
own trusted paths — coord inbox delivery to live sessions, self-update
via the installer path (W158), policy apply via the W147 settings
writer, label restarts. CR lifecycle: declared → delivered → applied →
verified → reported-up (or failed + escalated). Belt originates
LLM-policy CRs; suspenders originates work-graph/rules CRs — same queue,
same lifecycle.

## Policy advisor (suggested enforcement, owner law)

Machine-checkable policy rules run against the service a session is
working on: health endpoint presence (the W125 servicemon law), HTTP
citizenship (http-citizenship.md), the 1500-line law, qlty presence,
auth-surface conventions. A violation SURFACES to the user as a
suggestion with the policy citation and an opt-in offer — "according to
policy this service should have a health endpoint; want me to implement
it and push that PR?" — never a silent mutation: enforcement is
suggested, the PR is pushed only on the user's yes (and PRs land on
branches, never straight to main). The rule catalog is hub-distributable
(rides the same policy pull as everything else).

## Capability split (owner law: no auth code on user machines)

Local (spoke) variants of the services do NOT carry the centralized
capabilities — auth issuance, identity administration, key custody all
live hub-side only. A spoke machine ships: routing (laws, candidates,
ladder), adapters, aids/metering, the pull client, and its services bind
loopback with NO auth middleware — local trust is the loopback itself;
toward the hub it PRESENTS the enrollment token as a client credential
and never verifies anyone.

**Staying "in sync" without the capabilities**: both variants share the
same grammar, protocol shapes, and manifest versions (the policy pull
carries capability flags), so a spoke and the hub agree on everything
except the hub-only surfaces — a spoke never expects
`/federation/*`-adjacent admin or auth endpoints, and the hub never
assumes a spoke can authenticate third parties. The single-machine dev
case (this box, hub==spoke) is the one exception and runs the full
profile. Installer consequence: spoke installs exclude the identity/auth
modules entirely (W165); W156's identity plane is hub-profile.

## Wire crypto posture (PQC, verified 2026-10-01)

The .local API planes already negotiate **X25519MLKEM768** (hybrid
classical + ML-KEM-768 key exchange — RFC 10024) via Caddy 2.11.4's
default; verified live with OpenSSL 3.6.4 s_client on suspenders.local
and belt.local. Loopback services (swarm, store, board, belt entry,
buckle ports) run plain HTTP on 127.0.0.1 — no wire, no exposure, PQC
moot there. Law going forward: **every hub↔spoke wire terminates in
PQ-hybrid TLS** (Caddy in front, or a PQ-capable listener); a federation
endpoint served without ML-KEM hybrid is a config bug, not an option.
Post-quantum SIGNATURES (ML-DSA JWTs/certs) are deliberately deferred —
JOSE/COSE ML-DSA is still draft-track; key exchange is the
harvest-now-decrypt-later exposure and it is already covered. Symmetric
crypto (AES-256) is unchanged (Grover-resistent at 256-bit).

## Sequencing

Phase 1 (post-W144 cut-over): hub policy distribution + spoke pull (the
echo model is phase 1: spoke belt mirrors hub entitlements). Phase 2:
work-delta up-feed → global lane view. Phase 3: aggregate self-report
(opt-in) + global usage/aid dashboards (W152 renders them). Nothing here
re-opens W141-W143; federation is a phase, not a rewrite.
