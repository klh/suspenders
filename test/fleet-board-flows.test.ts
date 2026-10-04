// fleet-board-flows.test.ts — heavy flow suites (W64 ship + W57
// orchestrate), split from fleet-board.test.ts by the 1500-line law
// (W157); factory fixture, own scratch HOME + :7851 board (7847/7848 are
// main's board + demo board; W57's describe binds 7849 + mock :7850 —
// fixed ports are never shared across files or describes)
// test files in one process — a shared side-effect fixture would die
// with the first file's afterAll).
import { afterAll, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";
const { HOME, REPO, GREPO, env, bin, BASE, run, MY_PROJ, post, waitUp } =
	await boardFixture(7851, afterAll);

// W157: in the monolith, W55's body ran `git init -b main` in GREPO
// before W64/W57 needed it; files get separate fixture instances now,
// so flows inits its own GREPO up front
{
	const g = (args: string[], cwd = GREPO) =>
		Bun.spawnSync(["/usr/bin/git", ...args], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
	g(["init", "-b", "main"]);
	g(["config", "user.email", "t@threads.dk"]);
	g(["config", "user.name", "t"]);
	await Bun.write(join(GREPO, "f.txt"), "one\n");
	g(["add", "."]);
	g(["commit", "-m", "base"]);
}

describe("W64 ship trigger", () => {
	const g = (args: string[], cwd = GREPO) =>
		Bun.spawnSync(["/usr/bin/git", ...args], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
	// ship-ready fixture: work item + suspenders/<id> branch one commit ahead
	// of main, made in a shared throwaway worktree (removed after each use);
	// ownerless by default so the liveness guard stays out of the way
	function shipFixture(id: string, owner?: string): void {
		const wt = join(GREPO, "wt-tmp");
		const wa = g(["worktree", "add", "-b", `suspenders/${id}`, wt]);
		if (wa.exitCode !== 0) throw new Error(`worktree add failed: ${wa.stderr}`);
		g(["config", "user.email", "t@threads.dk"], wt);
		g(["config", "user.name", "t"], wt);
		writeFileSync(join(wt, "ship.txt"), `${id}\n`);
		g(["add", "-A"], wt);
		const c = g(["commit", "-m", `lane ${id}`], wt);
		if (c.exitCode !== 0) throw new Error(`fixture commit failed: ${c.stderr}`);
		g(["worktree", "remove", wt]);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, ?, 'ship demo', 'CLAIMED', ?, 'test', ?, ?)",
		).run(GREPO, id, owner ?? null, Date.now(), Date.now());
		db.close();
	}
	const shipJson = (repo: string, ladder: string | null): void => {
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		if (ladder === null)
			rmSync(join(repo, ".fleet", "ship.json"), { force: true });
		else
			writeFileSync(
				join(repo, ".fleet", "ship.json"),
				JSON.stringify({ ladder }),
			);
	};
	const waitBranch = (branch: string, gone: boolean): boolean => {
		for (let i = 0; i < 100; i++) {
			const exists =
				g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
					.exitCode === 0;
			if (exists !== gone) return true;
			Bun.sleepSync(100);
		}
		return false;
	};

	test("served page wires the ship button + llms.txt lists /api/ship", async () => {
		const page = await (await fetch(`${BASE}/`)).text();
		expect(page).toContain("diffbtn ship");
		expect(page).toContain("shipItem");
		expect(page).toContain("/api/ship");
		const txt = await (await fetch(`${BASE}/llms.txt`)).text();
		expect(txt).toContain("/api/ship");
	});

	test("validation: missing fields 400, unknown item 404, no-ladder 409", async () => {
		expect((await post("/api/ship", { project: GREPO })).status).toBe(400);
		expect(
			(await post("/api/ship", { project: GREPO, id: "WNOPE" })).status,
		).toBe(404);
		// branch exists + ahead + no live lane + no owner → the LADDER guard
		// is what refuses (ship.json never written for WSHIPZ)
		shipFixture("WSHIPZ");
		const noLadder = await post("/api/ship", { project: GREPO, id: "WSHIPZ" });
		expect(noLadder.status).toBe(409);
		expect(noLadder.json.error).toContain("no ladder configured");
		expect(noLadder.json.error).toContain("ship.json");
	});

	test("live-lane pid guard: a live lanes.json entry vetoes the ship", async () => {
		shipFixture("WSHIPL");
		mkdirSync(join(GREPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(GREPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{
					sid: "w64-test-lane",
					item: "WSHIPL",
					pid: process.pid,
					branch: "suspenders/WSHIPL",
					worktree: "",
				},
			]),
		);
		const r = await post("/api/ship", { project: GREPO, id: "WSHIPL" });
		expect(r.status).toBe(409);
		expect(r.json.error).toContain("live lane");
		expect(r.json.error).toContain("pid");
	});

	test("live-owner guard: a RUNNING session with a warm transcript vetoes", async () => {
		shipFixture("WSHIPO", "w64-live-owner");
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w64-live-owner', ?, 'worker', ?, ?, 'RUNNING')",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const r = await post("/api/ship", { project: GREPO, id: "WSHIPO" });
		expect(r.status).toBe(409);
		expect(r.json.error).toContain("still live");
	});

	test("merge-ladder guard: a live .fleet/merge-active marker vetoes the ship (W101)", async () => {
		shipFixture("WMRG");
		shipJson(GREPO, 'git merge --no-ff {branch} -m "shipped {branch}"');
		// marker pid = this test process; the board re-runs ps itself and
		// compares cmdline identity, exactly as fleet-loop's mergeRunnerAlive
		mkdirSync(join(GREPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(GREPO, ".fleet", "merge-active"),
			JSON.stringify({
				pid: process.pid,
				cmd: Bun.spawnSync(
					["ps", "-o", "command=", "-p", String(process.pid)],
					{ stdout: "pipe", stderr: "pipe" },
				)
					.stdout.toString()
					.trim(),
				branch: "suspenders/WMRG",
				ts: Date.now(),
			}),
		);
		const r = await post("/api/ship", { project: GREPO, id: "WMRG" });
		expect(r.status).toBe(409);
		expect(r.json.error).toContain("merge ladder in flight");
		// the marker names THIS process (still alive) — remove it or the next
		// ship test's detached child reads a live runner and vetoes too
		rmSync(join(GREPO, ".fleet", "merge-active"));
	});

	test("end-to-end: ok + detached child merges through the ladder and retires the branch", async () => {
		shipFixture("WSHIP1");
		shipJson(GREPO, 'git merge --no-ff {branch} -m "shipped {branch}"');
		writeFileSync(join(GREPO, ".fleet", "lanes.json"), "[]");
		const t0 = Date.now();
		const r = await post("/api/ship", { project: GREPO, id: "WSHIP1" });
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(true);
		expect(r.json.branch).toBe("suspenders/WSHIP1");
		expect(r.json.ladder).toContain("shipped {branch}");
		// the detached child does the real work — wait for retirement
		expect(waitBranch("suspenders/WSHIP1", true)).toBe(true);
		expect(Date.now() - t0).toBeLessThan(60_000);
		// ladder substitution proven by the merge subject; loop.log carries it
		expect(g(["log", "--format=%s", "-1"]).stdout.toString()).toContain(
			"shipped suspenders/WSHIP1",
		);
		const logTail = readFileSync(join(GREPO, ".fleet", "loop.log"), "utf8");
		expect(logTail).toContain("MERGED suspenders/WSHIP1");
		expect(logTail).toContain("RETIRED suspenders/WSHIP1");
		// shipped = branch retired — a second ship is an honest 404
		const again = await post("/api/ship", { project: GREPO, id: "WSHIP1" });
		expect(again.status).toBe(404);
		expect(again.json.error).toContain("no branch");
	});
});

describe("W57 orchestrate box", () => {
	const OPORT = 7849;
	const OB = `http://127.0.0.1:${OPORT}`;
	const MPORT = 7850;
	const MB = `http://127.0.0.1:${MPORT}`;
	// mock OpenAI-compatible endpoint: fenced-JSON proposal for normal goals,
	// prose-only garbage for goals containing JUNK (the parse-failure path)
	const mock = Bun.serve({
		port: MPORT,
		fetch: async (req) => {
			const body = (await req.json().catch(() => ({}))) as {
				messages?: { role: string; content: string }[];
			};
			const goal = body.messages?.find((m) => m.role === "user")?.content ?? "";
			if (goal.includes("JUNK")) {
				return Response.json({
					choices: [{ message: { content: "sorry, no json here" } }],
				});
			}
			const proposal = {
				title: "csv export for the tasks table",
				children: [
					{ title: "export scaffolding", brief: "route + content negotiation" },
					{ title: "streaming for big exports", brief: "cursor pagination" },
					{ title: "docs row", brief: "" },
				],
			};
			return Response.json({
				choices: [
					{
						message: {
							content: `\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``,
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
			});
		},
	});
	const orchProc = Bun.spawn(
		["bun", join(bin, "fleet-board.ts"), "--port", String(OPORT)],
		{
			cwd: REPO,
			env: { ...env, SUSPENDERS_LLM_URL: `${MB}/v1/chat/completions` },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	afterAll(async () => {
		orchProc.kill();
		await orchProc.exited;
		mock.stop(true);
	});
	const postO = async (path: string, body: unknown) => {
		const r = await fetch(`${OB}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: r.status, json: await r.json() };
	};
	test("llms.txt lists both orchestrate routes", async () => {
		const txt = await (await fetch(`${BASE}/llms.txt`)).text();
		expect(txt).toContain("/api/orchestrate/register");
		expect(txt).toContain("/api/orchestrate ");
	});
	test("unreachable LLM degrades to 502, nothing written", async () => {
		const r = await post("/api/orchestrate", {
			project: MY_PROJ,
			goal: "anything",
		});
		expect(r.status).toBe(502);
		expect(r.json.ok).toBe(false);
	});
	test("propose parses fenced LLM json into a proposal", async () => {
		await waitUp(OB);
		const r = await postO("/api/orchestrate", {
			project: MY_PROJ,
			goal: "add csv export",
		});
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(true);
		expect(r.json.proposal.title).toContain("csv export");
		expect(r.json.proposal.children.length).toBe(3);
		expect(r.json.proposal.children[0].brief).toBeTruthy();
		expect(r.json.model).toBeTruthy();
	});
	test("junk LLM output answers 502 with a retryable error", async () => {
		const r = await postO("/api/orchestrate", {
			project: MY_PROJ,
			unused: 0,
			goal: "JUNK goal",
		});
		expect(r.status).toBe(502);
		expect(r.json.error).toContain("no parseable plan");
	});
	test("register validation: 400s before any work-graph write", async () => {
		expect(
			(await postO("/api/orchestrate/register", { goal: "x" })).status,
		).toBe(400);
		expect(
			(await postO("/api/orchestrate/register", { project: MY_PROJ })).status,
		).toBe(400);
		expect(
			(
				await postO("/api/orchestrate/register", {
					project: MY_PROJ,
					title: "t",
					children: ["only one child"],
				})
			).status,
		).toBe(400);
		expect(
			(
				await postO("/api/orchestrate/register", {
					project: MY_PROJ,
					title: "t",
					children: Array.from({ length: 9 }, (_, i) => `c${i}`),
				})
			).status,
		).toBe(400);
	});
	test("register runs the plan-gated split in the target repo", async () => {
		const reg = await postO("/api/orchestrate/register", {
			project: MY_PROJ,
			title: "W57 e2e orchestration",
			children: [
				"first independently actionable child",
				"second independently actionable child",
				"third independently actionable child",
			],
		});
		expect(reg.status).toBe(200);
		expect(reg.json.ok).toBe(true);
		expect(reg.json.plan).toMatch(/^W\d+$/);
		expect(reg.json.children.length).toBe(3);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, {
			readonly: true,
		});
		const parent = db
			.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
			.get(MY_PROJ, reg.json.plan) as { state: string } | null;
		expect(parent?.state).toBe("SHATTERED");
		const kids = db
			.query(
				"SELECT id, state FROM work_items WHERE project = ? AND parent_id = ? ORDER BY id",
			)
			.all(MY_PROJ, reg.json.plan) as { id: string; state: string }[];
		db.close();
		expect(kids.length).toBe(3);
		for (const k of kids) expect(k.state).toBe("READY");
		const feed = await (await fetch(`${OB}/api/tasks`)).json();
		const plan = feed.tasks.find((t: Row) => t.id === reg.json.plan);
		expect(plan?.title).toBe("plan: W57 e2e orchestration");
	});
	test("orchestrate telemetry lands as an llm.call event", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, {
			readonly: true,
		});
		const row = db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'llm.call' AND source = 'orchestrate'",
			)
			.get() as { n: number };
		db.close();
		expect(row.n).toBeGreaterThanOrEqual(1);
	});
});
