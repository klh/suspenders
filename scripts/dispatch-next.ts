#!/usr/bin/env bun
// dispatch-next.ts — suspenders refills its own fleet (W145, "eat own dog
// food"). The POLICY half of the dispatch loop: pick READY unblocked items
// from the Work Graph, brief a headless lane, spawn it daemonized. The
// plumbing conventions (worktree, lanes.json, DISPATCHED log line, env
// scrub) mirror `hooks/bin/fleet-loop.ts dispatch` so the loop's pid guard,
// retire lifecycle, and `lanes` verb cover the lanes we spawn; the brief
// adds what the fleet needs to be self-resuming:
//
//   - capsule protocol  — lanes bank a ≤10-line continuation capsule at every
//     work-unit boundary (`coord capsule set/get`, hooks/bin/coord.ts); the
//     LAST capsule stands as the hand-off.
//   - landing chain     — commit → work done --sha → coord fact set finding.
//   - resume path       — alive lane: reachable via its sid on the graph
//     (owner_sid + coord inbox). Dead lane: re-dispatch reuses the sid,
//     reads the capsule + item state, and returns them as RESUME CONTEXT.
//
//   bun scripts/dispatch-next.ts [--repo <dir>] [--target N] [--dry-run]
//                                [--item Wn] [--no-belt]
//                                [--show-capsule <sid>]
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { laneEnv, spawnClaude } from "./lib/lane.ts";
import { jobslabFor, jobslabTag, laneClassOf } from "./lib/jobslab.ts";

const argv = process.argv.slice(2);
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const TARGET = Number(val("--target") ?? 3);
const REPO = val("--repo") ?? process.cwd();
const DRY = argv.includes("--dry-run");
const NO_BELT = argv.includes("--no-belt");
const SHOW_CAPSULE = val("--show-capsule");
const BIN = `${process.env.HOME}/.claude/hooks/suspenders/bin`;
const FLEET = `${REPO}/.fleet`;
const LANES_JSON = `${FLEET}/lanes.json`;
const LOOP_LOG = `${FLEET}/loop.log`;

type Lane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
	agent?: string;
	host?: string;
	slab?: string;
	launchedAt: number;
};

const sh = (cmd: string[], cwd = REPO): string => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
};
const run = (cmd: string[], cwd = REPO): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const log = (msg: string): void => {
	mkdirSync(FLEET, { recursive: true });
	appendFileSync(LOOP_LOG, `${new Date().toISOString()} ${msg}\n`);
};
const loadLanes = (): Lane[] => {
	try {
		return JSON.parse(readFileSync(LANES_JSON, "utf8")) as Lane[];
	} catch {
		return [];
	}
};
const saveLanes = (lanes: Lane[]): void => {
	mkdirSync(FLEET, { recursive: true });
	writeFileSync(LANES_JSON, JSON.stringify(lanes, null, 2));
};

/** live claude/codex process with cwd inside the worktree — pid-independent
 *  liveness, same contract-free probe fleet-loop uses for its retire guard. */
const worktreeLive = (wt: string): boolean => {
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

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** parse `work ready` rows (renderRow format, ANSI-stripped): glyph, id,
 *  truncated title. The title is for gating/log lines only — the brief must
 *  carry the FULL spec from `work show` (gaps W279 phantom-lane lesson). */
export const parseReady = (stdout: string): { id: string; title: string }[] =>
	stdout
		.replace(ANSI, "")
		.split("\n")
		.map((l) => /^\s*·\s+(W[\d.]+)\s+(.+)$/.exec(l.trimEnd()))
		.map((m) => (m ? { id: m[1], title: m[2].trim() } : null))
		.filter((x): x is { id: string; title: string } => !!x);

/** decision-gated items never ride the automagic — they surface to the owner. */
export const isOwnerGated = (title: string): boolean =>
	/OWNER-GATED|OWNER GATE|\bGATED\b|\bHELD\b|NEED_DECISION|\bDECISION\b|PAUSED/i.test(
		title,
	);

/** `coord capsule get --as <sid>` output → parsed capsule, or null when the
 *  lane has none. (Bare `capsule get <sid>` misparses the sid as "get" —
 *  always pass --as.) */
export const parseCapsuleGet = (
	stdout: string,
): Record<string, string> | null => {
	const line = stdout.replace(ANSI, "").trim();
	if (!line || line.includes("(no capsule)")) return null;
	try {
		const c = JSON.parse(line) as Record<string, string>;
		return typeof c === "object" && c !== null ? c : null;
	} catch {
		return null;
	}
};

const capsuleGet = (sid: string): Record<string, string> | null =>
	parseCapsuleGet(
		sh([process.execPath, `${BIN}/coord.ts`, "capsule", "get", "--as", sid]),
	);

/** the mission brief. Everything a headless lane needs: full item spec,
 *  capsule protocol, landing chain, sid + how it gets resumed. Resume runs
 *  embed the dead lane's last capsule as RESUME CONTEXT. */
export const composeBrief = (o: {
	item: string;
	showOut: string;
	sid: string;
	branch: string;
	worktree: string;
	capsule: Record<string, string> | null;
	repo?: string;
	aids?: string[];
	extra?: string[];
}): string => {
	const parts = [
		`You are lane "${o.sid}", Work Graph item ${o.item}, repo ${o.repo ?? REPO}. English only.`,
		``,
		`MISSION (from work show):`,
		o.showOut.replace(ANSI, "").trim(),
		``,
		`PROTOCOL: BEFORE any edit, read AGENTS.md in the repo root and follow it (plan-first, shatter judgment, gates, done protocol, final-line vocabulary).`,
		`Inbox: before planning and again before finishing, check bun ${BIN}/coord.ts inbox --as ${o.sid} — coordinator and board messages arrive there.`,
		`Work in the EXISTING worktree ${o.worktree} (branch ${o.branch}).`,
		``,
		`CAPSULE PROTOCOL — resumable lanes: at every work-unit boundary (a gate passed, a commit landed, before any pause) bank a ≤10-line capsule:`,
		`  bun ${BIN}/coord.ts capsule set --as ${o.sid} --checkpoint=<branch-head-sha|none> --file="<anchor path:line>" --done="<done so far>" --next="<next step>"`,
		`The LAST capsule stands as the hand-off: if this lane dies, the next dispatch resumes from it. A stale or missing capsule strands the work.`,
		``,
		`RESUME PATH: while your process is alive you are reachable via your sid — it is the item's owner_sid on the graph, and coord inbox --as ${o.sid} reaches you. If you die mid-item, the fleet loop re-dispatches the SAME sid, reads your latest capsule, and returns it below as RESUME CONTEXT. Reconcile with it and the worktree state — never restart blind.`,
		``,
		`LANDING CHAIN (all three, in order):`,
		`1. commit on ${o.branch} (subject starts with the item id) — land a checkpoint commit early; a zero-commit branch is indistinguishable from debris to the reaper.`,
		`2. bun ${BIN}/work.ts done ${o.item} --sha <branch-head> --as ${o.sid}`,
		`3. bun ${BIN}/coord.ts fact set finding.${o.item.toLowerCase()} --text "<one-line headline + how to verify>" --source ${o.sid}`,
		``,
		`IDENTITY: prefix every progress note, inbox reply and your final report lines with [${o.item}] plus a locality tag when it aids scanning — [${o.item}·local], [${o.item}·remote], [${o.item}·sim], [${o.item}·buckle] — the owner's agent list shows your live activity text, and the id is what ties it to the graph. Humans deep-link your item on the fleet board as #task=${o.item}${process.env.FLEET_BOARD_URL ? ` (full URL: ${process.env.FLEET_BOARD_URL}/#task=${o.item})` : ""}; include the link in your final report.`,
		`CRAFT: ≤25-line anchored edits per write (content gate parse-checks; splice via /tmp chunks for larger); build verify every ~3rd edit; GUI deliverables get a headless-Chrome render-and-look pass against the LIVE surface with real data — report what you saw; evidence before claims, always.`,
		``,
		`Final: DONE <sha> | SPLIT ${o.item} | BLOCKED (after 3 honest attempts, tree restored).`,
	];
	// W146 interfaces: down = knowledge interfaces + aids placeholder for the
	// child lane; extra = supervisor context lines appended verbatim.
	if (o.aids?.length) {
		parts.push(
			``,
			`AIDS (knowledge interfaces):`,
			...o.aids.map((a) => `  - ${a}`),
		);
	}
	if (o.extra?.length) parts.push(``, ...o.extra);
	if (o.capsule) {
		parts.push(
			``,
			`RESUME CONTEXT — latest capsule from a previous run of this lane (reconcile with the worktree + item state before continuing):`,
			JSON.stringify(o.capsule),
		);
	}
	return parts.join("\n");
};

export const sidOf = (item: string): string =>
	`autow${item.replace(/^W/, "").replace(/\./g, "")}`;

/** one item → claim, worktree, brief, daemonized lane. Returns the summary
 *  fragment or null when the item cannot be taken (claimed elsewhere). */
const dispatchItem = (
	item: string,
	lanes: Lane[],
	resume?: Lane,
): string | null => {
	const sid = resume?.sid ?? sidOf(item);
	const wt = `${REPO}/.worktrees/${item}`;
	if (DRY) {
		// read-only end to end: no claim, no worktree, no brief file, no spawn
		const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
		const capsule = capsuleGet(sid);
		const branch = existsSync(wt)
			? sh(["git", "-C", wt, "branch", "--show-current"]) ||
				`suspenders/${item}`
			: `suspenders/${item}`;
		console.log(`DRY dispatch ${item} → ${sid}${capsule ? " (RESUME)" : ""}`);
		console.log(
			composeBrief({
				item,
				showOut: show.out,
				sid,
				branch,
				worktree: wt,
				capsule,
			}),
		);
		return `${item}→${sid}(dry)`;
	}
	const take = run([
		process.execPath,
		`${BIN}/work.ts`,
		"take",
		item,
		"--as",
		sid,
		"--origin",
		`${hostname()}:claude`,
	]);
	if (take.code !== 0) {
		const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
		if (!show.out.includes(sid)) {
			console.log(
				`SKIP ${item} — claimed elsewhere: ${take.out.split("\n")[0]}`,
			);
			return null;
		}
		// claimed by this sid from a previous dispatch attempt — resume
	}
	if (!existsSync(wt)) {
		const created = run([
			process.execPath,
			`${BIN}/worktree.ts`,
			"create",
			item,
		]);
		if (created.code !== 0) {
			console.log(
				`SKIP ${item} — worktree create failed: ${created.out.split("\n")[0]}`,
			);
			return null;
		}
	}
	const branch =
		sh(["git", "-C", wt, "branch", "--show-current"]) || `suspenders/${item}`;
	const show = run([process.execPath, `${BIN}/work.ts`, "show", item]);
	const capsule = capsuleGet(sid);
	const brief = composeBrief({
		item,
		showOut: show.out,
		sid,
		branch,
		worktree: wt,
		capsule,
	});
	const briefFile = `${FLEET}/brief-${sid}.md`;
	mkdirSync(FLEET, { recursive: true });
	writeFileSync(briefFile, brief);
	// env + spawn recipe shared with supervise.ts via scripts/lib/lane.ts
	const env = laneEnv({ ...process.env }, NO_BELT);
	env.SUSPENDERS_SID = sid;
	const bin = Bun.which("claude");
	if (!bin) {
		console.log("SKIP — claude binary not found on PATH");
		return null;
	}
	const prompt = `Read ${briefFile} and execute it fully.`;
	const laneLog = `${FLEET}/lane-${sid}.log`;
	const proc = spawnClaude({
		bin,
		prompt,
		cwd: wt,
		logFile: laneLog,
		env,
		fleetDir: FLEET,
	});
	proc.unref();
	const slab = laneClassOf("claude");
	const entry: Lane = {
		sid,
		item,
		pid: proc.pid,
		branch,
		worktree: wt,
		agent: "claude",
		host: hostname(),
		slab,
		launchedAt: Date.now(),
	};
	lanes.push(entry);
	log(
		`DISPATCHED ${item} → ${sid} (pid ${proc.pid}, ${branch}, slab ${jobslabTag(slab, jobslabFor(slab, FLEET))})`,
	);
	console.log(
		`dispatched ${item} → ${sid} (pid ${proc.pid})${capsule ? " — resumed from capsule" : ""}`,
	);
	return `${item}→${sid}(pid ${proc.pid})`;
};

const main = async (): Promise<void> => {
	if (SHOW_CAPSULE) {
		console.log(
			sh([
				process.execPath,
				`${BIN}/coord.ts`,
				"capsule",
				"get",
				"--as",
				SHOW_CAPSULE,
			]),
		);
		return;
	}
	// prune: dead entries leave lanes.json (history keeps the audit); a worktree
	// with a live claude/codex cwd is alive no matter what the pid says —
	// daemonized `claude -p` re-parents away from the recorded pid within minutes.
	const lanes = loadLanes();
	const live = lanes.filter((l) => alive(l.pid) || worktreeLive(l.worktree));
	// resume candidates: dead dispatched lanes whose item is still CLAIMED by
	// them (state on the graph) — re-dispatch with the same sid so the capsule
	// fact (lane.<sid>.capsule) and the claim both carry over.
	const resumeOf = new Map<string, Lane>();
	for (const l of lanes.filter((x) => !live.includes(x))) {
		if (worktreeLive(l.worktree)) continue; // raced between filter and here
		const show = run([process.execPath, `${BIN}/work.ts`, "show", l.item]);
		if (!/state:\s*(CLAIMED|RUNNING)/.test(show.out)) continue;
		if (!show.out.includes(l.sid)) continue;
		resumeOf.set(l.item, l);
	}
	const dispatched: string[] = [];
	for (const [, resume] of resumeOf) {
		if (live.length + dispatched.length >= TARGET) break;
		const out = dispatchItem(resume.item, live, resume);
		if (out) dispatched.push(out);
	}
	// fresh READY pool (id order = FIFO priority; `work ready` already gates on
	// requires/blocks deps AND on DONE-but-unmerged dep shas via depsMet)
	const ready = parseReady(
		run([process.execPath, `${BIN}/work.ts`, "ready"]).out,
	).filter(
		(r) =>
			!live.some((l) => l.item === r.id) &&
			!resumeOf.has(r.id) &&
			!isOwnerGated(r.title),
	);
	for (const r of ready) {
		if (live.length + dispatched.length >= TARGET) break;
		const out = dispatchItem(r.id, live);
		if (out) dispatched.push(out);
	}
	// daemonized-pid resolve: the `claude -p` parent re-parents away from
	// proc.pid within minutes; one settle + lsof cwd scan re-points fresh
	// entries so the pid guard and `lanes` stay honest.
	if (dispatched.some((d) => d.includes("(pid "))) {
		await Bun.sleep(3000);
		const listing = sh([
			"lsof",
			"-a",
			"-p",
			sh(["ps", "-axo", "pid=,comm="])
				.split("\n")
				.filter((l) => /claude|codex/.test(l))
				.map((l) => Number.parseInt(l.trim(), 10))
				.join(","),
			"-d",
			"cwd",
			"-Fn",
		]);
		const byCwd = new Map<string, number>();
		let cur = "";
		for (const line of listing.split("\n")) {
			if (line.startsWith("p")) cur = line.slice(1);
			if (line.startsWith("n")) {
				const wt = byCwd.get(line.slice(1));
				byCwd.set(
					line.slice(1),
					cur && (!wt || Number(cur) > wt) ? Number(cur) : (wt ?? 0),
				);
			}
		}
		for (const l of live) {
			const resolved = byCwd.get(l.worktree);
			if (resolved && (l.pid === 0 || !alive(l.pid))) {
				l.pid = resolved;
				dispatched.push(`${l.item}→${l.sid}(daemonized pid ${resolved})`);
			}
		}
	}
	// dry-run is read-only end to end — never rewrite the lane registry
	if (!DRY) saveLanes(lanes);
	console.log(
		`lanes live: ${live.length}/${TARGET}${dispatched.length ? ` — dispatched: ${dispatched.join(", ")}` : " — pool drained or lanes busy"}`,
	);
	if (ready.length === 0 && resumeOf.size === 0)
		console.log(
			"READY pool empty — register work or pull the next epic forward",
		);
};

if (import.meta.main) {
	if (SHOW_CAPSULE || !DRY) mkdirSync(FLEET, { recursive: true });
	await main();
}
