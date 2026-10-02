# Enterprise pricing research — what an agent control plane should cost (2026-10-02)

Owner-directed market study: what a large European retailer (~150k employees,
~200 dev seats) should expect to **pay** for a capability set shaped like the
klh agent stack (work-graph orchestration, LLM gateway + governance, fleet
knowledge store, hub/spoke federation with PQC, local-LLM swarm). Two
research passes: (A) commercial list prices of comparable platforms,
(B) build-vs-buy cost model + value framing. Method: public first-tier
sources only, every load-bearing number cited, ranges over point estimates.
Prices checked 2026-10-02, USD. Second-tier corroboration is explicitly
flagged "reported" — treat those as leads, not facts.

**The stack being priced:** (1) multi-agent work graph + lane dispatch +
lifecycle (claim/cancel/reassign/second-opinion); (2) LLM gateway: 100+
provider adapters, routing laws, per-key/team rate limits, budgets, usage
attribution; (3) policy/governance: hook gates, audit trail, executor
allow-lists, PQC (ML-KEM) wire crypto; (4) fleet knowledge store (lessons,
session-end capture, curation queue); (5) federation: hub + spokes,
entitlements echo, CR push-down, hub-only signing keys; (6) local self-hosted
LLM swarm, BYO-LLM per repo via dotfiles.

## A. Commercial comparables (list prices)

### LLM gateways / routers

| Vendor                | Model                              | List price                                                                                                                                                                                             | Self-host                                                                 | Gated behind enterprise                                                                 |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| LiteLLM               | Annual request capacity            | Contact sales; reported $250/mo basic, ~$30k/yr premium (reported — [TrueFoundry analysis](https://www.truefoundry.com/blog/litellm-pricing-guide))                                                    | Yes, OSS core free ([litellm.ai/pricing](https://www.litellm.ai/pricing)) | SSO/SCIM, OIDC, audit logs, RBAC, secret managers, air-gap                              |
| Portkey               | Monthly + per-100k-request overage | Production $49/mo, +$9 per extra 100k req (to 3M); Enterprise custom ([portkey.ai/pricing](https://portkey.ai/pricing))                                                                                | OSS tier free                                                             | SSO, granular budgets, private cloud, data-lake export, SOC2/GDPR/HIPAA, PII anonymizer |
| TrueFoundry           | Per-user + request overage         | Pro $25/user/mo; $20 per extra 100k req; Enterprise custom ([truefoundry.com/pricing](https://www.truefoundry.com/pricing))                                                                            | VPC/on-prem/air-gap = Enterprise only                                     | SSO/SCIM, audit logs, custom guardrails, agent gateway                                  |
| Kong AI Gateway       | Per control plane + usage          | Plus from $25/mo + usage ($200/mo per extra 1M req, $100/mo per extra LLM); Enterprise custom, reported $30–50k+/yr entry (estimates: [vendr](https://www.vendr.com/marketplace/kong))                 | Hybrid/self-hosted = Gateway Enterprise (custom)                          | AI Gateway Manager + paid plugins Enterprise-only                                       |
| Cloudflare AI Gateway | Free + Workers plan                | $0 core; Logpush +$0.05/1M req on Workers Paid; guardrails billed as Workers AI tokens; 5% fee on prepaid credits ([Cloudflare docs](https://developers.cloudflare.com/ai-gateway/reference/pricing/)) | No (SaaS)                                                                 | Enterprise custom via account team                                                      |

### Agent orchestration platforms

| Vendor                         | Model                | List price                                                                                                                                                    | Self-host                                   | Gated behind enterprise                                    |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| LangSmith / LangGraph Platform | Per seat + LSU usage | Plus $39/seat/mo (10k base traces); compute 0.0675 LSU/vCPU-hr (1 LSU = $1); Enterprise custom ([langchain.com/pricing](https://www.langchain.com/pricing))   | Cloud; hybrid/self-hosted = Enterprise only | SSO/ABAC/RBAC, SLA, self-host, committed credits           |
| CrewAI Enterprise              | Custom ACV           | Contact sales (free tier 50 executions/mo) ([crewai.com/pricing](https://www.crewai.com/pricing))                                                             | Own VPC on Enterprise                       | SSO, RBAC, workload identity, PII redaction, dedicated VPC |
| MS Copilot Studio              | Credit packs / PAYG  | $200/pack/mo per 25,000 credits (~$0.008/credit); PAYG $0.01/credit ([Azure pricing](https://azure.microsoft.com/en-us/pricing/details/copilot-studio))       | No                                          | n/a — capacity is the only lever                           |
| Sierra                         | Outcome-based        | Contact sales; reported $1–1.5/resolution, setup $50–200k, contracts from ~$150k/yr (reported, unverified — [fin.ai](https://fin.ai/learn/sierra-ai-pricing)) | No                                          | Everything                                                 |
| Decagon                        | Per-resolution       | Contact sales; reported ~$50k platform fee + usage, median ACV ~$433k (reported — [fin.ai](https://fin.ai/learn/decagon-ai-pricing))                          | No                                          | Everything                                                 |

### Agent-coding fleet tools

| Vendor                       | Model                       | List price                                                                                                                                                                                                                    | Self-host          | Gated behind enterprise                                 |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| Cursor                       | Per seat + usage in arrears | Teams $40/user/mo; Enterprise custom ([cursor.com/pricing](https://cursor.com/pricing))                                                                                                                                       | No                 | Pooled usage, SCIM, audit logs, repo/model/MCP controls |
| Devin / Windsurf (Cognition) | Per team + per seat, quota  | Teams $80/mo + $40/full seat/mo; Pro $20, Max $200; Enterprise custom, reported ~$60/user/mo at scale ([devin.ai/pricing](https://devin.ai/pricing); reported — [CloudZero](https://www.cloudzero.com/blog/windsurf-pricing)) | VPC = Enterprise   | SAML/OIDC, VPC, multi-org, teamspace isolation          |
| Coder                        | Annual per user             | Contact sales (Community free, 5 agents) ([coder.com/pricing](https://coder.com/pricing))                                                                                                                                     | Always self-hosted | Premium/AI Premium tiers                                |

### Observability / evals

| Vendor     | Model                     | List price                                                                                                                                             | Self-host                         | Gated behind enterprise                                                            |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------- |
| Langfuse   | Per 100k billable units   | Core $29/mo; Pro $199/mo; Pro+Teams $499/mo; Enterprise $2,499/mo; overage $8→$6/100k graduated ([langfuse.com/pricing](https://langfuse.com/pricing)) | Yes — OSS core free               | Audit logs + SCIM (Ent); SSO/RBAC (Teams +$300/mo); PrivateLink (Ent + commitment) |
| Braintrust | Flat fee + usage          | Starter $0; Pro $249/mo ($100 credits, then $3/GB); Enterprise custom ([braintrust.dev/pricing](https://www.braintrust.dev/pricing))                   | Enterprise only                   | SAML SSO, SLA, on-prem, retention                                                  |
| Arize      | Flat fee, unlimited users | Free 25k spans/mo; Pro $50/mo; Enterprise custom ([arize.com/pricing](https://arize.com/pricing/))                                                     | Self-host = Ent; Phoenix OSS free | SSO, audit logs, SOC2/HIPAA, data regions                                          |

Humanloop excluded: defunct (team acqui-hired by Anthropic 2025-08-13, platform
sunset 2025-09-08 — [TechCrunch](https://techcrunch.com/2025/08/13/anthropic-nabs-humanloop-team-as-competition-for-enterprise-ai-talent-heats-up)).
Windsurf pricing now 308-redirects to devin.ai/pricing (Cognition).

### Governance / AI-security SKUs

| Vendor                          | Model                                         | List price                                                                                                                                                         | Notes                                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt Security (→ SentinelOne) | Contact sales; AWS Marketplace private offers | No public list; Marketplace entry ~$10k/12-mo (reported — [Futurepedia](https://www.futurepedia.io/tool/prompt-security))                                          | Acq. announced 2025-08-05, closed 2025-09-05 ([SentinelOne IR](https://investors.sentinelone.com/press-releases/news-details/2025/SentinelOne-to-Acquire-Prompt-Security-to-Advance-GenAI-Security-and-Agent-Security-Strategy/default.aspx)) |
| IBM watsonx.governance          | Per vCPU-month, floor                         | Basic from $3,500/mo; Advanced from $6,450/mo; SaaS $0.60/unit; AWS entry ~$38,160/yr ([ibm.com pricing](https://www.ibm.com/products/watsonx-governance/pricing)) | Reported IBM deal range $150–400k/yr (second-tier)                                                                                                                                                                                            |

## B. Build-vs-buy cost model

Loaded rate: Copenhagen senior SWE ≈ DKK 600–780K/yr ([levels.fyi](https://www.levels.fyi/t/software-engineer/levels/senior/locations/copenhagen-dnk)),
2.0x overhead → **$15–18K per engineer-month (em)**, $16.5K midpoint.

| Subsystem                                                         | em (low–high) |
| ----------------------------------------------------------------- | ------------- |
| Orchestrator: work graph, lane dispatch, concurrency governor     | 8–14          |
| LLM gateway: 100+ adapters, routing, budgets, attribution         | 18–30         |
| Governance: policy hooks, audit, allow-lists, PQC, federation     | 14–24         |
| Fleet knowledge store                                             | 6–10          |
| Local/self-hosted LLM swarm (vLLM-class serving, GPU scheduling)  | 8–12          |
| Console UI                                                        | 5–8           |
| Platform hardening (SSO, secrets, on-prem packaging, tests, docs) | 10–16         |
| SDK/integration surface                                           | 4–8           |
| **Total**                                                         | **73–122 em** |

Calibration proxies: LiteLLM's gateway = multi-year, thousands-of-contributors
effort ([github.com/BerriAI/litellm](https://github.com/BerriAI/litellm));
Spotify's Backstage ≈ 3 years internal before open-sourcing
([Spotify Engineering](https://engineering.atspotify.com/2025/4/celebrating-five-years-of-backstage)).

- **Direct build: $1.2–2.0M; +20% contingency → $1.4–2.4M** (12–18 months, 6–8 engineers). GPU capex excluded (needed either way).
- **Run cost: 1.5–3 FTE = $0.3–0.6M/yr.**

Buy-side ACV proxies (SEC filings): GitLab FY26 ~$94K avg customer
([10-K](https://www.sec.gov/Archives/edgar/data/1653482/000162828026018731/gtlb-20260131.htm));
HashiCorp FY24 ~$132K ([Nasdaq PR](https://www.nasdaq.com/press-release/hashicorp-announces-fourth-quarter-and-fiscal-year-2024-financial-results-2024-03-05));
JFrog FY25 ~$74K ([JFrog IR](https://investors.jfrog.com/news/news-details/2026/JFrog-Announces-Fourth-Quarter-and-Fiscal-2025-Results/default.aspx)).
Agent-platform deals run hotter: reported $50K–$500K+; Blitzy $500K–$10M
(reported — [startupfundraising.com](https://startupfundraising.com/ai-coding-agents-enterprise-fundraising)).

Value framing (public data):

- Token routing saves 40–70% industry-wide; LiteLLM auto-router **51%** in production; TALE **67%** at <3% quality loss ([routing roundup](https://medium.com/@adnanmasood/right-sizing-the-frontier-a-guide-to-llm-routing-workload-to-model-matching-and-token-per-dollar-1032d3dbcb01)). Local inference at high utilization: **3–5x cheaper** than cloud APIs ([sitepoint TCO](https://www.sitepoint.com/local-llms-vs-cloud-api-cost-analysis-2026)).
- Productivity: Copilot RCT **55.8% faster** on isolated tasks ([arXiv:2302.06590](https://arxiv.org/abs/2302.06590)); METR RCT found **19% slower** for experts on familiar codebases ([metr.org](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study)). Defensible planning range for fleet-orchestrated work: **5–15% net throughput** (orchestration mitigates METR's failure mode).
- Governance: EU AI Act Art. 12 log obligations (≥6-month retention) + Art. 99 penalties (**€35M/7%** turnover prohibited-practices, **€15M/3%** other) ([artificialintelligenceact.eu](https://artificialintelligenceact.eu/article/12), [AI Act Service Desk](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-99)). Audit-ready attribution + policy hooks are direct evidence infrastructure.

Value model (200 devs, ~$200K loaded each): productivity **$2–6M/yr** +
token routing **$0.4–1.8M/yr** (on a $1–3M/yr model bill) + governance/audit
**$0.2–0.5M/yr** ≈ **$2.6–8.3M/yr identified value** — the question is
capture ratio, not value existence.

## C. Synthesis — should-pay envelope (3-year, 200 seats)

- **OSS-first path** (LiteLLM OSS $0 + Langfuse self-host $0 + LangSmith Plus 200×$39 + Cursor Teams 200×$40 + basic AI security): **$200–250K/yr** (~$1.0–1.3K/seat/yr), before tokens.
- **Enterprise path** (gateway $30–100K + orchestration $100–300K + coding fleet $100–250K + observability $30–150K + governance $42–150K): **$300–950K/yr** (~$1.5–4.8K/seat/yr), before tokens.
- **Floor (build amortized): $0.5–0.8M/yr** — plus ops FTEs either way.
- **Fair landing: $250–450K/yr ($0.75–1.35M over 3 years)** ≈ **$105–190/seat/month platform fee, tokens excluded.**

**No single vendor sells the whole stack.** The work-graph lifecycle,
federation with hub-only signing keys, PQC wire crypto, and the fleet
knowledge store have **no commercial SKU at any price** — closest partial
analogs are LangSmith Enterprise workspaces and Kong multi-zone gateways.
Dominant cost drivers: (1) coding-agent seats/usage (least capped line),
(2) enterprise-tier gating (SSO/SCIM/audit/self-host multiply list 2–5x),
(3) metered overage compounding linearly with agent traffic.

Caveats: all figures are ranges from public pages checked 2026-10-02; Sierra/
Decagon/LiteLLM-enterprise numbers are reported third-party estimates;
build-cost em figures are analogical (open-source proxies), not bottom-up;
METR re-examination pending; excludes model/token spend and GPU hardware.
