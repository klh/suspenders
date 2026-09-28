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
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { symlinkBuildDirs } from "../lib/builddirs.ts";

const argv = process.argv.slice(2);
const MODE = argv[0];
if (
	!MODE ||
	!["once", "watch", "lanes", "dispatch", "ship"].includes(MODE) ||
	!argv.includes("--repo")
) {
	console.error(
		`usage: fleet-loop once|watch|lanes|dispatch|ship --repo <dir> [--glob lane/autow*] [--main main]\n` +
			`          [--ladder <cmd template with {branch}>]  default: plain git merge --no-ff\n` +
			`          [--ladder-timeout 10]                    minutes; watchdog-kills a hung ladder\n` +
			`          [--dispatch-cmd <template>]              optional policy script\n` +
			`          [--agent claude|codex]                   dispatch backend (default claude)\n` +
			`          ship --branch <branch>                   one branch through the ladder (board ship trigger)\n` +
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
const AGENT = val("--agent", "claude");
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
	agent?: string;
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

// retire's runs capture stderr — a RETIRE-BLOCKED line must carry git's
// reason (the loop's own "reasonless FAIL is a bug" doctrine)
const runCap = (cmd: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};

/** Actual worktree path checked out at branch b, from git's registry —
 *  gaps parks lanes under .claude/worktrees/ (not .worktrees/), so the
 *  default-path guess misses them and branch delete stalls on "used by
 *  worktree" (autow294.1, 2026-09-28). */
function wtPathFromGit(b: string): string | null {
	const out = sh(["git", "worktree", "list", "--porcelain"]);
	let path: string | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch ")) {
			if (line.slice("branch ".length).trim() === `refs/heads/${b}` && path)
				return path;
		}
	}
	return null;
}

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
	// worktree path: git's registry is ground truth — gaps parks lanes under
	// .claude/worktrees/ (not .worktrees/), so the bare default guess misses
	// them and branch delete stalls on "used by worktree"
	const wt =
		wtPathFromGit(b) ??
		tracked?.worktree ??
		`${REPO}/.worktrees/${b.replace(/^.*\//, "")}`;
	// mid-spawn grace (2026-09-28 gaps autow298/299): dispatch registers the
	// branch immediately but gaps' async wrapper lands the lanes.json entry
	// 22–55s later — the ladder saw ahead=0 with NO entry, the pid guard had
	// nothing to check, and retire fired on a lane mid-spawn. A seconds-old
	// (or missing) worktree with no commits is ambiguous; ambiguity defers
	// to don't-touch: skip retire under a 10-min worktree-age grace.
	if (!tracked) {
		const st = statSync(wt, { throwIfNoEntry: false });
		if (Date.now() - (st?.birthtimeMs ?? Date.now()) < 10 * 60_000) return;
	}
	if (existsSync(wt)) {
		let rm = runCap(["git", "worktree", "remove", "--force", wt]);
		if (rm.code !== 0) {
			// stale worktree registration (git's metadata outlived a dead lane) —
			// prune and retry once; a second failure is logged with git's reason
			runCap(["git", "worktree", "prune"]);
			rm = runCap(["git", "worktree", "remove", "--force", wt]);
		}
		if (rm.code !== 0)
			log(
				`RETIRE-STALL ${b} — worktree remove failed: ${rm.out.split("\n").slice(-2).join(" | ")}`,
			);
	}
	const delD = runCap(["git", "branch", "-d", b]);
	const del = delD.code === 0 ? null : runCap(["git", "branch", "-D", b]);
	if (delD.code === 0 || (del && del.code === 0)) log(`RETIRED ${b}`);
	else
		log(
			`RETIRE-BLOCKED ${b} — branch delete failed: ${del ? del.out.split("\n").slice(-2).join(" | ") : "?"}`,
		);
}

// a failed ladder: abort the merge, log the tail, count the strike, park at 3
function mergeFail(b: string, tail: string): void {
	// a failed ladder leaves MERGE_HEAD behind — abort it; NEVER reset --hard
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) run(["git", "merge", "--abort"]);
	log(
		`FAIL ${b} — ladder failed, merge aborted, branch left for inspection${tail ? `: ${tail}` : ""}`,
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

// one branch through the ladder — the cycle's per-branch body, shared with
// the board's one-click ship (`ship --branch <b>` runs it foreground).
// Fail-isolated: a failed ladder aborts the merge, leaves the branch for
// inspection, and counts toward the 3-strike park like every other merge.
function mergeOne(b: string): void {
	if (ahead(b) === 0) {
		retireMerged(b);
		return;
	}
	// liveness marker: a crash between --no-commit and commit leaves
	// MERGE_HEAD + staged debris that plain merge --abort cannot clear (the
	// 2026-09-28 gaps stall). The marker tells the next cycle whether a
	// merge runner is genuinely alive or the state is debris.
	const marker = `${REPO}/.fleet/merge-active`;
	writeFileSync(
		marker,
		JSON.stringify({ pid: process.pid, branch: b, ts: Date.now() }),
	);
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
		mergeFail(b, mv.tail);
	}
	try {
		rmSync(`${REPO}/.fleet/merge-active`);
	} catch {}
	retireMerged(b);
}

/** pid of a live merge runner, or null. A stale marker (dead pid, or older
 * than 30 min — a watchdog-killed runner whose unlink never ran) reads as
 * debris. */
function mergeRunnerAlive(): number | null {
	try {
		const j = JSON.parse(
			readFileSync(`${REPO}/.fleet/merge-active`, "utf8"),
		) as { pid: number; ts: number };
		if (Date.now() - j.ts > 30 * 60_000) return null;
		process.kill(j.pid, 0);
		return j.pid;
	} catch {
		return null;
	}
}

async function cycle(): Promise<void> {
	// 1. never enter a cycle with leftover merge state. MERGE_HEAD is either
	// a LIVE merge (another runner mid-flight — hands off) or crashed-run
	// debris (heal: surgical abort, guarded reset as last resort).
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		const live = mergeRunnerAlive();
		if (live) log(`MERGE in progress by pid ${live} — cycle leaves it alone`);
		else healCrashedMerge();
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
	for (const b of branches) mergeOne(b);

	// 3. refill the fleet — policy lives in the repo's dispatch script
	if (DISPATCH) runTemplate(DISPATCH, "", LADDER_TIMEOUT_MS);
}

/** Recover a crashed merge: a dead runner left MERGE_HEAD + staged debris.
 * SURGICAL FIRST — restore only STAGED paths (index column of porcelain) to
 * the index, which is what blocks merge --abort; unstaged paths may be a
 * bystander session's WIP and are never touched. Guarded reset --hard is
 * the last resort, loud, and only when no live runner exists. */
function healCrashedMerge(): void {
	const head = sh(["git", "rev-parse", "--short", "MERGE_HEAD"]) || "?";
	const branch = sh(["git", "name-rev", "--name-only", "MERGE_HEAD"]) || head;
	const staged = sh(["git", "status", "--porcelain"])
		.split("\n")
		.filter((l) => l.length > 3 && l[0] !== " " && l[0] !== "?")
		.map((l) => l.slice(3).trim());
	if (staged.length)
		run([
			"git",
			"checkout",
			"--",
			...staged.map((p) => p.split(" -> ").pop() ?? p),
		]);
	const ab = runCap(["git", "merge", "--abort"]);
	if (ab.code === 0) {
		log(
			`SELF-HEAL crashed merge of ${branch} (${head}): restored ${staged.length} staged path(s) to the index, aborted cleanly`,
		);
		return;
	}
	run(["git", "reset", "--hard"]);
	log(
		`SELF-HEAL crashed merge of ${branch} (${head}): surgical abort failed (${ab.out.slice(0, 120)}), discarded staged debris via guarded reset --hard`,
	);
}

// dispatch: one Work Graph item → claimed, worktree, briefed headless lane.
// The fleet's own spawner — the coordinator dispatches a single item; the
// loop's pid guard, lanes verb, and retire lifecycle cover the result.
if (MODE === "dispatch") {
	const item = val("--item");
	if (!item) {
		console.error("dispatch requires --item <Wn>");
		process.exit(1);
	}
	if (AGENT !== "claude" && AGENT !== "codex") {
		console.error("dispatch --agent must be claude or codex");
		process.exit(1);
	}
	const sid = `autow${item.replace(/^W/, "").replace(/\./g, "")}`;
	const wt = `${REPO}/.worktrees/${item}`;
	// live-lane guard: a running lane still owns its worktree — refuse. An
	// existing worktree with NO live lane is reused (resume path).
	const live = lanes().find((l) => l.sid === sid);
	if (live?.pid) {
		let alive = false;
		try {
			process.kill(live.pid, 0);
			alive = true;
		} catch {}
		if (alive) {
			console.error(`lane ${sid} already running (pid ${live.pid})`);
			process.exit(1);
		}
	}
	const runTool = (args: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync([process.execPath, ...args], {
			cwd: REPO,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
		};
	};
	const take = runTool([
		`${process.env.HOME}/.claude/hooks/suspenders/bin/work.ts`,
		"take",
		item,
		"--as",
		sid,
		"--origin",
		`${hostname()}:${AGENT}`,
	]);
	if (take.code !== 0) {
		const mine = runTool([
			`${process.env.HOME}/.claude/hooks/suspenders/bin/work.ts`,
			"show",
			item,
		]);
		if (!mine.out.includes(sid)) {
			console.error(`work take failed and not ours: ${take.out}`);
			process.exit(1);
		} // claimed by us from a previous dispatch attempt — resume
	}
	// reuse path: an existing worktree (dead lane's leftover) is used as-is —
	// only a missing one is created. Codex workspaces are NOT git worktrees:
	// a plain dir whose .git file points at the private store (see below).
	if (!existsSync(wt)) {
		if (AGENT === "codex") {
			mkdirSync(wt, { recursive: true });
			// build dirs symlinked from the repo root — parity with worktree.ts
			// create, so codex lanes skip reinstalls too
			symlinkBuildDirs(REPO, wt);
		} else {
			const wtree = runTool([
				`${process.env.HOME}/.claude/hooks/suspenders/bin/worktree.ts`,
				"create",
				item,
			]);
			if (wtree.code !== 0) {
				console.error(`worktree create failed: ${wtree.out}`);
				process.exit(1);
			}
		}
	}
	const branch =
		Bun.spawnSync(["git", "-C", wt, "branch", "--show-current"], {
			cwd: REPO,
			stdout: "pipe",
		})
			.stdout?.toString()
			.trim() || `suspenders/${item}`;
	const show = runTool([
		`${process.env.HOME}/.claude/hooks/suspenders/bin/work.ts`,
		"show",
		item,
	]);
	const brief = [
		`You are lane "${sid}", Work Graph item ${item}, repo ${REPO}.`,
		``,
		`MISSION (from work show):`,
		show.out,
		``,
		`PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it (plan-first, shatter judgment, gates, done protocol, final-line vocabulary).`,
		`Work in the EXISTING worktree ${wt} (branch ${branch}).`,
		`Finish: bun ~/.claude/hooks/suspenders/bin/work.ts done ${item} --sha <branch-head>.`,
		`Final line: DONE <sha> | SPLIT ${item} | BLOCKED (after 3 honest attempts, tree restored).`,
	].join("\n");
	mkdirSync(`${REPO}/.fleet`, { recursive: true });
	const briefFile = `${REPO}/.fleet/brief-${sid}.md`;
	writeFileSync(briefFile, brief);
	const env = { ...process.env };
	delete env.ANTHROPIC_BASE_URL;
	delete env.ANTHROPIC_AUTH_TOKEN;
	if (AGENT === "codex") {
		env.GIT_DIR = `${wt}/.gitstore`;
		env.GIT_WORK_TREE = wt;
		// W73: the fleet sid rides the lane env — hooks inherit it, making
		// SUSPENDERS_SID the primary identity channel for the codex adapter
		// (ppid-walk into lanes.json stays the fallback, lib/fleetlane.ts).
		env.SUSPENDERS_SID = sid;
	}
	const prompt = `Read ${briefFile} and execute it fully.`;
	// the agent binary resolves at dispatch time — a bare name ENOENTs under
	// launchd, where PATH is minimal
	const bin = Bun.which(AGENT);
	if (!bin) {
		console.error(`${AGENT} binary not found on PATH`);
		process.exit(1);
	}
	// W73 gate wiring: idempotent merge-not-clobber into ~/.codex/hooks.json
	// right before the lane starts, after the binary check (a missing binary
	// must fail dispatch with its own error, not a wiring one). A failed wire
	// aborts — never a silent gate-less lane (W68 degradation rule).
	if (AGENT === "codex") {
		const wire = Bun.spawnSync(
			[process.execPath, `${import.meta.dir}/gate-wire-codex.ts`],
			{
				cwd: REPO,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (wire.exitCode !== 0) {
			console.error(
				`codex gate wiring failed: ${new TextDecoder().decode(wire.stderr ?? new Uint8Array()).trim()}`,
			);
			process.exit(1);
		}
	}
	// codex lanes: codex's seatbelt denies every write into any .git
	// directory (name-based, verified empirically 2026-09-28), so the standard
	// worktree layout (admin dir + objects under REPO/.git) can never commit.
	// The lane gets a PRIVATE git store under a non-.git name inside its
	// workspace, wired with GIT_DIR/GIT_WORK_TREE env: main-repo objects are
	// shared read-only via alternates; the lane's own objects/refs land in
	// the private store — the main object db stays seatbelt-protected.
	if (AGENT === "codex") {
		const store = `${wt}/.gitstore`;
		if (!existsSync(`${store}/HEAD`)) {
			Bun.spawnSync(["git", "init", "--quiet", "--bare", store]);
			const g = (args: string[]): void => {
				Bun.spawnSync(["git", "--git-dir", store, ...args], {
					cwd: REPO,
					stdout: "ignore",
					stderr: "ignore",
				});
			};
			g(["config", "core.bare", "false"]);
			g(["config", "core.worktree", wt]);
			writeFileSync(
				`${store}/objects/info/alternates`,
				`${REPO}/.git/objects\n`,
			);
			g([
				"update-ref",
				`refs/heads/suspenders/${item}`,
				sh(["git", "-C", REPO, "rev-parse", MAIN]),
			]);
			g(["symbolic-ref", "HEAD", `refs/heads/suspenders/${item}`]);
			g(["reset", "--hard", "--quiet"]);
			g([
				"remote",
				"add",
				"origin",
				sh(["git", "-C", REPO, "remote", "get-url", "origin"]),
			]);
			// loud, never silent: verify the store landed on the lane's branch
			// before spawning anyone (unborn main = lane can push origin main)
			const head = Bun.spawnSync(
				["git", "--git-dir", store, "symbolic-ref", "--short", "HEAD"],
				{ stdout: "pipe" },
			)
				.stdout?.toString()
				.trim();
			if (head !== `suspenders/${item}`) {
				console.error(
					`codex store init failed: HEAD=${head || "unborn"} — inspect ${store}`,
				);
				process.exit(1);
			}
		}
		writeFileSync(`${wt}/.git`, `gitdir: ${store}\n`);
	}
	const agentArgs =
		AGENT === "codex"
			? // full access — owner directive 2026-09-28: codex lanes are
				// EQUIVALENT to claude lanes (same trust class, unsandboxed).
				// The seatbelt structurally denies git writes, which forked the
				// protocol into lane-commits vs coordinator-commits; one
				// approach, two backends. The private git store stays: even
				// unsandboxed, a codex lane's commits never touch the main
				// object db until the coordinator merges.
				["exec", "--sandbox", "danger-full-access", prompt]
			: [
					"-p",
					prompt,
					"--allowedTools",
					"Bash(git:*) Bash(bun:*) Bash(qlty:*) Bash(rg:*) Bash(eza:*) Bash(ls:*) Bash(mkdir:*) Bash(sd:*) Bash(sed:*) Bash(diff) Edit Write",
					"--permission-mode",
					"acceptEdits",
				];
	// both agents spawn through sh -c exec: the intermediary survives parent
	// exit (codex dies under direct detached Bun spawn — the dns-sd lesson
	// again) and < /dev/null gives codex the stdin EOF it blocks on. The lane
	// log file is the live-tail surface for the board.
	const sq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
	const laneLog = `${REPO}/.fleet/lane-${sid}.log`;
	const proc = Bun.spawn(
		[
			"/bin/sh",
			"-c",
			`exec ${sq(bin)} ${agentArgs.map(sq).join(" ")} < /dev/null >> ${sq(laneLog)} 2>&1`,
		],
		{ cwd: wt, env, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
	);
	proc.unref();
	const entry = {
		sid,
		item,
		pid: proc.pid,
		branch,
		worktree: wt,
		agent: AGENT,
		host: hostname(),
		launchedAt: Date.now(),
	};
	const all = lanes().filter((l) => l.sid !== sid);
	all.push(entry);
	writeFileSync(`${REPO}/.fleet/lanes.json`, JSON.stringify(all, null, 2));
	log(`DISPATCHED ${item} → ${sid} (pid ${proc.pid}, ${branch})`);
	console.log(`dispatched ${item} → ${sid} (pid ${proc.pid})`);
	process.exit(0);
}

// ship: one branch through the ladder NOW — the board's one-click ship
// trigger (W64, fleet-board /api/ship). A foreground single-shot of the
// cycle's merge step: same MERGE_HEAD abort, ladder timeout, FAIL tail,
// strike/park discipline, retire lifecycle. The branch need not match
// --glob (explicit intent); the BOARD resolves the ladder from the repo's
// .fleet/ship.json and passes it here — the loop shell stays policy-free.
if (MODE === "ship") {
	const b = val("--branch");
	if (!b) {
		console.error("ship requires --branch <branch>");
		process.exit(1);
	}
	// never enter with leftover merge state (same as cycle step 1)
	if (existsSync(`${REPO}/.git/MERGE_HEAD`)) {
		run(["git", "merge", "--abort"]);
		log("ABORT leftover MERGE_HEAD");
	}
	mergeOne(b);
	process.exit(0);
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
			`${alive ? "ALIVE" : "dead "}  ${l.item.padEnd(10)} ${l.sid.padEnd(16)} pid ${String(l.pid).padEnd(8)} ${(l.agent ?? "claude").padEnd(7)} ${l.branch}`,
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
