#!/usr/bin/env bun
// quota-window.ts — track z.ai/GLM 5-hour quota windows from observed 429
// resets, so long lane batches get deferred away from the cliff.
// Reset timestamps are parsed out of the auto-mode classifier's 429 log and
// remembered in a state file (windows chain from each observed reset).
//
//   bun hooks/bin/quota-window.ts            # status; exit 0 safe / 1 near cliff / 2 unknown
//   bun hooks/bin/quota-window.ts --margin 45
//
// quotaWindowVerdict() is exported as the in-process seam for callers that
// need the verdict without a subprocess (dispatch checks, degradation status). CLI output and exit codes
// are byte-identical to the pre-refactor script.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

const STATE = `${process.env.HOME}/.cache/claude-governor/quota-window.json`;
const PROJECTS = `${process.env.HOME}/.claude/projects`;
const WINDOW_MS = 5 * 3600_000;

export type QuotaVerdict = {
  code: 0 | 1 | 2; // 0 safe / 1 near cliff / 2 unknown
  expiry: number | null; // predicted reset (epoch ms) when known
  leftMin: number | null;
  lines: string[];
};

// harvest "reset at 2026-09-24 17:43:32" lines from every session's
// classifier-error log (the harness rotates them, so scan them all)
export function harvestResets(projectsDir = PROJECTS): number[] {
  const resets: number[] = [];
  try {
    for (const proj of readdirSync(projectsDir)) {
      for (const e of readdirSync(`${projectsDir}/${proj}`).filter((f) => f.endsWith("classifier-error.txt"))) {
        const txt = readFileSync(`${projectsDir}/${proj}/${e}`, "utf8").slice(-200_000); // tail only
        for (const m of txt.matchAll(/reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g)) {
          resets.push(new Date(m[1].replace(" ", "T") + "+00:00").getTime());
        }
      }
    }
  } catch {}
  return resets;
}

export function quotaWindowVerdict(opts: { now?: number; marginMs?: number; extraResets?: number[] } = {}): QuotaVerdict {
  const now = opts.now ?? Date.now();
  const margin = opts.marginMs ?? 45 * 60_000;
  const resets = harvestResets();
  const prev = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as { resets?: number[] }) : {};
  const all = [...new Set([...(prev.resets ?? []), ...resets, ...(opts.extraResets ?? [])])].sort((a, b) => a - b);
  mkdirSync(`${process.env.HOME}/.cache/claude-governor`, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ resets: all.slice(-20) }));
  // each observation is an EXPIRY (the 429 names when quota returns), not a start
  const expiry = all.find((r) => r > now) ?? null;
  if (!expiry) {
    return {
      code: 2,
      expiry: null,
      leftMin: null,
      lines: ["quota window: UNKNOWN — no future expiry observed; a new 5-h window starts on first use and any 429 will name its end"],
    };
  }
  const leftMin = Math.round((expiry - now) / 60000);
  const startedMin = Math.round(WINDOW_MS / 60000) - leftMin;
  const lines = [`quota window: ~${leftMin} min left (expires ${new Date(expiry).toISOString()}, ~${startedMin} min into the window)`];
  if (leftMin * 60_000 <= margin) {
    lines.push(`within ${Math.round(margin / 60000)}-min margin — DEFER long batch jobs / lane restarts until after the reset`);
    return { code: 1, expiry, leftMin, lines };
  }
  lines.push("safe to run long batches");
  return { code: 0, expiry, leftMin, lines };
}

if (import.meta.main) {
  const argv = process.argv;
  const margin = Number(argv.includes("--margin") ? argv[argv.indexOf("--margin") + 1] : 45) * 60_000;
  // manual observations survive log rotation: quota-window.ts note "reset at <time>"
  const noteArg = argv[2] === "note" ? argv.slice(3).join(" ") : "";
  const noteReset: number[] = [];
  if (noteArg) {
    const m = noteArg.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (m) noteReset.push(new Date(m[1].replace(" ", "T") + "+00:00").getTime());
  }
  const v = quotaWindowVerdict({ marginMs: margin, extraResets: noteReset });
  for (const l of v.lines) console.log(l);
  process.exit(v.code);
}
