# HTTP citizenship standard — buckle / belt / suspenders (2026-10-01)

Owner directive: the APIs must be GOOD netizens — correct status codes,
rate-limit information in headers, protocol-level best practice. This is a
fleet convention: every HTTP surface in the stack codes to it. Testable, not
aspirational.

## Status codes

| code    | when                                                     | required headers                                                                                 |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 200     | success                                                  | rate-limit trio (below) on authenticated APIs                                                    |
| 201     | created                                                  | `Location` + rate-limit trio                                                                     |
| 204     | success, no body (DELETE, OPTIONS)                       | `Allow` on OPTIONS                                                                               |
| 304     | `If-None-Match` hit                                      | `ETag` echo                                                                                      |
| 400     | malformed request (syntax/shape)                         | —                                                                                                |
| 401     | missing/invalid/expired credentials                      | `WWW-Authenticate: Bearer realm="<srv>", error="invalid_token"`; body carries `refresh_endpoint` |
| 403     | authenticated, not allowed                               | `WWW-Authenticate` with `error="insufficient_scope"` when scope-shaped                           |
| 404     | unknown resource                                         | —                                                                                                |
| 405     | method not allowed on known path                         | `Allow`                                                                                          |
| 409     | state conflict (claim race, mtime guard)                 | —                                                                                                |
| 429     | rate/budget limited                                      | `Retry-After` (seconds, jittered) + `RateLimit-Remaining: 0` + trio                              |
| 503     | must-no-fit / degraded / cooldown exhausted (buckle law) | `Retry-After` when recovery time is known                                                        |
| 502/504 | upstream failed/timeout                                  | —                                                                                                |

500s never leak internals (no paths, no stack, no SQL).

## Error bodies — application/problem+json (RFC 9457)

Every non-stream error: `type`, `title`, `status`, `detail`, `instance`,
plus our extensions: `code` (the stable machine code — `buckle.invalid_key`,
`buckle.key_revoked`, `buckle.auth_missing`, `no_healthy_fit`,
`cloud_forbidden`…), `why`, `refresh_endpoint`, `agent_next_steps`.
Existing stable codes are PRESERVED inside `code` — nothing that reads them
today breaks. Content-Type: `application/problem+json`.

Streaming exception: errors BEFORE the first SSE byte = problem+json with
the real status; errors MID-STREAM = SSE error event (status is already
sent) — both cases documented per endpoint.

## Rate-limit headers — every authenticated API response

Both families, always:

- `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (IETF draft:
  Reset = seconds until window reset), `RateLimit-Policy: <name>;q=<quota>`
- `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`
  (de-facto: Reset = unix epoch of window reset)

429 additionally: `Retry-After` + `RateLimit-Remaining: 0`. Budget names
mirror the govdb shapes: `rpm` / `tpm:<model-group>` windows.

Proxy precedence (buckle): buckle's OWN admission limits win; upstream
providers' limits ride as `x-upstream-ratelimit-*` so clients never confuse
whose budget a 429 was. Pass-through doctrine unchanged otherwise.

## Conditional requests + caching

- `ETag` (strong, content-hash) on GET-able resources: board item JSON,
  `/status` snapshots, usage reports; honor `If-None-Match` → 304.
- `Cache-Control: no-store` on `/auth/*` and anything credentialed.
- `Cache-Control: private, max-age=0, must-revalidate` on per-user data;
  `max-age=<ttl>` only where the servicemon TTL already defines truth.

## Introspection

`OPTIONS` → 204 + `Allow` everywhere; `Allow` on every 405; Prometheus
`/metrics` stays `text/plain; version=0.0.4`; `/status` stays JSON with the
TTL stamp. The LLMS_TXT board contract gains a "protocol conventions"
section pointing here.

## Adoption (work-graph order)

1. buckle middleware (W141 landed — extend to full trio + problem+json).
2. suspenders store-server `/auth/*` + board `/api/*` (+ ETag on
   item/status GETs).
3. belt's own endpoints now; LiteLLM :4100 emits its own headers until the
   W144 cut-over makes buckle's the only path.
   Code lands as the flying lanes converge (same files); a register item
   tracks it — no lane touches another's in-flight surface.
