// hooks/board/routes-actions.ts — board writes: /api/answer /api/ack /api/advise /api/comment /api/message /api/start /api/ship (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { CLI, db, DEMO, WORK_CLI } from "./context.ts";
import { beltCheck, rowLocality } from "./belt.ts";
import { runCli, laneExecFacts, llmRoute } from "./exec.ts";
import { json, writeGuard, readJson } from "./helpers.ts";
import {
	syncDecisions,
	pidAlive,
	lanesOf,
	readShipJson,
	sessionAlive,
} from "./lanes.ts";
import { decisionEvals, evaluateDecision } from "./decide-eval.ts";
import { isDecisionKind } from "../lib/govdb.ts";
import { executorAllowed, readBoardSettings } from "../lib/board-config.ts";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export async function handleActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/answer") {
		// the board's single write: relay a human answer into the event bus.
		// Idempotency per docs/decisions-api.md: the client echoes the
		// answer_token it read — the same note on an already-answered fork
		// replays (200 {replay:true}); a stale token (another tab answered
		// or dismissed since) is 409 {error:"stale"}.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = Number(parsed.body?.id ?? parsed.body?.forEvent ?? 0);
		let to = String(parsed.body?.to ?? "");
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		const token = String(parsed.body?.token ?? "");
		if (!id || !to || !note || !token)
			return json({ ok: false, error: "missing id, to, note or token" }, 400);
		syncDecisions();
		const row = db
			.query(
				"SELECT state, answer_note, answer_token, answer_to FROM decisions WHERE event_id = ?",
			)
			.get(id) as {
			state: string;
			answer_note: string | null;
			answer_token: string | null;
			answer_to: string | null;
		} | null;
		// reject unknown ids instead of silently answering nothing
		if (!row)
			return json({ ok: false, error: `unknown decision id: ${id}` }, 404);
		if (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED")
			return row.answer_note === note
				? json({ ok: true, replay: true, to: row.answer_to })
				: json({ ok: false, error: "stale" }, 409);
		if (row.state !== "OPEN" || row.answer_token !== token)
			return json({ ok: false, error: "stale" }, 409);
		// accept full sids, unique prefixes, or live bus aliases (an identity
		// that has emitted before — e.g. a coordinator's chosen --as name)
		const exact = db
			.query("SELECT sid FROM sessions WHERE sid = ?")
			.get(to) as { sid: string } | null;
		if (exact) to = exact.sid;
		else {
			const cands = db
				.query("SELECT sid FROM sessions WHERE sid LIKE ? || '%'")
				.all(to) as { sid: string }[];
			if (cands.length === 1) to = cands[0]?.sid;
			else {
				const alias = !!db
					.query("SELECT 1 AS x FROM events WHERE source = ? LIMIT 1")
					.get(to);
				if (!alias)
					return json(
						{
							ok: false,
							error:
								cands.length > 1
									? `ambiguous sid: ${to}`
									: `unknown target session: ${to}`,
						},
						400,
					);
			}
		}
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"ANSWER",
				"--to",
				to,
				"--note",
				note,
				"--as",
				"fleet-board",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json({ ok: false, output: out.slice(0, 400), to }, 500);
		// answered — lifecycle state, correlated to the fork's event id; the
		// WHERE clause guards a concurrent answer (raced → stale, another
		// tab got there first)
		const done = db
			.query(
				"UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN' AND answer_token = ?",
			)
			.run(note, to, Date.now(), crypto.randomUUID(), id, token);
		return Number(done.changes) === 0
			? json({ ok: false, error: "stale" }, 409)
			: json({ ok: true, output: out.slice(0, 400), to });
	}
	if (
		req.method === "POST" &&
		/^\/api\/decisions\/\d+\/evaluate$/.test(url.pathname)
	) {
		// W217: re-evaluate an OPEN decision — each call runs a fresh LLM
		// evaluation (local/z.ai via the :4000 shim) and appends a stamped
		// entry; the owner clicks as often as they like (ad nauseum, no cap).
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const id = Number(
			url.pathname.match(/\/api\/decisions\/(\d+)\/evaluate/)?.[1],
		);
		if (!id) return json({ ok: false, error: "bad id" }, 400);
		try {
			const entry = await evaluateDecision(id);
			return json({
				ok: true,
				latest: entry,
				count: decisionEvals(id).length,
			});
		} catch (e) {
			return json(
				{ ok: false, error: e instanceof Error ? e.message : String(e) },
				502,
			);
		}
	}
	if (req.method === "POST" && url.pathname === "/api/ack") {
		// board dismiss = CANCELLED (the UI confirms before calling).
		// Idempotent; monotonic — never un-answers a decision.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = Number(parsed.body?.id ?? 0);
		if (!id) return json({ ok: false, error: "missing event id" }, 400);
		const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as {
			kind: string;
		} | null;
		if (!ev) return json({ ok: false, error: `unknown event id: ${id}` }, 404);
		if (!isDecisionKind(ev.kind))
			return json({ ok: false, error: `not a decision event: ${id}` }, 400);
		syncDecisions();
		const row = db
			.query("SELECT state FROM decisions WHERE event_id = ?")
			.get(id) as { state: string } | null;
		if (row && (row.state === "ANSWERED" || row.state === "ACKNOWLEDGED"))
			return json({ ok: false, error: "already answered" }, 409);
		db.query(
			"UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(Date.now(), crypto.randomUUID(), id);
		return json({ ok: true });
	}
	if (req.method === "POST" && url.pathname === "/api/advise") {
		// fire hooks/bin/advise.ts detached — it writes fact advice.<id> when
		// the LLM answers; the 1s poll picks it up. Human decides after.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = Number(parsed.body?.id ?? 0);
		if (!id) return json({ ok: false, error: "missing event id" }, 400);
		const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as {
			kind: string;
		} | null;
		if (!ev) return json({ ok: false, error: `unknown event id: ${id}` }, 404);
		if (!isDecisionKind(ev.kind))
			return json({ ok: false, error: `not a decision event: ${id}` }, 400);
		const child = Bun.spawn([process.execPath, CLI("advise.ts"), String(id)], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
		return json({ ok: true, started: true });
	}
	if (req.method === "POST" && url.pathname === "/api/comment") {
		// W55 — review line-comments: route a board note to the item's
		// owning lane over the same coord path /api/answer uses. Mirrors
		// its guards (writeGuard + JSON-only body) and its emit shape
		// (spawnSync argument array, --as fleet-board). Unknown or
		// ownerless item = 404.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = String(parsed.body?.id ?? "");
		const file = String(parsed.body?.file ?? "")
			.trim()
			.slice(0, 500);
		const line = String(parsed.body?.line ?? "")
			.trim()
			.slice(0, 20);
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		if (!id || !file || !line || !note)
			return json({ ok: false, error: "missing id, file, line or note" }, 400);
		const w = db
			.query(
				"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(id) as { owner_sid: string | null } | null;
		if (!w) return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!w.owner_sid)
			return json(
				{ ok: false, error: `work item ${id} has no owning lane` },
				404,
			);
		const full = `review ${id} ${file}:${line} — ${note}`;
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				w.owner_sid,
				"--note",
				full,
				"--as",
				"fleet-board",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json(
				{ ok: false, output: out.slice(0, 400), to: w.owner_sid },
				500,
			);
		return json({ ok: true, to: w.owner_sid });
	}
	if (req.method === "POST" && url.pathname === "/api/message") {
		// W76 — message-to-lane: a general board note routed to the owning
		// lane over coord, emitted as the published coordinator identity
		// (fact `coordinator.sid`; fallback `fleet-board` when unset so the
		// route degrades to the /api/comment identity, never to "unknown").
		// Mirrors /api/comment's guards and emit shape. Unknown or
		// ownerless item = 404.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = String(parsed.body?.id ?? "");
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		if (!id || !note)
			return json({ ok: false, error: "missing id or note" }, 400);
		const w = db
			.query(
				"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(id) as { owner_sid: string | null } | null;
		if (!w) return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!w.owner_sid)
			return json(
				{ ok: false, error: `work item ${id} has no owning lane` },
				404,
			);
		const as =
			(
				db
					.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
					.get() as { value: string } | null
			)?.value ?? "fleet-board";
		const full = `board ${id} — ${note}`;
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				w.owner_sid,
				"--note",
				full,
				"--as",
				as,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json(
				{ ok: false, output: out.slice(0, 400), to: w.owner_sid },
				500,
			);
		return json({ ok: true, to: w.owner_sid, as });
	}
	if (req.method === "POST" && url.pathname === "/api/start") {
		// W65 — start-on-READY: the board dispatches a fresh lane on a READY
		// item via fleet-loop's dispatch mode (CAS claim → worktree → briefed
		// headless claude). This endpoint only validates; the claim race
		// belongs to dispatch's work take. Detached spawn: the HTTP answer
		// returns while the lane boots.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		const raw = String(parsed.body?.agent ?? "claude");
		const agent =
			raw === "codex" ? "codex" : raw.startsWith("llm:") ? raw : "claude";
		// W201: policy gates the dispatch target server-side — the feed
		// filter only hides options from the UI; this is the teeth.
		if (!executorAllowed(agent, readBoardSettings().settings))
			return json(
				{
					ok: false,
					error: `${agent} is disabled by the executor policy (suspenders-board.json)`,
				},
				409,
			);
		if (!project || !id)
			return json({ ok: false, error: "missing project or id" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		let claude = "";
		if (!agent.startsWith("llm:")) {
			claude =
				Bun.which(agent) ??
				(agent === "codex"
					? "/opt/homebrew/bin/codex"
					: `${process.env.HOME}/.local/bin/claude`);
			if (!existsSync(claude))
				return json(
					{
						ok: false,
						error: `${agent} binary not found on the board's PATH`,
					},
					409,
				);
		}
		const w = db
			.query(
				"SELECT state, owner_sid, project, title, description FROM work_items WHERE project = ? AND id = ?",
			)
			.get(project, id) as {
			state: string;
			owner_sid: string | null;
			project: string;
			title: string;
			description: string | null;
		} | null;
		if (!w)
			return json(
				{ ok: false, error: `no work item ${id} in ${project}` },
				404,
			);
		if (w.owner_sid)
			return json(
				{ ok: false, error: `${id} already claimed by ${w.owner_sid}` },
				409,
			);
		if (w.state !== "READY")
			return json(
				{
					ok: false,
					error: `${id} is ${w.state} — only READY items start a lane`,
				},
				409,
			);
		const repo = w.project.replace(/\/\.git$/, "");
		if (!existsSync(repo))
			return json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			);
		if (agent.startsWith("llm:")) {
			// board-forced LLM dispatch: claim the item as the board lane
			// (the same take the agent dispatch uses) so nobody double-
			// dispatches while belt routes; the answer lands as llm.result
			// on the item's thread and the claim releases either way
			const rest = agent.slice(4);
			const c1 = rest.indexOf(":");
			const machine = c1 > 0 ? rest.slice(0, c1) : rest;
			const tail = c1 > 0 ? rest.slice(c1 + 1) : "";
			const ep = (await beltCheck()).find(
				(r) =>
					r.machine === machine &&
					r.protocol === "openai" &&
					(r.model === tail || String(r.port ?? "") === tail),
			);
			if (!ep)
				return json(
					{
						ok: false,
						error: `unknown llm target ${agent} — belt registry unreachable?`,
					},
					409,
				);
			const role = ep.roles?.includes("general")
				? "general"
				: (ep.roles?.[0] ?? "");
			if (!role)
				return json({ ok: false, error: `${agent} serves no route role` }, 409);
			const sid = `autow${id.replace(/^W/, "").replace(/\./g, "")}`;
			const take = runCli(
				[
					WORK_CLI,
					"take",
					id,
					"--as",
					sid,
					"--origin",
					`${hostname()}:llm:${machine}`,
				],
				repo,
			);
			if (take.code !== 0)
				return json(
					{ ok: false, error: `claim failed: ${take.out.slice(0, 300)}` },
					409,
				);
			laneExecFacts(sid, agent, ep.model ?? tail, rowLocality(ep));
			void llmRoute({
				item: id,
				repo,
				role,
				target: `${machine}:${tail}`,
				sid,
				title: w.title,
				desc: w.description ?? "",
			});
			return json({ ok: true, item: id, sid, executor: agent });
		}
		const sid = `autow${id.replace(/^W/, "").replace(/\./g, "")}`;
		laneExecFacts(sid, agent, agent, "remote");
		const child = Bun.spawn(
			[
				process.execPath,
				CLI("fleet-loop.ts"),
				"dispatch",
				"--repo",
				repo,
				"--item",
				id,
				"--agent",
				agent,
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				// a launchd board can miss the user PATH — hand the lane's
				// agent spawn the dir we just resolved it from
				env: {
					...process.env,
					PATH: `${dirname(claude)}:${process.env.PATH ?? ""}`,
				},
			},
		);
		child.unref();
		return json({
			ok: true,
			item: id,
			sid,
		});
	}
	if (req.method === "POST" && url.pathname === "/api/ship") {
		// W64 — one-click ship from the W55 diff drawer: run the repo's merge
		// ladder for ONE branch (suspenders/<id>). Guarded; ladder required.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "");
		const id = String(parsed.body?.id ?? "");
		if (!project || !id)
			return json({ ok: false, error: "missing project or id" }, 400);
		if (DEMO)
			return json({ ok: false, error: "demo board — no real lanes" }, 409);
		const w = db
			.query("SELECT project FROM work_items WHERE project = ? AND id = ?")
			.get(project, id) as { project: string } | null;
		if (!w)
			return json(
				{ ok: false, error: `no work item ${id} in ${project}` },
				404,
			);
		const repo = project.replace(/\/\.git$/, "");
		if (!existsSync(repo))
			return json(
				{ ok: false, error: `project directory missing: ${repo}` },
				409,
			);
		const branch = `suspenders/${id}`;
		const git = (args: string[]): { out: string; code: number } => {
			const p = Bun.spawnSync(["/usr/bin/git", "-C", repo, ...args], {
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
				{ ok: false, error: `no main/master branch in ${repo}` },
				404,
			);
		const ahead = Number(
			git(["rev-list", "--count", `${baseBranch}..${branch}`]).out.trim() ||
				"0",
		);
		if (!Number.isFinite(ahead) || ahead <= 0)
			return json(
				{
					ok: false,
					error: `nothing to ship — ${branch} is already merged`,
				},
				409,
			);
		// never ship a branch a live lane still owns: the dispatched-lane pid
		// registry (.fleet/lanes.json) and the owning session's liveness both
		// veto — interactive lanes aren't in lanes.json, hence the second check
		const liveLane = lanesOf(repo).find(
			(l) => l.branch === branch && pidAlive(l.pid),
		);
		if (liveLane)
			return json(
				{
					ok: false,
					error: `a live lane (pid ${liveLane.pid}) still owns ${branch}`,
				},
				409,
			);
		const owner = db
			.query("SELECT owner_sid FROM work_items WHERE project = ? AND id = ?")
			.get(project, id) as { owner_sid: string | null } | null;
		if (owner?.owner_sid && sessionAlive(owner.owner_sid))
			return json(
				{
					ok: false,
					error: `owning session ${owner.owner_sid} is still live — ship after the lane finishes`,
				},
				409,
			);
		// W101 merge-ladder guard: a live .fleet/merge-active marker means
		// a daemon merge is mid-flight — one-click ship spawned fleet-loop
		// ship, whose blind MERGE_HEAD abort killed the ladder and
		// FAIL-struck the innocent branch. Mirror of fleet-loop's
		// mergeRunnerAlive (same 30-min freshness + ps cmdline identity);
		// the scripts can't share the helper without running the loop's
		// mode dispatch, so this stays a commented twin.
		try {
			const j = JSON.parse(
				readFileSync(`${repo}/.fleet/merge-active`, "utf8"),
			) as { pid: number; cmd?: string; ts: number };
			if (Date.now() - j.ts < 30 * 60_000 && j.cmd) {
				process.kill(j.pid, 0);
				const cmd = Bun.spawnSync(
					["ps", "-o", "command=", "-p", String(j.pid)],
					{ stdout: "pipe", stderr: "pipe" },
				)
					.stdout.toString()
					.trim();
				if (cmd === j.cmd)
					return json(
						{
							ok: false,
							error: `merge ladder in flight (pid ${j.pid}) — ship refused`,
						},
						409,
					);
			}
		} catch {}
		// the ladder is owner config in the repo — REQUIRED (a silent plain
		// merge would bypass the repo's quality policy)
		const ship = readShipJson(repo);
		if (!ship.ladder)
			return json(
				{
					ok: false,
					error: `no ladder configured — add ${repo}/.fleet/ship.json {"ladder":"<cmd template with {branch}>"}`,
				},
				409,
			);
		// detached child: HTTP answers while the ladder runs (ladders test — minutes)
		const child = Bun.spawn(
			[
				process.execPath,
				CLI("fleet-loop.ts"),
				"ship",
				"--repo",
				repo,
				"--branch",
				branch,
				"--ladder",
				ship.ladder,
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				// the ladder's own tools (bun/qlty/git) must resolve under launchd
				env: {
					...process.env,
					PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
				},
			},
		);
		child.unref();
		return json({ ok: true, item: id, branch, ladder: ship.ladder });
	}
	return null;
}
