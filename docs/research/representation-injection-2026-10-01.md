# Representation-level knowledge injection — literature dig (2026-10-01)

Research note (W120). Owner's axis: "even to the point of memery mapping and
bit injection" — how far below prompt-text can the literature push knowledge
into models, and what of it is usable by a harness that controls **text + API
only** (belt routes, packets, provider caches)? Three usability levels used
throughout: **HARNESS** (usable today via text/API), **SELF-HOST** (usable on
our MLX swarm or the llama.cpp lane), **RESEARCH** (needs white-box hooks we
don't have in serving).

Tiers: T1 = primary source fetched this session (arXiv abstract, repo source
or README); T2 = secondary (search snippet, project README, local repo doc);
UNVERIFIED = claimed, not confirmed this session.

## 1. Technique taxonomy

Ordered by injection depth: prompt-adjacent → activation → parameters.

| Stratum             | Technique (source)                                | Mechanism one-liner                                                                                         | Usability |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------- |
| Prompt-adjacent     | Provider prefix caching (Anthropic docs, T1)      | Server caches KV for an exact text prefix; hits cost 10% of input price, writes cost +25% (5-min TTL)       | HARNESS   |
| Prompt-adjacent     | Prompt Cache (Gim et al, MLSys 2024)              | Precomputed attention state for recurring "modules" defined in a schema, reused inside prompts              | RESEARCH  |
| Prompt-adjacent     | CacheBlend (Yao et al, EuroSys 2025)              | Reuse KV of non-prefix chunks, selectively recompute the small subset of tokens whose attention crossed     | RESEARCH  |
| Prompt-adjacent     | LMCache (LMCache/LMCache README)                  | KV-cache management layer: cross-request/session reuse, tiered offload to CPU RAM/SSD/remote, vLLM plugin   | RESEARCH  |
| Activation          | ActAdd (Turner et al, arXiv 2023)                 | Add the activation difference of a prompt pair ("Love"−"Hate") to the residual stream during inference      | RESEARCH  |
| Activation          | ITI (Li et al, NeurIPS 2023)                      | Shift activations at selected attention heads along "truthful" directions found with a few hundred examples | RESEARCH  |
| Activation          | RepE (Zou et al, 2023)                            | Read and manipulate population-level latent representations for honesty, harmlessness, power-seeking        | RESEARCH  |
| Activation          | Refusal-direction ablation (Arditi et al, 2024)   | Erase one residual-stream direction and refusal behavior disappears across 13 chat models up to 72B         | RESEARCH  |
| Activation          | Unlearned-info extraction (Seyitoğlu et al, 2024) | Steering vectors re-exact-retrieve "unlearned" facts — suppressed knowledge persists along directions       | RESEARCH  |
| Parameter (PEFT)    | Prefix-tuning (Li & Liang, 2021)                  | Train a continuous "virtual token" prefix that downstream tokens attend to; 0.1% of parameters              | SELF-HOST |
| Parameter (PEFT)    | Prompt tuning (Lester et al, EMNLP 2021)          | Learn soft-prompt embeddings on a frozen model; matches full fine-tuning only at billions of parameters     | SELF-HOST |
| Parameter (PEFT)    | P-Tuning v2 (Liu et al, ACL 2022)                 | Deep prompt embeddings at every layer; 0.1–3% of parameters, matches fine-tuning across scales and tasks    | SELF-HOST |
| Parameter (distill) | Context distillation (Snell et al, 2022)          | Fine-tune the model to reproduce its own with-context behavior without the context (self-distillation)      | SELF-HOST |
| Decoding speed      | Medusa (Cai et al, 2024)                          | Extra decoding heads draft multiple future tokens, tree attention verifies them in one pass                 | SELF-HOST |
| Decoding speed      | EAGLE-3 (Li et al, 2025)                          | Draft model on fused multi-layer features, "training-time test"; direct token prediction                    | SELF-HOST |
| Decoding speed      | MTP (DeepSeek-V3, 2024)                           | Multi-token-prediction heads trained at pretraining, repurposed as the speculative-decoding drafter         | SELF-HOST |
| Decoding speed      | mlx-lm spec decoding (ml-explore/mlx-lm source)   | `--draft-model` + `--num-draft-tokens` (default 3): small model drafts, main model verifies                 | SELF-HOST |

## 2. Evidence table

What injection/acceleration effect was measured, at what cost. T1 unless
marked.

| Technique        | Effect measured                                                                                        | Cost / requirements                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| ITI              | TruthfulQA truthfulness 32.5% → 65.1% on Alpaca (NeurIPS 2023 spotlight)                               | Few hundred examples; inference-time head shifts; no weight changes; truth/helpfulness tradeoff |
| ActAdd           | SOTA sentiment-shift and detoxification on LLaMA-3 and OPT; no factual-knowledge claims                | One prompt pair, zero training                                                                  |
| RepE             | Monitoring + manipulation of honesty/harmlessness/power-seeking; abstract claims NO fact injection     | Representation reading vectors; research tooling                                                |
| Refusal ablation | Erasing one direction disables refusal; adding it elicits refusal on harmless prompts (13 models)      | Activation contrast harmless-vs-harmful; white-box jailbreak with minimal collateral            |
| Unlearned-info   | Exact retrieval of "unlearned" facts via steering (NeurIPS 2024 Safe GenAI workshop)                   | Steering vector construction (Anonymized Activation Steering); success varies by info type      |
| Prefix-tuning    | Matches full fine-tuning full-data, beats it low-data (GPT-2 table-to-text, BART summarization)        | 0.1% of parameters trained                                                                      |
| Prompt tuning    | Closes the gap to model tuning only "as models exceed billions of parameters" (EMNLP 2021)             | Soft-prompt embeddings on frozen model; weak at small scale                                     |
| P-Tuning v2      | Matches fine-tuning across scales/tasks incl. sequence labeling (ACL 2022)                             | 0.1–3% of parameters                                                                            |
| Context distill. | Instructions/reasoning internalized; +9% over direct gradient descent on SPIDER text-to-SQL            | Teacher-with-context generates labels; student fine-tunes without context (self-distillation)   |
| Prompt Cache     | TTFT reduction up to 8x (GPU) / 60x (CPU) for long prompts, accuracy maintained (MLSys 2024)           | Recurring text modules + positional schema; server-side cache infrastructure                    |
| CacheBlend       | TTFT 2.2–3.3x and throughput 2.8–5x vs full recompute, quality uncompromised (EuroSys 2025, T2)        | ~selective recompute of cross-attention tokens; CUDA/vLLM stack, not MLX                        |
| LMCache          | Cross-session KV reuse, offload tiers; "10x MoE" blog claim (T2)                                       | Separate daemon + vLLM integration; PyTorch Foundation since Oct 2025                           |
| Medusa           | 2.2x speedup frozen-backbone, 2.3–3.6x joint (ICML 2024 claim T2)                                      | Train extra heads only (Medusa-1) or heads+backbone (Medusa-2)                                  |
| EAGLE-3          | Up to 6.5x vs vanilla decoding, ~1.4x over EAGLE-2, 1.38x SGLang throughput at batch 64                | Train draft model; multi-layer feature fusion                                                   |
| MTP (DSv3)       | Acceptance-rate and TPS numbers NOT confirmed (§5.4.3 truncated) — UNVERIFIED                          | MTP heads trained during pretraining; repurposed as drafter                                     |
| MTP (our lane)   | T1 (W115): magnitude engine ran MTP spec-dec, 5/5 drafted tokens accepted, 161 tok/s — still slower    | vs rapid-mlx MLX 175 tok/s on the 4B class; unsloth MTP GGUF via llama.cpp                      |
| mlx-lm flags     | T1 (source): `--draft-model`, `--num-draft-tokens`, `--prompt-cache-file`, `--kv-bits` KV quantization | mlx_lm.cache_prompt persists KV prefix cache to .safetensors for reuse                          |
| Provider caching | T1 (Anthropic docs): reads 0.1x, 5-min writes 1.25x, 1-hour 2x; 100% exact-prefix match required       | Free-refreshing 5-min TTL on use; min cacheable lengths; breakpoints cost nothing (up to 4)     |

## 3. Steal for our stack (ranked by practicality)

1.  **Packet layout for provider prompt caching** — HARNESS, today, zero risk.
    Provider caches cover the exact prefix tools → system → messages at 0.1x
    read cost. Our packets are ≤3KB prose cards (W107/W113) — make the shared
    fleet cards byte-identical and place them FIRST in the injected brief,
    per-task deltas after. Byte-stable ordering converts repeated packet text
    into cache hits instead of full-price input tokens. Note the failure mode
    the docs call out: any timestamp/rotating card inside the prefix makes
    every request a permanent miss.
2.  **Self-host KV prefix persistence** — SELF-HOST, low risk. mlx-lm ships
    `mlx_lm.cache_prompt` with `--prompt-cache-file`: precompute the stable
    packet prefix once per resident model, persist KV to .safetensors, reuse
    across sessions; `--kv-bits` quantizes the cache to shrink it. On a
    128GB machine hosting several resident models, persistent packet-prefix
    KV is the CacheBlend/Prompt Cache idea with infrastructure we already
    run. Caveat (T2): the 5-min-style freshness of provider caches does not
    apply — file-based KV is only valid per exact model weights.
3.  **Context distillation as offline packet → LoRA** — SELF-HOST, medium
    effort, biggest knowledge-injection upside. Our packets ARE context;
    Snell et al show a model can be fine-tuned to keep its with-context
    behavior without the context. Recipe: run the resident Qwen with
    packet-in-context on synthetic tasks, fine-tune (mlx_lm.lora, quantized
    models supported) on its own with-context answers, sans packet. That
    deletes the per-request packet token cost entirely for hot resident
    models. Honesty check: W113 found packet value rides file-level pointers
    — distill the pointers' navigation payoff, keep packets for cold models.
4.  **Draft-model spec decoding on mlx-lm** — SELF-HOST, cheap experiment,
    targeted. `--draft-model` + `--num-draft-tokens` exists in the source
    (T1); known rough edges (T2): Qwen3 spec-dec token-drop bug report, no
    batched-request support in one MLX server impl. W115 says the 4B class
    is memory-bandwidth-bound enough that MLX vanilla beat active MTP spec
    decoding — so test only where decode is compute/bandwidth-starved:
    the 30B+ resident class, not the 4B fleet.
5.  **MTP checkpoints watch** — SELF-HOST, watch. The llama.cpp lane already
    serves unsloth MTP GGUFs and catalogs per-model acceleration (DFlash /
    DSpark labels in magnitude's hardware report, T1). MLX has no MTP-head
    support; an EAGLE-3 prototype discussion exists in the mlx-lm repo (T2,
    not merged). Concrete W115 follow-up: re-run the head-to-head when an
    MTP-capable model appears in the resident 30B+ class — the 4B verdict
    does not extrapolate.
6.  **Not actionable here**: activation steering/ITI/RepE/refusal-direction —
    all need white-box forward-pass hooks (insert/modify activations mid-
    forward). MLX exposes activations but there is no serving-level steering
    surface, and our provider models don't offer one. llama.cpp control
    vectors (GGUF-lane steering) are reported to exist but UNVERIFIED this
    session. Soft prompts as knowledge carriers: prompt tuning only matches
    full fine-tuning at billions of parameters — exactly NOT our 4B fleet;
    and CacheBlend-style KV fusion needs the CUDA/vLLM LMCache stack we
    don't run.

Framing to keep: the deepest representation-level lever we actually control
today is the **KV cache at the provider** — steered by text layout, not by
activations. CacheBlend's core insight (non-prefix segments suffer positional
attention drift; a small targeted recompute repairs it) has a harness analog:
keep the stable-prefix discipline even when packet segments vary, so the
prefix continues to hit.

## 4. Could not verify

- DeepSeek-V3 MTP speculative-decoding acceptance rate and TPS speedup
  (arXiv §5.4.3 truncated; secondary claims of 85–90% acceptance and ~1.8x
  TPS circulating, unconfirmed). Our T1: W115 measured 5/5 acceptance on the
  4B class and it still lost to MLX.
- llama.cpp control vectors (`--control-vector*` flags, control-vector-gguf
  generator) — not on the README page fetched; unconfirmed.
- Peer-review venues: Medusa (ICML 2024 claim), context distillation (ICLR
  2023 claim), ActAdd, EAGLE-3, Prompt Cache author-listed venue beyond the
  abstract page ("MLSys 2024" was on-page, T1).
- RepE survey "Taxonomy, Opportunities, and Challenges of Representation
  Engineering for LLMs" — name surfaced via search, no arXiv ID pinned.
- MTPLX "2x, no draft model" and DFlash "4.1x on Qwen3.5-9B" (blogs/Reddit).
- mlx-lm EAGLE-3 prototype discussion status (repo discussion #890, T2).
