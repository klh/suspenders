# machines — the cross-machine work dispatch + capability registry (W176)

Suspenders dispatches lanes locally only — at fleet scale you want to say
"run this on the beefy box" and have results return on their own. This is
the work graph's answer, mirroring belt's LLM registry (hooks/lib/remotes.ts)
at machine granularity.

## The registry

One row per fleet machine in governor.db (`machines` table):

    name TEXT PK · host · roles (csv) · cpu_cores · ram_gb · gpu ·
    store_url · state ('active'|'retired') · last_hb (ms) ·
    origin_sid · created_at · updated_at

`roles` share the CAPABILITIES vocabulary work items already declare
(`work add --requires shell,git`) — the routing contract is the SAME
set-inclusion check `work take` enforces on session capabilities, now at
machine granularity: roles ⊇ item.requires.

## CLI

    coord machine register <name> [--host h] [--roles a,b] [--cpu n] [--ram n] [--gpu s] [--store-url u] [--as sid]
    coord machine list [--json]
    coord machine heartbeat <name>
    coord machine remove <name>        # soft retire — history stays in deltas
    coord machine route [--item Wn] [--need a,b] [--json]

`route` picks active + heartbeat-fresh machines whose roles cover the need,
ranked by the "beefy score" cpu×ram (ties: fresher heartbeat). No capable
machine → exit 2 with the honest reason.

## Cross-machine dispatch

    bun fleet-loop.ts dispatch --repo <dir> --item Wn --machine <name|auto>

`--machine <name>` pins the item to a registered machine (refuses retired
or heartbeat-stale); `--machine auto` routes by roles ⊇ item.requires,
beefiest first. The resolved machine replaces `hostname()` in the origin
stamp — `work_items.origin` = `<machine>:<agent>`, shown on board cards.
Without the flag, dispatch is byte-identical to before (local hostname).

## The delta up-feed

`machines` ∈ govdb `deltaTables` (W33 row-image log): every register/
heartbeat/retire write is a delta row. A remote machine's registry writes
ride the W92 store port (GOVERNOR_STORE_URL) into the hub's governor.db,
and any machine tails results with a cursor:

    coord diff --table machines --since <seq> [--json]

No new server, no poll scripts — the feed is the store port plus the delta
log that already exists. Results of remote work return the same way: the
remote lane's `work take/done` writes land centrally, and the deltas log
carries them.

## Liveness

Heartbeat freshness window is 15 min (MACHINE_HB_STALE_MS, matching the
/tmp agent-progress TTL convention). A machine silent past the window is
excluded from routing until its next heartbeat. Retirement is soft — the
row stays for audit; the delta log carries the state flip.

## Tests

    bun test test/machines.test.ts

Covers register/list round-trip + upsert, heartbeat + stale exclusion,
beefiest-first routing, route --item through work_items.requires, the
delta up-feed (insert/update rows + coord diff), and fleet-loop dispatch
--machine (refusals + origin stamping through a real work take).
