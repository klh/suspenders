# Compression + cache-aware serving economics — W118 research dig

Date: 2026-10-01. Lane: w118-research. Axis: context/prompt compression + cache-aware
serving economics for agent knowledge preload.

Tier legend: **T1** = read this session in the primary source (paper abstract or full
text on arxiv/ar5iv, official provider/engine docs). **T2** = secondary corroboration
only. **UNVERIFIED** = lead that did not confirm.

Sibling docs this cycle (do not re-derive):

- `representation-injection-2026-10-01.md` (W120) — already verified Anthropic prompt
  caching T1: cached reads 0.1x input price, 5-min-TTL writes 1.25x (free refresh on
  use), 1-hour 2x, 100% exact-prefix matching. Recommended stable-prefix packet layout.
- `agent-token-efficiency-2026-10-01.md` (W121) — agent token-efficiency lit dig.

Baseline facts used below (governor.db, via `coord fact get`):

- `finding.injection-final` — clean-room cell: INJECTED 106.1k tok / 50 turns / 11.0 min
  vs BLIND 159.3k / 67 / 14.5 min = -33% tokens, -25% turns, -24% time. Push-style
  brief injection at entry works; pull-style hub queries neutral-to-negative.
- `finding.w111-context-share` — context = 51.9% of modeled spend cache-aware (58.4%
  standard-rate); lanes worst at 61.2%; planning = 8.9% of cost.
- `finding.w113-hub-vs-docs` — docs packets beat hub-distilled packets on nav-heavy
  repos (mechanism: pointer density); both tax small repos (+7.6% hub / +26.7% docs vs
  blind).

## 1. Compression mechanisms + measured tradeoffs

| Method                                           | Mechanism                                                                                                                                                                                                                        | Measured result                                                                                                                                                                                                                                             | Tier                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| LLMLingua (arXiv:2310.05736, EMNLP 2023)         | Coarse-to-fine: budget controller over demos + iterative token-level pruning scored by a small LM (Alpaca-7B or GPT2-Alpaca)                                                                                                     | GSM8K 77.33 EM at 20x (117 tok) vs 78.85 full-shot (2,366 tok) = -1.52 pts at 20x; BBH far less tolerant: 7x = 56.85 vs 70.07 (-13.2). V100 e2e latency 1.7x-5.7x speedup; compression pass itself 0.2-0.8 s                                                | T1 (full text)                                   |
| LongLLMLingua (arXiv:2310.06839, ACL 2024)       | Question-aware coarse-to-fine (doc-level ranking, then token-level via "contrastive perplexity" = conditional PMI), doc reordering for position bias, subsequence recovery; scorer LLaMA-2-7B-Chat                               | NQ open-domain: +21.4% with ~4x fewer tokens (ground-truth doc at position 10); LooGLE 94.0% cost cut ($5.6 vs $93.6 per 1k samples); e2e latency 1.4x-2.6x at 2x-6x on ~10k-token prompts; LongBench avg 48.8 vs 44.0 original at 3k-token budget          | T1 (full text)                                   |
| LLMLingua-2 (arXiv:2403.12968, ACL 2024)         | Task-agnostic extraction as token classification; XLM-R-large 355M (or mBERT 110M) distilled from GPT-4-32k labels; 2x-5x ratios                                                                                                 | LongBench 42.4 at 3x vs 44.0 original (96% retention); 39.1 at 5x (89%); MeetingBank QA EM 86.92 vs 87.75 original. Compressor 0.4-0.5 s on V100 vs Selective-Context 15.5 s / LLMLingua 1.5-2.9 s; peak mem 2.1 GB vs 16.6 / 26.5 GB; e2e 1.6x-2.9x        | T1 (full text)                                   |
| Recomp (arXiv:2310.04408, ICLR 2024)             | Trained extractive (110M Contriever-init dual encoder, contrastive objective) + abstractive (T5-large 775M distilled from GPT-3.5 w/ critic filter); selective augmentation = can emit empty string when retrieval is irrelevant | Trained compressors: 5-10% of original evidence tokens with <10% relative drop on open-domain QA (NQ 44.22/45.47 vs 48.28 top-5, at ~37 tok vs 660); LM-task ratio 25%. Oracles: 6-13% of tokens, sometimes beating full prepend (NQ oracle 64.25 vs 48.28) | T1 (full text)                                   |
| Selective Context (arXiv:2304.12102, EMNLP 2023) | Self-information filter via small causal LM, lexical/sentence granularity                                                                                                                                                        | Own abstract: mechanism + summarisation/QA effectiveness only. As measured by LLMLingua-2 authors: LongBench 5x = 24.8 vs 44.0 (worst of family), 15.5 s / 26.5 GB — dominated empirically                                                                  | T1 (abstract + comparative tables in 2403.12968) |

Reading of the tradeoff surface:

- Extraction-based methods (LLMLingua-2, Recomp) hold ~89-96% of quality at 3-5x on
  long-context tasks and are cheap to run (355M params, sub-second, 2 GB). Token-level
  deletion (LLMLingua) reaches 20x but only where prompts are demo-dominated (GSM8K
  ICL); the accuracy cliff is task-specific (BBH -13 pts already at 7x).
- Compression can IMPROVE accuracy by denoising: LongLLMLingua +21.4% on NQ at 1/4
  tokens; Recomp's oracles beat prepending everything. Removing irrelevant context is
  not lossy by definition — relevance, not length, is the variable.
- Cache-hostility: query-aware compression (LongLLMLingua) mutates the prompt per
  query, which destroys exact-prefix caches. Deterministic, task-agnostic compression
  done once at artifact-build time is cache-compatible.

Lead corrections made this session (leads were wrong, sources are right):

- "LLMLingua achieves GPT-4 equivalence" — absent from the paper full text AND the
  Microsoft blog; the blog uses GPT-4 only to RESTORE compressed prompts. Dead lead.
- "LongLLMLingua 28% average LongBench improvement" — not in the current full text;
  the table shows +4.8 absolute (48.8 vs 44.0). The 21.4 figure is the NQ performance
  boost, not "21.4x cost reduction" as often paraphrased.
- Recomp "10-20% F1 gains" — oracle-only; trained compressors lose ~2-4 F1 while
  cutting tokens ~90-95%.

## 2. Caching economics

### Serving-side (self-hosted / fleet hardware)

| System                                                                | Mechanism                                                                                                                                                    | Measured                                                                                                                                                                                                                                                                                                      | Tier                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| vLLM PagedAttention (arXiv:2309.06180, SOSP 2023)                     | OS-paging for KV cache; waste bounded to one partial block; flexible block sharing                                                                           | Existing systems: only 20.4-38.2% of KV memory holds real token states (62-80% waste). Throughput 2-4x vs FasterTransformer/Orca; up to 22x vs FasterTransformer on ShareGPT. Cross-request shared prefix: 1.67x vs Orca (1-shot prefix), 3.58x (5-example prefix). OPT-13B: 800 KB KV/token, ~1.6 GB/request | T1 (full text)                  |
| vLLM automatic prefix caching (official docs)                         | `enable_prefix_caching=True`; reuse requires shared prefix; prefill-only savings (decoding unaffected); no gain for long-generation or prefix-less workloads | Qualitative only — no speedup numbers in docs                                                                                                                                                                                                                                                                 | T1 (docs)                       |
| SGLang RadixAttention (arXiv:2312.07104, NeurIPS 2024)                | Radix-tree KV reuse across generation steps AND across calls + cache-aware scheduling                                                                        | Up to 6.4x throughput vs state-of-the-art serving systems, on agent control, few-shot, JSON decoding, RAG, multi-turn workloads                                                                                                                                                                               | T1 (abstract)                   |
| CachedAttention (arXiv:2403.19708, USENIX ATC 2024; basis of LMCache) | Hierarchical compute/memory/disk KV tiers, multi-turn-aware eviction, async save/layer-wise preload                                                          | TTFT -87% (up to), prefill throughput +7.8x, e2e inference cost -70% (up to) for multi-turn long-prompt serving                                                                                                                                                                                               | T1 (abstract)                   |
| CacheGen (arXiv:2310.07240, SIGCOMM 2024)                             | KV cache -> compact bitstream (custom tensor encoder), bandwidth-adaptive levels, recompute fallback                                                         | KV size -3.5-4.3x; total fetch+process delay -3.2-3.7x; negligible quality impact. Makes KV a shippable artifact over a network                                                                                                                                                                               | T1 (abstract)                   |
| Parrot (arXiv:2405.19888, OSDI 2024)                                  | Semantic Variable exposes app-level data flow to the serving layer; cross-request optimization via data-flow analysis                                        | "Up to an order-of-magnitude improvement" e2e. The specific 11.7x figure is body-only — not read                                                                                                                                                                                                              | T1 (abstract); 11.7x UNVERIFIED |

### Provider pricing (paid tier, per 1M tokens)

- **Anthropic** — verified in W120 (cite, not re-derive): cached reads 0.1x; 5-min
  writes 1.25x, refreshed free on use; 1-hour 2x; exact-prefix match. T1 via sibling doc.
- **Gemini** (official docs, this session): cached input = **10% of base input** —
  2.5 Flash $0.03 vs $0.30; 2.5 Pro $0.125 vs $1.25 (<=200k prompt tier). Cache
  STORAGE is billed hourly: $1.00 / 1M tok / hr (Flash), $4.50 / 1M tok / hr (Pro).
  Implicit caching is on by default for 2.5+ models with savings passed through
  automatically; minimum cacheable length 2,048 tok (2.5 Flash/Pro), 4,096 tok (3.x
  generation). Docs' own hit-rate advice: put "large and common contents at the
  beginning of your prompt" and send similar prefixes within a short time window. T1.
  - Correction: the "cached tokens cost 25%" folklore is wrong for current pricing —
    it is 10%, same multiplier as Anthropic reads.
  - Keep-warm math: a 50k-token packet costs ~$0.05/hr (Flash) to ~$0.225/hr (Pro) to
    hold warm; break-even vs full-price re-reads depends entirely on hit rate inside
    the TTL window.

### The tension that matters for packet design

Compression at dispatch time and prefix caching are mutually destructive (mutated
prompts = 0% hit rate on exact-prefix matchers). They are complements only when
compression is deterministic and applied BEFORE the prefix is fixed — i.e. at packet
build, offline.

## 3. Preload-vs-retrieve evidence

- **Preload (long context) wins at ample budget:** LC > RAG by 7.6% (Gemini-1.5-Pro),
  13.1% (GPT-4o), 3.6% (GPT-3.5-Turbo) across 9 datasets / ~2,030 queries (Self-Route,
  arXiv:2407.16833, EMNLP 2024 industry). T1 (full text).
- **Routing recovers most of the cost gap:** Self-Route (read retrieved chunks, then
  self-reflect: answerable from chunks vs needs full context) = cost -65% for
  Gemini-1.5-Pro and -39% for GPT-4o with quality comparable to LC (46.41 vs 49.70;
  48.89 vs 48.67; GPT-3.5-Turbo actually +1.7 ABOVE LC), at 38-61% of LC tokens. T1.
- **Compression shifts the preload-vs-retrieve boundary:** LongLLMLingua's NQ result
  (compressed full-context beats uncompressed at 1/4 tokens) and Recomp's selective
  augmentation (empty string when evidence irrelevant) show the real decision is not
  preload-vs-retrieve but relevant-tokens-vs-noise. Oracles that drop irrelevant
  context beat prepending everything. T1.
- **Reuse economics decide whether preload is cheap:** CachedAttention (-87% TTFT,
  -70% cost) and CacheGen (3.5-4.3x KV shrink, shippable) make a shared preload
  amortizable across many sessions/instances; without reuse, preload is re-prefilled
  and paid per request. T1.
- **Our own cells agree:** entry-injection -33% tok (injection-final); docs-pointer
  packets beat hub-distilled packets, both tax small repos (W113); pointer rows (W112)
  are the minimal-token preload format already.

Synthesis: preload wins when (a) the shared context amortizes across enough requests
(cache hits), (b) content is pointer-dense and denoised, and (c) a router can say "no"
for small/low-nav targets. Retrieve (or blind) wins when queries are rare relative to
content volume or the preload would be stale.

## 4. Steal for our stack — ranked by expected savings on OUR measured numbers

Anchors: context = 51.9% of modeled spend cache-aware (W111), lanes 61.2%; entry
injection already -33% tok / -24% time (injection-final); W112 pointer rows; W120
stable-prefix layout + Anthropic 0.1x reads.

1. **Deterministic offline packet compression in packet-prep (LLMLingua-2 class).**
   Compress at packet BUILD time with a task-agnostic extractor; never per-request
   (preserves exact-prefix caches). Keep file pointers verbatim (W112), compress only
   architecture/operational prose — which is exactly the layer W113 showed loses to
   pointers. Evidence fit: Recomp oracles prove denoising can beat full prepend;
   LLMLingua-2 holds 96% quality at 3x. Expected on our numbers: if packet prose is
   10-20% of lane context and lane context is ~52% of spend, 3x compression of that
   prose is roughly a 3-7% total-spend cut plus the same order in raw tokens. Cost:
   355M-param extractor at 0.4 s / 2.1 GB runs on fleet Macs; GPT-4-label distillation
   is a one-off.
2. **Prefix-affinity dispatch (RadixAttention concept at the gateway).** Two halves:
   (a) layout — static system prompt first, stable packet block second, volatile lane
   content last (W120 already recommends this); (b) routing — send lanes sharing a
   packet prefix to the same provider identity inside TTL windows. Evidence: shared
   prefixes gave 1.67x/3.58x throughput on self-hosted (PagedAttention); Anthropic
   0.1x reads (W120) and Gemini 10% cached input make the hit rate the dominant cost
   variable. Expected: every +10 points of cached context share is ~-9% of context
   spend = ~-4.7% of total; the ceiling if lane workloads approach CachedAttention-style
   reuse is multiples of that. Pure gateway policy, zero model change — do first.
3. **Preload router (Self-Route analog) in dispatch.** Per task, choose full docs
   packet vs pointer-only vs blind, keyed on repo size/nav-density — this deletes the
   measured small-repo tax (+7.6-26.7%) and is Recomp's empty-string mechanism made
   operational. Expected: recovers the tax on the small-repo share of lanes; Self-Route
   demonstrates -39/-65% cost at comparable quality in the retrieval setting.
4. **KV persistence + cross-machine KV shipping for the resident fleet.** W120 already
   flags `mlx_lm.cache_prompt`; CacheGen's 3.5-4.3x bitstreams make LAN shipping of a
   prefilled packet KV between fleet Macs plausible; CachedAttention's +7.8x prefill /
   -87% TTFT is the target metric. Token-neutral (own hardware, no $-per-token), so
   rank below the $-levers; measure before building.
5. **Gemini-fronted lanes only: 10% cached input + implicit caching.** Attractive
   because implicit caching is default-on and free (no explicit cache objects), but
   hourly storage changes the math: keep-warm for a 50k packet is $0.05/hr Flash vs
   $0.225/hr Pro — prefer Flash-family for cached packet serving, and only if a lane
   family actually rides Gemini.

Order of operations: (2) is policy — first; (1) slots into packet-prep; (3) is a
dispatch-table edit; (4)/(5) experimental.

## 5. Could-not-verify

- **"Certifiably Robust Prompt Compression"** — exact-title searches on arxiv and the
  open web return nothing; the author named in the lead publishes on diffusion-model
  robustness, not prompt compression. Likely a garbled or hallucinated lead (nearest
  real neighbor: "Certifiably Robust RAG against Retrieval Corruption",
  arXiv:2405.15556). UNVERIFIED.
- "LLMLingua achieves GPT-4 equivalence" — absent from paper and MS blog alike. Dead.
- "LongLLMLingua 28% average LongBench improvement" — not in the current full text;
  table shows 48.8 vs 44.0. Probably blog-paraphrase drift.
- Parrot "11.7x on D-RAG" — abstract claims only "order-of-magnitude"; body not read.
- PagedAttention "<4% waste" — abstract says "near-zero"; exact percentage not read.
- CachedAttention's ShareGPT reuse statistics (share of prefill that is redundant) —
  body-only, not read.
- vLLM APC speedup percentages — official docs are qualitative only.
