# suspenders

Agent control plane: governor.db (SQLite/WAL) work graph, coord bus, fleet
board (:7799), launchd agents, hook gates. Docs: docs/, board API at
http://suspenders.local/llms.txt. Companions: belt (LLM fleet), klh/local
(Caddy .local services), speedy (config layer).

## qlty Quality Doctrine

qlty is THE quality tool; `.qlty/` must exist or the governor's on-write
gate silently no-ops. Three moments: (1) on-write — the post-files gate
(hooks/gates/files.ts — they live in THIS repo) runs qlty-fmt + fast lint
and blocks with the diff inline; (2) pre-merge — `qlty fmt` +
`qlty check --fix` on staged files; (3) on-stop — the evidence gate, not
lint.

**SPEC FIRST: read `.qlty/qlty.toml` and the biome rule set BEFORE the first
write here, then code to the spec.** Never emit flagged patterns and let the
gate catch them — recurring offenders: non-null `!` (noNonNullAssertion),
string `+ "\n"` concat (useTemplate), comma operator, unused vars/imports,
use-before-declaration. biome owns code formatting; prettier owns markdown
only — never enable both on code (they deadlock).

## 1500-Line Hard Limit

Any .ts (or equivalent) that grows past **1500 lines MUST be decomposed**:
split by responsibility, DRY the second duplicate, and run a codescan for
shareable patterns (ast-grep) before adding code near the limit — one
source of truth per pattern, helpers over copy-paste. Applies to every lane
and every klh repo. The on-write gate **blocks** any .ts past 1500 lines
(W157 2026-10-01: law enforced in hooks/gates/files.ts — the W157 backlog is
cleared; fleet-board, coord, board-html and the fleet-board suite all live
under the limit).

## Streams Over Buffers

Streaming interfaces by default — no whole-payload buffering or memory
hangups unless strictly necessary: streams for HTTP/SSE pass-through,
NDJSON/line streams for logs and feeds, bounded rings with backpressure
for async writes (the W143 ledger ring is the pattern). Buffers only for
bounded, size-capped payloads. Fleet law (`law.streams-over-buffers`).
