# review-gate — the fresh-context reviewer pass before merge (W247)

Every suspenders branch merges THROUGH the review gate. The lane's own
session knows its own briefs, capsules, and chat — a reviewer drawn from that
same context would recognize its own work and rubber-stamp it. So the gate
reviews from a context that has never seen the worker's framing.

## The inputs (and only these)

| Input     | Source                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| objective | `work show <item>` — the Work Graph record itself                                                             |
| diff      | `git diff <main>...<branch>` (merge-base), stat + patch, capped at 60k chars with an honest truncation marker |
| tests     | gate-run `bun test` on the test files the branch touches, executed in the branch's own registered worktree    |

Not included, by construction: lane briefs (`.fleet/brief-*.md`), capsules,
coord bus messages, lane logs. The prompt builder is a pure function of the
three inputs — it reads no files — so worker framing cannot reach the
reviewer even by accident.

## The reviewer

A stateless belt `/api/route` call (`role: "reasoning"`, the advise.ts
pattern): belt picks the best healthy target fleet-wide. The reviewer has no
filesystem access, so there is nothing to leak into its context. Reply must
end with a machine-parsable final line:

```
VERDICT: APPROVE
VERDICT: REQUEST_CHANGES — <one-line reason>
```

The last verdict line wins; no verdict line = unparsable → one retry, then
fail closed.

## Ladder contract (fleet-loop: exit 0 = merged)

| Outcome                               | Gate behavior                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `VERDICT: APPROVE`                    | the gate runs `git merge --no-ff` itself → exit 0                                                                          |
| `REQUEST_CHANGES`                     | exit 1 → fleet-loop FAIL: strike counter, 3-strike park                                                                    |
| unparsable after retry                | exit 1, stored verbatim as `UNPARSABLE` evidence                                                                           |
| belt unreachable                      | `REVIEW-SKIPPED` passthrough merge — never wedge merges on LLM-infra weather; lane-side gates (qlty, tests) stay the floor |
| graph unreachable (`work show` fails) | same passthrough                                                                                                           |
| `.fleet/review-paused`                | owner kill switch: plain passthrough merge                                                                                 |

## Wiring

- **watch daemon**: `hooks/launchd/com.suspenders.fleet-loop.plist` — the
  `--ladder` is now the gate (`__BUN__ __PREFIX__/bin/review-gate.ts --repo __REPO__ --branch {branch}`),
  `--ladder-timeout 15` (review + scoped tests must fit).
- **board ship trigger**: needs the same template in `.fleet/ship.json`
  (gitignored runtime config): `{"ladder": "<same command with {branch}>"}`.
- The ladder REPLACES the plain merge, so the gate runs the merge itself.

## Evidence

Every reply is stored verbatim under `.fleet/reviews/<item>-<epoch>.md` with
verdict, model, host, latency. Every call lands an `llm.call` event on the
bus (source `review-gate`) for board telemetry. Fail-closed output puts the
verdict reason in the loop's FAIL tail (last 3 lines).

## Tests

`bun test test/review-gate.test.ts` — unit helpers + in-process e2e (approve
→ merge, changes → strike, belt-down → passthrough, kill switch, unparsable
→ retry+fail-closed, scoped-test evidence reaches the reviewer, diff cap).
The e2e runs runGate() in-process against a fake belt on loopback: spawned
children cannot reach loopback listeners in a sandboxed session, so the gate
exposes `runGate(argv) → exit code` and `main()` stays a thin wrapper.
