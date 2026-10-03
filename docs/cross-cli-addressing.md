# Cross-CLI session addressing

Suspenders now exposes one canonical session label shape across live CLIs:

`[hub][tool]-session-name (llm-shorthand)`

Examples:

- `[nas][copilot]-ikea-opus (gpt)`
- `[local][claude]-w296-adapter (sonnet)`
- `[local][codex]-w301-review`

## Field mapping

`hooks/lib/addressing.ts` owns the formatter.

- `hub`: `tags.hub` / `tags.hubId` / `tags.host` when an adapter stamps one.
  There is no dedicated `sessions.hub` column yet, so unlabeled sessions fall
  back to `local` instead of inventing a remote identity.
- `tool`: derived from `tags.tool` / `tags.cli` / `tags.dialect`, then lane
  executor facts (`lane.<sid>.executor`), then transcript/worktree path clues.
  Current normalized tools are `claude`, `codex`, `copilot`, `grok`, and `llm`.
- `session-name`: adapter-provided `tags.name` / `tags.sessionName` wins.
  Otherwise suspenders derives a short label from the active owned work item,
  then recent claim intent, then the worktree basename, then the sid prefix.
- `llm-shorthand`: adapter-provided `tags.model` wins, then
  `lane.<sid>.model`, then the transcript tail when available. The formatter
  collapses raw model ids into short families such as `sonnet`, `opus`, `gpt`,
  `grok`, `gemini`, `flash`, `luna`, or `local`.

If the model is unknown, the parenthetical is omitted. Labels must never print
`undefined`.

## Discovering live `@` targets

Use the coord CLI:

```bash
bun hooks/bin/coord.ts targets
bun hooks/bin/coord.ts targets --filter copilot
bun hooks/bin/coord.ts targets --json
```

`targets` lists the currently live bus recipients using the same freshness rule
as bus broadcasts: `sessions.state = 'RUNNING'` and heartbeat within the bus
window. Default output is a table with the canonical label and the full sid.
`--json` returns an array for scripting.

## Messaging one lane or everyone

Direct note to one resolved lane:

```bash
bun hooks/bin/coord.ts message ikea-opus "please checkpoint after the next green test" --as coordinator-sid
```

Broadcast to every currently live lane:

```bash
bun hooks/bin/coord.ts message --all "fleet notice: pause new dispatches" --as coordinator-sid
```

Behavior:

- Single-target `message` resolves against the same live target list as
  `targets`, matching exact sid, exact label, sid prefix, then case-insensitive
  substring. Zero matches and ambiguous matches both fail loudly.
- Single-target delivery reuses the existing coord event primitive and emits a
  directed `NOTE`.
- `message --all` reuses the existing broadcast primitive and emits
  `BROADCAST` events to the current live set plus the usual bootstrap fact for
  future sessions.

## Adapter requirements for CLI #5

A new adapter does not need to modify the core bus if it stamps enough session
metadata for addressing to stay honest.

Recommended session tags when calling `coord bootstrap` or writing the session
row:

```json
{
  "hub": "nas",
  "cli": "copilot",
  "name": "ikea-opus",
  "model": "gpt-5.4"
}
```

At minimum:

1. Stamp the tool identity (`tool`, `cli`, or `dialect`).
2. Stamp the model id when known (`model`).
3. Stamp a hub label when the session is not local (`hub`).
4. Keep `worktree`, `actor`, `tags`, and `capabilities` populated so fallback
   naming still works when some fields are missing.

Without those tags, suspenders still emits a usable label, but it honestly
falls back to `local`, transcript/worktree heuristics, and the sid/work item
shape already present in `governor.db`.
