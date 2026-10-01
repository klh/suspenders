# W162 sim — full-system federation harness

Hub trio (buckle + central suspenders + central belt) in Docker Desktop on
this machine; the spoke is the **real host stack**. This is the system-level
acceptance harness for the federation stack: W154 (policy pull/echo), W156
(identity.db/JWKS), W160 (CR channel). Federation features may start RED —
the smoke must fail honestly ("awaiting W154…"), never crash.

## Run

    cd sim
    docker compose up -d        # hub trio on 127.0.0.1:1700x
    bun smoke.ts                # line-per-check PASS/RED/ERR
    docker compose down         # stop (add -v to wipe hub state)

## Port map (all host loopback)

| port  | service    | container net                              | what it is                             |
| ----- | ---------- | ------------------------------------------ | -------------------------------------- |
| 17001 | buckle-hub | `network_mode: host`                       | buckle shadow router (W141 gate on)    |
| 17002 | board-hub  | `network_mode: host`                       | fleet board over the HUB's governor.db |
| 17003 | store-hub  | `network_mode: suspenders-hub-sim_default` | hub governor store + W149 `/auth/*`    |
| 17004 | belt-hub   | bridge + loopback publish                  | central belt dashboard                 |

`network_mode: host` is load-bearing: buckle/store/board bind 127.0.0.1
in-code, so host networking PRESERVES the loopback-only bind instead of
defeating it; belt hard-binds 0.0.0.0 and the bridge + loopback publish keeps
it off the LAN.

## State + laws

- `buckle-state` (buckle.db), `hub-state` (hub governor.db + the W149 HS256
  key home), `hub-secrets` (`BUCKLE_SECRETS_HOME` — the signing key
  auto-generates at first boot INSIDE the volume and never leaves the hub,
  owner law), `belt-state`.
- `docker compose down -v` destroys hub state: hub-plane data (identity.db,
  keys) lives and dies with the hub volumes. That is the law, not a bug.
- Repos bind-mount READ-ONLY (`SIM_*_REPO` overrides in `.env`); containers
  write only into volumes. No registry pushes.
- W157 is in-flight in this repo (fleet-board/coord/gates). board-hub runs
  those files read-only; if W157 churn bounces the container,
  `docker compose restart board-hub` after their landing.

## Smoke (sim/smoke.ts, run by bun on the host = the spoke)

Line per check; exit 0 all-green / 2 = honest REDs / 1 = harness error
(hub down). Groups:

- `hub/*` — four services answer `/status` (`/api/status` for belt)
- `token/*` — store-hub `POST /auth/token` is admin-gated (W149): issuance
  needs a `write_auth` bearer, bootstrapped hub-side via `docker exec
sim-store-hub bun /src/suspenders/hooks/bin/auth.ts issue --actor w162-sim
--class app-role --scopes read:*`; until the sim bootstraps one, this
  check is **RED (awaiting W156 identity plane)**. JWKS
  `.well-known/jwks.json` on buckle+store = **awaiting W156**
- `spoke/profile` — spoke-profile.env parses, 4 `SIM_HUB_*` vars present
- `federation/policy-manifest` — **awaiting W154**
- `federation/cr-queue` — **awaiting W160** (rides the W154 payload)
- `federation/echo-menu` — **awaiting W154** (hub entitlement payload the
  spoke belt mirrors; spoke menu = hub menu + spoke-private entries)
- `citizenship/*` — 405+Allow, OPTIONS 204+Allow, 401+WWW-Authenticate,
  ETag/304, no-store on `/auth/*`, RateLimit trio (http-citizenship.md);
  missing = RED, **awaiting W155**

## Green-flip contracts

| Smoke check                  | Lane      | Must land to flip green                                                                                                                        |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `federation/jwks-*`          | W156      | RS256 keys generated at first boot INSIDE hub-secrets; `GET /.well-known/jwks.json` → 200 `{keys[]}` with `kid` + `use=sig`, served by the hub |
| `federation/policy-manifest` | W154      | `GET /federation/policy-manifest` on buckle-hub → 200 `{version, rules[], cr_queue[]}`                                                         |
| `federation/cr-queue`        | W160      | `cr_queue[]` entries with `id, action, target, declared_at`; lifecycle declared→delivered→applied→verified→reported-up                         |
| `federation/echo-menu`       | W154 echo | `GET /federation/entitlements` → `{models[]}`; spoke belt mirrors hub menu + spoke-private entries; local models never in the hub menu         |
| `citizenship/*`              | W155      | trio + problem+json + ETag/304 + no-store per docs/design/http-citizenship.md                                                                  |

`token/issue` flips only with W156's identity plane (hub-issued tokens,
bootstrap story). The check proves the admin-gated W149 surface EXISTS on
the hub store and that key material stays hub-side in `hub-secrets`.
