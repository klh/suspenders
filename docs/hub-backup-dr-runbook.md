# Hub backup/DR + key-rotation runbook (W178)

Status: **rehearsed 2026-10-01 — `bun sim/dr-rehearsal.ts`, 19 pass / 0 red.**
Losing the hub's identity state must never mean re-enrolling the fleet by
hand. Everything below is backed up automatically, restorable by copy, and
drilled by a script.

## What identity state exists

| State                                              | Home                                              | Backed up                             |
| -------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| api_keys + auth_events (the identity tables)       | `~/.cache/claude-governor/governor.db`            | yes — governor snapshots              |
| Signing key (HS256, the current material)          | `~/.claude/local-llm/buckle-jwt.key` (0600)       | yes — `identity-<stamp>/`             |
| Rotation ring (retired keys + grace windows)       | `~/.claude/local-llm/buckle-jwt-ring.json` (0600) | yes — `identity-<stamp>/`             |
| Issued token files (`buckle-*.token` / `.refresh`) | `~/.claude/local-llm/` (0600)                     | yes — `identity-<stamp>/`             |
| Auth config (issuer allowlist, BUCKLE_AUTH_CONFIG) | wherever the env points                           | no — re-create from config management |

Note: W156 (identity.db + RS256/JWKS hub keys) has **not** landed yet —
identity rows live in governor.db and the local issuer is HS256. The ring +
grace-window model here maps 1:1 onto JWKS when W156 arrives (kids + overlap
windows are the same semantics).

## Loss scenarios and blast radius

- **Secrets home lost** (key + ring + token files): every local-issuer access
  token 401s `bad_signature`. Refresh tokens survive only if the api_keys rows
  survive (governor.db). Restore = copy the latest `identity-<stamp>/` back;
  no re-enrollment.
- **governor.db lost**: work graph, sessions, api_keys, auth_events all gone.
  Restore the newest snapshot; identity rows ride inside it. A pre-loss access
  token verifies again immediately after restore (signature + api_keys row).
- **Both lost**: restore both from the same-stamp snapshot + identity dir.
  That exact sequence is the drill in `sim/dr-rehearsal.ts` ([3]→[4]).

## Backup

`hooks/bin/db-backup.ts` (launchd `com.suspenders.db-backup`, daily 10:00 +
RunAtLoad; log `/tmp/governor-backup.log`):

- governor.db via `VACUUM INTO` (consistent incl. WAL) → integrity check +
  row-count sanity line, red exit code on integrity failure.
- knowledge.db checkpoint + copy (W166).
- W178: the secrets-home identity material — `buckle-jwt.key`,
  `buckle-jwt-ring.json`, `buckle-*.token`, `buckle-*.refresh` — copied 0600
  into `identity-<stamp>/` (dir 0700). Two generations kept: restoring
  yesterday's key beats re-minting fleet trust after a same-day loss.

Backup dest: `~/Library/Application Support/governor-backups` (override
`--dest`). It holds signing material — keep the volume FileVault-encrypted;
never commit or sync it anywhere shared.

## Restore procedure

1. Stop hub writers (store-server/launchd agents) or accept WAL churn.
2. `mkdir -p ~/.claude/local-llm && chmod 700` it; copy the chosen
   `identity-<stamp>/*` into it, files 0600.
3. Copy the chosen `governor-<stamp>.db` over
   `~/.cache/claude-governor/governor.db` (fresh `-wal`/`-shm` are created on
   open; delete stale ones if present).
4. Restart the hub agents.
5. **Verify** (the drill's checks): open the db — `api_keys` row count > 0;
   call a token-holding client (or `auth.ts whoami`) — signature + denylist
   both read the restored state, so a pre-loss token must verify.

## Key rotation

Rotate = new key minted, old key retired at `now + grace`. The ring keeps the
old key verifying through the window; refresh tokens are opaque (not signed),
so clients self-heal via `/auth/refresh` even after the window closes.

```sh
bun hooks/bin/auth.ts rotate-key --grace-hours 24   # normal: zero downtime
bun hooks/bin/auth.ts rotate-key --grace-hours 0    # emergency: old tokens die now
bun hooks/bin/auth.ts keyring                       # CURRENT / grace / dead states
```

- Normal cadence: rotate monthly (or on suspicion) with the default 24 h
  grace. In-flight access tokens stay valid until `retire_at`, then clients
  take one 401 `bad_signature` and refresh under the new key.
- Emergency (suspected key compromise): `--grace-hours 0` — every token signed
  by the old key fails signature immediately. The refresh flow is unaffected
  (opaque tokens + api_keys hash rows), so the fleet re-auths without
  re-enrollment. Follow with `auth.ts revoke --actor <suspect>` if revocation
  is also needed.

## Rehearsal

`bun sim/dr-rehearsal.ts` — a live drill on throwaway state: seeds a sandbox
identity, runs the REAL db-backup, destroys the secrets home AND governor.db,
restores from the snapshot, then drills both rotations. 19 checks, exit
non-zero on any red. Re-run after any change to db-backup, the ring, or the
auth libs.

Last rehearsal log (2026-10-01, exit 0):

```text
[2] db-backup … integrity ok … identity-<stamp> (3 identity file(s), 0600)
[3] destroy — secrets home AND governor.db, gone
[4] restore … restored db holds identity rows (2)
    ✓ pre-loss access token verifies against RESTORED key + db
[5] grace rotation … verifies DURING grace … after retire_at: 401 bad_signature
[6] grace 0 … old token dead immediately … opaque refresh survives, self-heals
summary: 19 pass, 0 red — exit 0
```
