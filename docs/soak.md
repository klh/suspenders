# Nightly real-provider soak — W179.3

`hooks/bin/soak.ts` + `hooks/lib/soak.ts` extend the W162 sim smoke's
PASS/RED/ERR chain into a scheduled nightly real-provider soak with hard
spend caps. Belt resolves through the shared chain (`hooks/lib/belt-locate.ts`);
each iteration = belt status + one small REAL completion through
`POST /api/route` (the advise.ts call shape), metered and capped.

## Caps (the spend-limit story)

| cap                        | default | enforcement                                                                                                                                               |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOAK_MAX_USD`             | 0.25    | on priced tokens only; unpriced models are counted, not costed (omit-when-unknown). Pin real $/Mtok in `~/.claude/local-llm/soak-pricing.json` to arm it. |
| `SOAK_MAX_TOKENS`          | 40 000  | on observed usage tokens. Also bounded structurally: iters × per-call `max_tokens` holds even if belt reports no usage.                                   |
| `SOAK_ITERS`               | 48      | max route iterations                                                                                                                                      |
| `SOAK_MAX_MINUTES`         | 20      | wall-clock bound                                                                                                                                          |
| `SOAK_GAP_MS`              | 2 000   | sleep between iterations                                                                                                                                  |
| `SOAK_MAX_TOKENS_PER_CALL` | 32      | per-request bound                                                                                                                                         |

A cap hit is a clean exit (the cap working is a PASS-grade outcome — the run
stops, notes `stop=token-cap` etc., exit 0). Exit codes: 0 clean, 2 = REDs,
1 = belt unreachable. Rows stream live; summary line carries calls/tokens/
unpriced/usd.

Pricing honesty: the built-in table only asserts the derivable fact that
local families (local/mlx/ollama/gguf/swarm) are free. Everything else is
unknown → counted, not costed. Cloud pricing goes in the owner-pinned
`soak-pricing.json` (config-over-code; never in a repo).

## Scheduling

`hooks/launchd/com.suspenders.soak.plist` — nightly 03:15, RunAtLoad false,
no KeepAlive, Nice 10, logs `/tmp/soak.log`. DELIVERED NOT INSTALLED (W145):
activate with `SUSPENDERS_PREFIX=~/.claude/hooks/suspenders ./install.sh
--with-launchd`.

Manual probe: `bun hooks/bin/soak.ts --iters 1 --max-tokens 2000`.

## Live findings baked in (2026-10-01)

- `belt.local`'s Caddy vhost strips the Authorization header — every authed
  call 401s with "missing bearer token" while `/api/status` stays 200.
  `resolveBelt()` now verifies the DNS legs with an authed `/api/remotes`
  probe and falls through to `http://127.0.0.1:7791` (verified: real routed
  completions, glm-5.2 via z.ai).
- `belt-tokens.json` keys ARE the bearers (hash keys, {label, created}
  values). `belt.env`'s ANTHROPIC_AUTH_TOKEN is a different credential
  (the :4100 gateway), not a belt bearer.
- belt's `/api/route` does not echo usage — tokens meter as unpriced/unknown
  until belt surfaces usage in that response (noted per row).
