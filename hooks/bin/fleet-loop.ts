#!/usr/bin/env bun
// fleet-loop.ts — the generic merge/dispatch loop lifted from gaps'
// dk.threads.gaps-fleet-loop (W59): the loop SHELL is fleet machinery, the
// merge LADDER and dispatch POLICY stay per-repo, invoked as child scripts.
//
//   bun fleet-loop.ts once  --repo <dir> [options]
//   bun fleet-loop.ts watch --repo <dir> [options]
//
// Each cycle:
//   1. abort leftover merge state
//   2. merge every branch matching --glob that is ahead of --main, through
//      the ladder child (--ladder template with {branch}; default: plain
//      git merge --no-ff)
//   --dispatch-cmd <template> runs once per cycle after merges (policy lives there)
//   3. retire merged branches' worktree + branch (pid-guarded, honest RETIRE-BLOCKED)
//
// Hardened per the gaps incidents (2026-09-28): cycles run as killable --once
// children under a watchdog (a hung spawnSync froze the gaps daemon 26h);
// FAIL lines carry the ladder's last 3 output lines (a pnpm-ENOENT cascade
// was invisible for an hour); 3-strike PARK; live-lane pid guard on retire;
// MERGE_HEAD abort, never reset --hard on a shared checkout.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";

const argv = process.argv.slice(2);
const MODE = argv[0];
if (
	!MODE ||
	!["once", "watch", "lanes"].includes(MODE) ||
	!argv.includes("--repo")
) {
	console.error(
		`usage: fleet-loop once|watch|lanes --repo <dir> [--glob lane/autow*] [--main main]\n` +
			`          [--ladder <cmd template with {branch}>]  default: plain git merge --no-ff\n` +
			`          [--ladder-timeout 10]                    minutes; watchdog-kills a hung ladder\n` +
			`          [--dispatch-cmd <template>]              optional policy script\n` +
			`          [--every 120] [--cycle-timeout 15] [--log <file>]   (watch mode)\n`,
	);
	process.exit(MODE ? 1 : 0);
}
const val = (flag: string, dflt?: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : dflt;
};
const num = (flag: string, dflt: number): number =>
	Number(val(flag, String(dflt)));

const REPO = val("--repo");
if (!REPO) process.exit(1); // usage block above already explained
const MAIN = val("--main", "main");
const GLOB = val("--glob", "lane/autow*");
const LADDER = val("--ladder");
const LADDER_TIMEOUT_MS = num("--ladder-timeout", 10) * 60_000;
const DISPATCH = val("--dispatch-cmd");
const EVERY_MS = num("--every", 120) * 1000;
const CYCLE_TIMEOUT_MS = num("--cycle-timeout", 15) * 60_000;
const LOG = val("--log", `${REPO}/.fleet/loop.log`);
const FAILS = `${REPO}/.fleet/merge-fails.json`;
const LANES_JSON = `${REPO}/.fleet/lanes.json`;

const log = (msg: string): void => {
	const line = `${new Date().toISOString()} ${msg}\n`;
	try {
		appendFileSync(LOG, line);
	} catch {
		try {
			mkdirSync(LOG.replace(/\/[^/]+$/, ""), { recursive: true });
			appendFileSync(LOG, line);
		} catch {}
	}
};

const sh = (cmd: string[]): string => {
	const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
};
const run = (cmd: string[]): number =>
	Bun.spawnSync(cmd, { cwd: REPO, stdout: "ignore", stderr: "ignore" })
		.exitCode ?? 1;

type Lane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
};

function readJsonSync<T>(p: string): T | null {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
}

const lanes = (): Lane[] => readJsonSync(LANES_JSON) ?? [];
const readFails = (): Record<string, number> => readJsonSync(FAILS) ?? {};
const writeFails = (o: Record<string, number>): void => {
	try {
		writeFileSync(FAILS, JSON.stringify(o));
	} catch {}
};
const bumpFail = (b: string): number => {
	const o = readFails();
	o[b] = (o[b] ?? 0) + 1;
	writeFails(o);
	return o[b];
};
const clearFail = (b: string): void => {
	const o = readFails();
	if (o[b] === undefined) return;
	delete o[b];
	writeFails(o);
};

// the ladder and dispatch commands are repo-OWNER config (same trust class as
// a Makefile): {branch} is substituted, then the template runs via sh -c in
// the repo dir — see docs/fleet-loop.md.
const runTemplate = (
	template: string,
	branch: string,
	timeoutMs: number,
): { code: number; tail: string } => {
	const cmd = template.split("{branch}").join(branch);
	const p = Bun.spawnSync(["/bin/sh", "-c", cmd], {
		cwd: REPO,
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	const tail =
		`${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-3)
			.join(" | ");
	return { code: p.exitCode ?? 1, tail };
};

const ahead = (b: string): number =>
	Number(sh(["git", "rev-list", "--count", `${MAIN}..${b}`]) || "0");

function retireMerged(b: string): void {
	if (ahead(b) !== 0) return;
	// ahead=0 is also true for a freshly-dispatched lane's pre-commit branch —
	// never retire a branch a LIVE lane still owns
	const tracked = lanes().find((l) => l.branch === b);
	if (tracked?.pid) {
		let alive = false;
		try {
			process.kill(tracked.pid, 0);
			alive = true;
		} catch {}
		if (alive) return;
	}
	const wt =
		tracked?.worktree ?? `${REPO}/.worktrees/${b.replace(/^.*\//, "")}`;
	if (existsSync(wt)) run(["git", "worktree", "remove", "--force", wt]);
	const deleted =
		run(["git", "branch", "-d", b]) === 0 ||
		run(["git", "branch", "-D", b]) === 0;
	if (deleted) log(`RETIRED ${b}`);
	else log(`RETIRE-BLOCKED ${b} — branch delete failed, inspect manually`);
}

async function cycle(): Promise<void> {
	// 1. never enter a cycle with leftover merge state
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		run(["git", "merge", "--abort"]);
		log("ABORT leftover MERGE_HEAD");
	}

	// 2. merge every ahead branch through the ladder (fail-isolated per branch)
	const branches = sh([
		"git",
		"branch",
		"--list",
		GLOB,
		"--format",
		"%(refname:short)",
	])
		.split("\n")
		.filter(Boolean);
	for (const b of branches) {
		if (ahead(b) === 0) {
			retireMerged(b);
			continue;
		}
		const before = sh(["git", "rev-parse", "--short", "HEAD"]);
		const mv = LADDER
			? runTemplate(LADDER, b, LADDER_TIMEOUT_MS)
			: {
					code: run(["git", "merge", "--no-ff", b, "-m", `Merge ${b}`]),
					tail: "",
				};
		if (mv.code === 0) {
			const after = sh(["git", "rev-parse", "--short", "HEAD"]);
			log(`MERGED ${b} ${before}→${after}`);
			clearFail(b);
		} else {
			// a failed ladder leaves MERGE_HEAD behind — abort it; NEVER reset --hard
			if (existsSync(`${REPO}/.git/MERGE_HEAD`))
				run(["git", "merge", "--abort"]);
			log(
				`FAIL ${b} — ladder failed, merge aborted, branch left for inspection${mv.tail ? `: ${mv.tail}` : ""}`,
			);
			const n = bumpFail(b);
			if (n >= 3) {
				const parked = b.replace(/^([^/]+)\//, "parked/");
				run(["git", "branch", "-m", b, parked]);
				log(
					`PARKED ${b} → ${parked} after ${n} failed ladder attempts — needs a repair lane`,
				);
				clearFail(b);
			}
		}
		retireMerged(b);
	}

	// 3. refill the fleet — policy lives in the repo's dispatch script
	if (DISPATCH) runTemplate(DISPATCH, "", LADDER_TIMEOUT_MS);
}

// lanes: the liveness table from .fleet/lanes.json — who's alive, who died
// without the loop noticing (the check gaps ran ad-hoc after the flip)
if (MODE === "lanes") {
	const rows = lanes();
	if (rows.length === 0) {
		console.log("no lanes in .fleet/lanes.json");
		process.exit(0);
	}
	for (const l of rows) {
		let alive = false;
		try {
			process.kill(l.pid, 0);
			alive = true;
		} catch {}
		console.log(
			`${alive ? "ALIVE" : "dead "}  ${l.item.padEnd(10)} ${l.sid.padEnd(16)} pid ${String(l.pid).padEnd(8)} ${l.branch}`,
		);
	}
	process.exit(0);
}

if (MODE === "once") {
	await cycle();
	process.exit(0);
}

// watch: each cycle is a killable --once child under a watchdog timer
log(
	`fleet-loop start pid=${process.pid} repo=${REPO} glob=${GLOB} every=${EVERY_MS / 1000}s watchdog=${CYCLE_TIMEOUT_MS / 60000}min`,
);
while (true) {
	const child = Bun.spawn(
		[process.execPath, import.meta.path, "once", ...argv.slice(1)],
		{ cwd: REPO, stdout: "inherit", stderr: "inherit", stdin: "ignore" },
	);
	const timer = setTimeout(() => {
		log(
			`WATCHDOG killed cycle pid=${child.pid} after ${CYCLE_TIMEOUT_MS / 60000}min — hung spawn/gate`,
		);
		try {
			child.kill(9);
		} catch {}
	}, CYCLE_TIMEOUT_MS);
	await child.exited;
	clearTimeout(timer);
	await Bun.sleep(EVERY_MS);
}
