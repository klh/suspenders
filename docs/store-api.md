# store-api — the colocation-free control plane (W92)

One seam over governor.db: consumers talk to a **port**
(`hooks/lib/store-ports.ts`), never the DB file. Local = special case of
distributed (owner directive, 2026-09-30): the embedded SQLite adapter
answers when no store server runs; the HTTP adapter answers when
`resolveStore()` finds one. Parity is by construction — both transports
call the same `SqliteControlPlaneStore` — and the parity test
(`test/store-ports.test.ts`) proves the wire shape.

## Server

    bun hooks/bin/store-api.ts [--port 7796]

LaunchAgent `com.suspenders.store-api` (installed by `install.sh` like the
other plists). Loopback bind by default (`SUSPENDERS_BIND` to widen);
optional bearer auth — `SUSPENDERS_STORE_TOKEN` env or the first key in
`~/.claude/local-llm/store-tokens.json` — enforced on every route except
`/health`.

## Resolution chain (W91 #9a shape)

    SUSPENDERS_STORE_URL (env)
      → ~/.claude/local-llm/store.json {url, token?} (operator config)
      → http://127.0.0.1:7796 (same-box default; ~1ms when down)
      → store.local:7796 / store.local (.local race, 600ms budget)
      → null ⇒ embedded SQLite (makeStore falls back automatically)

Hooks resolve on every invocation, so a down server must cost ~ms: the
loopback probe is connect-refused-instant and the two `.local` candidates
race in parallel.

## Port surface (grows with need)

Events / facts / claims / sessions / work-reads / knowledge — one method
per consumer op. `collectInbox` consumes (advances the cursor,
`coord inbox --ack` semantics); `inboxCount` does not.

## Ownership rule (enforced by the files gate)

`openGovernorDb` is store-owner-only. Owners: `lib/govdb.ts` (schema),
`lib/store-ports.ts` (embedded adapter), `bin/store-api.ts` (HTTP face),
`lib/knowledge-ports.ts` (W91 knowledge owner). Consumers that still open
the DB today are grandfathered (soft note on write); any NEW direct import
in a `hooks/` module hard-blocks. Migrating a subsystem = move its SQL
behind a port method and drop the direct import; the gate rule then keeps
it migrated.

## Migrated so far

session-start, session-end, advise (reference migrations); knowledge
routes proxied through the W91 store port. Remaining subsystems
(coord/work CLI, fleet-board, monitor/harvest/claim/worktree/fleet-loop,
gates) are child items of W92 — each grows the port with its ops.

## Tests

    bun test test/store-ports.test.ts

Spins the real server as a subprocess against a temp governor.db and runs
the SAME op sequence through both transports — embedded == HTTP parity is
the property the whole item rests on.
