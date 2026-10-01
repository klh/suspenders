// scripts/lib/jobslab.ts — W177: per-class resource ceilings for fleet lanes.
// A runaway lane could forkbomb the user machine — the don't-overtax law
// (docs/design/buckle/federation-2026-10-01.md) says heavy work lands where
// it does not overtax the system, and LLM placement already obeys it; local
// lanes now do too. Every local lane spawn drives exactly two recipes:
// spawnClaude (scripts/lib/lane.ts → dispatch-next + supervise) and
// fleet-loop's dispatch verb (claude + codex; board /api/start is a child of
// it). Both wrap the agent in a sh -c preamble: ulimit ceilings + a nice
// increment, per lane class, overridable per machine via <fleet>/jobslab.json
// (config-over-code; .fleet/ is gitignored runtime config):
//
//   { "*": { "nice": 15 }, "codex": { "maxProc": 4096 } }
//
// merge order: class defaults ← config["*"] ← config[cls]. Caps ≤ 0 or
// missing = uncapped (no ulimit fragment); nice ≤ 0 = no nice prefix (a
// non-root lane can only LOWER priority, so nice is clamped to 0..20).
//
// Darwin honesty: RLIMIT_NPROC is enforced per REAL UID, not per lane — the
// ceiling must sit above the machine's ambient process count or lanes'
// git/bun children starve with EAGAIN (~1200 ambient on the fleet's main
// box, kernel default 10666). There is NO working per-process RAM ulimit on
// darwin (-v/-m are address-space no-ops); the honest local levers are nice
// + cpu + nproc + filesize. RAM containment stays with the belt placement
// law until darwin grows a real rlimit.
import { readFileSync } from "node:fs";

export type Jobslab = {
	nice: number;
	maxProc: number;
	cpuSeconds: number;
	fileBlocks: number;
	env: Record<string, string>;
};

// WORKING = the local lane class ceiling. Values sit above ambient process
// counts (measured ~1200 on the fleet's main box) but bound a forkbomb to
// ~+800 processes; cpu 3600 = 1 CPU-hour per PROCESS (children each get
// their own budget) — a tight loop dies at SIGXCPU long before it burns a
// core-hour; file 2 GiB caps runaway single-file writes at SIGXFSZ.
const WORKING: Omit<Jobslab, "env"> = {
	nice: 10,
	maxProc: 2048,
	cpuSeconds: 3600,
	fileBlocks: 4_194_304, // 2 GiB in 512B blocks
};

export const JOBSLAB_DEFAULTS: Record<string, Jobslab> = {
	claude: { ...WORKING, env: {} },
	codex: { ...WORKING, env: {} },
	// llm:* executors are belt-routed REMOTELY — no local caps apply
	llm: { nice: 0, maxProc: 0, cpuSeconds: 0, fileBlocks: 0, env: {} },
};

/** executor string → lane class: `llm:<machine>:<model>` → "llm", else the
 *  agent name (claude|codex). Unknown classes inherit the working caps
 *  (safe by default — every LOCAL class is capped). */
export const laneClassOf = (agent: string): string =>
	agent.startsWith("llm:") ? "llm" : agent;

const clamp = {
	nice: (n: number): number => Math.min(20, Math.max(0, Math.trunc(n) || 0)),
	cap: (n: number): number => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0),
};

/** resolve the slab for a class: defaults ← <fleetDir>/jobslab.json ["*"] ←
 *  [cls]. Unreadable/missing config silently falls back to defaults — a
 *  broken config must never fail a dispatch. */
export const jobslabFor = (cls: string, fleetDir?: string): Jobslab => {
	const base = JOBSLAB_DEFAULTS[cls] ?? { ...WORKING, env: {} };
	let cfg: Record<string, Partial<Jobslab>> = {};
	if (fleetDir) {
		try {
			cfg = JSON.parse(
				readFileSync(`${fleetDir}/jobslab.json`, "utf8"),
			) as Record<string, Partial<Jobslab>>;
		} catch {}
	}
	const pick = (k: string): Partial<Jobslab> => cfg[k] ?? {};
	const m = { ...pick("*"), ...pick(cls) };
	const env = { ...base.env, ...(m.env ?? {}) };
	return {
		nice: clamp.nice(m.nice ?? base.nice),
		maxProc: clamp.cap(m.maxProc ?? base.maxProc),
		cpuSeconds: clamp.cap(m.cpuSeconds ?? base.cpuSeconds),
		fileBlocks: clamp.cap(m.fileBlocks ?? base.fileBlocks),
		env,
	};
};

/** the sh -c recipe fragment: `ulimit …; exec nice -n N ` — the caller
 *  appends the sq'd agent command. Ends in "exec " so concatenation is
 *  always valid sh; zero caps + zero nice = bare "exec " (recipe unchanged). */
export const jobslabPrefix = (js: Jobslab): string => {
	const parts: string[] = [];
	if (js.maxProc > 0) parts.push(`ulimit -u ${js.maxProc}`);
	if (js.cpuSeconds > 0) parts.push(`ulimit -t ${js.cpuSeconds}`);
	if (js.fileBlocks > 0) parts.push(`ulimit -f ${js.fileBlocks}`);
	const nice = js.nice > 0 ? `nice -n ${js.nice} ` : "";
	return `${parts.length ? `${parts.join("; ")}; ` : ""}exec ${nice}`;
};

/** lane env with the class's env caps merged in (caps override incoming). */
export const jobslabEnv = (
	js: Jobslab,
	env: Record<string, string>,
): Record<string, string> => ({
	...env,
	...js.env,
});

/** compact caps tag for DISPATCHED log lines: `claude:n10/p2048/c3600/f2g`. */
export const jobslabTag = (cls: string, js: Jobslab): string =>
	`${cls}:n${js.nice}/p${js.maxProc}/c${js.cpuSeconds}/f${js.fileBlocks}`;
