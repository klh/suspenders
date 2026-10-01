// hooks/board/exec.ts — lane exec helpers: runCli, lane exec facts, LLM routing (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { db, BELT_REPO, WORK_CLI, COORD_CLI } from "./context.ts";
import { json } from "./helpers.ts";
import { board, llm, payload } from "./data.ts";

export const runCli = (
	args: string[],
	cwd?: string,
): { code: number; out: string } => {
	const p = Bun.spawnSync([process.execPath, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		...(cwd ? { cwd } : {}),
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(),
	};
};
// W105 — plumb executor+model+locality into the lane registry at dispatch
// time: facts lane.<sid>.executor / .model / .locality (governor.db), keyed
// by the sid the lane will bootstrap under (autow<id> for board dispatches).
// The board UI reads them back for the MODEL badges; direct facts-table
// writes are the same trust class as the board-owned decisions table.
export const laneExecFacts = (
	sid: string,
	executor: string,
	model: string,
	locality: string,
): void => {
	for (const [k, v] of [
		["executor", executor],
		["model", model],
		["locality", locality],
	] as const)
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, ts) VALUES (?, ?, 'fleet-board', ?)",
		).run(`lane.${sid}.${k}`, v, Date.now());
};
// one llm:* dispatch: route the item's title+description through belt's
// remotes router (role-based), land the answer on the item's coord thread,
// release the board claim either way. Fire-and-forget — the HTTP answer
// returns while belt routes. cwd = the item's repo: coord stamps
// payload.project from the cwd and the drawer timeline matches on it.
export const llmRoute = async (job: {
	item: string;
	repo: string;
	role: string;
	target: string;
	sid: string;
	title: string;
	desc: string;
}): Promise<void> => {
	const prompt = `${job.title}${job.desc ? ` — ${job.desc}` : ""}`.slice(
		0,
		4000,
	);
	let ok = false;
	let answer = "";
	try {
		const cmd = [
			process.execPath,
			`${BELT_REPO}/bin/remotes.ts`,
			"route",
			job.role,
			prompt,
		];
		const p = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: job.repo,
		});
		const [out, err] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		await p.exited;
		ok = p.exitCode === 0;
		answer = ok
			? out.trim()
			: `route failed: ${(err.trim() || out.trim() || `exit ${p.exitCode}`).slice(0, 400)}`;
	} catch (e) {
		answer = `route failed: ${e instanceof Error ? e.message : String(e)}`;
	}
	const note = `${ok ? "llm.answer" : "llm.error"} (${job.target}): ${answer.slice(0, 1800)}`;
	runCli(
		[
			COORD_CLI,
			"emit",
			"llm.result",
			"--scope",
			job.item,
			"--as",
			job.sid,
			"--note",
			note,
		],
		job.repo,
	);
	runCli([WORK_CLI, "release", job.item, "--as", job.sid], job.repo);
};
// this install's wiring scripts — the setup checks look for THEM in
// ~/.claude/settings.json, not just any suspenders install
