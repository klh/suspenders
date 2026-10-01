# Build-base evaluation: which OSS to build the enterprise router on (W130, 2026-10-01)

Lane: w130-buildbase (RESEARCH — this doc is the only artifact, no code).
Mission: find the best OSS to build the enterprise router on — path of least
resistance to keys/teams/quotas/SSO-ready/audit, license-clean for building
OUR license layer on top. Companions W128 (adopt-vs-build) and W131
(belt-native sketch) had not landed facts when this was written (no w128/
w131 entries in coord facts, verified via the coord CLI 2026-10-01).

Method: each candidate's LICENSE file fetched raw from its repo (T1), repo
metadata (stars / last push / latest release / archived flag) pulled from the
GitHub API on 2026-10-01, feature claims anchored on READMEs and vendor docs,
CVEs from NVD/CISA. Scores are this lane's judgment per axis on 0-10; every
data row is cited in §6.

## 1. TL;DR verdict

- **Best fork base: Portkey Gateway (MIT, TypeScript).** The only
  license-clean candidate in the fleet's language. Its OSS core is a
  stateless data plane (routing, fallbacks, guardrails, load balancing,
  virtual-key credential vaulting) — it ships zero identity/tenancy, which
  sounds like a con and is actually the point: nothing to fight, nothing
  license-tainted; belt owns 100% of keys/teams/quotas/SSO/audit in our own
  repo and DB.
- **Runner-up: APISIX (Apache-2.0, Apache Software Foundation).** The only
  zero-open-core gateway where the entire enterprise surface — token-based
  rate limiting with Redis, consumer/key-auth identity, an openid-connect
  plugin for SSO, ai-proxy/ai-proxy-multi routing — ships free under
  foundation governance, released 3.19.0 the week of this audit. You pay in
  Lua/OpenResty/etcd ops weight and a policy layer that lives outside the
  fleet's language.
- **Disqualified:**
  - **new-api** — best product on the list (users, groups, quotas, OIDC,
    passkeys, 2FA, audit logs, subscriptions, multi-node, ClickHouse; rc.41
    released 2026-09-30), wrong license: AGPL-3.0 plus Section 7 terms
    (keep "Frontend design and development by New API contributors"
    attribution + visible repo link). A proprietary license layer built on
    it must ship source to its network users. Escape hatches: go fully
    open-source (then it jumps to #1) or buy their commercial license.
  - **TensorZero** — Apache-2.0, but the repo was archived read-only on
    2026-06-12; the company wound down with most of a $7.3M seed unspent;
    no named successor. (The mission feared AGPL here; it was actually
    new-api that carried the AGPL.)
  - **one-api** — MIT-clean but dead: last tagged release v0.6.10 Feb 2025,
    two CVEs including an auth bypass (CVE-2026-75486, channel-pinning)
    unpatched by any release; the community already migrated to new-api.
  - **Kong AI Gateway** — open-core trap: the features we would build
    (token rate limiting via ai-rate-limiting-advanced, RBAC, audit logs)
    are exactly Kong's paid tier; only six basic AI plugins are free.
  - **Agent Router** (ex-Envoy AI Gateway) — Apache-2.0 and v1.0 GA June
    2026, but Kubernetes/CRD-first (Gateway API, control plane required),
    and it left the CNCF/Envoy structure for the brand-new Agentic AI
    Foundation in Sept 2026: governance track record measured in weeks.
- **Universal pattern (corroborates W126's LiteLLM audit):** every OSS
  gateway gives away transport and machine-facing quota; human identity
  (SSO/SCIM) and audit are the paywall — new-api is the lone exception and
  it pays for that with AGPL. Consequence: **no fork hands us the license
  layer; the control plane is ours under every option.** See §5.

## 2. Matrix

Scores 0-10 per axis; Mean = unweighted average of (a)-(e). (f) is the
mission-weighted call, which re-weights license-cleanliness and fleet
language fit above feature completeness — see §4.

| Candidate           | (a) License        | (b) Ent. surface free | (c) Stack fit | (d) Belt embed | (e) Maintenance | Mean | (f) Verdict        |
| ------------------- | ------------------ | --------------------- | ------------- | -------------- | --------------- | ---- | ------------------ |
| Portkey Gateway     | 9 (MIT)            | 5                     | 9             | 7              | 6               | 6.7  | **1 — fork base**  |
| APISIX              | 10 (Apache-2, ASF) | 9                     | 2             | 5              | 10              | 7.2  | **2 — runner-up**  |
| Helicone            | 8 (Apache-2)       | 5                     | 8             | 5              | 6               | 6.4  | 3 — wrong center   |
| new-api             | 2 (AGPL-3 + §7)    | 10                    | 4             | 4              | 10              | 6.0  | 4 — license-locked |
| one-api             | 10 (MIT)           | 9                     | 4             | 5              | 1               | 5.8  | 5 — dead           |
| Agent Router        | 9 (Apache-2)       | 4                     | 3             | 4              | 7               | 5.4  | 6 — K8s-first      |
| Kong AI Gateway     | 6 (Apache-2 oc)    | 4                     | 2             | 4              | 9               | 5.0  | 7 — open-core trap |
| TensorZero          | 8 (Apache-2)       | n/a                   | 3             | 3              | 0               | DQ   | archived 2026-06   |
| LiteLLM (ref, W126) | 8 (MIT core)       | 8                     | 3 (Python)    | 5              | 9               | n/a  | config, not fork   |

## 3. Per-candidate notes

### Portkey Gateway (Portkey-AI/gateway)

(a) MIT verbatim, Copyright 2024 Portkey Inc; no non-standard terms; no CLA
found this pass (not exhaustively checked). (b) Free: 140+ provider
integrations with virtual keys (credential vault), fallbacks, load
balancing, caching, guardrails, config-driven routing. NOT free/in-OSS:
organizations, workspaces, per-workspace API keys, budgets — that is the
SaaS Admin API / enterprise tier. It is deliberately stateless: no users, no
teams, no quotas in the repo. (c) TypeScript/Node — composes directly with
the Bun/TS fleet doctrine. (d) Best-in-class embed: belt's route-hint
grammar and W124 policy ladder can live as TS config/modules feeding the
gateway, or belt can sit in front of it; no translation boundary. (e) 13.1k
stars; last push 2026-05-25, last release v1.15.2 2026-01-12 — active-ish
with a slowing cadence; VC-backed with the OSS core as SaaS funnel (drift
risk toward hosted). (f) Least resistance to "our license layer on top":
the layer is 100% ours by construction; the fork buys the provider/
translation/filter breadth we would otherwise hand-write.

### APISIX (apache/apisix)

(a) Apache-2.0 (ASF project, LICENSE verified); Apache CLA applies to
contributors, irrelevant to forking. (b) Everything free, no open-core on
the AI path: ai-proxy (3.11+, Oct 2024), ai-proxy-multi (LB/retries/
fallback), ai-rate-limiting (token-based, local + Redis), key-auth,
consumer/consumer-restriction, openid-connect (SSO), prompt decoration/
request rewriting, response caching. Audit is not turnkey — you stream logs
(http-logger etc.) and assemble. (c) Lua on OpenResty + etcd: permanent
translation cost against the TS doctrine; etcd is a new always-on service.
(d) Extensible via plugins (Lua/WASM) or ext-plugin sidecar over HTTP —
belt's policy ladder can sit beside it as a Bun sidecar, callable but
outside our language. (e) 17.2k stars, 3.19.0 released 2026-09-28, ASF
governance, weekly-scale cadence — the strongest maintenance story on the
list. (f) Least resistance to FEATURES, high resistance to FLEET FIT. If
the enterprise router grows into a multi-tenant product with real traffic,
this is the foundation that will still be there in five years.

### Helicone (Helicone/helicone)

(a) Apache-2.0 stated repo-wide; no ee/ directory found at repo root this
pass (root /ee 404s); hosted Enterprise tier gates SSO/SCIM/audit/custom
rate limits. (b) Free self-host: request logs, cost tracking, caching, rate
limits, fallbacks. (c) TypeScript/Next+Express — best stack fit after
Portkey. But self-host is an o11y platform stack: Web (Next.js), Worker,
Jawn (Express), Supabase, ClickHouse, MinIO; the team shrunk it 12 to 4
containers but it is still a data-platform footprint, and third-party
reviews flag "full self-hosting without enterprise contracts" as shaky.
(d) Its center of gravity is observability, not identity/quota: embedding
belt's policy ladder means building a control plane BESIDE it, at which
point the fork adds o11y value, not router value. (e) 6.2k stars, pushed
2026-09-16, active; repo root also contains Bifrost (Go gateway engine,
Helicone's AI gateway — see §7). (f) Right license and language, wrong
center of gravity for a router fork.

### new-api (QuantumNous/new-api)

(a) AGPL-3.0 plus additional Section 7 terms: modified versions must keep
the "Frontend design and development by New API contributors" attribution
and a visible link back. Developed based on One API (MIT). Commercial
licensing contact offered for AGPL-disallowed orgs. (b) The whole
enterprise list, free: users, groups, fine-grained permissions, API-key
restrictions, quotas, subscriptions, usage/cost logs, OAuth/OIDC, passkeys,
2FA, login-session management, audit logs, multi-node (shared DB + Redis),
optional ClickHouse log DB, expression-based pricing. (c) Go + React.
(d) Fork-and-modify in Go — belt's grammar would be re-expressed in Go or
called over HTTP; no plugin seam. (e) 49.2k stars, 6,473 commits, rc.41
released 2026-09-30 — the most active project evaluated. (f) The only
candidate where the feature gap is zero AND maintenance is best-in-class —
and the license forbids exactly our mission (a proprietary license layer
served over a network). Conditional #1: if the router ever goes fully
open-source, or if a commercial license is bought, this becomes the
default answer.

### one-api (songquanpeng/one-api)

(a) MIT verbatim (Copyright 2023 JustSong) — cleanest paper license.
(b) The original channel/user/token/quota design; all free. (c) Go + React.
(d) Code-level only. (e) Dead: 37.1k stars, but last release v0.6.10
2025-02-02; pushes since are a trickle (last 2026-01-09). CVE-2025-3801
(XSS, all versions through v0.6.10) and CVE-2026-75486 (auth bypass via
channel-pinning suffix, Aug 2026 CISA summary) — the auth bypass has no
patched release. Community consensus moved to new-api. (f) Forking a dead
MIT codebase means inheriting an unpatched security surface in a language
we do not speak. Its real value: the feature inventory new-api proved out.

### Kong AI Gateway (Kong/kong)

(a) Apache-2.0 core (Copyright 2016-2026 Kong Inc.); Kong gate
contributions via CLA; trademark/vendor-controlled roadmap. (b) Open-core
boundary lands exactly on our mission: six AI plugins free (ai-proxy, AI
Request Transformer, etc.); ai-rate-limiting-advanced (token quotas),
ai-proxy-advanced (LB/semantic routing), semantic cache, prompt guard, PII
sanitizer, RBAC, audit logs are Enterprise/Konnect-only. (c) Lua on
OpenResty. (d) Plugin development in Lua; belt policy would live outside
the fleet language. (e) 44.2k stars, 3.9.3 June 2026 — steady vendor
cadence. (f) Building our license layer on free Kong means competing with
the vendor's paid tier on our exact feature list — the definition of
building on sand.

### Agent Router, ex-Envoy AI Gateway (theagentrouter/agent-router)

(a) Apache-2.0; now an Agentic AI Foundation project. (b) Platform-team
controls: BackendSecurityPolicy CRDs for upstream credentials, global rate
limiting at the tier-one gateway, failover, usage attribution; consumer
keys/teams/quotas/SSO remain thin (external auth / RBAC patterns expected).
(c) Go + Envoy, Kubernetes Gateway API + CRDs + control plane — the unit of
deployment is a cluster, not a launchd box. (d) Control via CRDs,
extension in Go. (e) 2.2k stars, v1.0.0 GA 2026-06-23, then left CNCF/
Envoy for the newborn AAIF (Sept 2026): same code, same maintainers — but
foundation governance measured in weeks and vendor (Tetrate) gravity.
(f) The naturalized-routing standard for hyperscale K8s estates; the wrong
size and governance risk for this fleet.

### TensorZero (tensorzero/tensorzero)

(a) Apache-2.0 (mission's AGPL fear: not the case here). (b)-(d) moot.
(e) ARCHIVED read-only 2026-06-12; CEO confirmed wind-down on HN; most of
the $7.3M seed unspent; no successor or prominent community fork found.
Rust gateway, strong ideas (config-driven optimization loop) — cite, do
not build. (f) Disqualified: an archived upstream is an unowned fork from
day one.

### LiteLLM (reference row, from W126 — config lens, not fork lens)

MIT OSS core + license-gated litellm_enterprise package we already pin
(1.103.0). W126 verdict stands and this audit EXTENDS it: quota/rate-limit/
fallback = free config; human SSO = the paywall; knowledge ACLs +
control-plane auth + belt product layer = ours. Python rules it out as a
FORK base for a TS fleet, but as a component it beats every candidate here
on the quota tier — which is why the fork lens and the adopt lens (W128)
must be read together.

## 4. Ranked verdict (mission-weighted)

The unweighted mean ranks APISIX first (7.2), but the mission is "path of
least resistance to keys/teams/quotas/SSO-ready/audit, license-clean for
building OUR license layer on top", and the brief itself weights TS fleet
composition over feature completeness. Mission-weighted ranking:

1. **Portkey Gateway — the fork base.** Only candidate that is both
   license-clean (MIT) and fleet-native (TS). Accept the trade: it ships no
   identity/tenancy, so keys/teams/quotas/SSO/audit are belt+governor.db
   work either way — the fork's job is provider breadth, translation,
   fallbacks and the guardrail pipeline, which is exactly the part that is
   expensive to hand-write.
2. **APISIX — runner-up, and the serious-product answer.** Everything the
   mission lists ships free under ASF governance; the cost is Lua/OpenResty
   - etcd ops and a policy seam outside our language. Choose it over
     Portkey if the router must stand alone as a multi-tenant product.
3. **Helicone** — keep for o11y reference; not a router base.
4. **new-api — conditional.** Feature-complete and hyper-maintained; AGPL+§7
   locks a proprietary layer. Becomes #1 only under a fully-open strategy
   or purchased commercial license.
5. **one-api** (dead), 6. **Agent Router** (K8s-first + new foundation), 7. **Kong** (open-core on our exact features). TensorZero: disqualified
   (archived).

## 5. Fork vs belt-native: decision rule for W131

W131's sketch had not landed when this was written; the comparison rule to
apply once it does:

- Every option — including every fork above — leaves the control plane
  (keys, teams, quotas, SSO, audit) as OURS. The fork-build lens only ever
  buys the data plane: provider adapters, protocol translation, fallback
  execution, guardrail/filter pipeline.
- Therefore: price W131's belt-native sketch against ONLY the data-plane
  delta. If its provider-adapter breadth is cheap (provider count the fleet
  actually uses is small, translation is thin), belt-native wins outright —
  zero upstream surface, zero license surface, one language.
- If breadth is expensive, Portkey is the least-resistance fork: MIT, TS,
  stateless — belt bolt a control plane onto it without negotiating with
  anyone's license.
- new-api remains the standing counterfactual: it is what "free and
  complete" costs — AGPL. Any proposal to build on it must first answer the
  license question, not the feature question.

## 6. Sources

License files (fetched raw, 2026-10-01):

- raw.githubusercontent.com/songquanpeng/one-api/main/LICENSE (MIT)
- raw.githubusercontent.com/QuantumNous/new-api/main/LICENSE (AGPL-3.0)
- raw.githubusercontent.com/Helicone/helicone/main/LICENSE (Apache-2.0)
- raw.githubusercontent.com/Kong/kong/master/LICENSE (Apache-2.0)
- raw.githubusercontent.com/envoyproxy/ai-gateway/main/LICENSE (Apache-2.0)
- raw.githubusercontent.com/Portkey-AI/gateway/master/LICENSE (MIT)
- raw.githubusercontent.com/tensorzero/tensorzero/main/LICENSE (Apache-2.0)
- raw.githubusercontent.com/apache/apisix/master/LICENSE (Apache-2.0)

Repo metadata: GitHub API (api.github.com/repos/...) queried 2026-10-01 —
stars, last push, latest release, archived flags as quoted in §3.

Feature and governance claims:

- github.com/QuantumNous/new-api README (features; AGPLv3 + Section 7
  attribution terms; commercial-licensing contact)
- nvd.nist.gov/vuln/detail/CVE-2025-3801 (one-api XSS)
- CISA vulnerability summary, week of 2026-08-24 (CVE-2026-75486, one-api
  channel-pinning auth bypass)
- apisix.apache.org/docs/apisix/plugins/ai-proxy/ and
  .../plugins/ai-rate-limiting/; release blog for 3.11.0 (2024-10-17,
  ai-proxy introduced); apisix.apache.org/ai-gateway/
- konghq.com/blog "Announcing Kong's New Open Source AI Gateway" (six free
  plugins); developer.konghq.com/plugins/ai-rate-limiting-advanced/
  (license required); github.com/Kong/kong discussion #9167 (free mode vs
  enterprise plugins)
- theagentrouter.ai/release-notes/v1.0/ (v1.0.0 GA 2026-06-23);
  aaif.io/blog/agent-router-joins-aaif (2026-09-09)
- news.ycombinator.com/item?id=48516504 (TensorZero wind-down, CEO
  statement); github.com/tensorzero/tensorzero (archived banner)
- github.com/helicone/helicone README (self-host service list);
  helicone.ai/blog/self-hosting-journey (12 to 4 containers);
  helicone.ai/pricing (SSO/SCIM/audit/custom-rate-limits = Enterprise)
- docs.portkey.ai Admin API / workspace docs (org+workspace tenancy on the
  SaaS side); github.com/Portkey-AI/gateway (MIT core, virtual keys)
- Cross-lane: docs/research/litellm-enterprise-audit-2026-10-01.md (W126)

## 7. Could-not-verify

- new-api payment specifics (Stripe-native or epay-style plugins only):
  README references reseller legal obligations; no payment-provider
  evidence collected this pass.
- Helicone EE gating inside the repo: no ee/ directory found at root; the
  Apache-2.0 claim is README-level; per-file license headers not audited.
- Bifrost (maximhq/bifrost, Go, MIT per repo badge — unverified this pass):
  Helicone's gateway engine, living inside the Helicone repo. Wildcard for
  a data-plane fork lens; deserves its own pass if W131 leans fork-ward.
- Portkey CLA: none found in a quick pass, not exhaustively checked.
- Supply-chain posture (dependency audits) of one-api/new-api beyond CVE
  listings: not done.
- W128/W131 facts: not landed at write time (verified via coord fact list,
  2026-10-01); §5 is the rule to apply, not a comparison already made.
