# Magnitude inference engine — benchmark vs our MLX swarm (2026-09-30)

Research note. Tiers: T1 = measured in our own commands this session, T2 = docs/README/changelog, UNVERIFIED = not confirmable.
Benchmarked by fleet lane w115-magbench; companion to `magnitude-benchmark-2026-09-30.md` (the abandoned test agent).

## Summary

The magnitudedev/magnitude engine (0.2.1, llama.cpp+Rust, released today) **does not beat our rapid-mlx MLX stack on the 4B class on this machine**: same-client same-prompt, rapid-mlx :8902 did **175 tok/s decode / 64 ms TTFT** vs magnitude's **161 tok/s / 111 ms**; prefill roughly parity (~760-token cold prompt: 594 ms MLX vs 669 ms magnitude). Magnitude's catalog predicted 105–126 tok/s for its Qwen3.5 4B Q4 — measured 161, so predictions are honest and conservative. Verdict: **watch / steal-ideas, not adopt.**

## 1. Version discrepancy (T1, registry + releases)

- npm `@magnitudedev/cli` **0.0.15** (published 2026-09-16, 654 KB unpacked, `bin: magnitude`, description "Magnitude AI coding agent") is **not the engine** — it is a downloader stub. On first run it fetched the real binary from GitHub releases into `~/.magnitude/releases/`, pinned to its own version tag (`@magnitudedev/cli@0.0.15`, manifest `acnRevision: 39`), and prints a deprecation notice pointing at the desktop download.
- GitHub releases ran ahead of npm: 0.1.0 (09-17) → 0.2.0 (09-30) → **0.2.1 (2026-09-30T15:19Z)**. The npm channel is 14 days / 9 releases stale, but its stub still works (0.0.15 engine binary, 80 MB).
- The 0.2.1 **standalone CLI tarball is not a complete install** — `magnitude serve` fails with "This command is not inside a complete Magnitude installation". The complete install is the desktop bundle (`Magnitude.app`, Electron) or an npm-stub install of 0.0.15.
- What we benchmarked: `magnitude-desktop-darwin-arm64.zip` (188 MB) from the 0.2.1 release, sha256-verified against the digest published in the release API metadata. No installer scripts executed; the bundled `magnitude` CLI (0.2.1) was run directly from the extracted app bundle.

## 2. Profile + recommendations (T1 unless noted)

`magnitude hardware` — detected **Apple M5 Max · ARM64 · 18 cores · 128 GB unified · Metal**, 52.5 GB free at run time. Assessment covered 59 of 59 catalog models.

Sample recommendations (T1, per-machine predictions; T2 for method — the bundled docs state speed labels are "a hardware-aware prediction rather than a benchmark run of the downloaded model", ranges = short- vs long-context spread):

| Preference  | Model                     | Predicted tok/s | Memory  | Acceleration |
| ----------- | ------------------------- | --------------- | ------- | ------------ |
| Balanced #1 | Qwen3.6 35B-A3B (Q8)      | ~66–92          | 43.2 GB | DFlash       |
| Balanced #2 | Gemma 4 26B-A4B (Q4 QAT)  | ~84–115         | 19.2 GB | None         |
| Fastest #1  | Liquid LFM2.5 2.6B (Q8)   | ~138–147        | 6.7 GB  | DSpark       |
| Fastest #4  | Liquid LFM2.5 8B-A1B (Q8) | ~188–200        | 12.4 GB | DSpark       |
| Fastest #7  | Qwen3.5 4B (Q5)           | ~99–117         | 9.6 GB  | None         |

Prediction accuracy on the model we benchmarked: catalog said **~105–126 tok/s** for `qwen3.5-4b:gguf:q4` (9.3 GB runtime estimate); measured **161 tok/s** — underpromised by ~30–50%. Honest, conservative, and per-machine. "Memory" is runtime footprint (download was 3.67 GB); observed inference RSS was 4.3 GB (not directly comparable to the runtime estimate).

## 3. Head-to-head: magnitude 0.2.1 vs rapid-mlx (T1)

Same client (bun fetch + SSE parse), identical prompts, 3 runs each, medians. Magnitude on :10100 serving `qwen3.5-4b:gguf:q4` (thinking disabled via `chat_template_kwargs.enable_thinking=false`); rapid-mlx on :8902 serving Qwen3-4B-class (read-only probes, nothing restarted or reconfigured).

| Probe                         | Magnitude 0.2.1 (llama.cpp+Rust)                                   | rapid-mlx (MLX)                | Winner       |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------ | ------------ |
| TTFT, ~200-token prompt       | **110.7 ms** (runs 111/109/119)                                    | **63.8 ms** (63/74/64)         | MLX          |
| Decode, 256 out, non-thinking | **161 tok/s** (srv) / 156 (client)                                 | **175 tok/s** (usage-verified) | MLX          |
| Prefill, ~760-token cold      | **669 ms** (1,133 tok/s client; srv prompt_per_second 1,473–1,522) | **594 ms** (1,270 tok/s)       | MLX (slight) |

- Same-class but not identical weights: magnitude catalogs Qwen3.5 4B GGUF Q4; our :8902 runs Qwen3-4B-Instruct-2507 4bit (MLX 4-bit). Model-class match, generation differs — noted, unavoidable without an MLX/GGUF dual-format model.
- Magnitude ran **MTP speculative decoding** (observed draft 5 proposed / 5 accepted) via the unsloth MTP GGUF; MLX beat it anyway.
- Magnitude's OpenAI surface reports a rich per-request `timings` object (`prompt_per_second`, `predicted_per_second`, `time_to_first_token_ms`) — nice observability our stack lacks.
- Today's 0.2.1 changelog fixes a local-model concurrency hang "as with Qwen3.6 35B-A3B" — directly relevant to a belt backend; we did not stress concurrency ourselves.

## 4. Both API surfaces verified (T1)

- OpenAI-compatible: `http://127.0.0.1:10100/inference/v1` (`/models`, `/chat/completions`, streaming + usage).
- Anthropic-compatible: `http://127.0.0.1:10100/inference/anthropic/v1/messages` — thinking blocks with `signature: "magnitude-local-v1"`, Anthropic usage shape.
- Thinking control: `reasoning: {enabled: false}` does NOT work; `chat_template_kwargs: {enable_thinking: false}` does.
- Port :10100 confirmed in official docs and by listener (the research note's UNVERIFIED :10100 is now T1).

## 5. Tune (T1)

No `tune`/`optimize` subcommand exists in 0.2.1. Tuning is the automatic **"Optimizing"** phase after `catalog pull` (~2 min for the 4B after a 109 s / 3.67 GB download at ~34 MB/s; cache in HF-hub layout under `~/.magnitude/models/hub`). Our bench numbers are post-tune; no before/after was possible without deleting tuned artifacts.

## 6. Verdict

**(b) watch + steal ideas — do not adopt as a belt backend today.**

- rapid-mlx/MLX wins every probe in the 4B class on this machine (decode +9%, TTFT 1.7x, prefill slight).
- Steal list:
  1. **Per-request server timings object** in completion responses (prefill/decode/TTFT) — cheap observability for belt routing decisions; rapid-mlx exposes none.
  2. **Speculative decoding as a catalog dimension** ("Acceleration: None/MTP/DFlash/DSpark", per-machine prepared draft artifacts). Concrete experiment for our stack: try unsloth MTP GGUF-style spec-decode checkpoints in the MLX lane for the 4B/35B-A3B models.
  3. **Per-machine catalog predictions** (59 models auto-assessed, honest conservative ranges) — a smarter version of our llm-routing doc's hand-measured table.
  4. **Anthropic-compatible localhost surface** — lets Claude Code speak to a local model with no proxy; useful if a belt lane ever wants /v1/messages.
- The engine moves fast (0.1.0 → 0.2.1 in 13 days, concurrency fix landed today); re-check in a quarter.

## Sources

npm registry metadata (`@magnitudedev/cli`), GitHub releases/tags API for magnitudedev/magnitude (0.2.1 release, digests, changelog body), magnitude repo README, docs.magnitude.dev (api/overview, reference, llms.txt), bundled CLI docs (`recommendations`, `speculative-methods`), and this session's CLI/API output on the machine under test.

## Could not verify

1. Whether the npm-stub 0.0.15 engine would measure differently (we benchmarked current 0.2.1; 0.0.15 lacks today's concurrency fix).
2. RSS vs the 9.3 GB "runtime memory" estimate (Metal reserved vs RSS not comparable from outside).
3. Concurrency behavior under parallel load (0.2.1 changelog claims a fix; not stress-tested).
4. Long-context (>2 KB prompt) behavior; the 66 tok/s "prefill" seen in one streaming parse was an artifact of chunk-level timings parsing, superseded by the non-stream measurements above.
5. The README's "up to 2x faster than llama.cpp" claim (their claim is vs llama.cpp, not MLX; we did not run plain llama.cpp).
