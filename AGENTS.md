# AGENTS.md — lane working protocol

How to work in this repo as a dispatched lane — written for any agent CLI
(`claude -p`, `codex exec`, or a human). The dispatch brief carries WHO you
are and WHAT the mission is; this file carries HOW. Read it before any edit.

## Protocol

0. **PLAN FIRST** — before any edit: `eza -T` the directories the mission
   touches (or `git ls-files`) for the shape, then rg the areas it names,
   read the files you would edit and `.qlty/qlty.toml` + the biome rule set.
   Code to the spec — never emit flagged patterns for the gate to catch.
   Note what live lanes already own: the governor denies parallel edits to
   a leased file; re-read and retry, it integrates rather than blocks.
1. **SHATTER JUDGMENT** — if the mission decomposes into 2+ genuinely
   independent scopes, do NOT implement it all here:
   `bun ~/.claude/hooks/suspenders/bin/work.ts split <id> "child one title"
"child two title" --reason independent-scopes --keep 1`, work only the
   kept child, end with `SPLIT <id>` — the fleet refills the rest. A split
   beyond 2 children needs a registered plan item first (`work add "plan: …"`,
   then `split --plan <id>`). Poll your inbox before starting and before
   finishing — `coord inbox --as <sid>` carries coordinator/board messages
   (drawer "send message" delivers there).
2. Work in the worktree + branch your brief names. SMALL anchored edits;
   co-situated tests for new logic; never hand-edit files another live lane
   owns.
3. **GATES** — `qlty fmt` + `qlty check` on changed files → "No issues";
   `bun test` on the files you touched → green.
4. Commit on your branch (subject = the item title), push the branch. NO tags.
5. Finish: `bun ~/.claude/hooks/suspenders/bin/work.ts done <id> --sha <branch-head>`.

Final line of output: `DONE <sha>` | `SPLIT <id>` | `BLOCKED` (after 3
honest attempts, tree restored).

## Consult/Broadcast Narration

Any CLI polling `coord inbox`/`coord wait` narrates terse, not verbose:

- Not addressed to you and not a consult (routine BROADCAST, work.landed,
  knowledge.settled, etc.) — say nothing, just advance past it.
- A consult addressed to your sid:
  ```
  consult: [C12] 3bb4718c asks <question, truncated>
  thinking
  consult: [C12] replying <answer, truncated>
  ```
- A fleet-wide consult (`--best`, no single addressee):
  ```
  consult: fleet asks, <question, truncated>
  thinking
  consult: fleet, no knowledge, didn't reply
  ```
  or, if you have an answer:
  ```
  consult: fleet, details forwarded
  ```

Repo doctrine (quality bar, architecture) lives in CLAUDE.md.
