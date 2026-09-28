# morph — AST-grade structural edits

`hooks/bin/morph.ts` + `hooks/lib/morph.ts`. Recipes mutate an in-memory
ts-morph project of every `.ts` under `--root`, gated before anything
reaches disk. Born from W79 (docs-first: ts-morph.com guides + the fleet
lesson `lesson.ts-morph-edits`).

## When to reach for it

Text rewrites (Edit, `sd`, `splice.ts`) match bytes; ast-grep matches syntax
but is still a **pattern** tool. `morph` is for what those cannot see:

- rename a symbol across files, language-service backed — not a textual
  `--find/--replace` that also hits comments, strings, and same-name locals
- move a top-level declaration to another file with importer rewiring
- organize imports mechanically

For ≤40-line anchored edits, plain Edit still wins. morph is for the edits
where "which sites does this actually touch?" is the hard question.

## Guardrails (the contract)

1. **Dry-run by default.** Without `--apply` you get the unified diff and
   nothing else. Every abort path writes zero bytes.
2. **Snapshot before mutate.** Matches (declaration + reference sites) are
   collected up front; recipes never iterate live descendants mid-mutation.
3. **Diagnostics gate.** Pre-emit diagnostics are computed at load and again
   after mutation; any NEW diagnostic aborts (exit 2) — nothing written.
4. **One save.** All changes land through a single `project.saveSync()` on
   success — no halfway states on disk, ever.
5. **Count discipline** (`rename --count N`): found-sites must equal N, in
   the spirit of `splice.ts` — never rewrite more sites than you intended.

Exit codes: 0 ok/dry-run, 1 usage, 2 aborted (no match, count mismatch, new
diagnostics).

## Recipes

```sh
bun hooks/bin/morph.ts rename <file> --symbol OLD --to NEW [--count N] [--apply] [--root DIR]...
bun hooks/bin/morph.ts move   <file> --symbol NAME --to TARGET.ts [--apply]
bun hooks/bin/morph.ts organize [file...] [--apply]
```

- `rename` — declaration + every reference (LS-backed, cross-file).
  `--count N` asserts the total site count before mutating.
- `move` — one **top-level** declaration; its full text (incl. leading
  JSDoc) travels; importers get the symbol re-pointed from the old module to
  the target (old binding stripped first); if the source still uses the
  symbol it imports it back. It does NOT move the declaration's own
  dependencies — that aborts via the diagnostics gate, which is the point.
- `organize` — `organizeImports` on named files (default: all loaded).

`--root` (repeatable) scopes the project; default cwd. `.git`, `node_modules`,
`.worktrees`, `.tmp-*` etc. are skipped.

## Pitfalls paid for (do not re-learn)

- **`getVariableStatement()` throws on non-variable declarations** (v28: it
  dies inside its ancestor walk with `Array.find callback must be a
function`). Kind-guard first: only call it when
  `node.getKind() === SyntaxKind.VariableDeclaration`.
- **Script-mode globals defeat the diagnostics gate.** After a move, a
  source file left without any import/export becomes a _script_; its
  top-level declarations become ambient globals visible module-wide, so a
  moved declaration's dangling reference may type-check CLEANLY. The gate is
  strongest on real module graphs — fixtures and expectations should keep
  files as modules.
- Replace the narrowest node; `replaceWithText` on a whole call forgets its
  siblings (ManipulationError child-count mismatch).
- `getStatements().indexOf()` returns -1 for statement wrappers →
  `insertStatements` lands at index 0. Always verify placement in the diff.

## Adding a recipe

A recipe is a function `(session, opts) -> Outcome` in `hooks/lib/morph.ts`:

1. `resolveFile()` the inputs; return `noFile()` when absent.
2. Find matches with the snapshot discipline (collect, count, then mutate).
3. Mutate through ts-morph APIs — never `replaceWithText` a wide node.
4. Return `finish(session, note, opts)` — it runs the diagnostics gate,
   renders the diff, and performs the single save when `opts.apply`.
   Never call `project.saveSync()` yourself.
