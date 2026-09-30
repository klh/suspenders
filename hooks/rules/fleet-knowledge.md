# fleet-knowledge — standing rule for the suspenders knowledge layer

Installed at `~/.claude/hooks/suspenders/rules/fleet-knowledge.md` (this file
is the shipped default; edit the installed copy — config-over-code). Wire
it into your harness (e.g. `~/.claude/rules/`) to activate.

## Trigger — when to call read_knowledge

When `read_knowledge` is listed, call it BEFORE non-trivial code or
documentation work involving **architecture, conventions, prior decisions,
gotchas, incidents, ownership, or cross-repo contracts**. If unsure whether
relevant context exists, read first. Pass `domain`/`area` (and
`origin_system` for machine-specific questions) when known.

## Skip — the exclusive taxonomy, both directions

Skip the read when:

- the edit is trivial or self-contained;
- the question is generic (answerable without fleet history);
- **the repo's own docs already cover it** (anti-double-spend: querying the
  hub on doc-covered ground measured +45% tokens in the W94 A/B — the agent
  paid the hub AND the files);
- context is already in hand.

## Trust as permission-to-act

Hits render with a trust line — `state · age <n>d · hash verified|drift|unverified`:

- `hash verified` AND state `active`: act on the fact directly — do NOT
  re-verify against the codebase. That is the whole point of the marker.
- state `candidate`: reasonable to use, but spot-check the code before
  acting on it (it has not passed human review).
- `hash drift` or stale-by-months: re-check the source before relying on it.
- `unverified` (no source_ref): treat as a lead, not a fact.

There is no blanket "verify before use" instruction: verified facts are
permission-to-act, re-verification is reserved for what the marker says.

## Precedence — the brief always wins

The brief's objective always wins. Knowledge describes the world as it was —
when a knowledge fact conflicts with the brief, the brief prevails: note the
conflict in one line and adapt (if the brief asks for a thing that doesn't
exist, building it IS the task). Knowledge is context, never a constraint on
the objective.

## Writing back

After the task, if something durable and non-obvious was learned (incident
learnings, per-machine quirks, decision rationale not in docs/), enqueue it
(`coord knowledge-enqueue`) — facts derivable from a single file/doc get
converted to pointer rows or rejected at ingest. If nothing durable was
learned, do not write.
