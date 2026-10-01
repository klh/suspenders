# W181 — Adversarial security review, klh stack (2026-10-02)

Reviewer: lane autow181. Method: six parallel read-only audit lanes (auth plane,
buckle request plane, board/API, .llm dotfile + knowledge settle, installer/swarm,
CR channel + supply chain), each producing line-cited findings; the load-bearing
claims were then re-verified against source by the lane owner before ranking here.
Fixes are registered as work items — nothing was auto-applied.

Surfaces: suspenders (control plane: board, store-server, knowledge, auth,
installer, local-llm), belt (LLM fleet: gateway, router-shim, nas-llm deploy),
buckle (governed proxy: request plane, gov/federation). Standing preconditions
the stack itself asserts: the LAN is in-scope (Bonjour + Caddy `.local` serving),
buckle hub binds loopback by default, single-user macOS host.

Gate re-run after W156/W165 auth-plane changes: `bun test test/auth.test.ts
test/secrets-gate.test.ts test/federation-pull.test.ts` → **35 pass / 0 fail**.

Totals: **1 CRITICAL · 5 HIGH · 16 MEDIUM · 25 LOW**, plus 12 hypotheses checked
clean (mission premises that did not hold — some good news, some wrong premises).

## Ranking — act on these first

| #   | Sev      | Finding                                                                                | Surface              |
| --- | -------- | -------------------------------------------------------------------------------------- | -------------------- |
| F1  | CRITICAL | Board write surface has zero auth → LAN agent-dispatch RCE                             | suspenders board     |
| F2  | HIGH     | knowledge-api binds all interfaces, no auth, mutation routes, full private corpus      | suspenders knowledge |
| F3  | HIGH     | Router :4000 binds 0.0.0.0, no auth, can spend owner's cloud token                     | belt/local-llm       |
| F4  | HIGH     | OIDC-issuer tokens bypass `requiredScope`; mint local `buckle:admin`                   | suspenders auth      |
| F5  | HIGH     | mDNS-discovered endpoints interpolated raw into litellm.yaml (prompt + key exfil sink) | belt                 |
| F6  | HIGH     | Federation policy manifest + CR queue: anonymous AND unsigned, no anti-rollback        | buckle federation    |

## CRITICAL

### F1 — Board writes are unauthenticated; LAN client → agent-dispatch RCE

`hooks/board/helpers.ts:21-46` — the only gate, `writeGuard`, is a CSRF/Host
check, not authentication: the Origin branch compares `origin.host === host`
(any HTTP client can set both), the no-Origin branch accepts `Host: localhost`
or the configured bind — `SUSPENDERS_BIND=0.0.0.0` (`com.suspenders.board.plist:10`)
makes `Host: 0.0.0.0:7799` an accepted host string. `hooks/bin/fleet-board.ts:66-83`
mounts no auth middleware at all; the W149 JWT seam (`verifyJwt`) is wired into
`:7794 /auth/*` only. The surface is advertised: Bonjour (`fleet-board.ts:101-109`)
and `routes-meta.ts:29` (Caddy `.local`).

Chain: `POST /api/orchestrate/register` (`orch.ts:213-236` validates only
`existsSync`) plants a plan item with attacker title; `POST /api/start`
(`routes-actions.ts:288-448`) dispatches headless `claude`/`codex` with the
owner's privileges; `/api/ship` merges to main; `/api/ack` and `/api/message`
act under coordinator identity. DNS-rebind variant (M3) makes even loopback-only
deployments drive-by-exploitable from a webpage.

Fix: mount a bearer gate (`write_board` scope) on all write routes; Host
allowlist in BOTH writeGuard branches; treat a `0.0.0.0` bind as proxy-only.

## HIGH

### F2 — knowledge-api: all-interfaces, zero auth, private corpus + mutations

`hooks/bin/knowledge-api.ts:45-148` — `Bun.serve` gets no `hostname` (Bun
defaults to all interfaces), no auth, no origin check; KeepAlive plist on :7795.
`POST /search` reads the merged corpus including coord facts, and
`knowledge.ts:134-141, 163-169` — the facts_fts and consult_kb_fts queries have
**no domain predicate**, so the the enterprise customer-class private intel is LAN-readable with
one curl. `/enqueue`/`/promote`/`/retire`/`/note` mutate; `/verify` discloses
sourceRef + hash; `/curate` walks any `repo` path given.

Fix: `hostname: "127.0.0.1"`, token/writeGuard-class enforcement, domain
predicate on the aux stores, strip sourceRef/hash from anonymous output.

### F3 — router-shim :4000 on 0.0.0.0, unauthenticated, cloud-token escalation

`hooks/local-llm/router-shim.ts:414-416` — `Bun.serve({ port })` with no
`hostname` pin (verified: zero `hostname` occurrences in the file); handler has
no auth. Any LAN host gets free local-model use; with `prefs.allow_cloud=true`
a COMPLEX-rated prompt escalates to cloud spending the owner's real
`ANTHROPIC_AUTH_TOKEN` (`router-shim.ts:617-622, 314-345`). Both repos' swarm
spawn paths inherit it (suspenders `swarm.ts:116`, belt `bin/swarm.ts:103`).

Fix: `hostname: "127.0.0.1"` on both repos' router-shim; external exposure only
via the authenticated Caddy hop.

### F4 — OIDC-issuer tokens bypass `requiredScope`; mint local buckle:admin

`hooks/lib/auth.ts:724-739` (verified) — the scope gate runs only for
`entry.type === "local"`; an oidc entry whose `roles` mapping is empty passes
`checkRoles` (`auth.ts:674-693`, `entry.roles?.length` optional) regardless of
the caller's `requiredScope`. `hooks/lib/auth-server.ts:71` then accepts such a
token for `/auth/token` minting (`verifyJwt(req, "write_auth")` never enforces
it) → external IdP user mints a local `buckle:admin` pair. Needs only a config
omission (optional `roles`/`audience` left unset).

Fix: require explicit scope/role mapping for oidc entries (hard-fail when
`requiredScope` is set and no mapping exists); make `audience` mandatory.

### F5 — mDNS discovery + raw interpolation into litellm.yaml

`belt/deploy/nas-llm/announce.py` registers `_klh-llm._tcp` with no auth
(mDNS never authenticates); `belt/bin/gateway-config.ts:56-75` interpolates
`remotes.json` fields raw: `api_base: ${ep.base}`, `openai/${ep.model}`,
`http://${m.host}:${ep.port}/v1` — only the alias is sanitized. A spoofed
announcement poisons the discovered "nas-llm" endpoint → belt routes user
prompts to the attacker host; any `ep.base` entry carries
`api_key: os.environ/Z_AI_API_KEY` (line 65) — a non-z.ai base exfiltrates that
credential via LiteLLM's own auth injection. Precondition: the discovery writer
trusting mDNS (the compose file asserts it; remotes.ts not fully verified).

Fix: allowlist `ep.base` (https + known hosts); validate every interpolated
field; operator confirmation for new discoveries; scope the z.ai key to its host.

### F6 — Federation manifest + CR queue: anonymous AND unsigned

`buckle/src/gov/middleware.ts:269-271` passes credential-less GETs straight
through; `federation.ts:183-195` serves `manifest()` incl. the full CR queue
(payloads + actor names) and entitlements — no signature, no TOFU, and
`version` is a recomputable content hash (`federation-manifest.ts:54-59`), so
no anti-rollback. Spokes reconcile the queue through trusted paths, so injected
payloads ride into spoke-trusted surfaces. Mitigating: hub defaults loopback.
Three lanes converged on this; the code's own header defers to W156
signatures — not yet landed. Same class: buckle `/status`+`/metrics` answer
outside the gate (`server.ts:176-177`) with `last_error` strings.

Fix: land W156 (ed25519 manifest signature, pinned hub key, monotonic version
floor); require spoke:READ_ on federation GETs; gate /status+/metrics views.

## MEDIUM

### Auth plane

- **M1 — `write_auth` is an unrestricted mint authority + forever tokens**
  (`auth-server.ts:71-93`, `auth.ts:279-281` — verified): any write_auth holder
  mints any scope incl. `buckle:admin`; omitted `access_ttl_seconds` maps to
  `exp: null` = no-expiry access JWT that survives rotation. Fix: minted scopes
  ⊆ caller's scopes; bounded default TTL.
- **M2 — no theft cascade on rotated-refresh replay** (`auth.ts:392-435`):
  replay of the old refresh returns `refresh_already_used` but revokes nothing —
  attacker with the current refresh keeps a valid credential forever (RFC 6819
  §5.2.2.3 says replay of the rotated token is the canonical theft signal).
  Fix: revoke the `parent_key_id` lineage on replay.
- **M3 — writeGuard DNS-rebind bypass (browser branch)** (`helpers.ts:23-34`):
  when Origin is present, Host is never checked against loopback/BIND — a
  rebound page is same-origin, passes the guard, and reaches every write
  endpoint even on loopback-only binds. Extends F1 to drive-by. Fix: Host
  allowlist in both branches.

- **M4 — store-server `/rpc`: arbitrary SQL, token optional** (`store-server.ts:92-104`):
  unset `GOVERNOR_STORE_TOKEN` (the default) leaves a local SQL console over
  the whole graph incl. `api_keys`/`auth_events`; `req.json()` accepts any
  content-type → browser drive-by can fire it (no-cors simple request).
  Fix: token required (fail closed), content-type json, Host check.
- **M5 — unvalidated discovery/JWKS fetch** (`auth.ts:551-558`, buckle
  `gov/jwt.ts:73-99`): fetch of discovery doc + its `jwks_uri` with no
  https/scheme/pinning and default redirect-following → control of the
  discovery response = full principal forgery for that issuer. Fix: https-only,
  pin jwks to issuer origin, `redirect: "error"`.
- **M6 — secrets world-readable at rest (observed on disk)**: fleet-loop plist
  (contains ANTHROPIC_AUTH_TOKEN env), `belt.env`, `belt-tokens.json`,
  `settings.json` all 0644 while `litellm.yaml`/`remotes.json`/tokens are 0600 —
  the estate is inconsistent, not locked down. Fix: `umask 077` in both
  installers + explicit chmod 600 at creation of every token-bearing artifact.

### Knowledge / .llm / board

- **M7 — read_knowledge domain filter never applies to facts/consult_kb**
  (`knowledge.ts:96-105 vs 134-141, 163-169`): the MCP tool surfaces private
  coord facts into any session's context regardless of the declared domain —
  the W159 domain-separation law is broken on the read side.
  Fix: domain-tag aux stores or exclude them for non-private domains.
- **M8 — hub_eligible is spoofable via self-declared origin_sid**
  (`coord/knowledge.ts:76-83` → `knowledge-ports.ts:537-544`): a lane (or the
  unauthenticated `/enqueue`) tags private text with another session's sid; at
  that session's end the rows are permanently stamped hub-eligible. Today
  nothing ships hub_eligible anywhere (pull-only federation), so this is a
  latent exfil vector that activates with the hub-ward feed. The only content
  gate is `redactSecrets` (credential regexes). Fix: verify enqueuer identity
  from hook context, not CLI flag; classify content before any feed.
- **M9 — .llm apply: repo not re-validated on POST** (`console-repo-law.ts:478-481,
210-241`): GET validates `.git` presence, apply takes `repo` from the form and
  writes `<repo>/.llm` → arbitrary-directory write with comment-borne content;
  the standalone `defaultWriteGuard` lacks the loopback check the board's
  guard has. Dormant until the console routes mount (header says pending).
  Fix: re-check `.git`, constrain repo to `listRepos()`, reuse board writeGuard.

- **M10 — BYO apply: no mtime guard + wipe-on-unparseable** (`console-repo-law.ts:381-394`):
  preview mtime is captured but never compared (unlike the main apply), and a
  `values` blob that fails base64/JSON silently becomes `{}` → `writeUserPlane([])`
  wipes local-models.json. Fix: enforce the guard; refuse unparseable input.
- **M11 — tpm budgets enforce fiction** (`gov/middleware.ts:368-372`,
  `gov/budgets.ts:106-138`): admission charges `ceil(content-length/4)` and
  chunked bodies (no content-length) charge 0; `addUsage` has no request-path
  call site — real token usage is never debited. A tpm-only key sends chunked
  requests and is never throttled. Fix: debit real usage at record() time;
  minimum admission reservation when content-length is absent.
- **M12 — unbounded metrics label cardinality** (`servicemon.ts:359, 85-93,
113-116`): every unique path (incl. 404s) becomes a permanent series —
  unauthenticated memory-exhaustion DoS on the LLM plane; `x-belt-aids` header
  tokens meter as new labels too. Fix: LRU cap per family; collapse unknown
  paths to `:other`; allowlist the aid label.

- **M13 — cross-spoke CR control, no claim binding** (`buckle
gov/federation.ts:202-225`, `middleware.ts:292-297`): any spoke:WRITE_ key can
  transition/fail ANY CR (state machine checks `p !== null` only), post forged
  escalation notes (overwritten, not appended), claim unprobed `applied` states.
  Fix: claim/lease binding (`claimed_by = keyId`), failed restricted to owner
  or admin, append-only notes.
- **M14 — CR verification probe is monotonic** (`federation.ts:96, 119-120`):
  `have >= want` on doc version passes vacuously (policy@1 "verified" while file
  sits at v5); probes registered only for policy@/routing-policy@ so other
  targets can never verify. Fix: content-equality probe; probes for every
  accepted target prefix.
- **M15 — unauthenticated reads: diffs, transcripts, answer_tokens**
  (`routes-drawer.ts:14-127`, `data.ts:555, 229`): /api/diff returns full branch
  patches; /api/tail returns lane transcripts incl. tool inputs; decisions feed
  carries live `answer_token`s — any LAN reader can also answer forks;
  `/api/setup` leaks the governor.db path. Fix: read-scope token or redact tool
  inputs + answer_tokens; scrub db path.

- **M16 — nas-llm deploy: unauthed ollama on 0.0.0.0 + unpinned supply chain**
  (`belt/deploy/nas-llm/docker-compose.yml:8,17,24`): ollama API reachable by
  any LAN host (compute/disk abuse, hostile model pulls); announcer runs
  `pip install zeroconf` unpinned at every start, `:latest` images, host
  networking, root. Fix: VPN-only bind or auth in front; pin digests + a
  hash-pinned requirements.txt; run non-root.

## LOW (compact — all line-cited in the lane reports, summarized here)

- **L1** store token `x-governor-token` compared with `!==` (`store-server.ts:94`)
  and approvals HMAC `sig !== hmac(...)` + substring source binding
  (`approvals.ts:29,33`) — plain compares; `safeEq` exists and is used for the
  JWT HMAC (`auth.ts:644`) but not here. Loopback makes it impractical; fix is
  mechanical.
- **L2** empty/garbage key file becomes the HS256 signing key (`auth.ts:90-93`) —
  empty file = empty HMAC key. Reject non-`/^[0-9a-f]{64}$/`, refuse to start.
- **L3** `/auth/refresh` state oracle + unbounded auth_events growth
  (`auth-server.ts:113-119`): five distinct failure codes let a token holder
  probe lifecycle state; flood grows the DB. Collapse codes, rate-limit, cap
  retention.

- **L4** env-injection forges the trust root (`auth.ts:71-75, 180-181`):
  `BUCKLE_JWT_KEY_FILE`/`BUCKLE_SECRETS_HOME`/`BUCKLE_AUTH_CONFIG` silently
  redirect key + issuer allowlist. Pin in an owner-owned file; env = test seam.
- **L5** federation gate pass-through when unwired (`gov/middleware.ts:267`):
  `/federation/*` reaches the app router unauthenticated if the surface is
  null. 404 at the gate.
- **L6** JWKS caches TTL-only, never refetch on kid miss (`gov/jwt.ts:64-77`,
  `auth.ts:548-550`) — rotation outage window + bounded stale-key acceptance.
  Refetch on unknown kid before rejecting.
- **L7** sed-templated plist generation injectable at install time
  (`install.sh:151-152` suspenders, `belt/install.sh:79`): `&`/`|`/XML
  metachars in BELT_TOKEN/repo path inject argv/XML into launchd jobs.
  Serialize with `plutil` instead of sed; escape/validate every substitution.
- **L8** shell-string + `python -c` spawn paths (`swarm.ts:104-105, 170`,
  belt `bin/swarm.ts:91-92, 157`): registry values interpolate into
  `/bin/sh -c` and python code — arg/model-id injection at revive time.
  Use argv-array spawn; model id as argv.

- **L9** predictable `/tmp` launchd log paths, 9 agents (`com.suspenders.*.plist`)
  — symlink pre-create clobber on multi-user hosts; belt does it right
  (`~/.claude-insights/`). Move StandardOut/ErrorPath under the secrets home.
- **L10** port-identity trust + kill-by-port (`spawner.ts:56-67`, `swarm.ts:37-68`):
  any process on :890x receives prompts; `lsof -ti | xargs kill -9` hits
  established connections (local DoS). Verify served model id; kill listeners
  only (`-sTCP:LISTEN`).
- **L11** unpinned model supply chain: `snapshot_download` with no revision
  (`swarm.ts:159-179`, belt `bin/swarm.ts:146-160`), `com.belt.kev.plist`
  `--run jaredpalmer/kev-4b` resolves latest at runtime. Pin commit SHAs.
- **L12** `_force_dead_port` debug hook = LAN port-scan/partial-read oracle
  (`router-shim.ts:433, 571-578, 302-309, 651-660`) once F3 closes the bind.
  Gate behind a selftest env flag; stop reflecting upstream bodies.
- **L13** `/aids/preseed` repo_root file-walk oracle (`preseed.ts:311-318`) —
  gated off by default (`aids.preseed.default: off`); confine to allowlist.
- **L14** upstream fetch follows redirects, no scheme validation (`wire.ts:28`,
  adapter token hosts); buckle SSE status hardcoded 200 (`handlers.ts:445`);
  SseSniffer unbounded line buffer (`sse.ts:28-34`); ledger ring drops rows on
  flush failure (`ledger.ts:164-178`).

- **L15** internal endpoint disclosure to authed clients: `x-belt-route` header
  (`handlers.ts:106-121`), upstream 4xx bodies verbatim (`handlers.ts:368-389`),
  `scrubText` misses `/Volumes/…` paths (`handlers.ts:142-144`). Gate header on
  principal; extend scrub patterns.
- **L16** malformed JWT → 500 not 401 (`gov/jwt.ts` b64urlJson uncaught); no
  explicit `maxRequestBodySize` anywhere in buckle. Catch parse faults; set cap.
- **L17** YAML key injection via `/console settings/apply` (`console-view.ts:198-217`,
  `board-config.ts:236-252`): unrestricted `ladder.model`/`tiers` strings
  rendered raw into routing-policy.yaml; parse tolerates unknown keys. Whitelist
  `[A-Za-z0-9._-]+`; reject unknown top-level keys.
- **L18** `.llm` discovery/editor follow symlinks out of the repo + no size cap
  (`repo-laws.ts:193-203, 476`): hostile repo symlinks `.llm` → arbitrary file
  read into the GUI and mirrored into the secrets home. `lstatSync` + refuse
  non-regular files; cap read (64 KB).
- **L19** source_ref accepts absolute paths and `..` (`knowledge-ports.ts:834-848`,
  `knowledge.ts:517-574`) — hash/existence oracle outside docs root. Reject
  absolutes + `..` segments at enqueue and asItem.

- **L20** settle read-then-stamp race + mtime delete-race (`settle.ts:74-82`,
  `console-repo-law.ts:227`): concurrent domain record between read and stamp
  mislabels hub_eligible; deleting the dotfile after preview skips the guard.
  Re-read domain inside the stamp transaction; treat missing-at-apply as
  conflict.
- **L21** knowledge-resweep targets the pre-split governor.db by default
  (`knowledge-resweep.ts:254`) — W166 moved knowledge to knowledge.db; the
  `--write` path silently no-ops against the live store. Point the default at
  `openKnowledgeDb()`.
- **L22** CR origin attribution self-asserted (`federation.ts:268-280`) — stamp
  `authenticated_as: keyId` alongside declared origin.
- **L23** federation routes bypass rate limiting (`middleware.ts:229-230,
359-379`) — route writes through the budget seam with a spoke-class limit.
- **L24** `BUCKLE_AUTH=off` unwires the whole gate (`server.ts:164-176`) —
  require explicit flag-file or loopback-only hostname to honor it.
- **L25** no CSP/X-Frame-Options on board HTML (`routes-meta.ts:93-99`); NOTE
  2000-cap holds (enforced at write) with only a trivial ~2540-char composition
  overflow via /api/comment's `full` string (`routes-actions.ts:206`).

## Mission hypotheses — verdicts on the brief's specific premises

- **Board/API injection/traversal**: clean. SQL is parameterized without
  exception (~6,600 lines of surface); spawns are argument arrays; drawer/diff
  ids are regex-gated `^[A-Za-z0-9][A-Za-z0-9._-]*$` — no traversal. XSS
  escape-disciplined throughout. The real board problem is F1 (no auth), not
  injection.
- **W172 LAN gate / safeEq**: the "LAN gate" premise does not exist as such —
  the actual gates are writeGuard (CSRF-shape only, F1/M3) and the store token
  (L1). `safeEq` IS used for the JWT HMAC (`auth.ts:644`, constant-time); the
  gap is that it stops there (L1).
- **x-belt-hint 512-cap smuggling**: no. The cap is a reject-not-truncate
  (`hints.ts:185-189`), duplicate headers refused, hints never enter upstream
  headers/body, cannot force cloud or flashx. Clean.
- **SSE pass-through smuggling**: no desync surface — responses re-framed via
  `new Response` with CL/TE/connection stripped (`handlers.ts:66-75, 424-447`);
  retries only on non-2xx with failed body cancelled. Clean.

- **Budget TOCTOU**: no race exists — check-and-increment is one synchronous
  block (`gov/budgets.ts:106-123`). The real weakness is M11 (the enforced
  number is fiction), not a TOCTOU.
- **W160 private-domain guard claim**: **does not hold as a guard**. The
  implementation is a deep-walk exact-string marker check
  (`data_domain === "private"`, `federation-manifest.ts:102-110`); case/format
  variants and unmarked payloads pass. Prototype pollution doesn't apply
  (own-property walk sees `__proto__` from JSON.parse; no deep-merge anywhere).
  Verdict: labeling convention, not content classification — treat the W160
  claim as retired until a real classifier exists.
- **FTS injection**: clean — `ftsTerms` tokenizes `[^a-z0-9_.-]+`, quotes, ORs
  phrases; no operators/NEAR/column-filters survive. All other SQL parameterized.
- **CR replay/lifecycle**: replay rejected (next-state-only machine, 409 on
  replay; declare idempotent `ON CONFLICT DO NOTHING`; terminal states final).
  The lifecycle gap is cross-spoke control (M13), not replay.
- **uPlot integrity**: vendored files byte-identical to upstream 1.6.32
  (sha256 JS `19c8d4c6ad88…eb78f1f`, CSS `df630c6a8d…35fa04`, double-sourced
  from raw.githubusercontent + jsdelivr). Zero suspicious tokens. Clean.
- **uv deps**: none exist anywhere (mission premise negative). Suspenders
  runtime deps: p-queue + shell-quote, all registry-resolved with sha512;
  buckle: zero runtime deps; belt: no package.json at all (zero-dep posture).
- **.llm dotfile content smuggling / eval**: clean — hand-rolled line grammar,
  nothing eval'd/spawned; HTML esc()'d throughout.

## Fix registration

Fixes are registered as work items on the governor work graph (search "W181"
in `work list`) — none auto-applied. Priority 1: F1 board auth gate; F2
knowledge-api bind+auth; F3 router bind; F4 oidc scope enforcement. Priority 2:
F5/F6 + M1/M3/M4/M6. Priority 3: the low-severity batch.

## Verification notes

Every CRITICAL/HIGH above was re-verified against source by the lane owner
(F1: helpers.ts + fleet-board.ts + orch.ts read personally; F2: knowledge-api.ts

- knowledge.ts read personally; F3: hostname absence grepped personally; F4:
  auth.ts:724-739 + auth-server.ts:71 read personally). MEDIUM findings carry
  their lane's line citations; LOWs are one-line summaries of cited facts.
  Lane reports with full CHECKED-CLEAN lists live in the lane transcripts;
  this file is the consolidated record. Method note: belt/buckle were audited
  via direct file reads (`bat`) — companion repos were read-only from this
  lane's sandbox; no probes were executed against any live service.
