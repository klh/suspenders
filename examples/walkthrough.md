# Walkthrough — one full loop of the harness

Every command below is copy-pasteable. Run them from **any git repo** — the
Work Graph partitions per project, so this creates its own lane of work
without touching any other repo's graph. (The only shared state is the
governor.db file itself; events carry `payload.project` so foreign traffic is
filterable.)

Open a second terminal with `bun ~/.claude/hooks/suspenders/bin/fleet-board.ts`
and watch everything you do appear live.

## 1. Bootstrap: you are the coordinator

```bash
SID="my-coordinator-0001"   # any stable string; use the full session sid in real fleets
bun ~/.claude/hooks/suspenders/bin/coord.ts bootstrap --as "$SID" --role coordinator --caps shell,fs,git,build
```

Session registered, capabilities advertised, RULES printed. In a real fleet
every lane bootstraps the same way with `--role worker --parent "$SID"` —
capabilities inherit, so a lane can never be dispatched work its type can't do.

## 2. Register work; take it; land it

```bash
W=~/.claude/hooks/suspenders/bin/work.ts
bun $W add "wire the payment webhook retries" --scope src/payments --by "$SID"
bun $W take W1 --as "$SID"        # CAS claim — a lost race is informational
bun $W done W1 --sha "$(git rev-parse --short HEAD)"   # checkpoint + roll-up
```

Parallelizable? Split it — children are plan-gated (register the decomposition
plan first; each child gets exclusive file regions):

```bash
bun $W split W2 "parse webhook payloads" "idempotent retry table" --reason independent-scopes --keep 1
bun $W ready    # what the fleet can self-serve right now
```

## 3. Ask the fleet a question (consult)

```bash
C=~/.claude/hooks/suspenders/bin/coord.ts
bun $C who-knows "retry table migrations"        # ranks live sessions by context
bun $C consult --best "does the retry table need a backfill?" --scope src/payments --as "$SID"
# the expert's inbox gets: ? C## from <you> — they reply:
# bun $C consult-reply C## "no — table starts empty, backfill unnecessary" --as "<expert>"
```

## 4. Hit a fork → let the board + LLM advise → decide

```bash
bun $C emit NEED_DECISION --to "$SID" --note "retry storms: exponential backoff or token bucket? backoff is 20 lines, bucket needs a rate limiter dep" --as "$SID"
```

On the board, the question appears in the **Decisions needed** section. Press
**Get recommendation** — the advise worker reads the control plane (claims,
recent events, work items) and asks your configured LLM:

```bash
SUSPENDERS_LLM_URL=http://127.0.0.1:8901/v1/chat/completions \
SUSPENDERS_LLM_MODEL=      # empty = autodiscover from /v1/models
bun ~/.claude/hooks/suspenders/bin/advise.ts <event-id>
```

The recommendation lands inline: rec, rationale, risk, model. "Use" fills the
field; you edit; **send** — the answer rides the bus back:

```bash
bun $C emit ANSWER --to "$SID" --note "token bucket — we already own the dep transitively" --as fleet-board
bun $C inbox --as "$SID"   # the lane sees it on next poll
```

The advise worker only writes recommendations — answers reach the bus only
from the human.

## 5. When a lane dies mid-flight

A lane frozen by a usage cliff stops heartbeating while its claim keeps going.
The monitor (or launchd agent) flags it — two stale signals = ZOMBIE, one =
SUSPECT:

```bash
bun ~/.claude/hooks/suspenders/bin/monitor.ts          # read-only health
bun $W orphaned                                        # items whose owner went silent
bun $W reclaim W4                                      # human calls this, no auto-reclaim
```

Re-dispatch pointing at the frozen transcript so the next lane inherits its
context.

## 6. The invariant

Task state lives in the graph: every actionable item is a `work add`, every
milestone a `work done --sha`, every decision a bus event. Sessions restart,
contexts compact, lanes die — the graph keeps going.
