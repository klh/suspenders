# Fleet-wide hook installer (W298)

How suspenders detects which CLI/agent tools are installed on a machine and
offers to wire each one's dialect adapter (session registration + gate
enforcement) in one pass — instead of running each dialect's `wire.ts` by
hand.

## Origin: lifted from `vercel-labs/skills`

[`vercel-labs/skills`](https://github.com/vercel-labs/skills) (npm package
`skills`, MIT) solves the same class of problem for installing *skills*
across agent tools: detect what's on the machine, then prompt the user with
exactly the right set of choices depending on how many tools were found.

We lifted two things from it verbatim, by explicit instruction ("use the
exact same patterns"):

1. **The registry** — `src/agents.ts`, a `Record<AgentType, AgentConfig>` of
   70+ CLI/agent targets, each with a `detectInstalled(): Promise<boolean>`
   closure (almost all `existsSync(join(home, '.xxx'))`, a few with env-var
   overrides like `CODEX_HOME`/`GROK_HOME`/`HERMES_HOME`). Vendored byte-for-byte
   into `hooks/lib/vendor/skills-agents.ts` (`AgentType`/`AgentConfig` inlined
   from the separate `types.ts` we didn't copy). License copied to
   `hooks/lib/vendor/SKILLS-LICENSE`.
2. **The decision flow** — `src/add.ts`'s 0/1/2+ branching:
   - **0 detected** → full interactive multiselect across every known target.
   - **1 detected** (or `--yes`) → auto-select it, no prompt.
   - **2+ detected** → interactive multiselect, pre-populated with the
     detected set so the user can add/remove before confirming.

   We use `@clack/prompts`'s built-in `multiselect` rather than vendoring
   vercel's custom 701-line fuzzy-search readline component
   (`search-multiselect.ts`) — judged not essential to the core ask. If UX
   fidelity with the original ever matters, that component is the one to
   port next.

## Why vendor instead of `npm install skills` and import it

`skills`' public API is built around installing *skill* files into
`.agents/skills`/tool-specific skill directories — not wiring hook gates.
We only needed its **registry + detection + prompting shape**, not its
install mechanism, so vendoring the registry and writing our own thin
installer on top was more direct than depending on the package and fighting
its API surface.

## What's "supported" vs "gated"

The vendored registry is never trimmed — all 70+ entries stay, per explicit
instruction ("don't remove the 70+ others we might want to support later,
just gate it"). `hooks/lib/targets.ts` layers wiring metadata on top:

- **`supported: true`** — has a real dialect adapter under
  `hooks/dialects/<name>/wire.ts` (currently: `codex`, `github-copilot`,
  `grok`, `cline`), or is `claude-code` (native, no wiring needed — Claude
  Code *is* the gate's native format).
- **`supported: false`** — every other vendored target (zed, cursor,
  windsurf, hermes-agent, opencode, zcode, …). Still detected and listed;
  `fleet-install.ts` refuses to wire these with a clear
  `"<Name> has no hook adapter yet (gated) — cannot wire"` message pointing
  back to [`cli-dialect-pattern.md`](./cli-dialect-pattern.md) for how to add
  one.

## Usage

```bash
# Detect what's installed, prompt interactively for which to wire
bun hooks/bin/fleet-install.ts

# Wire specific targets non-interactively
bun hooks/bin/fleet-install.ts --agent codex,github-copilot

# Wire every supported+detected target, no prompt
bun hooks/bin/fleet-install.ts --yes
# or explicitly:
bun hooks/bin/fleet-install.ts --agent '*'

# Preview without touching any settings file
bun hooks/bin/fleet-install.ts --dry-run
```

Exit codes mirror `skills`' own discipline: a genuine interactive cancel
exits `0`; requesting an unknown or gated target, or cancelling when stdin
isn't a TTY (can't prompt), exits `1` with an explanatory message — so CI/
non-interactive runs never silently report false success.

## Keeping the vendored registry in sync

`hooks/lib/vendor/skills-agents.ts` should stay byte-identical to upstream's
`src/agents.ts` (plus the inlined types and our attribution header) so future
re-syncs are a simple diff-and-replace. To refresh it:

1. `git clone https://github.com/vercel-labs/skills /tmp/skills-upstream`
2. Diff `/tmp/skills-upstream/src/agents.ts` (+ `src/types.ts`) against our
   vendored copy.
3. Re-apply our two intentional deltas: the attribution header comment, and
   inlining `AgentType`/`AgentConfig` (upstream splits them into
   `types.ts`, which we don't vendor separately).
4. Re-run `bun test test/fleet-targets.test.ts test/fleet-install.test.ts`
   to confirm `listTargets()`/`detectFleetTargets()` still see every new
   entry correctly (new entries default to `supported: false` automatically
   — nothing else needs updating unless a new entry should also get a real
   dialect adapter).

## Known environment-dependent detection quirk

A few vendored `detectInstalled()` closures (e.g. `isZCodeInstalled`) check
an absolute, non-`$HOME`-relative path like `/Applications/ZCode.app` as a
fallback. This is correct upstream behavior (it really does detect a
system-wide install), but it means a "detect with an empty/fake `$HOME`"
test can still see `installed: true` for those entries on a machine that
happens to have that app installed. Our own tests scope "nothing installed"
assertions to `supported` targets only, since those are the only ones whose
detection we rely on for wiring decisions.
