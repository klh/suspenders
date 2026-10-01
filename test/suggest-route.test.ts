// suggest-route.test.ts — W163 composer suggest: /api/suggest against a mock
// OpenAI-compatible endpoint. Own scratch fixture on 7852 + mock :7853 +
// suggest-board on 7854 (fixed ports are never shared across files).
import { afterAll, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";
const { HOME, REPO, env, bin, MY_PROJ, waitUp } = await boardFixture(
	7852,
	afterAll,
);

const MPORT = 7853;
const MB = `http://127.0.0.1:${MPORT}`;
const SUG_PORT = 7854;
const SB = `http://127.0.0.1:${SUG_PORT}`;
let mockHits = 0;
let lastUser = "";
// mock OpenAI-compatible endpoint: a canned brief-shaped expansion for normal
// drafts, <think>-wrapped junk for drafts containing JUNK (the parse-failure
// path); captures the last user message so tests can pin the prompt shape
const mock = Bun.serve({
	port: MPORT,
	fetch: async (req) => {
		mockHits++;
		const body = (await req.json().catch(() => ({}))) as {
			messages?: { role: string; content: string }[];
		};
		const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
		lastUser = user;
		if (user.includes("JUNK")) {
			return Response.json({
				choices: [{ message: { content: "<think>hmm</think>no" } }],
			});
		}
		return Response.json({
			choices: [
				{
					message: {
						content:
							"MISSION — build the thing.\nPROTOCOL — worktree + gates + commit.\nCONTEXT — drawn from the draft.",
					},
				},
			],
			usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
		});
	},
});

const sugProc = Bun.spawn(
	["bun", join(bin, "fleet-board.ts"), "--port", String(SUG_PORT)],
	{
		cwd: REPO,
		env: { ...env, SUSPENDERS_SUGGEST_URL: `${MB}/v1/chat/completions` },
		stdout: "pipe",
		stderr: "pipe",
	},
);
afterAll(async () => {
	sugProc.kill();
	await sugProc.exited;
	mock.stop(true);
});
// the suggest board races nothing: every test below hits SB, so the wait
// happens at fixture time, not inside the first test
await waitUp(SB);

const postS = async (path: string, body: unknown) => {
	const r = await fetch(`${SB}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: r.status, json: await r.json() };
};

// lane-plane fixture: one RUNNING session with a claim + an open owned work
// item — laneContext() must surface all three to the model
{
	const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	db.query(
		"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'lane', ?, ?, 'RUNNING')",
	).run("testsug", MY_PROJ, Date.now(), Date.now());
	db.query(
		"INSERT INTO claims (sid, scope, intent, hot, ts) VALUES (?, 'suggest-route.test.ts', 'expanding drafts', 0, ?)",
	).run("testsug", Date.now());
	db.query(
		"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'W99191', 'suggest lane demo item', 'CLAIMED', 'testsug', 'test', ?, ?)",
	).run(MY_PROJ, Date.now(), Date.now());
	db.close();
}

describe("W163 composer suggest", () => {
	test("llms.txt lists /api/suggest", async () => {
		const txt = await (await fetch(`${SB}/llms.txt`)).text();
		expect(txt).toContain("/api/suggest");
	});

	test("validation: 400s before any model call", async () => {
		expect((await postS("/api/suggest", { draft: "x" })).status).toBe(400);
		expect((await postS("/api/suggest", { project: MY_PROJ })).status).toBe(
			400,
		);
		const hitsBefore = mockHits;
		await postS("/api/suggest", { project: MY_PROJ, draft: "x" });
		expect(mockHits).toBe(hitsBefore);
	});

	test("suggest expands a draft with lane context, mock pins the shape", async () => {
		await waitUp(SB);
		const r = await postS("/api/suggest", {
			project: MY_PROJ,
			draft: "add csv export for the tasks table",
		});
		expect(r.status).toBe(200);
		expect(r.json.ok).toBe(true);
		expect(r.json.prompt).toContain("MISSION");
		expect(r.json.model).toBeTruthy();
		expect(r.json.cached).toBeFalsy();
		expect(lastUser).toContain("DRAFT:");
		expect(lastUser).toContain("RUNNING LANES:");
		expect(lastUser).toContain("testsug (this project)");
		expect(lastUser).toContain("W99191 suggest lane demo item");
	});

	test("junk model output answers 502 with a retryable error", async () => {
		const r = await postS("/api/suggest", {
			project: MY_PROJ,
			draft: "JUNKQ goal x",
		});
		expect(r.status).toBe(502);
		expect(r.json.error).toContain("no usable suggestion");
	});

	test("re-click re-serves from the cache, never re-bills the model", async () => {
		const hitsBefore = mockHits;
		const r = await postS("/api/suggest", {
			project: MY_PROJ,
			draft: "add csv export for the tasks table",
		});
		expect(r.status).toBe(200);
		expect(r.json.cached).toBe(true);
		expect(mockHits).toBe(hitsBefore);
	});

	test("suggest telemetry lands as an llm.call event", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, {
			readonly: true,
		});
		const row = db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'llm.call' AND source = 'suggest'",
			)
			.get() as { n: number };
		db.close();
		expect(row.n).toBeGreaterThanOrEqual(1);
	});
});
