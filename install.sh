#!/usr/bin/env bash
# suspenders installer — copies the harness into ~/.claude/hooks/suspenders and
# optionally: --wire merges the hook registrations into ~/.claude/settings.json
# (per-event concat, never clobbers), --with-launchd installs the macOS agents.
# Idempotent: re-running just refreshes the files.
#   ./install.sh [--wire] [--with-launchd] [--dry-run] [--skip-models] [--no-llm]
# Default (owner law 2026-10-01): ALWAYS sets up the local-llm swarm and
# downloads the smallest-fit models (BELT_TIER=minimal residents).
set -euo pipefail
# secrets at rest (W195): everything this script creates is owner-only —
# belt.env/belt-tokens.json/plists/settings.json carry tokens and keys
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${SUSPENDERS_PREFIX:-$HOME/.claude/hooks/suspenders}"

# flags (order-independent) — replaces the old positional $1/$2 checks
WIRE=0 WITH_LAUNCHD=0 DRY_RUN=0 SKIP_MODELS=0 NO_LLM=0
for arg in "$@"; do
  case "$arg" in
    --wire) WIRE=1 ;;
    --with-launchd) WITH_LAUNCHD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    --no-llm) NO_LLM=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

LLM_HOME="$HOME/.claude/local-llm"
KIT_DIR="$REPO_DIR/hooks/local-llm"

# --dry-run: print the plan, touch nothing (bun read-only for the tier list)
if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run — would:"
  echo "  install harness → $PREFIX (+ bun install)"
  echo "  local-llm baseline → $LLM_HOME:"
  echo "    kit: swarm.ts (serve supervisor), spawner.ts, router-shim.ts,"
  echo "         registry.ts, belt.env + routing-policy.yaml stubs"
  echo "    registry/belt.env/routing-policy.yaml: only when absent"
  echo "    swarm.ts: refreshed when the copy lacks serve (revival fix)"
  echo "    models (BELT_TIER=minimal residents, resumable download):"
  BELT_TIER=minimal LOCAL_LLM_HOME="$KIT_DIR" bun -e '
const { residentSet } = await import(process.env.LOCAL_LLM_HOME + "/registry.ts");
for (const s of residentSet()) console.log("      " + s.model + " → :" + s.port);
' 2>/dev/null || echo "      (bun import failed — kit registry unreadable)"
  echo "    launchd: com.suspenders.local-llm (swarm.ts serve, KeepAlive)"
  exit 0
fi

command -v bun >/dev/null || { echo "suspenders needs bun — https://bun.sh first"; exit 1; }

echo "→ installing to $PREFIX"
mkdir -p "$PREFIX"
for item in bin lib board-html coord board gates launchd rules gate.ts session-start.ts session-end.ts knowledgeworker.md; do
  cp -R "$REPO_DIR/hooks/$item" "$PREFIX/"
done
cp "$REPO_DIR/package.json" "$REPO_DIR/bun.lock" "$PREFIX/"
(cd "$PREFIX" && bun install) # shell-quote, for the bash gate
echo "→ harness in place"

# ─── local-llm baseline (owner law 2026-10-01) ───
# Installing suspenders ALWAYS installs the local-llm swarm — smallest models
# that fit the bill (registry BELT_TIER=minimal residents). The kit lands in
# $LLM_HOME; copies never clobber the runtime home (it is the live fleet's
# possibly-customized source of truth). --no-llm skips for CI/containers.
if [[ $NO_LLM -eq 0 ]]; then
  mkdir -p "$LLM_HOME"
  for f in registry.ts spawner.ts router-shim.ts; do
    if [ -f "$LLM_HOME/$f" ]; then
      echo "= $LLM_HOME/$f kept (runtime copy is source of truth)"
    else
      cp "$KIT_DIR/$f" "$LLM_HOME/$f"
      echo "+ $LLM_HOME/$f"
    fi
  done
  # swarm.ts is the one kit file that MAY refresh a present copy: an older
  # installed swarm.ts lacks the serve supervisor, and a serve-less swarm.ts
  # under launchd KeepAlive is exactly the busy-loop flaw this fixes.
  if [ ! -f "$LLM_HOME/swarm.ts" ] || ! grep -q 'case "serve"' "$LLM_HOME/swarm.ts" 2>/dev/null; then
    cp "$KIT_DIR/swarm.ts" "$LLM_HOME/swarm.ts"
    echo "+ $LLM_HOME/swarm.ts (serve supervisor)"
  else
    echo "= $LLM_HOME/swarm.ts kept (serve already present)"
  fi
  # config stubs — belt.env + routing-policy.yaml, only when absent
  for f in belt.env routing-policy.yaml; do
    if [ -f "$LLM_HOME/$f" ]; then
      echo "= $LLM_HOME/$f kept (operator-owned runtime copy)"
    else
      cp "$KIT_DIR/$f" "$LLM_HOME/$f"
      echo "+ $LLM_HOME/$f (stub — fill/verify at activation)"
    fi
  done
  # secrets at rest (W195): belt.env carries ANTHROPIC_AUTH_TOKEN, belt-tokens
  # .json carries the belt bearer — converge both to owner-only, fresh or kept
  for f in belt.env belt-tokens.json; do
    if [ -f "$LLM_HOME/$f" ]; then
      chmod 600 "$LLM_HOME/$f"
    fi
  done
  # smallest-fit models: derived FROM the registry (same source of truth the
  # swarm reads) — BELT_TIER=minimal residents. huggingface_hub snapshot_
  # download resumes partial downloads; --skip-models skips for offline boxes.
  if [[ $SKIP_MODELS -eq 0 ]]; then
    MLX_PYTHON="$HOME/.local/share/uv/tools/mlx-lm/bin/python"
    if [ ! -x "$MLX_PYTHON" ] && command -v uv >/dev/null 2>&1; then
      uv tool install mlx-lm >/dev/null 2>&1 || true
    fi
    if [ -x "$MLX_PYTHON" ]; then
      MODELS="$(BELT_TIER=minimal LOCAL_LLM_HOME="$LLM_HOME" bun -e '
const { residentSet } = await import(process.env.LOCAL_LLM_HOME + "/registry.ts");
process.stdout.write(residentSet().map((s) => s.model).join("\n"));
')"
      printf '%s\n' "$MODELS" | while IFS= read -r model; do
        [ -z "$model" ] && continue
        echo "→ downloading $model (resumes if partial)"
        "$MLX_PYTHON" -c 'from huggingface_hub import snapshot_download; import sys; snapshot_download(sys.argv[1])' "$model" \
          || echo "  ✗ $model failed — re-run install to resume"
      done
    else
      echo "→ mlx-lm missing — skipping model download (re-run install to fetch)"
    fi
  else
    echo "→ --skip-models: skipping model download (offline install)"
  fi
fi

# --wire: merge the example hooks block into ~/.claude/settings.json — per-event
# array concat, existing entries untouched; paths rewritten to the real prefix
if [[ $WIRE -eq 1 ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  [ -f "$SETTINGS" ] || echo "{}" >"$SETTINGS"
  # "$HOME/..." is a literal JS string for replaceAll, not shell expansion
  # shellcheck disable=SC2016
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
    fs.chmodSync(settingsPath, 0o600); // secrets at rest (W195): env keys can live in hook env blocks
    console.log("→ wired " + settingsPath);
  '
fi

# --with-launchd: template-substitute and load the macOS agents
if [[ $WITH_LAUNCHD -eq 1 ]]; then
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "→ --with-launchd skipped (not macOS)"
  else
    BUN_BIN="$(command -v bun)"
    for f in "$REPO_DIR"/hooks/launchd/*.plist; do
      name="$(basename "$f")"
      out="$HOME/Library/LaunchAgents/$name"
      sed -e "s|__BUN__|$BUN_BIN|" -e "s|__HOME__|$HOME|" -e "s|__PREFIX__|$PREFIX|" -e "s|__REPO__|$REPO_DIR|" \
        -e "s|__BELT_URL__|${BELT_URL:-http://127.0.0.1:4100}|" -e "s|__BELT_TOKEN__|${BELT_TOKEN:-}|" "$f" >"$out"
      # secrets at rest (W195): fleet-loop.plist embeds BELT_TOKEN — owner-only
      chmod 600 "$out"
      launchctl bootout "gui/$(id -u)/${name%.plist}" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$out"
      echo "→ loaded $name"
    done
    # supersede the pre-namespacing agent labels so old and new never run side
    # by side (same jobs, stale script paths, double keepwarm/monitor pings)
    for legacy in com.klh.llm-keepwarm com.klh.fleet-monitor; do
      launchctl bootout "gui/$(id -u)/$legacy" 2>/dev/null || true
      if [ -f "$HOME/Library/LaunchAgents/$legacy.plist" ]; then
        rm "$HOME/Library/LaunchAgents/$legacy.plist"
        echo "→ superseded legacy agent $legacy"
      fi
    done
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
echo "local-llm: $LLM_HOME (swarm serve supervisor; BELT_TIER=minimal residents + :4000 router)"
echo "  bun $LLM_HOME/swarm.ts status   # swarm health"
echo "  bun $LLM_HOME/swarm.ts serve    # resident supervisor (launchd label com.suspenders.local-llm)"

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
