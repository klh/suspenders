// hooks/gates/files.ts — PostToolUse(Edit|Write|NotebookEdit): markdown format
// + code auto-format (qlty fmt) + syntax gate + blind-edit nudge in ONE process.
// 2026-09-15: syntax checking consolidated on QLTY ONLY (user directive —
// the tsc/esbuild/jq/yq/taplo/ruff/biome/sass per-type gates are gone).
// 2026-09-15 (owner: "learn from the formatting mistakes"): code files get
// `qlty fmt` ON SAVE, before the check — safe fixes land without a
// fix-it-yourself loop, and the agent is told to re-read when the file
// changed under it (same contract as the markdown/prettier path).
// Runs from the file's dir with the basename (absolute paths fail qlty's
// strip-prefix). Repos without qlty setup (exit 99) skip silently — run
// `qlty init -y && qlty plugins enable biome` there to get coverage.
// W14: the gate body lives in filesCheck() — exit-free — so stop.ts re-verifies
// changed files IN-PROCESS instead of spawning `bun gate.ts post-files` per file.
import { allow, context, feedback, type HookInput } from "../lib/hookio.ts";
import { have, lines, run } from "../lib/run.ts";
import { openGovernorDb } from "../lib/govdb.ts";
import { basename, dirname } from "node:path";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Exit-free verdict of the files gate; filesGate maps kinds 1:1 to the old
 * exit behavior (ok→allow, context→additionalContext+exit 0, feedback→
 * stderr+exit 2, block→stderr+exit 2). */
export type FilesExit =
  | { kind: "ok" }
  | { kind: "context"; msg: string }
  | { kind: "feedback"; msg: string }
  | { kind: "block"; err: string };

export function filesGate(hook: HookInput): never {
  const v = filesCheck(hook);
  if (v.kind === "context") context(v.msg, "PostToolUse");
  if (v.kind === "feedback") feedback(v.msg);
  if (v.kind === "block") {
    process.stderr.write(v.err);
    process.exit(2);
  }
  allow();
}

export function filesCheck(hook: HookInput): FilesExit {
  if (!["Edit", "Write", "NotebookEdit"].includes(hook.tool_name ?? "")) return { kind: "ok" };
  const F = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path ?? "";
  if (!F) return { kind: "ok" };

  const isMd = /\.(md|markdown)$/i.test(F);
  const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc)$/i.test(F);

  // Worktree lanes (multi-agent): SKIP per-save formatting. The fmt mutates
  // the file after the governor hashed it and every cycle risks a lost-update
  // deny on the shared registry — 4.8K false "changed on disk" retries in the
  // gaps session. Formatting happens once at claim-done: stop.ts re-runs this
  // gate with _deferred_fmt=true (syntax check still runs per-save).
  const deferFmt = F.includes("/.claude/worktrees/") && (hook as any)._deferred_fmt !== true;

  // ---- markdown: prettier (GFM, prose preserved) ----
  if (isMd && !deferFmt && existsSync(F) && have("prettier")) {
    const before = Bun.hash(readFileSync(F));
    run("prettier", ["--write", "--prose-wrap", "preserve", "--log-level", "warn", F]);
    if (Bun.hash(readFileSync(F)) !== before) {
      refreshLeaseHash(F);
      return { kind: "feedback", msg: `md-format: reformatted ${F} with prettier (GFM: table alignment, list markers, fence style). Re-read before further edits.` };
    }
  }

  // ---- code: qlty fmt ON SAVE, then the syntax gate ----
  if (isCode && existsSync(F)) {
    const fmtNote = deferFmt ? null : qltyFmt(F);
    const issues = qltyGate(F);
    if (issues) {
      const head = fmtNote ? `${fmtNote} Re-read before further edits.\n` : "";
      return { kind: "block", err: `${head}qlty check found issues in ${F}:\n${issues.slice(0, 4000)}\nFix this now before continuing.\n` };
    }
    if (fmtNote) {
      refreshLeaseHash(F);
      return { kind: "feedback", msg: `${fmtNote} Re-read before further edits.` };
    }
  }

  // ---- settings.json guard (the ONE exception to qlty-only — qlty has no
  // JSON plugin, and a broken settings.json silently disables all settings;
  // user-approved 2026-09-15). jq, ~3ms; basename match covers project copies.
  if (basename(F) === "settings.json" && existsSync(F)) {
    const r = run("jq", ["empty", F]);
    if (!r.ok) return { kind: "block", err: `INVALID JSON in ${F}:\n${lines(r.out, 3)}\nFix this now before continuing.\n` };
  }

  // The sanctioned WRITE itself is the lease's new ground truth (owner
  // 2026-09-22: the governor integrates): refresh on every successful
  // edit — not only when a formatter happened to change more — so the
  // lease owner's NEXT edit never sees the edit's own delta as foreign.
  if (existsSync(F)) refreshLeaseHash(F);

  const note = editStreak(hook, F);
  if (note) return { kind: "context", msg: note };
  return { kind: "ok" };
}

/** `qlty fmt` in place. Returns a note when the file changed, null otherwise.
 * Repos without qlty setup (exit 99) skip silently — never blocks. */
function qltyFmt(F: string): string | null {
  const before = Bun.hash(readFileSync(F));
  const proc = Bun.spawnSync(["qlty", "fmt", "--no-upgrade-check", basename(F)], {
    cwd: dirname(F),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 99 || /must be set up/i.test(`${proc.stdout}${proc.stderr}`)) return null;
  if (!existsSync(F)) return null; // TOCTOU: gone mid-fmt
  return Bun.hash(readFileSync(F)) !== before ? `qlty-fmt: auto-fixed ${F} on save.` : null;
}

/** `qlty check` — returns the issues text, or null when clean/skipped. */
function qltyGate(F: string): string | null {
  const stillThere = () => existsSync(F);
  const proc = Bun.spawnSync(["qlty", "check", "--no-upgrade-check", basename(F)], {
    cwd: dirname(F),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${proc.stdout}${proc.stderr}`.trim();
  // exit 99 = "Qlty must be set up in this repository" — skip silently
  if (proc.exitCode === 99 || /must be set up/i.test(out)) return null;
  return proc.exitCode !== 0 && stillThere() ? out : null;
}

// Count edits per file per session; every 3rd edit nudges to verify
// (CLAUDE.md blind-edit rule: run/build/test before editing further).
function editStreak(hook: HookInput, F: string): string | null {
  const sid = hook.session_id;
  if (!sid) return null;
  const statePath = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/claude-edits-${sid}.json`;
  let counts: Record<string, number> = {};
  try { counts = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  counts[F] = (counts[F] ?? 0) + 1;
  try { writeFileSync(statePath, JSON.stringify(counts)); } catch {}
  if (counts[F] % 3 !== 0) return null;
  return `Edit #${counts[F]} to ${F.slice(F.lastIndexOf("/") + 1)} this session — verify-every-3rd-edit rule: run/build/test it now before editing further.`;
}

/** Governor interplay: a post-tool write (prettier/qlty-fmt) mutated the file
 * AFTER the governor recorded its hash — refresh the lease hash AND record the
 * observed hash in the lease's seen ring, so the owner's next edit is allowed
 * outright and a same-session retry BLESSES the write instead of denying
 * (owner 2026-09-22: the governor integrates; it only prevents blind
 * concurrent write errors). Never blocks. Lease state lives in governor.db
 * (SQLite/WAL) — busy_timeout arbitrates against concurrent gate processes. */
function refreshLeaseHash(F: string): void {
  try {
    const db = openGovernorDb();
    const rp = existsSync(F) ? realpathSync(F) : F;
    const row = db.query("SELECT path, seen FROM locks WHERE path = ? OR path = ?").get(F, rp) as
      | { path: string; seen: string | null }
      | undefined;
    if (!row) {
      db.close();
      return;
    }
    const h = createHash("sha256").update(readFileSync(F)).digest("hex").slice(0, 16);
    let seen: string[] = [];
    try {
      seen = row.seen ? (JSON.parse(row.seen) as string[]) : [];
    } catch {}
    seen = [...new Set([...seen, h])].slice(-5);
    db.query("UPDATE locks SET hash = ?, seen = ? WHERE path = ?").run(h, JSON.stringify(seen), row.path);
    db.close();
  } catch {
    // registry write failure must never block — fail open
  }
}
