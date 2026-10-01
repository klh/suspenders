# Gateway license audit: free-identity alternatives vs build-on-LiteLLM-MIT (W128, 2026-10-01)

Owner question, verbatim: "can we copy what LiteLLM is doing and tack the stuff
you need on top of it?" — take the MIT core and build the enterprise feature
list ourselves: SSO+SCIM, OIDC/JWT auth, audit logs, secret managers + key
rotation, org & team admins, multi-region control plane, self-host/air-gap.
This doc adds the second axis the W126 audit left open: gateways whose
identity/tenancy tier ships 100%-free-license, and the build-vs-buy verdict.

Method / tiering: T1 = read directly from OUR pinned install (litellm 1.103.0
wheel metadata + source tree, strongest applicability evidence) or fetched
from the candidate repos (GitHub license metadata / raw LICENSE files /
plugin trees). T2 = docs pages and project READMEs. GitHub "archived" and
"pushed" dates are repo facts at fetch time (2026-10-01).

## 1. Legal ground

**LiteLLM core = MIT. T1: the pinned 1.103.0 wheel carries
`License-Expression: MIT`** (PEP 639 metadata) with the LICENSE file noting
an `enterprise/` directory carve-out. GitHub shows the repo as NOASSERTION
for exactly this reason — the wheel metadata is the cleaner evidence. MIT
grants use, modification, distribution, sublicensing, private use — for any
purpose, including commercially and including building a product that
competes with the vendor's own paid tier.

**`litellm_enterprise` = proprietary. T1: the pinned 0.1.69 wheel carries
`License-Expression: LicenseRef-Proprietary`**, and the bundled LICENSE.md is
the BerriAI Enterprise License: production use requires a subscription;
you may develop/test without one; patches are permitted but BerriAI retains
title. **Practical rule: features are fair game, code is not.** Building our
own implementation of equivalent features (audit logs, SCIM, JWT auth,
rotation) on top of the MIT core is licensed use of MIT code plus original
work — copyright protects expression, not functionality. The closed package
(143 Python modules in the pinned wheel: audit endpoints, JWT/enterprise auth
modules, SCIM, secret-detection plugins, gated callbacks) must never be
copied, decompiled, or transliterated. Two further boundaries: MIT grants no
patent license (theoretical exposure; no specific BerriAI patents identified),
and LiteLLM trademarks/logo must not be used to market ours.

Corollary: patches we write against the MIT tree are ours to keep proprietary
or contribute upstream — MIT permits both.

## 2. Candidate matrix (gateway alternatives)

License = repo LICENSE detection (T1). "Identity tier free?" = does
SSO/OIDC/org/tenancy functionality ship under the same free license.

| Candidate                          | License      | Identity tier free?                                                                                   | Maturity                                                                           | W124-ladder parity (fallback ladder, 429 backoff, per-group budgets, local backends)            |
| ---------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| LiteLLM MIT core (pinned)          | MIT          | No (SSO>5 users/SCIM/JWT/orgs/audit paid) — **but see §3: half the tier is in the MIT tree already**  | 60k stars, very active                                                             | Native, pinned-source verified (W126)                                                           |
| one-api                            | MIT          | Yes — users/tokens/quota UI all free                                                                  | 37k stars, **DORMANT: last commit 2025-02-21**                                     | Partial: channel retry, token quotas; no spend-in-dollars budgets                               |
| new-api                            | **AGPL-3.0** | Yes — but viral on a network product                                                                  | 49k stars, very active                                                             | Partial: fork of one-api with more models; no $ budgets/audit                                   |
| Helicone                           | Apache-2.0   | Mostly — orgs/virtual keys in the OSS web app; hosted-parity unverified                               | 6.2k stars, active; observability-first                                            | Partial: budget/rate-limit hooks via the gateway app in-repo; ladder/fallback parity unverified |
| Portkey-AI/gateway                 | MIT          | **In flux**: 2.0 pre-release branch says "core enterprise gateway is merging into open-source"        | 13k stars; main pushed 2026-05                                                     | Routing core only on main today; no keys/teams UI in the OSS repo                               |
| BricksLLM                          | MIT          | Yes (keys/budgets free); dashboard = paid managed                                                     | 1.2k stars, **DORMANT since 2025-01-05**                                           | Partial: key budgets, rate limits; no fallback ladder                                           |
| Kong Gateway OSS                   | Apache-2.0   | **No — openid-connect plugin is `tier: enterprise`** (docs badge; absent from OSS plugin tree)        | 44k stars, very active                                                             | Partial: ai-proxy family free; advanced AI plugins (rate-limit, failover) enterprise            |
| APISIX                             | Apache-2.0   | **Yes — openid-connect, key-auth, consumers, ai-proxy-multi (fallback), ai-rate-limiting all in OSS** | 17k stars, active, Apache Software Foundation                                      | Good: ai-proxy-multi fallback machinery in-tree; token rate limits; no $-spend budgets          |
| Agent Router (ex-Envoy AI Gateway) | Apache-2.0   | Partial: K8s/Envoy-native auth; OIDC via Envoy filters                                                | 2.2k stars, active, "An Agentic AI Foundation project. Formerly Envoy AI Gateway." | Unverified: fallback/OIDC specifics                                                             |
| Higress (+ console)                | Apache-2.0   | Partial: free console, consumer auth plugins                                                          | 9.5k stars, very active                                                            | Unverified: AI fallback specifics                                                               |
| TensorZero                         | Apache-2.0   | Moot — **repo ARCHIVED 2026-06-12, no successor**; company pivoted to paid Autopilot                  | 11.7k stars, dead                                                                  | Moot                                                                                            |
| LlamaEdge                          | Apache-2.0   | No identity tier in evidence (local runtime, not a multi-tenant gateway)                              | 1.7k stars, quiet since 2026-02                                                    | Mismatch: wrong layer for us                                                                    |

Read-out:

- **Answer to the owner's axis (a):** the only mature projects shipping
  SSO-grade identity 100%-free are **APISIX** (ASF, OIDC + AI fallback +
  token rate limiting in-tree) and **Kong**-class gateways where identity is
  free but Kong's OIDC is paid. Of the AI-native gateways, one-api/new-api
  ship full user/token/quota consoles free but are MIT-dormant or AGPL, and
  none of the AI-native set has org/RBAC/audit free anywhere.
- The AI-native "free identity" projects are dead or dormant (one-api 19
  months quiet, BricksLLM 21 months, TensorZero archived). The live forks
  (new-api) buy activity at the price of AGPL.
- Portkey is the one to watch: if 2.0 really merges the enterprise control
  plane into the MIT repo, the free-identity landscape shifts; pre-release,
  unverifiable today.

## 3. Build-on-LiteLLM-MIT effort matrix (the owner's key question)

Pinned-source facts that shrink the build: the MIT wheel itself contains
`litellm/secret_managers/` (HashiCorp, AWS v1+v2, Google, CyberArk, custom
loader — **no license gate in the handler**), `proxy/auth/oauth2_check.py`
(generic OAuth2 token introspection for the data plane),
`proxy/auth/oauth2_proxy_hook.py` (trusted oauth2-proxy/Authelia
identity-assertion headers, default-secure allowlist), `handle_jwt.py`, and a
custom-auth seam (`user_custom_auth` in the proxy server; the enterprise hook
imports degrade to None when the enterprise wheel is absent). In other
words: **the MIT core already ships the seams a free identity layer needs;
the enterprise wheel is the polished turnkey version.**

| Enterprise feature         | Build-on-MIT effort   | Path                                                                                                                                  |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OIDC/JWT auth (data plane) | **S**                 | Already half-shipped: oauth2_check introspection + handle_jwt + custom_auth seam in MIT; W92 store-server token auth is our precedent |
| SSO for admin UI           | **S–M**               | oauth2-proxy (MIT, 15k stars, active) or Keycloak (Apache-2.0) in front of the UI; MIT's trusted-header hook asserts identity         |
| SCIM provisioning          | **M**                 | SCIM 2.0 server endpoints writing LiteLLM user/team tables; toolkit: python-scim2 (Apache-2.0, active)                                |
| Audit logs                 | **S–M for us**        | LiteLLM custom callbacks → our DB; governor.db already has the row-image deltas table + `coord diff` audit trail precedent (govdb.ts) |
| Secret managers            | **~0**                | Already MIT (pinned-source: the secret_managers tree, ungated) — W126's "ENTERPRISE" row was docs-marketing; the code is in the core  |
| Key rotation + grace       | **S**                 | Regenerate via /key/generate + expiry on the old key; scheduler in our plane                                                          |
| Org & team admins (RBAC)   | **M**                 | Teams are free; orgs = one table + UI + role checks; we already run a role-scoped plane (knowledge hub domain scoping)                |
| Multi-region control plane | **M (ops, not code)** | Deployment topology + config projection; no license unblocks this for free — honest note: this is work either way                     |
| Self-host / air-gap        | **0**                 | MIT already; license verification has an airgapped path in the core for the paid features we would not use                            |

What we uniquely already bring — the layer nobody else sells: suspenders
control plane (work graph, coord bus, board), knowledge hub with domain
scoping (ACLs LiteLLM has no concept of), belt's resolution/scoring/audit
layer, W92 store-server token auth. The enterprise layer on this axis is
OURS, not a resale of someone's gateway.

Build cost summary: ~S+S–M+M+S+0+S+M+M ≈ one focused quarter for one agent
lane, sequenced by demand. Nothing in the list requires touching the
proprietary wheel.

## 4. Verdict + recommendation

Three axes, cost/risk per:

1. **Build-on-LiteLLM-MIT + our identity layer (RECOMMENDED).** Cost: the
   matrix above; risk: maintenance of our auth surface (real but precedented
   — W92, governor deltas). Highest leverage because (a) the quota/reliability
   tier we depend on (W124/W126) is already free MIT config, (b) over half
   the enterprise feature list is already in the MIT tree or trivially
   adjacent to seams we own, (c) the knowledge/ACL/control-plane layer that
   is actually defensible product is ours either way.
2. **Adopt a free-identity alternative.** APISIX is the only serious one
   (mature, ASF, OIDC + AI fallback free). Cost: migration away from
   LiteLLM's provider breadth, $-spend budgets, guardrail mechanism, and the
   W124 config surface we already validated; risk: we trade a gateway we
   know for an infra-tier gateway we'd productize identity on top of anyway.
   Payoff over axis 1 is negative — it replaces MIT-core code with
   Apache-2.0 code of a different shape to avoid building features we mostly
   get free from seams. one-api/new-api/Helicone/Kong all fail on dormancy,
   AGPL, hosted-parity, or paid identity.
3. **Buy LiteLLM Enterprise.** Usage-sized annual, no public figures (W126).
   Only rational under a real compliance deadline at org scale where turnkey
   SSO/SCIM/audit/multi-region beats a quarter of build. Keep as the
   fallback, not the plan.

Recommendation: **build on the MIT core; defer SCIM + org-admins until a
customer demands them; buy only under a compliance deadline.** Sequence: (1)
oauth2 introspection / oauth2-proxy fronting (days), (2) audit-log callback
into our DB + retention (days), (3) key rotation wrapper (days), (4) SCIM +
org admins (weeks, demand-gated). The `litellm_enterprise` wheel stays
uninstalled-on-new-surfaces and never read for implementation reference
beyond what W126 already documented.

## 5. Could-not-verify

- Portkey Gateway 2.0: which enterprise features actually merge into the MIT
  repo (pre-release branch claim in README only; main branch pushed
  2026-05-25).
- Helicone self-host parity with hosted (no ee/ directory found at repo top
  level or under web/, but hosted dashboard features may live outside the
  repo); composition of the `bifrost` directory inside their repo.
- Agent Router (ex-Envoy AI Gateway) fallback + OIDC specifics, and its
  governance status ("Agentic AI Foundation", not CNCF) — README-level only.
- Higress AI-fallback plugin specifics (repo-level license verified only).
- one-api: whether the 19-month commit silence is abandonment or a hiatus.
- Enterprise-tier pricing figures (unchanged from W126: sales-quoted only).
- MIT grants no patent license; no specific BerriAI patent claims were
  searched or found — theoretical exposure only.
