#!/usr/bin/env bash
# suspenders installer — copies the harness into ~/.claude/hooks/suspenders and
# optionally: --wire merges the hook registrations into ~/.claude/settings.json
# (per-event concat, never clobbers), --with-services installs the fleet
# services for this platform (launchd on macOS, systemd user-units on Linux).
# Idempotent: re-running just refreshes the files.
#   ./install.sh [--wire] [--with-services]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${SUSPENDERS_PREFIX:-$HOME/.claude/hooks/suspenders}"

command -v bun >/dev/null || { echo "suspenders needs bun — https://bun.sh first"; exit 1; }

echo "→ installing to $PREFIX"
mkdir -p "$PREFIX"
for item in bin lib gates gate.ts session-start.ts session-end.ts knowledgeworker.md; do
  cp -R "$REPO_DIR/hooks/$item" "$PREFIX/"
done
cp "$REPO_DIR/package.json" "$REPO_DIR/bun.lock" "$PREFIX/"
(cd "$PREFIX" && bun install) # shell-quote, for the bash gate
echo "→ harness in place"

# --wire: merge the example hooks block into ~/.claude/settings.json — per-event
# array concat, existing entries untouched; paths rewritten to the real prefix
if [[ "${1:-}" == "--wire" || "${2:-}" == "--wire" ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  [ -f "$SETTINGS" ] || echo "{}" >"$SETTINGS"
  SUSPENDERS_EXAMPLE="$REPO_DIR/settings.example.json" SUSPENDERS_PREFIX="$PREFIX" bun -e '
    const fs = require("node:fs");
    const settingsPath = process.env.HOME + "/.claude/settings.json";
    const prefix = process.env.SUSPENDERS_PREFIX;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const ex = JSON.parse(fs.readFileSync(process.env.SUSPENDERS_EXAMPLE, "utf8")).hooks;
    settings.hooks ??= {};
    for (const [event, entries] of Object.entries(ex)) {
      const rewritten = JSON.parse(JSON.stringify(entries).replaceAll("$HOME/.claude/hooks/suspenders", prefix));
      const cur = (settings.hooks[event] ??= []);
      const seen = new Set(cur.map((m) => JSON.stringify(m)));
      for (const e of rewritten) if (!seen.has(JSON.stringify(e))) cur.push(e);
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log("→ wired " + settingsPath);
  '
fi

# --with-services (alias: --with-launchd): render the ONE service manifest
# for this platform and load it — launchd agents on macOS, systemd user-units
# on Linux. Replaces the per-repo __HOME__ plist templates + sed substitution.
if [[ "${1:-}" == "--with-services" || "${2:-}" == "--with-services" || "${1:-}" == "--with-launchd" || "${2:-}" == "--with-launchd" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    BUN_BIN="$(command -v bun)"
    bun "$PREFIX/bin/service-gen.ts" install --target launchd --prefix "$PREFIX" --repo "$REPO_DIR" --bun "$BUN_BIN"
    # supersede the pre-namespacing agent labels so old and new never run side
    # by side (same jobs, stale script paths, double keepwarm/monitor pings)
    for legacy in com.klh.llm-keepwarm com.klh.fleet-monitor; do
      launchctl bootout "gui/$(id -u)/$legacy" 2>/dev/null || true
      if [ -f "$HOME/Library/LaunchAgents/$legacy.plist" ]; then
        rm "$HOME/Library/LaunchAgents/$legacy.plist"
        echo "→ superseded legacy agent $legacy"
      fi
    done
  else
    bun "$PREFIX/bin/service-gen.ts" install --target systemd --prefix "$PREFIX" --repo "$REPO_DIR"
  fi
fi

# optional: register the board with klh-local's user-level Caddy so the LAN
# gets http://suspenders.local:7799. Idempotent (converges on re-run) and
# never fatal — the loopback board works without it.
KLH_LOCAL_BIN="$HOME/.local/bin/klh-local"
if [[ -x "$KLH_LOCAL_BIN" ]] && command -v caddy >/dev/null 2>&1; then
  if "$KLH_LOCAL_BIN" register suspenders --port 7799 --health /; then
    echo "→ suspenders.local → 127.0.0.1:7799 (klh-local / Caddy)"
  else
    echo "→ klh-local register failed (non-fatal) — board stays on http://127.0.0.1:7799"
  fi
else
  echo "optional: install klh-local + caddy to also serve this board at http://suspenders.local:7799"
fi

echo
echo "done. restart Claude Code so the hooks register, then:"
echo "  bun $PREFIX/bin/fleet-board.ts        # live fleet board (+ decision forks)"
echo "  bun $PREFIX/bin/work.ts ready         # what the fleet can pick up"
echo "  bun $PREFIX/bin/monitor.ts            # control-plane health"
echo "env knobs: SUSPENDERS_LLM_URL / SUSPENDERS_LLM_MODEL / SUSPENDERS_LLM_KEY (advice worker)"

# ─── release notify: the distributed changelog (2026-09-30) ───
# every deploy announces the live version on the coord bus; every session
# sees it at next poll or SessionStart. Fresh machines (no coord) skip.
COORD="$HOME/.claude/hooks/suspenders/bin/coord.ts"
if [ -f "$COORD" ]; then
  REL_VER=$(git -C "$(cd "$(dirname "$0")" && pwd)" describe --tags --abbrev=0 2>/dev/null || echo unknown)
  REL_NOTE=$(git -C "$(cd "$(dirname "$0")" && pwd)" tag -l --format='%(contents:subject)' "$REL_VER" 2>/dev/null | head -1)
  bun "$COORD" emit RELEASE --scope suspenders --version "$REL_VER" \
    --note "${REL_NOTE:-deployed}" --as installer >/dev/null 2>&1 || true
fi
