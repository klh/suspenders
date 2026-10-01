# :4100 gateway repair — auth failures 500 instead of 401 (W169, 2026-10-01)

Incident record + staged fix. Diagnosed read-only 2026-10-01 ~21:00–21:30 while
the W144 baseline bench was still transiting; nothing was applied.

## The chain

launchd `com.belt.gateway` (plist in `~/Library/LaunchAgents/`, belt repo
`bin/gateway.ts`) reads `Z_AI_API_KEY` from `~/.claude.json` plus the master
key from `~/.claude/local-llm/litellm.key`, then spawns:

    ~/.local/bin/litellm --config ~/.claude/local-llm/litellm.yaml --port 4100

Log: `~/.claude/local-llm/litellm-gateway.log` (both stdout+stderr). Config is
generated (`do not edit by hand`), DB-less: `master_key: os.environ/LITELLM_KEY`,
no `database_url`. The uv tool env is a **bare** LiteLLM 1.103.0 on python 3.13
(`~/.local/share/uv/tools/litellm/`) — no proxy extras.

## Incident

Every request that fails virtual-key auth (no/wrong key) returns **500
Internal Server Error** instead of a clean 401. Root cause, straight from the
traceback (131 occurrences in the log):

    litellm/proxy/auth/user_api_key_auth.py  _handle_authentication_error
    → auth_exception_handler.py:73  _as_proxy_exception
    → proxy/db/exception_handler.py:119  is_database_infrastructure_error
    → import prisma → ModuleNotFoundError: No module named 'prisma'

The auth-error classifier imports prisma unguarded to check whether the
failure is really a DB outage; the bare install has no prisma, so the
classifier itself crashes and the ModuleNotFoundError surfaces as a 500.
Auth-passing traffic is unaffected — lane traffic held a continuous 200 line
through the whole incident; the gateway was healthy for anyone holding
`litellm.key`.

Impact: keyless probes (`GET /health` with no key → 500) and any client
without the master key get 500s on every route. W144's litellm baseline row
was captured empty this way (`/tmp/w144-shadow-dir/2026-10-01.jsonl`, last
row: `litellm-nonstream n:0 available:false "50 unreachable/empty of 50"`).

## Staged fix — no restart required

    uv tool inject litellm prisma

Adds prisma to the existing tool env. The failing `import prisma` is lazy
(per-request, in the error path only), so the running proxy picks the module
up without a restart — no lane stream is dropped. In this deployment prisma
is only ever used for isinstance checks in the error classifier (no
`database_url`, no client instantiation, no engine download at import).
Auth errors then classify correctly and surface as 401 invalid-key.

Fallback if inject's dependency resolution wants to move existing pins
(haven't seen it — dry-run was permission-gated in the dispatch sandbox):

    uv tool install --force --python 3.13 'litellm[proxy]==1.103.0'

That rebuilds the whole env and **does** require a restart, which drops
in-flight streams — apply it at a quiet moment only (no lanes transiting;
coordinator confirms between fan-outs):

    launchctl kickstart -k "gui/$(id -u)/com.belt.gateway"

## Verify

Key stays out of argv/stdout — read it into the header:

    xh GET http://127.0.0.1:4100/health authorization:"Bearer $(cat ~/.claude/local-llm/litellm.key)"   # → 200
    xh GET http://127.0.0.1:4100/health                                                                  # → 401 (was 500)

Then a keyed `POST /v1/chat/completions` against any `local-*` model, and
re-run the W144-style litellm baseline row that captured empty.

## Doctrine

LiteLLM stays installed — it is the W144 fallback gateway regardless of the
buckle native-router cut (docs/design/belt-native-router-2026-10-01.md). The
fix adds one dependency to its env; config, models, and routing policy are
untouched.
