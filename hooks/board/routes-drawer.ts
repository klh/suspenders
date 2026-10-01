// hooks/board/routes-drawer.ts — drawer feeds: /api/diff /api/tail (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { db } from "./context.ts";
import { json } from "./helpers.ts";
import { LANE_TAIL_BYTES, transcriptTail, transcriptTailAll } from "./lanes.ts";
import { board } from "./data.ts";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export async function handleDrawer(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/diff") {
		// W55 — per-item diff for the drawer: the lane branch vs its base.
		// Branch = suspenders/<id> (worktree.ts naming); base = merge-base
		// with main (fallback master). Read-only GET, argument-array git
		// only; the patch is tail-cap so a huge diff can't flood the board.
		const id = url.searchParams.get("id") ?? "";
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
			return json({ ok: false, error: "bad item id" }, 404);
		const w = db
			.query(
				"SELECT project FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(id) as { project: string } | null;
		if (!w) return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		const branch = `suspenders/${id}`;
		const git = (args: string[]): { out: string; code: number } => {
			const p = Bun.spawnSync(["/usr/bin/git", "-C", w.project, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			return { out: p.stdout.toString(), code: p.exitCode };
		};
		if (
			git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code !==
			0
		)
			return json(
				{ ok: false, error: `no branch ${branch} for item ${id}` },
				404,
			);
		const baseBranch = ["main", "master"].find(
			(b) =>
				git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).code === 0,
		);
		if (!baseBranch)
			return json(
				{ ok: false, error: `no main/master branch in ${w.project}` },
				404,
			);
		const base = git(["merge-base", baseBranch, branch]).out.trim();
		if (!base)
			return json(
				{ ok: false, error: `no common ancestor for ${branch}` },
				404,
			);
		const stat = git(["diff", "--stat", `${base}...${branch}`]).out;
		const full = git(["diff", `${base}...${branch}`]).out;
		const DIFF_CAP = 200 * 1024;
		const diff =
			full.length > DIFF_CAP
				? `[truncated — showing the last ${Math.round(DIFF_CAP / 1024)}KB of the patch]\n${full.slice(-DIFF_CAP)}`
				: full;
		return json({ ok: true, id, branch, base, stat, diff });
	}
	if (url.pathname === "/api/tail") {
		// W76 — live lane tail for the drawer: the owning lane's
		// stdout/stderr log (.fleet/lane-<sid>.log — fleet-loop's declared
		// live-tail surface) plus the session transcript's recent assistant
		// blocks. `claude -p` buffers stdout until the run finishes, so the
		// transcript is what makes the window live for a RUNNING claude
		// lane; the log carries finished runs and codex's streaming output.
		const id = url.searchParams.get("id") ?? "";
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
			return json({ ok: false, error: "bad item id" }, 404);
		const w = db
			.query(
				"SELECT project, owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(id) as { project: string; owner_sid: string | null } | null;
		if (!w) return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!w.owner_sid)
			return json(
				{ ok: false, error: `work item ${id} has no owning lane` },
				404,
			);
		const repo = w.project.replace(/\/\.git$/, "");
		const logFile = `${repo}/.fleet/lane-${w.owner_sid}.log`;
		let log: {
			size: number;
			mtime: number;
			truncated: boolean;
			text: string;
		} | null = null;
		if (existsSync(logFile)) {
			const size = statSync(logFile).size;
			const start = Math.max(0, size - LANE_TAIL_BYTES);
			const len = size - start;
			const buf = Buffer.alloc(len);
			let text = "";
			try {
				const fd = openSync(logFile, "r");
				readSync(fd, buf, 0, len, start);
				closeSync(fd);
				text = buf.toString("utf8");
			} catch {
				// a lane appending mid-read — the next poll retries
			}
			log = {
				size,
				mtime: statSync(logFile).mtimeMs,
				truncated: start > 0,
				text,
			};
		}
		const recent = transcriptTailAll(w.owner_sid, 12).reverse();
		return json({
			ok: true,
			id,
			sid: w.owner_sid,
			log,
			transcript: transcriptTail(w.owner_sid),
			recent,
		});
	}
	return null;
}
