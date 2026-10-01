# W179 decomposition plan — usage export, notification fan-out, nightly soak

Date: 2026-10-02 · Author: lane autow180 (plan item [W180](http://suspenders.local/?task=W180)) · Parent: W179 (⊞ shattered)

Three genuinely independent scopes, one child each. Every child owns an
exclusive file region — no two lanes write the same file. This document is
the regions/contracts/integration-order registration the split was plan-gated
on; the one-line titles on the graph items are not the plan.

## State at planning time

| Child  | Scope                                       | Branch              | State                                                                 |
| ------ | ------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| W179.1 | per-actor/license CSV export (usage routes) | `suspenders/W179`   | landed d07aa66, awaiting merge                                        |
| W179.2 | notification fan-out (coord/monitor)        | `suspenders/W179.2` | claimed, zero commits, no capsule — restarts blind                    |
| W179.3 | nightly real-upstream soak (sim + launchd)  | `suspenders/W179.3` | in flight, uncommitted in its worktree (capsule 2026-10-02 03:34 UTC) |

## Exclusive file regions

| Region               | Owner  | Files                                                                                                                                                                    |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| usage export         | W179.1 | `hooks/lib/usage-export.ts`, `hooks/lib/usage.ts`, `hooks/board/routes-usage.ts`, `hooks/bin/usage-page-html.ts`, `test/usage-export.test.ts`                            |
| notification fan-out | W179.2 | `hooks/lib/notify.ts` (new), `hooks/bin/monitor.ts`, `test/notify.test.ts` (new), optional `hooks/launchd/com.suspenders.notify-test.plist`                              |
| nightly soak         | W179.3 | `hooks/lib/soak.ts` (new), `hooks/bin/soak.ts` (new), `sim/smoke.ts`, `sim/lib` http helpers, `hooks/launchd/com.suspenders.soak.plist` (new), `test/soak.test.ts` (new) |

The regions are disjoint by construction: W179.2 owns the only shared-adjacent
file (`monitor.ts`); W179.3 must not touch it — its soak is a standalone CLI
on its own launchd timer, not a monitor check.

## W179.1 — usage/billing CSV export (contract as landed)

`d07aa66` on `suspenders/W179`, cut from `08553a3`:

- `buildUsageCsv` in `hooks/lib/usage-export.ts` — one row per actor-seat,
  joining `usage_rollup` + `sessions.tags` + `api_keys` + `budget_state`
  (newest window wins per key), RFC 4180 escaping, honest degradation when
  v8 tables are absent.
- Board route `GET /api/usage/export.csv` in `hooks/board/routes-usage.ts`
  with `days`/`team`/`dept` filters; export link on the usage page carries
  the active filter state.
- `actorTagsMap`/`actorAllowlist` extracted into `hooks/lib/usage.ts` — one
  attribution source.

Remaining: nothing code-side; merge proceeds via the normal landing chain
(`work done --sha` → `work.landed` at merge). No other child may edit the
usage region, so the merge is conflict-free by fiat.

## W179.2 — notification fan-out

The fleet is board-poll-only today. Detection already lives in
`hooks/bin/monitor.ts` (runs every 900 s via
`com.suspenders.fleet-monitor.plist --fix`); delivery does not exist.

Event sources, all already emitted somewhere in the plane:

- `NEED_DECISION` — decision rows held by `coord emit NEED_DECISION`
  (see `docs/decisions-api.md`); visible to monitor as unresolved rows.
- budget exhaustion — `budget_state`, the same table W179.1's CSV joins.
- hub-down — `/status` probe failures (buckle/board/store/belt; the sim
  probes in `sim/smoke.ts` show the status-poll contract).
- lane-death — monitor's existing dead/zombie detection (transcript-mtime
  liveness, per `lesson.zombie-session-hygiene`).

Design contract:

- Delivery in a new `hooks/lib/notify.ts`; `monitor.ts` keeps detection and
  calls it. Channels: email (SMTP `smtp.gmail.com:587`, credentials only from
  `~/.gmail.env`), desktop (`osascript`), Slack (incoming webhook URL).
- Secrets live in runtime config, never in the repo; an unconfigured channel
  is skipped and counted, not an error.
- Coalescing is the load-bearing decision: a 900 s monitor must not re-notify
  per tick. Notify once per condition until it clears (sticky suppression
  keyed on condition id), with a re-notify escalation interval for conditions
  that stay unresolved.
- The monitor itself stays the scheduler — no separate daemon, no new plist
  in the base case.

## W179.3 — nightly real-upstream soak

Per the lane's capsule (the authoritative resume context; ratified here as
the exclusive region): `hooks/lib/soak.ts` (~360 lines) + `hooks/bin/soak.ts`
CLI + `com.suspenders.soak.plist` at 03:15 nightly; `sim/smoke.ts` refactored
onto shared http helpers; scaffolding removed. Real upstream is the belt
router (`/api/route`, bearer from `belt-tokens.json` — same contract as
`advise.ts`); the sim compose URLs (`SIM_BELT_URL` et al., `sim/spoke-profile.env`)
remain the mock tier. Cost caps are part of the soak config: a spend limit and
an iteration cap bound every nightly run, and a run that hits either reports
honestly instead of silently stopping. Remaining per capsule:
`test/soak.test.ts`, gates, one real 1-iteration run against belt, commit,
done.

## Integration order

1. W179.1 merges first — region untouched by the others, zero conflict risk.
2. W179.2 and W179.3 land in either order; their regions are disjoint.
3. After both land, the board's usage page may link soak spend from the CSV
   data — a follow-up item, deliberately not in any child's scope.

Every child runs `qlty fmt` + `qlty check` on its changed files and `bun test`
on its own test files before done; any HTML touch obeys the UI law
(no `innerHTML`, Lit + tokens). No child may grow a file past the 1500-line
law — `monitor.ts` (676) and `soak.ts` (~360) both have ample headroom.
