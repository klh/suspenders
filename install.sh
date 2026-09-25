#!/usr/bin/env bash
# suspenders installer — copies the harness into ~/.claude/hooks/suspenders and
# optionally: --wire merges the hook registrations into ~/.claude/settings.json
# (per-event concat, never clobbers), --with-launchd installs the macOS agents.
# Idempotent: re-running just refreshes the files.
#   ./install.sh [--wire] [--with-launchd]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${SUSPENDERS_PREFIX:-$HOME/.claude/hooks/suspenders}"

command -v bun >/dev/null || { echo "suspenders needs bun — https://bun.sh first"; exit 1; }

echo "→ installing to $PREFIX"
mkdir -p "$PREFIX"
for item in bin lib gates launchd gate.ts session-start.ts session-end.ts; do
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

# --with-launchd: template-substitute and load the macOS agents
if [[ "${1:-}" == "--with-launchd" || "${2:-}" == "--with-launchd" ]]; then
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "→ --with-launchd skipped (not macOS)"
  else
    BUN_BIN="$(command -v bun)"
    for f in "$REPO_DIR"/hooks/launchd/*.plist; do
      name="$(basename "$f")"
      out="$HOME/Library/LaunchAgents/$name"
      sed -e "s|__BUN__|$BUN_BIN|" -e "s|__HOME__|$HOME|" -e "s|__PREFIX__|$PREFIX|" "$f" >"$out"
      launchctl bootout "gui/$(id -u)/${name%.plist}" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$out"
      echo "→ loaded $name"
    done
  fi
fi

echo
echo "done. restart Claude Code so the hooks register, then:"
echo "  bun $PREFIX/bin/fleet-board.ts        # live fleet board (+ decision forks)"
echo "  bun $PREFIX/bin/work.ts ready         # what the fleet can pick up"
echo "  bun $PREFIX/bin/monitor.ts            # control-plane health"
echo "env knobs: SUSPENDERS_LLM_URL / SUSPENDERS_LLM_MODEL / SUSPENDERS_LLM_KEY (advice worker)"
