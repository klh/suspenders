# belt × Microsoft 365 Copilot / Azure — enterprise integration research (2026-09-30)

Question: can belt (LLM router/policy gateway over LiteLLM; token auth, audit,
knowledge store) be positioned as "a layer in front of Microsoft 365 Copilot"
for an enterprise like IKEA running per-seat Copilot licenses on Azure —
ideally as a man-in-the-middle on the Copilot setup, reusing the customer's
entitlements instead of belt implementing shared access itself?

Method: primary sources first (learn.microsoft.com pages fetched in full via
WebFetch: architecture, licensing, cost-considerations, Copilot APIs overview,
Retrieval API, copilotRoot, aiInteractionHistory, custom engine agents, Foundry
deployment types, model router, APIM llm-token-limit, Foundry MCP tooling,
Azure OpenAI Entra auth). Tier marks: **T1** = primary page fetched in full;
**T1s** = primary URL identified but content seen via search snippet only;
**T2** = second-hand corroboration; **UNVERIFIED** = could not be traced.

## Verdict (short)

M365 Copilot's model calls are not customer-routable: they happen inside the
Microsoft 365 service boundary on models Microsoft operates, and no admin
setting, API, or extension point exposes, repeats, or re-routes them. The
sanctioned "layer in front" for belt is in front of the customer's **Azure**
entitlements (Foundry/OpenAI deployments paid on their subscription,
authenticated via an Entra service principal), plus belt-as-MCP-server and
belt-as-custom-engine-agent inside the Microsoft agent surface. No Copilot
seats are required for a belt deployment; seats are only consumed if belt's
surface is M365 Copilot/Teams and grounding touches shared tenant data.

## 1. How M365 Copilot model access actually routes

- **Service boundary.** "When you create a Microsoft 365 subscription, you
  automatically create a tenant... Your tenant sits inside the Microsoft 365
  service boundary, where Microsoft Copilot can access your organization's
  data." Prompt flow: user prompt → Copilot preprocessing with grounding
  (Microsoft Graph, user's tenant, scoped to the signed-in user's permissions)
  → "Copilot sends the grounded prompt to the LLM" → response back to the app.
  The LLM call itself is made by the Copilot service; the customer never
  touches it (T1: learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-architecture).
- **Per-seat gating.** Copilot is an add-on license to a long list of M365 /
  Office 365 / Teams / Exchange / SharePoint / OneDrive plans; "Microsoft 365
  Copilot Chat is included in your Microsoft 365 subscription at no additional
  charge" for web-based chat; work-based chat requires the add-on license or
  pay-as-you-go (T1: .../microsoft-365-copilot-licensing; T1:
  .../copilot/extensibility/cost-considerations).
- **No BYO-model knob.** There is no documented admin setting, endpoint, or
  config that lets a customer point Copilot at its own Azure OpenAI deployment
  or intercept the internal model call. Copilot's admin surface
  (`copilotRoot` — "a container for Microsoft 365 Copilot admin controls")
  exposes governance: `admin` settings, `interactionHistory`, `users` (T1:
  .../extensibility/api/resources/copilotroot). Secondary write-ups describe
  the product the same way: model/orchestration swap happens only via the
  extensibility surfaces (Copilot Studio, agents, Foundry), never by
  substituting the built-in experience's models (T2: community/blog corroboration).
  Absence-of-evidence caveat: this is a documented-absence claim — Microsoft
  documents the flow as internal and offers no counter-mechanism.
- **Graph "Copilot APIs" — the sanctioned read/write side.** All live under
  `graph.microsoft.com/v1.0/copilot` and `graph.microsoft.com/beta/copilot`
  (T1: .../extensibility/copilot-apis-overview):
  - **Retrieval API — GA (v1.0).** "Retrieve relevant text chunks from the
    hybrid index that powers Microsoft 365 Copilot" (SharePoint, OneDrive,
    Copilot connectors), in place, keeping permissions/sensitivity labels —
    "the Retrieval API is available at no extra cost to users with a Microsoft
    365 Copilot add-on license"; for unlicensed users it is available via
    **pay-as-you-go (preview)** for tenant-level sources (SharePoint,
    connectors) but **not** OneDrive. Permissions: `Files.Read.All`,
    `Sites.Read.All`, `ExternalItem.Read.All`; throttling 200 req/user/hour;
    KQL `filterExpression`; `maximumNumberOfResults` ≤ 25 (T1:
    .../extensibility/api/ai-services/retrieval/overview).
  - **Chat API — preview** (textual Copilot answers in custom apps; no
    actions), **Search API — preview**, **AI Interactions change
    notifications — preview** (T1: copilot-apis-overview).
  - **Interaction export — beta.** `aiInteractionHistory`
    (`/copilot/users/{id}/interactionHistory`) exports Copilot prompts and
    responses for compliance; "might require a Microsoft 365 Copilot add-on
    license, depending on your tenant configuration"; needs app permissions +
    admin consent (T1: .../api/ai-services/interaction-export/resources/aiinteractionhistory).
  - **Licensing rule for the namespace:** "the Microsoft Graph APIs are
    available under standard Microsoft 365 license terms; the Copilot APIs
    require a Microsoft 365 Copilot license" per accessing user; "Support for
    users without a Microsoft 365 Copilot license is currently not available"
    (T1: copilot-apis-overview; T1: cost-considerations).
- **Extension points (additive, not substitutive).** The orchestrator routes
  between built-in capabilities, plugins/connectors, and agents (T1s:
  .../extensibility/orchestrator). Three sanctioned ways to inject custom
  capability or models:
  1. **Copilot Studio** — low-code agents; **MCP support**: agents can add MCP
     servers as actions; remote MCP servers must support OAuth (Entra ID or any
     OAuth IdP), Streamable HTTP transport (spec 2025-03-26 with 2025-06-18
     improvements), HTTPS, and `tools/list` + `tools/call` (tool descriptions
     required; text-content results) (T1s: learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-overview,
     /mcp-add-existing-server, /mcp-create-server).
  2. **Custom engine agents** — "provide full control over orchestration, AI
     models, and data integrations"; built with Copilot Studio, Microsoft 365
     Agents SDK, Teams SDK, or Microsoft Foundry; "any model of your choice";
     hosted **outside** M365 Copilot; published into M365 Copilot/Teams
     channels (manifest ≥ 1.21); pro-code agents ground in M365 data "via
     Microsoft Graph APIs and... the Retrieval API" (T1:
     .../extensibility/overview-custom-engine-agent).
  3. **Foundry Agent Service MCP tool** — Foundry agents connect to remote MCP
     servers; connection auth types include `oauth2` (Foundry-managed app or
     bring-your-own app registration), `user-entra-token` (user identity
     passthrough), `project-managed-identity`, `agentic-identity`; key/bearer
     credentials stored in project connections; private MCP via Azure
     Container Apps internal ingress (T1:
     learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol).

## 2. Azure AI Foundry / Azure OpenAI — the real door

- **Deployment model (T1: learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types).**
  - Consumption ("standard"): **Global Standard** (pay-per-token, highest
    quota, "for most workloads, start with Global Standard"), **Data Zone
    Standard** (processing pinned to US/EU/APAC zone), **Standard** (pinned to
    an Azure geography), **Batch** (async, 50% discount), Developer (eval only).
  - Reserved: **Global/Data Zone/Regional Provisioned** — "you purchase a
    fixed number of provisioned throughput units (PTUs) that guarantee a
    specific level of processing capacity"; "lower and more consistent
    latency"; use for "consistent high volume."
  - Data residency: global types may process in any region; data zone within
    the zone; standard/regional-provisioned within the customer's geography.
    Azure Policy can restrict deployment types/models org-wide.
- **Model router (T1: learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router).**
  A trained routing model deployed like any Foundry model; per-request model
  selection behind one deployment; routing modes Quality / Balanced (default) /
  Cost; **model subsets** for compliance control ("be sure to select model
  subsets with at least two models" for failover); routes across OpenAI,
  DeepSeek, Meta, xAI, Anthropic models; "It does not store your prompts";
  honors Azure Policy; "Model router usage is charged for input prompts at the
  rate listed on the pricing page." This matters to belt positioning: Microsoft
  ships model routing _inside_ the customer's tenant — belt's router must
  add value beyond it (knowledge store, policy, local-model federation,
  cross-cloud upstreams) rather than re-implement it.
- **Entra ID keyless auth — how belt authenticates upstream (T1: learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/managed-identity).**
  - "Microsoft Entra ID lets you call your Azure OpenAI resource without
    storing an API key"; a role is granted to an identity on the resource:
    **Cognitive Services OpenAI User** (or Contributor) for inference;
    **Cognitive Services Contributor** for control plane.
  - Token audiences: `https://ai.azure.com/.default` for the new data plane
    (`https://<resource>.openai.azure.com/openai/v1/`),
    `https://management.azure.com/.default` for control plane; the resource
    must have a **custom subdomain** to accept Entra tokens.
  - Identity matrix: developer account (local), system/user-assigned managed
    identity (Azure-hosted), **service principal — "CI/CD pipelines and
    non-Azure hosts" — with a client secret or certificate**. That is belt's
    lane: belt authenticates AS a service principal the customer registers and
    role-assigns; `DefaultAzureCredential`/client-credentials flow; the
    customer's subscription pays, their quota and Azure Policy apply.
  - Disabling local auth keys on the resource is the natural hardening
    companion (resource-level setting; not covered on the cited page — UNVERIFIED
    on that page specifically, standard Azure configuration elsewhere).
- **APIM AI-gateway pattern — Microsoft's own reference for "gateway in front
  of Azure OpenAI" (T1: learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy).**
  - `llm-token-limit`: per-key token rate (`tokens-per-minute`) and/or quota
    (`token-quota` over Hourly..Yearly), keyed by any expression (caller IP,
    subscription ID); `429` on rate exceeded, `403` on quota exceeded; works
    with OpenAI Chat Completions/Responses, Anthropic Messages, Vertex AI
    schemas; all APIM tiers (Developer through Premium v2); token counting from
    response `usage`, optional prompt estimation, streaming caveats.
  - Companion policies: `llm-emit-token-metric` (T1, referenced from the same
    page), `llm-semantic-cache-lookup` / `-store` (semantic caching of
    LLM responses; T1s: /azure/api-management/llm-semantic-cache-lookup-policy),
    and the older `azure-openai-token-limit` / `azure-openai-semantic-cache-*`
    / `azure-openai-emit-token-metric` variants (GA 2024, T2), plus backend
    pooling/load-balancing across Azure OpenAI endpoints (T1s:
    /azure/api-management/genai-gateway-load-balancing).
  - Read: the pattern belt sells (token budgeting, per-team quotas, caching,
    failover) is exactly what Microsoft teaches enterprises to build with APIM
    in front of Azure OpenAI. belt competes/composes here — a genuine market,
    not a novel hack. belt's differentiators: self-hostable LiteLLM core,
    knowledge store, local-model federation, klh-fleet ops.

## 3. The honest verdict on MITM

**Can belt sit between Copilot and its models? No — there is no sanctioned
path, and belt must not build one.** Why, with sources:

1. The model call is made by the Copilot service inside the M365 service
   boundary ("Copilot sends the grounded prompt to the LLM" — T1 architecture
   doc). The customer's clients never issue a model request, so there is no
   request for a network-level belt to intercept and re-route. TLS-level
   interception appliances would be enterprise MITM of Microsoft traffic, not
   integration — and whether Copilot clients would even function behind one is
   UNVERIFIED (no documentation either way; do not claim it works).
2. No configuration surface exists: admin controls are governance-only
   (`copilotRoot`: admin settings, interaction history, usage reports — T1);
   Conditional Access and MFA control **access** to Copilot, not routing
   (T1 architecture doc).
3. The extensibility model is additive by design: agents/plugins/MCP servers
   are invoked _by_ the orchestrator; the orchestrator's own model traffic is
   never delegated (T1s orchestrator + T1 custom-engine-agent docs). The only
   way to have "your model" inside the Copilot experience is to own the whole
   agent (custom engine agent), not to proxy Microsoft's.

**What IS sanctioned — three doors, all revenue-compatible with belt:**

- **Door A — belt as the gateway in front of the customer's Azure
  OpenAI/Foundry deployments.** Customer provisions subscription + deployments
  - Entra app registration; belt authenticates as their service principal;
    their subscription pays; their quota/regions/Azure Policy apply. This is the
    legitimate "reuse the customer's entitlements": not Copilot seat
    entitlements, but the Azure entitlement stack.
- **Door B — belt as an MCP server consumed by Copilot Studio agents (and
  Foundry agents).** Belt knowledge layer surfaces inside the customer's agent
  estate; belt implements Streamable HTTP + OAuth (Entra app registration),
  `tools/list`/`tools/call` (T1s Copilot Studio MCP docs; T1 Foundry MCP doc).
- **Door C — belt as the backend of a custom engine agent.** Belt becomes the
  orchestrator+model layer of an agent published into M365 Copilot and Teams;
  users do **not** need Copilot licenses to use custom engine agents in
  Copilot Chat (T1 cost-considerations: "Users don't need a Copilot license to
  access custom engine agents in Microsoft 365 Copilot Chat"); belt can ground
  in tenant content via the Retrieval API with delegated auth, so the
  customer's per-user M365 entitlements (permissions, sensitivity labels)
  apply automatically (T1 retrieval overview + custom-engine-agent doc).

## 4. License vs consumption economics

- **Seat side.** M365 Copilot add-on (list price commonly reported at
  $30/user/month annual — T2; Microsoft pricing page not fetched, so price is
  UNVERIFIED at T1) unlocks work-based chat and embedded Copilot in Word,
  Excel, Outlook, Teams (T1 licensing + cost-considerations). Copilot Chat
  (web) is included with eligible M365 subscriptions at no charge; optional
  pay-as-you-go for work-based chat (T1). Agents/connectors: no extra charges
  for add-on-license users; unlicensed users get Copilot-Credits metering via
  Copilot Studio when agents touch shared tenant data (T1 cost-considerations).
- **Agent consumption.** Copilot Studio bills in Copilot Credits: ~$200/month
  per 25,000-credit pack or ~$0.01 per credit pay-as-you-go billed via an
  Azure subscription (T2 — multiple corroborating sources incl. CSP billing
  providers; Microsoft page 404'd on fetch — treat exact numbers as unconfirmed).
  Work IQ API is consumption-based in Copilot Credits (T1 cost-considerations).
- **Azure side.** Pay-per-token (Global Standard) vs PTU reserved capacity;
  Batch at 50% off; model router charged per input prompt (T1). Retrieval API
  PAYG (preview) exists for unlicensed users (T1).
- **What a belt deployment actually needs the customer to provision — and what
  it does NOT.** Needs: (1) an Azure subscription; (2) a Foundry/OpenAI
  resource with model deployments (Global Standard to start; PTU only for
  steady high volume); (3) an Entra app registration (service principal,
  secret or — better — federated credential) with **Cognitive Services OpenAI
  User** on the resource; (4) network egress from belt to the custom-subdomain
  endpoint. For Door B: an Entra app registration for belt's MCP OAuth + a
  place to host belt (Azure Container Apps internal ingress is the documented
  private pattern). Does NOT need: M365 Copilot seats for belt to function
  (seats only matter if belt surfaces inside M365 and grounding hits shared
  tenant data — then Copilot Credits meter non-licensed users, T1), and does
  not need Copilot Studio packs unless the customer builds the consuming
  agents there.

## 5. Precedents — who already sells this layer

- **Azure API Management (first-party).** Microsoft's own AI-gateway play in
  front of Azure OpenAI/Foundry: token limits, token metrics, semantic caching,
  backend pools (T1/T1s above). The enterprise default answer.
- **LiteLLM (belt's core).** "Unified Interface: Calling 100+ LLMs"
  OpenAI-compatible proxy incl. Azure; virtual keys, budgets/spend tracking,
  load balancing/fallbacks; enterprise tier adds SSO/SAML, audit logs,
  guardrails (T1: docs.litellm.ai/docs/proxy/quick_start). Deploys in front of
  the customer's provider accounts.
- **Portkey.** Commercial managed AI gateway: 200+ providers, guardrails,
  caching, observability, VPC/self-host options (T2 comparisons).
- **Cloudflare AI Gateway.** Zero-ops edge gateway with Azure OpenAI among
  providers: caching, rate limiting, analytics (T2).
- Common thread: **none of them front M365 Copilot's internal model calls
  either** — the category's M365-adjacent surface is exactly the sanctioned
  set: Azure upstreams + MCP servers + agent backends. (Absence claim — T2;
  verified as "no such positioning found" in reviewed comparison material, not
  provable from vendor docs alone.) The ~$30k/yr LiteLLM enterprise license
  figure circulating in comparisons is UNVERIFIED.

## Integration blueprint for belt

### Ranked sanctioned architectures

**A (primary): belt = enterprise AI gateway in front of customer's Azure
Foundry/OpenAI.** `apps → belt (token auth, budgets, audit, knowledge) →
customer's Azure OpenAI/Foundry (Entra service principal, their subscription)`,
plus belt federating local models and other upstreams alongside. Reuses: the
customer's Azure entitlement stack; belt's existing LiteLLM translation layer,
token/policy layer, audit. Zero Copilot coupling — sellable to any Azure EA
customer whether or not they run Copilot.

**B (companion): belt = MCP server into their Copilot Studio / Foundry
agents.** `Copilot Studio agent → MCP (Streamable HTTP + Entra OAuth) → belt
knowledge store / belt-routed models`. This is the honest way to "be in the
Copilot picture": belt is a tool inside their agents, not a proxy over
Microsoft's. Implementation is mostly belt exposing an MCP endpoint
(`tools/list`, `tools/call`, text content, tool descriptions) — protocol work,
not gateway work.

**C (premium/optional): belt = custom engine agent backend published to M365
Copilot/Teams.** `M365 Copilot / Teams → belt agent (Agents SDK wrapper) →
belt → Azure/local upstreams`, grounding via Retrieval API with delegated
Entra auth (per-user entitlements respected by Microsoft's permission model —
belt does NOT implement shared access; Microsoft already does, and belt rides
it). Highest integration value, highest certification/hosting burden (Azure
hosting, Bot Service channel, manifest ≥ 1.21).

**D (rejected): MITM of Copilot.** Not sanctioned, no interception point, no
customer-routable model call. Do not build, do not pitch.

### What the customer provisions

1. Azure subscription + resource group; Foundry/OpenAI resource with custom
   subdomain; model deployments (Global Standard first; PTU only for steady
   high volume; Data Zone variants for EU residency).
2. Entra app registration = belt's service principal; client secret or
   (preferred) federated identity credential; role assignment **Cognitive
   Services OpenAI User** on the resource (control-plane work needs
   Contributor, but belt needs inference only).
3. For Door B/C: a second Entra app registration for belt's inbound OAuth
   (MCP/custom engine agent), plus hosting for belt itself in their tenant
   (Container Apps internal ingress for private-network posture).
4. Optional: APIM in front of belt (they may already run it — belt composes,
   sits behind or beside APIM), Azure Monitor/Log Analytics sink for belt
   audit export.

### What belt implements

- **Upstream Entra service-principal auth**: client-credentials token
  acquisition with audience `https://ai.azure.com/.default` (and legacy
  `https://cognitiveservices.azure.com/.default`), bearer injection into the
  OpenAI-compatible calls, token cache/refresh, per-tenant credential config,
  support for key-disabled resources. Small, testable module in the existing
  LiteLLM layer (Azure handler already supports Entra; the work is
  multi-tenant credential management + audit fields: tenant id, subscription,
  deployment name, region).
- **Protocol translation**: already have it (LiteLLM OpenAI-compatible front
  door); add per-tenant deployment-name mapping and region routing.
- **Token/policy layer**: already have token auth + budgets; align semantics
  with the APIM reference (`tokens-per-minute` + quota windows, 429/403
  distinction, per-key counters) so belt is evaluatable against the pattern
  enterprises already know; document belt-vs-APIM positioning honestly (belt
  adds knowledge store, local-model federation, fleet ops; APIM adds
  enterprise network fabric — they compose).
- **MCP server surface** (Door B): Streamable HTTP transport, Entra OAuth,
  `tools/list`/`tools/call` exposing knowledge-store retrieval and belt-routed
  inference; registerable via Copilot Studio MCP Toolkit.
- **Agent wrapper** (Door C, later): Microsoft 365 Agents SDK shim around
  belt; Retrieval API client with delegated permissions
  (`Files.Read.All`/`Sites.Read.All`/`ExternalItem.Read.All`) so grounding
  inherits Microsoft's permission model.

### What we deliberately DON'T build

- MITM/interception of M365 Copilot model traffic (no sanctioned path).
- Shared-access/billing on Copilot seats — seat metering is Microsoft's
  ledger; there is no API to resell or meter seats, and belt must not depend
  on scraping anything.
- A "replace Copilot's models" pitch — impossible for the built-in
  experience; position belt's agent surface as complementary.
- Belt-side permission re-implementation for tenant content — the Retrieval
  API's delegated auth means Microsoft's permission engine stays authoritative.

### Phased plan

- **P0 (days):** decision doc + positioning one-pager per this research;
  verify Retrieval API delegated-vs-app-only support and current Copilot
  Studio pricing against live Microsoft sources (open UNVERIFIED items below).
- **P1 (~1–2 wks):** multi-tenant Azure upstream — Entra client-credentials
  provider, per-tenant config + audit fields, scratch-subscription E2E test
  (keyless call, quota 429 handling, deployment mapping). Exit: belt serves an
  Azure OpenAI deployment authenticated purely by service principal.
- **P2 (~1–2 wks):** policy parity — token budgets/quotas with APIM-equivalent
  semantics; semantic-cache posture decision (belt has no cache today — scope
  or explicitly skip); belt-vs-APIM positioning doc.
- **P3 (~2–4 wks):** MCP server endpoint (Streamable HTTP + Entra OAuth +
  tools/list|call) over the knowledge store; test as an action in a Copilot
  Studio agent (MCP Toolkit). Exit: an agent in the customer tenant answering
  from belt's knowledge layer.
- **P4 (later):** custom engine agent wrapper (Agents SDK), Retrieval API
  grounding with delegated auth, M365 publishing path; decide hosting
  (customer Container Apps vs belt appliance).
- **P5 (GA):** federated credentials over client secrets, Private Link,
  audit export to their Log Analytics, CSP/marketplace billing motion.

## What could not be verified

- $30/user/month Copilot price from a Microsoft primary page (T2 only).
- Copilot Studio exact pack/PAYG numbers from a Microsoft primary page (T2,
  multiply corroborated; pricing page 404'd on fetch).
- Model router's full billing composition (input-prompt charge confirmed T1;
  whether/how underlying-model token costs are passed through beyond "the rate
  listed on the pricing page" — pricing page not fetched).
- Retrieval API: delegated vs application-only permission support in GA (the
  overview lists permissions but not the grant type; the
  security-and-authentication page would settle it — not fetched).
- Whether Copilot clients function behind enterprise TLS-inspection appliances
  (no documentation either way; treated as unsafe to assume).
- LiteLLM enterprise license price (~$30k/yr — T3 rumor level).
- Absence claims ("no vendor fronts Copilot's internals") are
  evidence-of-absence from reviewed material, not provable.

## Sources

T1 (fetched in full):

- learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-architecture
- learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-licensing
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/cost-considerations
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/copilot-apis-overview
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/retrieval/overview
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/resources/copilotroot
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/interaction-export/resources/aiinteractionhistory
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-custom-engine-agent
- learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types
- learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router
- learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy
- learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
- learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/managed-identity
- docs.litellm.ai/docs/proxy/quick_start

T1s (primary, via search snippets):

- learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-overview
- learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server
- learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-create-server
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/orchestrator
- learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agents-overview
- learn.microsoft.com/en-us/azure/api-management/llm-semantic-cache-lookup-policy
- learn.microsoft.com/en-us/azure/foundry/control-plane/how-to-enforce-limits-models
- devblogs.microsoft.com/microsoft365dev/microsoft-365-copilot-apis-whats-new-and-whats-next/

T2 (corroboration):

- Pricing roundups: microsoft.com/microsoft-365-copilot (404 on fetch),
  work365apps.com (CSP billing), flectic.com, windowscentral.com,
  aisubscriptioncomparison.com
- Gateway comparisons: guptadeepak.com (Top 5 AI Gateways), contabo.com,
  odock.ai, api7.ai
- Community: federicoporceddu.com (Copilot Chat API deep dive),
  community.powerplatform.com (Azure OpenAI in Copilot Studio cookbook)
