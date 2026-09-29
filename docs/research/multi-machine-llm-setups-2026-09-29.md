# Multi-machine LLM setups — shelf-tested tooling survey (2026-09-29)

Method: one research lane (W88/autow88), executed 2026-09-29 via search +
primary-source fetches. Every claim carries source + date + tier. T1 =
primary source fetched; T1s = primary verified via search metadata;
T2/UNVERIFIED-SNIPPET = not confirmed on the primary page. Scope: what
exists battle-tested at each scale — homelab to enterprise datacenter —
and what a 2-machine homelab should adopt vs adapt.

## The short answer (evidence-mapped)

- At 2 machines the battle-tested move is boring: one OpenAI-compatible
  gateway in front of two independent model servers, with
  health-check-driven cooldown/failover — not a distributed-inference
  framework. The datacenter-scale tools say so themselves: NVIDIA
  Dynamo's README states that running a single model on a single GPU
  needs only the inference engine, no orchestration layer (T1).
- Service discovery at n=2 is a solved non-problem: static endpoint
  config + active health checks. mDNS/DNS-SD is the zero-config fallback
  and is what `.local` homelab naming implicitly rides on — but RFC 6762
  Appendix G explicitly recommends against `.local` as a private
  _unicast_ DNS TLD because it collides with mDNS (T1).
- Distributed-tensor serving (llama.cpp RPC) exists and works, but it is
  a memory-aggregation tool, not a throughput tool: split a model across
  machines only when one machine cannot hold it.

## Track A — AI gateways (routing, keys, quotas, observability)

- LiteLLM proxy/router (T1, docs.litellm.ai/docs/proxy/load_balancing,
  fetched 2026-09-29): OpenAI-compatible proxy in front of N deployments.
  Selectable routing strategies per deployment group: `simple-shuffle`
  (default), `least-busy`, `usage-based-routing`, `latency-based-routing`,
  `cost-based-routing`. Ordered fallback lists tried on failure; failed
  deployments enter a cooldown before rejoining rotation; multi-instance
  proxy state (cooldowns, rate-limit budgets) shared via Redis. The
  de-facto homelab-through-enterprise Python gateway.
- Portkey Gateway (T1, github.com/Portkey-AI/gateway, fetched
  2026-09-29): "AI Gateway with integrated guardrails. Route to 1,600+
  LLMs, 50+ AI Guardrails with 1 fast & friendly API" — open-source,
  self-hostable (Node/TypeScript, Docker); fallback / load-balancing /
  canary routing configs (exact config names T1s).
- Kong AI Gateway (T1, developer.konghq.com/ai-gateway, fetched
  2026-09-29): the API-gateway incumbent's answer. Unified control plane
  over LLM + MCP + A2A traffic; provider load balancing and automatic
  failover "when one is slow or unavailable"; semantic cache; prompt
  guard/redaction; token metering and tiered budgets; OpenTelemetry.
  Control plane is Konnect (SaaS) with a self-hosted data plane — the
  quickstart provisions through a Konnect token with licensing handled by
  Konnect. Heavy machinery, priced accordingly.
- Envoy AI Gateway (T1, aigateway.envoyproxy.io/docs, fetched
  2026-09-29): open-source, built on Envoy; LLM-specific filters layered
  onto Envoy's Gateway API stack — token counting, streaming response
  handling, per-model routing (T1s via search metadata). The natural pick
  where Envoy/Istio already runs.
- Pattern-level takeaway: all four converge on the same feature set —
  provider abstraction, load-balancing strategies, health-aware
  failover/cooldown, token accounting, guardrails. At 2 machines any of
  them (or a small Caddy/nginx round-robin) covers the routing job; the
  choice is ergonomics and governance surface, not capability.

## Track B — cluster inference frameworks (placement, disaggregation, autoscaling)

- vLLM production stack (T1, github.com/vllm-project/production-stack,
  fetched 2026-09-29): vLLM's reference K8s-native deployment — Helm
  chart plus a router service with KV-cache-aware routing and LMCache
  integration; "cluster-wide deployment with community-driven performance
  optimization". The canonical way to run >1 vLLM replica once you are on
  Kubernetes.
- NVIDIA Dynamo (T1, github.com/ai-dynamo/dynamo, fetched 2026-09-29):
  datacenter-scale distributed-inference framework (Rust core, Python
  API), positioned _above_ engines (TensorRT-LLM, SGLang, vLLM):
  disaggregated prefill/decode (separate GPU pools), KV-aware routing,
  KV-cache offload (KVBM), weight streaming (ModelExpress), SLA-driven
  autoscaler (Planner), K8s operator (Grove), fault tolerance via canary
  health checks with in-flight request migration. Service discovery is
  K8s-native (CRDs + EndpointSlices) with a file-based mode for
  local/multi-node dev; etcd/NATS optional as of 1.0. Vendor-reported
  results (T1-as-published): 2× TTFT at fixed capacity from KV-aware
  routing (Qwen3-Coder-480B on Baseten); 7× throughput on GB200 NVL72
  with disaggregated DeepSeek-R1; 80% fewer SLA breaches at 5% lower TCO
  with Planner (Alibaba, APSARA 2025). The README's own scope warning:
  single model + single GPU → the engine alone suffices.
- Ray Serve LLM (T1, docs.ray.io/en/latest/serve/llm/ overview, fetched
  2026-09-29): deploy multiple LLMs on a Ray cluster with autoscaling and
  load balancing behind OpenAI-compatible APIs; multi-node multi-model
  serving is the headline use case. You inherit the Ray runtime's
  operational surface along with it.
- KServe (T1,
  kserve.github.io/website/docs/concepts/architecture/control-plane,
  fetched 2026-09-29): K8s `InferenceService` CRD with two control-plane
  modes — serverless (Knative autoscaling) or raw (plain K8s). Its v2
  inference protocol is the portability layer between model servers;
  Triton speaks it (T1, Triton README).
- NVIDIA Triton Inference Server (T1,
  github.com/triton-inference-server/server, fetched 2026-09-29):
  per-node inference server — dynamic batching, concurrent model
  execution, ensembles, HTTP/REST + gRPC on the KServe protocol, GPU
  metrics; current release 26.08 (v2.72.0). Multi-host scaling is classic
  K8s deployment + external load balancer; there is no built-in cluster
  brain. For LLMs specifically it has largely been overtaken by
  vLLM/TensorRT-LLM engines fronted by Dynamo.

## Track C — single-box-first tooling (the homelab's actual tools)

- llama.cpp RPC backend (T1,
  github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md, fetched
  2026-09-29): `rpc-server` on each host exposes ggml backend buffers
  over TCP; a client `llama-server --rpc host1:50052,host2:50053` splits
  model tensors/layers across the listed machines; scheduler state in a
  temp file, per-host stats behind `GGML_RPC_ENABLE_STATISTICS`. Design
  intent: run ONE model that does not fit one machine by pooling memory.
  Every token's tensors traverse the network, so interconnect bandwidth
  is the ceiling — it is not replication and buys no per-request
  throughput parallelism.
- Ollama (T1, docs.ollama.com/faq, fetched 2026-09-29): single-host
  runtime. The FAQ documents exposing the API on the network
  (`OLLAMA_HOST=0.0.0.0`) and proxying/fronting setups. No clustering,
  replication, or built-in multi-host load balancing appears anywhere in
  the official docs — "ollama multi-host" in the wild means fronting N
  independent ollama servers with an external gateway (third-party
  how-tos T2).

## Track D — service discovery: Consul vs mDNS/DNS-SD

- Consul (T1, developer.hashicorp.com/consul/docs, fetched 2026-09-29):
  service-networking platform — agents on every node register services
  with health checks; discovery via DNS interface and HTTP API;
  gossip-based membership with TLS/ACL; WAN federation and cluster
  peering for multi-DC; KV store feeding consul-template/CTS for config
  automation. Battle-tested at thousands of nodes; the price is a server
  quorum (3+ for availability) plus an agent fleet — even for two
  services.
- mDNS/DNS-SD (T1, RFC 6762 full text — Cheshire & Krochmal, Apple,
  Feb 2013, fetched 2026-09-29): DNS semantics over UDP multicast 5353 to
  224.0.0.251 / FF02::FB; `.local` names are link-local by definition;
  requires zero infrastructure and "works during infrastructure failures"
  (abstract). Conflict resolution via probing + tiebreaking; host records
  TTL 120 s; cache coherency via the cache-flush bit, goodbye packets,
  and Passive Observation Of Failures (§10.5: stale records flushed after
  ~10 s of unanswered queries). RFC 6763 (DNS-SD) adds service types and
  enumeration. Security posture: the protocol "assumes cooperating
  participants"; on untrusted links the RFC directs you to DNSSEC/IPsec
  (§21). Appendix G explicitly recommends against `.local` as a private
  unicast-DNS TLD — it conflicts with mDNS and produces split-resolution
  confusion (suggests `.internal`, `.lan`, etc. instead).
- Verdict for n=2: both are overkill. Two machines = two static endpoint
  entries + health checks. mDNS is already on the LAN for free; Consul
  earns its cost only when endpoints churn faster than you can edit a
  config file — dozens of services or multi-DC.

## Track E — health-check + liveness patterns

- Kubernetes probes (T1,
  kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-
  readiness-startup-probes/, fetched 2026-09-29): three orthogonal
  probes — liveness (dead → restart), readiness (unready → remove from
  rotation), startup (grace for slow container start before other probes
  engage). LLM serving makes the readiness/startup split concrete: model
  load can take minutes before an instance can serve.
- LiteLLM (T1, load-balancing doc, fetched 2026-09-29): cooldown-on-
  failure with re-probe before rejoining rotation; `/health` endpoints
  for probing; Redis shares cooldown state across proxy replicas.
- Dynamo (T1, README, fetched 2026-09-29): canary health checks on worker
  processes plus in-flight request migration, so a failing worker does
  not drop live generations.
- vLLM production-stack router (T1, README, fetched 2026-09-29): stat-
  based routing (in-flight + queued requests) with eviction of replicas
  failing health checks.
- mDNS POOF (T1, RFC 6762 §10.5): passive failure observation — peers
  watch queries go unanswered and flush stale records without anyone
  actively polling.
- Pattern synthesis: a healthy fleet = (1) a cheap active probe for "is
  alive", (2) rotation-level readiness for "take traffic", (3)
  cooldown/eviction with re-probe, (4) passive observation as backstop.

## Contradiction ledger & gaps

- "Multi-host ollama" how-tos (T2 blogs) imply clustering; the official
  docs have no such feature — the cluster is always the external gateway.
- Vendor benchmark numbers (Dynamo 2× TTFT, 7× throughput, Planner SLA
  numbers) are published in the project README without independent
  replication — vendor-reported (T1-as-published).
- The gateway space is saturated: four mature gateways with the same core
  feature set means no "battle-tested winner" exists at any tier — only
  operational-fit winners.
- Gap: no survey-grade benchmark compares app-level gateways (LiteLLM)
  against data-plane gateways (Envoy/Kong AI) for LLM traffic at homelab
  scale.

## What a 2-machine homelab should adopt vs adapt

Adopt (as-is; battle-tested at every scale):

1. One OpenAI-compatible gateway in front of everything. LiteLLM proxy is
   the lightest with real cooldown/fallback logic; plain Caddy/nginx
   round-robin if you would rather not run a Python service. Model
   placement across the 2 machines is a per-model decision made in
   config, not at runtime: the big model on machine A, small models on
   machine B.
2. K8s-style probe semantics even without Kubernetes: a liveness probe
   (systemd/launchd restarts the server), a readiness check that gates
   gateway rotation (model loaded, GPU responsive), and gateway-side
   cooldown with re-probe.
3. Static service configuration — 2 endpoints do not need discovery.
   Keep mDNS/DNS-SD for humans on the LAN; let the gateway read a config
   file.

Adapt (borrow the pattern, skip the framework):

4. KV-cache-aware routing: prefer the machine that already served the
   same conversation prefix — implementable as sticky-by-session at the
   gateway. Skip LMCache/KVBM machinery until cache offload is the
   measured bottleneck.
5. llama.cpp RPC only as a memory pool of last resort: if one model
   genuinely does not fit one machine, layer-split RPC over a wired,
   fast LAN works — expect interconnect-bound speed, not scale-out.
   Otherwise split by model, not by tensor.
6. Consul's register + health-check + lookup model, without Consul: a
   short config file with the same semantics serves 2 machines. Mind the
   RFC 6762 caveat: unicast private DNS should use a TLD other than
   `.local` (e.g. `.internal`) to avoid mDNS collision.

Skip until >5 machines or real SLAs:

7. Dynamo, KServe, Ray Serve, vLLM production-stack — K8s-native
   autoscaling, disaggregated prefill/decode, SLA planners. Their own
   documentation scopes them to clusters; at n=2 they add a control plane
   to babysit with no workload to justify it. Kong/Envoy AI Gateway's
   enterprise governance (multi-team budgets, MCP/A2A gatewaying)
   likewise.

## Notes for this repo's fleet

- The fleet board and klh/local services are served at `*.local` names
  via Caddy — that is unicast DNS riding the mDNS-reserved namespace.
  RFC 6762 Appendix G warns this pattern conflicts with mDNS; new
  internal services should prefer `.internal` (T1).
- The board's own health story matches the surveyed pattern: coord
  liveness via heartbeat/TTL (15-min progress-entry TTL, session
  timeouts) is cooldown-with-reprobe at the agent layer — no changes
  indicated.
