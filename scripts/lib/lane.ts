// scripts/lib/lane.ts — shared lane-spawn plumbing for the fleet scripts
// (W146). supervise.ts and dispatch-next.ts must drive IDENTICAL spawn
// recipes (env scrub, sh -c exec + stdin detach, lanes.json registry), so
// the recipes live here. dispatch-next's inline copies of the small read
// helpers (sh/run/alive/worktreeLive/loadLanes) stay until a lane can afford
// the churn — the mutation gate caps edits at 40 lines; the spawn/env core
// (the part a divergence would corrupt lanes with) is shared for real.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export type Lane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
	agent?: string;
	host?: string;
	launchedAt: number;
};

export const sh = (cmd: string[], cwd = process.cwd()): string => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
};

export const run = (
	cmd: string[],
	cwd = process.cwd(),
): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};

export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** live claude/codex process with cwd inside the worktree — pid-independent
 *  liveness, same contract-free probe fleet-loop uses for its retire guard.
 *  Takes the sh() helper as a parameter so callers keep their own cwd. */
export const worktreeLive = (
	wt: string,
	sh: (cmd: string[]) => string,
): boolean => {
	const pids = sh(["ps", "-axo", "pid=,comm="])
		.split("\n")
		.filter((l) => /claude|codex/.test(l))
		.map((l) => Number.parseInt(l.trim(), 10));
	if (pids.length === 0) return false;
	const listing = sh([
		"lsof",
		"-a",
		"-p",
		pids.join(","),
		"-d",
		"cwd",
		"-Fpcn",
	]);
	let pid = 0;
	for (const line of listing.split("\n")) {
		if (line.startsWith("p")) pid = Number.parseInt(line.slice(1), 10) || pid;
		else if (line.startsWith("n") && line.slice(1).startsWith(wt)) return true;
	}
	return false;
};

export const lanesFileFor = (fleet: string): string => `${fleet}/lanes.json`;

export const loadLanes = (fleet: string): Lane[] => {
	try {
		return JSON.parse(readFileSync(lanesFileFor(fleet), "utf8")) as Lane[];
	} catch {
		return [];
	}
};

export const saveLanes = (lanes: Lane[], fleet: string): void => {
	mkdirSync(fleet, { recursive: true });
	writeFileSync(lanesFileFor(fleet), JSON.stringify(lanes, null, 2));
};

// env: belt routing rides into the lane (the launchd plist carries
// ANTHROPIC_BASE_URL/AUTH_TOKEN); model overrides must NOT — a GLM-routed
// shell hung a lane at model init (W57), so the whole family is scrubbed.
export const MODEL_ENV_KEYS = [
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
];

export const laneEnv = (
	base: Record<string, string | undefined>,
	noBelt = false,
): Record<string, string> => {
	const env: Record<string, string> = { ...base };
	for (const k of MODEL_ENV_KEYS) delete env[k];
	if (noBelt) {
		delete env.ANTHROPIC_BASE_URL;
		delete env.ANTHROPIC_AUTH_TOKEN;
	}
	return env;
};

export const DEFAULT_ALLOWED_TOOLS =
	"Bash(git:*) Bash(bun:*) Bash(qlty:*) Bash(rg:*) Bash(eza:*) Bash(ls:*) Bash(mkdir:*) Bash(sd:*) Bash(sed:*) Bash(diff) Edit Write";

export const spawnClaude = (o: {
	bin: string;
	prompt: string;
	cwd: string;
	logFile: string;
	env: Record<string, string>;
	allowedTools?: string;
	/** Executor-specific arg tail (W223 dual-harness): copilot takes
	 * ["--allow-all-tools"], claude keeps the allowedTools recipe. */
	cliArgs?: string[];
}) => {
	const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
	const tail = (
		o.cliArgs ?? [
			"--allowedTools",
			o.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
			"--permission-mode",
			"acceptEdits",
		]
	)
		.map((a) => (a.includes(" ") ? sq(a) : a))
		.join(" ");
	// sh -c exec + stdin detach: the intermediary survives parent exit (the
	// dns-sd lesson); the log file is the board's live-tail surface.
	return Bun.spawn(
		[
			"/bin/sh",
			"-c",
			`exec ${sq(o.bin)} -p ${sq(o.prompt)} ${tail} < /dev/null >> ${sq(o.logFile)} 2>&1`,
		],
		{
			cwd: o.cwd,
			env: o.env,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		},
	);
};
