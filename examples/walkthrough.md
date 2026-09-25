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

## 3. Ask the fleet a question (consult — never ownership transfer)

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

On the board: **DECISION FORKS** panel, red card, your question. Press
**Advice me!** — the advise worker reads the control plane (claims, recent
events, graph shape) and asks your configured LLM:

```bash
SUSPENDERS_LLM_URL=http://127.0.0.1:8901/v1/chat/completions \
SUSPENDERS_LLM_MODEL=      # empty = autodiscover from /v1/models
bun ~/.claude/hooks/suspenders/bin/advise.ts <event-id>
```

Recommendation lands inline: **rec · rationale · risk · model**. "Use this"
fills the box; you edit; **send** — the answer rides the bus back:

```bash
bun $C emit ANSWER --to "$SID" --note "token bucket — we already own the dep transitively" --as fleet-board
bun $C inbox --as "$SID"   # the lane sees it on next poll
```

**The LLM advises; the human decides.** Nothing the advise worker writes ever
enters the bus as an instruction.

## 5. When a lane dies mid-flight (the part that used to hurt)

A lane frozen by a usage cliff stops heartbeating while its claim keeps going.
The monitor (or launchd agent) flags it — two stale signals = ZOMBIE, one =
SUSPECT, a lookup failure is never death:

```bash
bun ~/.claude/hooks/suspenders/bin/monitor.ts          # read-only health
bun $W orphaned                                        # items whose owner went silent
bun $W reclaim W4                                      # human calls this, no auto-reclaim
```

Re-dispatch pointing at the frozen transcript — its context is the salvage,
not the loss.

## 6. The one invariant

Operational state lives in the graph, never in Markdown or anyone's head:
every actionable item is a `work add`, every milestone a `work done --sha`,
every decision a bus event. Sessions restart, contexts compact, lanes die —
the graph doesn't care.
