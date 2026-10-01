#!/usr/bin/env bun
// supervise.ts — W146: the shattering planner becomes its subtree's
// MICRO-SUPERVISOR. Coordinator responsibilities, scoped to one parent
// item's descendants: dispatch READY children (W145 lane-spawn machinery,
// shared via scripts/lib/lane.ts), watch the graph, dispatch newly-unblocked
// children in dependency order (`work ready` IS the dep-order source — the
// W60 dep-merge gate keeps a child out of the pool until its deps are DONE
// and merged), integrate DONE children per the plan contract (verify the
// result sha is an ancestor of main, or merge the child branch with
// --integrate=merge), and close the parent when the subtree is terminal +
// integrated — the graph's roll-up usually marks the parent DONE first; the
// supervisor then records the integration evidence (fact + capsule).
//
// Scope isolation: a supervisor may only act on items under its parent —
// inScope() walks the parent chain before EVERY dispatch/close action;
// anything else is refused. Escalation goes UP, never sideways: conflicts,
// FAILED children, unmergeable branches, and dead-lane loops surface as
// `coord emit NEED_DECISION --to <its coordinator>` — never silently wait.
//
// State machine (idempotent — a restarted supervisor reads the graph,
// capsules, and journal and continues; graph state is the only truth):
//   shatter → dispatch(ready children) → watch(poll graph + inbox)
//   → unblock/integrate(dep order) → close(parent done)
//
//   bun scripts/supervise.ts <parent-id> [titles...] [--target N]
//       [--integrate verify|merge] [--to <coordinator sid>]
//       [--plan <itemId>] [--repo <dir>] [--dry-run] [--once] [--poll-ms ms]
//
//   titles...  — when the parent has no children yet, shatter it first
//                (1-2 children free; >2 needs --plan per the W16 split gate)
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
	composeBrief,
	isOwnerGated,
	parseCapsuleGet,
	parseReady,
	sidOf,
} from "./dispatch-next.ts";
import {
	laneEnv,
	loadLanes,
	saveLanes,
	spawnClaude,
	worktreeLive,
	type Lane,
} from "./lib/lane.ts";

/** scope isolation: itemId is the root itself or its parent chain reaches
 *  the root — children, grandchildren, any depth. Reads only; every
 *  dispatch/close action calls this FIRST. */
export const inScope = (
	db: Database,
	project: string,
	root: string,
	itemId: string,
	maxDepth = 64,
): boolean => {
	let cur: string | null = itemId;
	for (let i = 0; i < maxDepth && cur; i++) {
		if (cur === root) return true;
		const row = db
			.query("SELECT parent_id FROM work_items WHERE project = ? AND id = ?")
			.get(project, cur) as { parent_id: string | null } | undefined;
		cur = row?.parent_id ?? null;
	}
	return false;
};

const USAGE = `usage: bun scripts/supervise.ts <parent-id> [titles...] [--target N] [--integrate verify|merge] [--to <coordinator sid>] [--plan <itemId>] [--repo <dir>] [--dry-run] [--once] [--poll-ms ms]`;

const main = async (): Promise<void> => {
	const argv = process.argv.slice(2);
	const val = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const VAL_FLAGS = new Set([
		"--target",
		"--integrate",
		"--to",
		"--plan",
		"--repo",
		"--poll-ms",
		"--grace-ms",
	]);
	const pos: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (VAL_FLAGS.has(argv[i])) {
			i++;
			continue;
		}
		if (!argv[i].startsWith("--")) pos.push(argv[i]);
	}
	const PARENT = pos[0];
	const TITLES = pos.slice(1);
	const die = (msg: string, code = 1): never => {
		console.error(msg);
		process.exit(code);
	};
	if (!PARENT || TITLES.includes("")) die(USAGE);
	const REPO = val("--repo") ?? process.cwd();
	const DRY = argv.includes("--dry-run");
	const ONCE = argv.includes("--once");
	const TARGET = Number(val("--target") ?? 3);
	const POLL = Number(val("--poll-ms") ?? 30000);
	// a just-spawned lane is invisible to the lsof probe for a few seconds and
	// the recorded pid may already be recycled — a resume is only considered
	// once the last dispatch is this old (tests pass 0 to exercise resume).
	const GRACE = Number(val("--grace-ms") ?? 120000);
	const INTEGRATE = val("--integrate") ?? "verify";
	if (!["verify", "merge"].includes(INTEGRATE))
		die(`--integrate must be verify|merge`);
	const PLAN = val("--plan");
	const FLEET = `${REPO}/.fleet`;
	const BIN = `${process.env.HOME}/.claude/hooks/suspenders/bin`;
	const JOURNAL_PATH = `${FLEET}/supervise-${PARENT}.json`;
	const SUP = `sup${PARENT.replace(/^W/, "").replace(/\./g, "")}`;
	const pl = PARENT.toLowerCase();

	const gitOut = (args: string[]): string => {
		const p = Bun.spawnSync(["git", "-C", REPO, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return p.stdout ? new TextDecoder().decode(p.stdout).trim() : "";
	};
	const commonDir = gitOut(["rev-parse", "--git-common-dir"]);
	if (!commonDir) die(`not a git repo: ${REPO}`);
	const PROJECT = realpathSync(resolve(REPO, commonDir));
	const DB_PATH = `${process.env.HOME}/.cache/claude-governor/governor.db`;
	if (!existsSync(DB_PATH))
		die(`no governor db at ${DB_PATH} — bootstrap the control plane first`);
	const db = new Database(DB_PATH, { readonly: true });

	type Item = {
		id: string;
		parent_id: string | null;
		state: string;
		owner_sid: string | null;
		result_sha: string | null;
		title: string;
		required: number;
		created_by: string | null;
	};
	const getItem = (id: string): Item | null =>
		(db
			.query(
				"SELECT id, parent_id, state, owner_sid, result_sha, title, required, created_by FROM work_items WHERE project = ? AND id = ?",
			)
			.get(PROJECT, id) as Item | undefined) ?? null;
	const descendants = (root: string): Item[] =>
		db
			.query(
				`WITH RECURSIVE sub AS (
					SELECT project, id, parent_id, state, owner_sid, result_sha, title, required FROM work_items WHERE project = ? AND id = ?
					UNION ALL
					SELECT w.project, w.id, w.parent_id, w.state, w.owner_sid, w.result_sha, w.title, w.required
					FROM work_items w JOIN sub s ON w.parent_id = s.id AND w.project = s.project
				) SELECT id, parent_id, state, owner_sid, result_sha, title, required FROM sub WHERE id != ?`,
			)
			.all(PROJECT, root, root) as Item[];

	const run = (cmd: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
		};
	};
	const sh = (cmd: string[]): string => {
		const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
		return `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim();
	};
	const cli = (bin: string, ...args: string[]): { code: number; out: string } =>
		run([process.execPath, `${BIN}/${bin}`, ...args]);
	const headSha = (): string => gitOut(["rev-parse", "HEAD"]) || "none";
	// W60 semantics: exit 0 = ancestor of main, exit 1 = NOT, >1 = cannot
	// know — only a verified negative gates, never a lookup failure.
	const shaOnMain = (sha: string): boolean | null => {
		const r = Bun.spawnSync(
			["git", "-C", REPO, "merge-base", "--is-ancestor", sha, "main"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		return r.exitCode === 0 ? true : r.exitCode === 1 ? false : null;
	};

	// crash-safe journal: escalation + resume dedupe across restarts (graph
	// state is the truth; this only stops repeat NEED_DECISION spam)
	type Journal = {
		escalated: Record<string, string>;
		resumes: Record<string, number>;
		dispatchedAt: Record<string, number>;
	};
	const loadJournal = (): Journal => {
		try {
			return JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Journal;
		} catch {
			return { escalated: {}, resumes: {}, dispatchedAt: {} };
		}
	};
	const journal: Journal = DRY
		? { escalated: {}, resumes: {}, dispatchedAt: {} }
		: loadJournal();
	const saveJournal = (): void => {
		if (DRY) return;
		mkdirSync(FLEET, { recursive: true });
		writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
	};

	const it = getItem(PARENT);
	if (!it) die(`unknown item ${PARENT} in project ${PROJECT}`);
	const TO = val("--to") ?? it.created_by ?? "owner";

	const fact = (key: string, text: string): void => {
		if (DRY) return;
		cli("coord.ts", "fact", "set", key, "--text", text, "--source", SUP);
	};
	const bankCapsule = (done: string, next: string): void => {
		if (DRY) return;
		cli(
			"coord.ts",
			"capsule",
			"set",
			"--as",
			SUP,
			`--checkpoint=${headSha()}`,
			"--file=scripts/supervise.ts",
			`--done=${done}`,
			`--next=${next}`,
		);
	};
	const escalate = (kind: string, msg: string): void => {
		if (journal.escalated[kind]) return;
		console.log(`NEED_DECISION [${kind}] → @${TO}: ${msg}`);
		if (DRY) return;
		const r = cli(
			"coord.ts",
			"emit",
			"NEED_DECISION",
			"--to",
			TO,
			"--note",
			msg,
			"--as",
			SUP,
			"--scope",
			PARENT,
		);
		if (r.code === 0) {
			journal.escalated[kind] = msg;
			saveJournal();
		}
	};

	// W146 interfaces-down: child briefs carry knowledge-interface guidance;
	// the aids: stanza is the preseeding placeholder (buckle W142 plugs in).
	const AIDS = [
		`context: before non-trivial code/doc work, query fleet knowledge (read_knowledge MCP when available; otherwise bun ${BIN}/coord.ts knowledge) for architecture, conventions, prior decisions, gotchas.`,
		`capture: bank durable, non-obvious learnings with bun ${BIN}/coord.ts knowledge-enqueue (facts derivable from a single file become pointers or are rejected at ingest).`,
		`aids: (preseeding placeholder — buckle W142 plugs provider aids in here)`,
	];

	const dispatchChild = (
		item: string,
		lanes: Lane[],
		resume?: Lane,
	): string | null => {
		// scope isolation: read the parent chain BEFORE any dispatch action
		if (!inScope(db, PROJECT, PARENT, item)) {
			console.log(`SCOPE-REFUSED ${item} — not under ${PARENT}`);
			return null;
		}
		const sid = resume?.sid ?? sidOf(item);
		const wt = `${REPO}/.worktrees/${item}`;
		if (DRY) {
			// read-only: no claim, no worktree, no brief file, no spawn
			console.log(`DRY dispatch ${item} → ${sid}`);
			return `${item}→${sid}(dry)`;
		}
		const take = cli(
			"work.ts",
			"take",
			item,
			"--as",
			sid,
			"--origin",
			`${hostname()}:claude`,
		);
		if (take.code !== 0) {
			const show = cli("work.ts", "show", item);
			if (!show.out.includes(sid)) {
				console.log(
					`SKIP ${item} — claimed elsewhere: ${take.out.split("\n")[0]}`,
				);
				return null;
			}
			// claimed by this sid from a previous dispatch attempt — resume
		}
		if (!existsSync(wt)) {
			const created = cli("worktree.ts", "create", item);
			if (created.code !== 0) {
				console.log(
					`SKIP ${item} — worktree create failed: ${created.out.split("\n")[0]}`,
				);
				return null;
			}
		}
		const branch =
			sh(["git", "-C", wt, "branch", "--show-current"]) || `suspenders/${item}`;
		const show = cli("work.ts", "show", item);
		const capsule = parseCapsuleGet(
			cli("coord.ts", "capsule", "get", "--as", sid).out,
		);
		const brief = composeBrief({
			item,
			showOut: show.out,
			sid,
			branch,
			worktree: wt,
			capsule,
			repo: REPO,
			aids: AIDS,
			extra: [
				`SUPERVISION: this lane runs under micro-supervisor ${SUP} (subtree of ${PARENT}). It reads the graph + your capsule every cycle; you are reachable via coord inbox --as ${sid}.`,
				`On a conflict or ambiguity you cannot resolve: bun ${BIN}/coord.ts emit NEED_DECISION --to ${SUP} --note "..." --as ${sid} — never silently wait.`,
			],
		});
		const briefFile = `${FLEET}/brief-${sid}.md`;
		mkdirSync(FLEET, { recursive: true });
		writeFileSync(briefFile, brief);
		const env = laneEnv({ ...process.env }, false);
		env.SUSPENDERS_SID = sid;
		const bin = Bun.which("claude");
		if (!bin) {
			console.log("SKIP — claude binary not found on PATH");
			return null;
		}
		const proc = spawnClaude({
			bin,
			prompt: `Read ${briefFile} and execute it fully.`,
			cwd: wt,
			logFile: `${FLEET}/lane-${sid}.log`,
			env,
		});
		proc.unref();
		journal.dispatchedAt[item] = Date.now();
		saveJournal();
		lanes.push({
			sid,
			item,
			pid: proc.pid,
			branch,
			worktree: wt,
			agent: "claude",
			host: hostname(),
			launchedAt: Date.now(),
		});
		console.log(
			`dispatched ${item} → ${sid} (pid ${proc.pid})${resume ? " — resumed from capsule" : ""}`,
		);
		return `${item}→${sid}(pid ${proc.pid})`;
	};

	const finish = (how: string): { closed: boolean } => {
		fact(
			`supervise.${pl}.closed`,
			`${PARENT} closed (${how}) — subtree terminal + integrated, evidence @${headSha().slice(0, 8)}`,
		);
		bankCapsule(`subtree closed: ${how}`, "none — supervisor exiting");
		console.log(`CLOSED ${PARENT} — ${how}`);
		return { closed: true };
	};

	const cycle = (): { closed: boolean } => {
		const parent = getItem(PARENT);
		if (!parent) die(`item ${PARENT} vanished from the graph`);
		const kids = descendants(PARENT);
		console.log(
			`── ${new Date().toISOString()} parent ${PARENT} (${parent.state}) descendants: ${kids.length}${DRY ? " [DRY]" : ""}`,
		);
		// ── shatter: only with caller-supplied titles; never invent the plan
		if (kids.length === 0) {
			if (TITLES.length === 0) {
				escalate(
					"no-children",
					`${PARENT} has no children and no titles were given — the decomposition is a held decision, not mine to invent`,
				);
				return { closed: false };
			}
			console.log(`shattering ${PARENT} → ${TITLES.length} children`);
			if (DRY) {
				for (const t of TITLES) console.log(`  would split child: ${t}`);
				return { closed: false };
			}
			const args = [
				"split",
				PARENT,
				...TITLES,
				"--reason",
				`supervised by ${SUP}`,
			];
			if (PLAN) args.push("--plan", PLAN);
			const r = cli("work.ts", ...args);
			if (r.code !== 0) {
				escalate(
					"split-refused",
					`work split refused: ${r.out.split("\n")[0]}`,
				);
				return { closed: false };
			}
		}
		// ── dispatch(ready children): `work ready` already encodes dep order +
		// the W60 merge gate; the supervisor only narrows it to its subtree.
		const ready = parseReady(cli("work.ts", "ready").out).filter(
			(r) => !isOwnerGated(r.title) && inScope(db, PROJECT, PARENT, r.id),
		);
		const lanes = loadLanes(FLEET);
		// pid-only liveness lies (daemonized lanes re-parent away; pids recycle)
		// — the worktree cwd probe is the honest signal, grace covers fresh spawns
		const live = lanes.filter((l) => worktreeLive(l.worktree, sh));
		const liveItems = new Set(live.map((l) => l.item));
		// ── resume dead in-scope lanes FIRST (same sid, capsule carries over)
		let dispatched = 0;
		const notes: string[] = [];
		// snapshot: dispatchChild pushes into lanes[] — iterating the live array
		// would re-qualify the just-pushed (already-dead) entries in-loop
		for (const l of [...lanes]) {
			if (live.includes(l) || liveItems.has(l.item)) continue;
			if (!inScope(db, PROJECT, PARENT, l.item)) continue;
			const st = getItem(l.item);
			if (
				!st ||
				(st.state !== "CLAIMED" && st.state !== "RUNNING") ||
				st.owner_sid !== l.sid
			)
				continue;
			const n = (journal.resumes[l.item] ?? 0) + 1;
			if (Date.now() - (journal.dispatchedAt[l.item] ?? 0) < GRACE) continue;
			if (DRY) {
				notes.push(`would resume ${l.item} (lane ${l.sid} dead, item CLAIMED)`);
				continue;
			}
			if (n > 3) {
				escalate(
					`resume-${l.item}`,
					`lane ${l.sid} for ${l.item} died ${n - 1} times without finishing — reclaim, re-plan, or retire the worktree`,
				);
				continue;
			}
			journal.resumes[l.item] = n;
			journal.dispatchedAt[l.item] = Date.now();
			saveJournal();
			const out = dispatchChild(l.item, lanes, l);
			if (out) {
				dispatched++;
				notes.push(out);
			}
		}
		// ── dispatch fresh READY children up to target concurrency
		for (const r of ready) {
			if (liveItems.size + dispatched >= TARGET) break;
			if (liveItems.has(r.id)) continue;
			const out = dispatchChild(r.id, lanes);
			if (out) {
				dispatched++;
				notes.push(out);
			}
		}
		if (dispatched > 0 && !DRY) {
			// persist the registry so a restarted supervisor finds resume candidates
			saveLanes(lanes, FLEET);
			fact(
				`supervise.${pl}.dispatched`,
				`${dispatched} lane(s) this cycle: ${notes.join(", ")}`,
			);
			bankCapsule(
				`dispatched: ${notes.join(", ")}`,
				`watching ${kids.length} descendants`,
			);
		}
		// ── unblock/integrate: DONE children must satisfy the repo's dep-merge
		// contract (result_sha ancestor of main) before the subtree can close
		for (const k of kids) {
			if (k.state !== "DONE" || !k.result_sha) continue;
			if (shaOnMain(k.result_sha) !== false) continue;
			const br = `suspenders/${k.id}`;
			if (INTEGRATE === "merge") {
				if (DRY) {
					console.log(`would merge ${br} into main (${k.id} DONE, unmerged)`);
					continue;
				}
				console.log(`integrating ${k.id} — merging ${br}`);
				const m = run([
					"git",
					"-C",
					REPO,
					"merge",
					"--no-ff",
					br,
					"-m",
					`integrate ${k.id} (supervised by ${SUP})`,
				]);
				if (m.code !== 0) {
					run(["git", "-C", REPO, "merge", "--abort"]);
					escalate(
						`merge-${k.id}`,
						`merge of ${br} failed (conflict) — needs a decision`,
					);
				} else {
					fact(
						`supervise.${pl}.integrated`,
						`${k.id} merged (${br}) into main @${headSha().slice(0, 8)}`,
					);
				}
			} else {
				escalate(
					`unmerged-${k.id}`,
					`${k.id} DONE but ${k.result_sha.slice(0, 8)} is not on main — verify mode refuses to close; merge ${br} or run with --integrate=merge`,
				);
			}
		}
		// ── FAILED children hold the whole subtree — surface, never wait
		for (const k of kids) {
			if (k.state !== "FAILED") continue;
			escalate(
				`failed-${k.id}`,
				`${k.id} FAILED — subtree needs a decision (retry, supersede, or re-plan)`,
			);
		}
		// ── watch: drain the inbox (cursor never advanced — board/coordinator
		// messages surface here every cycle)
		if (!DRY) {
			const inbox = cli("coord.ts", "inbox", "--as", SUP);
			if (inbox.out) console.log(`inbox:\n${inbox.out}`);
		}
		// ── close: everything terminal + integrated → record evidence
		const terminal = (k: Item): boolean =>
			k.state === "DONE" || k.state === "SUPERSEDED";
		const allTerminal = kids.length > 0 && kids.every(terminal);
		const allMerged = kids.every(
			(k) =>
				k.state !== "DONE" ||
				!k.result_sha ||
				shaOnMain(k.result_sha) !== false,
		);
		if (allTerminal && allMerged) {
			const cur = getItem(PARENT);
			if (cur?.state === "DONE")
				return finish("parent already DONE via graph roll-up");
			if (
				cur &&
				(cur.state === "CLAIMED" || cur.state === "RUNNING") &&
				cur.owner_sid === SUP
			) {
				const r = cli(
					"work.ts",
					"done",
					PARENT,
					"--sha",
					headSha(),
					"--as",
					SUP,
				);
				if (r.code === 0)
					return finish("parent marked DONE with integration evidence");
				escalate(
					"close-refused",
					`work done ${PARENT} refused: ${r.out.split("\n")[0]}`,
				);
			}
		}
		return { closed: false };
	};

	for (;;) {
		let st: { closed: boolean };
		try {
			st = cycle();
		} catch (e) {
			console.error(
				`cycle error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
			);
			if (ONCE) process.exit(1);
			await Bun.sleep(POLL);
			continue;
		}
		if (ONCE || st.closed) break;
		await Bun.sleep(POLL);
	}
	saveJournal();
	console.log("supervisor exit");
};

if (import.meta.main) await main();
