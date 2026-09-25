// fleet-board.test.ts — decision lifecycle + endpoint hardening against a
// real board on a throwaway port, isolated HOME (same recipe as smoke.test.ts).
// Exercises the docs/decisions-api.md contract: schema v2 lifecycle
// (OPEN → ANSWERED → ACKNOWLEDGED / OPEN → CANCELLED), answer_token
// idempotency, delivery, and the /api/decisions feed shape.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-board-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-boardrepo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME, SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions", SUSPENDERS_MDNS: "0" };
const bin = join(import.meta.dir, "..", "hooks", "bin");
const PORT = 7847;
const BASE = `http://127.0.0.1:${PORT}`;

function run(cmd: string, args: string[]) {
	const p = Bun.spawnSync(["bun", join(bin, cmd), ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getData() {
	const r = await fetch(`${BASE}/api/data`);
	return r.json();
}
async function getDecisions() {
	return (await fetch(`${BASE}/api/decisions`)).json();
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	const r = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return { status: r.status, json: await r.json() };
}
// fetch() refuses to set Host/Origin — raw node:http for the hostile cases
function rawPost(headers: Record<string, string>, body: string): Promise<{ status: number | undefined; body: string }> {
	return new Promise((resolve) => {
		const rq = httpRequest({ host: "127.0.0.1", port: PORT, path: "/api/ack", method: "POST", headers }, (res) => {
			let b = "";
			res.on("data", (c) => (b += c));
			res.on("end", () => resolve({ status: res.statusCode, body: b }));
		});
		rq.end(body);
	});
}
function fork(feed: any, question: string) {
	const hits = feed.decisions.filter((d: any) => d.question === question);
	expect(hits.length).toBeLessThanOrEqual(1); // questions unique per test
	return hits[0];
}
// work add with a dynamic id — never hard-code W-numbers, the sequence shifts
function addWork(title: string, args: string[] = []): string {
	const r = run("work.ts", ["add", title, ...args]);
	if (r.code !== 0) throw new Error("work add failed: " + r.err);
	const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, { readonly: true });
	const row = db.query("SELECT id FROM work_items WHERE title = ?").get(title) as { id: string };
	db.close();
	return row.id;
}

const proc = Bun.spawn(["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
async function waitUp() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${BASE}/api/data`)).ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error("fleet board did not start on port " + PORT);
}
await waitUp();

afterAll(async () => {
	proc.kill();
	await proc.exited;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("served page", () => {
	test("inline script parses as JS (catches template corruption)", async () => {
		const r = await fetch(BASE + "/");
		expect(r.status).toBe(200);
		const page = await r.text();
		// only the corruption check is stable across UI rewrites — panel
		// internals belong to the UI and its own tests
		const script = page.match(/<script>([\s\S]*)<\/script>/)![1];
		expect(() => new Function(script)).not.toThrow();
	});
});

describe("decision lifecycle (docs/decisions-api.md)", () => {
	test("fork survives inbox ack; answer rotates the token; replay 200, stale 409, then ack", async () => {
		expect(run("coord.ts", ["bootstrap", "--as", "board-lane", "--role", "worker"]).code).toBe(0);
		expect(run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--scope", "W9", "--note", "ship or hold?", "--as", "board-lane"]).code).toBe(0);
		let rec = fork(await getDecisions(), "ship or hold?");
		expect(rec).toBeDefined();
		expect(rec.state).toBe("OPEN");
		expect(rec.asked_by).toBe("board-lane");
		expect(rec.delivery).toBe("DELIVERED");
		expect(typeof rec.answer_token).toBe("string");
		// the regression: the recipient reads their inbox — cursor moves past
		// the fork, but the fork must stay OPEN on the board
		expect(run("coord.ts", ["inbox", "--as", "board-lane", "--ack"]).code).toBe(0);
		expect(fork(await getDecisions(), "ship or hold?").state).toBe("OPEN");
		// answer requires the answer_token the client read
		const ans = await post("/api/answer", { id: rec.id, to: "board-lane", note: "ship it", token: rec.answer_token });
		expect(ans.status).toBe(200);
		expect(ans.json.ok).toBe(true);
		const answered = fork(await getDecisions(), "ship or hold?");
		expect(answered.state).toBe("ANSWERED");
		expect(answered.answer_note).toBe("ship it");
		expect(answered.answer_to).toBe("board-lane");
		expect(answered.answered_ts).toBeGreaterThan(0);
		expect(answered.answer_token).not.toBe(rec.answer_token); // rotated
		// idempotent replay: same note on the answered fork → 200 replay:true
		const replay = await post("/api/answer", { id: rec.id, to: "board-lane", note: "ship it", token: rec.answer_token });
		expect(replay.status).toBe(200);
		expect(replay.json.ok).toBe(true);
		expect(replay.json.replay).toBe(true);
		// stale view (another tab answered differently since) → 409 stale
		const stale = await post("/api/answer", { id: rec.id, to: "board-lane", note: "actually hold", token: rec.answer_token });
		expect(stale.status).toBe(409);
		expect(stale.json.error).toBe("stale");
		// ACKNOWLEDGED heuristic: lane checkpoint after answered_ts, token rotates again
		const tok2 = answered.answer_token;
		expect(run("coord.ts", ["emit", "checkpoint", "--as", "board-lane", "--note", "shipping"]).code).toBe(0);
		const acked = fork(await getDecisions(), "ship or hold?");
		expect(acked.state).toBe("ACKNOWLEDGED");
		expect(acked.ack_ts).toBeGreaterThan(0);
		expect(acked.answer_token).not.toBe(tok2);
	});

	test("dismiss = CANCELLED, idempotent, refused after an answer; answering a dismissed fork is stale", async () => {
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--note", "dismiss me", "--as", "board-lane"]);
		const rec = fork(await getDecisions(), "dismiss me");
		expect(rec).toBeDefined();
		for (let i = 0; i < 2; i++) {
			const ack = await post("/api/ack", { id: rec.id });
			expect(ack.status).toBe(200);
			expect(ack.json.ok).toBe(true); // idempotent
		}
		expect(fork(await getDecisions(), "dismiss me").state).toBe("CANCELLED");
		// answering a dismissed fork with the pre-dismiss token is stale
		const late = await post("/api/answer", { id: rec.id, to: "board-lane", note: "too late", token: rec.answer_token });
		expect(late.status).toBe(409);
		// monotonic: an ANSWERED fork cannot be dismissed
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--note", "answer then keep", "--as", "board-lane"]);
		const rec2 = fork(await getDecisions(), "answer then keep");
		expect(rec2).toBeDefined();
		expect((await post("/api/answer", { id: rec2.id, to: "board-lane", note: "kept", token: rec2.answer_token })).status).toBe(200);
		const dismiss = await post("/api/ack", { id: rec2.id });
		expect(dismiss.status).toBe(409);
		expect(dismiss.json.error).toBe("already answered");
	});

	test("v1 DISMISSED rows fold into CANCELLED on sync", async () => {
		// a NEED event with no target never backfills — host for a legacy row
		expect(run("coord.ts", ["emit", "NEED_DECISION", "--note", "legacy fork", "--as", "board-lane"]).code).toBe(0);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ev = db.query("SELECT id FROM events WHERE kind = 'NEED_DECISION' AND target IS NULL ORDER BY id DESC LIMIT 1").get() as { id: number };
		db.run("INSERT OR IGNORE INTO decisions (event_id, target, state, created_at) VALUES (?, 'board-lane', 'DISMISSED', ?)", ev.id, Date.now());
		db.close();
		const rec = fork(await getDecisions(), "legacy fork");
		expect(rec.state).toBe("CANCELLED");
		expect(rec.asked_by).toBe("board-lane"); // enrichment backfilled from the event
	});

	test("task_title joins from work_items; work supersede cancels the open fork", async () => {
		const wid = addWork("superseded target");
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--note", "hold the rework?", `--work=${wid}`, "--as", "board-lane"]);
		const rec = fork(await getDecisions(), "hold the rework?");
		expect(rec).toBeDefined();
		expect(rec.task_id).toBe(wid);
		expect(rec.task_title).toBe("superseded target");
		expect(run("coord.ts", ["emit", "work.superseded", `--work=${wid}`, "--as", "work"]).code).toBe(0);
		const after = fork(await getDecisions(), "hold the rework?");
		expect(after.state).toBe("CANCELLED");
	});

	test("delivery: live target DELIVERED, unknown target FAILED", async () => {
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "ghost-lane", "--note", "nobody home", "--as", "board-lane"]);
		const feed = await getDecisions();
		expect(fork(feed, "nobody home").delivery).toBe("FAILED");
		expect(fork(feed, "dismiss me").delivery).toBe("DELIVERED");
	});

	test("/api/decisions shape: options, age, label, global + per-project counts; /api/data drops decisions", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"pick one",
			`--options=[{"label":"queue","tradeoff":"slower start"},{"label":"stream","tradeoff":"more memory"}]`,
			"--as",
			"board-lane",
		]);
		const feed = await getDecisions();
		const rec = fork(feed, "pick one");
		expect(rec.options).toEqual([
			{ label: "queue", tradeoff: "slower start" },
			{ label: "stream", tradeoff: "more memory" },
		]);
		expect(rec.age_s).toBeGreaterThanOrEqual(0);
		expect(typeof rec.asked_by_label).toBe("string");
		expect(rec.created_ts).toBeGreaterThan(0);
		const open = feed.decisions.filter((d: any) => d.state === "OPEN");
		expect(feed.count).toBe(open.length);
		expect(feed.byProject[open[0].project]).toBeGreaterThan(0);
		const sum = Object.values(feed.byProject).reduce((a, b) => (a as number) + (b as number), 0) as number;
		expect(sum).toBe(feed.count);
		const d = await getData();
		expect(typeof d.decisionsTs).toBe("number");
		expect(d.needs).toBeUndefined();
	});
});

describe("endpoint hardening", () => {
	test("unknown and non-decision event ids are rejected, not no-opped", async () => {
		expect((await post("/api/ack", { id: 999999 })).status).toBe(404);
		const unknownAns = await post("/api/answer", { id: 999999, to: "board-lane", note: "x", token: "t" });
		expect(unknownAns.status).toBe(404);
		expect((await post("/api/advise", { id: 999999 })).status).toBe(404);
		// a real event that is not a NEED% fork
		run("coord.ts", ["emit", "NOTE", "--to", "board-lane", "--note", "not a fork", "--as", "board-lane"]);
		const nonNeed = (await getData()).events.find((e: any) => e.kind === "NOTE").id;
		expect((await post("/api/ack", { id: nonNeed })).status).toBe(400);
	});

	test("answer validation: id, to, note and token are all required", async () => {
		expect((await post("/api/answer", { to: "board-lane", note: "x", token: "t" })).status).toBe(400);
		expect((await post("/api/answer", { id: 1, note: "x", token: "t" })).status).toBe(400);
		expect((await post("/api/answer", { id: 1, to: "board-lane", token: "t" })).status).toBe(400);
		expect((await post("/api/answer", { id: 1, to: "board-lane", note: "x" })).status).toBe(400);
	});

	test("host, origin, and content-type guards", async () => {
		const evilHost = await rawPost({ host: "evil.example", "content-type": "application/json" }, '{"id":1}');
		expect(evilHost.status).toBe(403);
		const evilOrigin = await rawPost({ host: `127.0.0.1:${PORT}`, origin: "http://evil.example:8080", "content-type": "application/json" }, '{"id":1}');
		expect(evilOrigin.status).toBe(403);
		const nullOrigin = await rawPost({ host: `127.0.0.1:${PORT}`, origin: "null", "content-type": "application/json" }, '{"id":1}');
		expect(nullOrigin.status).toBe(403);
		const plain = await fetch(`${BASE}/api/ack`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"id":1}' });
		expect(plain.status).toBe(415);
		const noCt = await fetch(`${BASE}/api/ack`, { method: "POST", body: '{"id":1}' });
		expect(noCt.status).toBe(415);
		const malformed = await post("/api/ack", undefined as any);
		expect(malformed.status).toBe(400);
	});
});

describe("dashboard accuracy", () => {
	test("advise job reconciles: error fact clears the spinner state", async () => {
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--note", "advise me", "--as", "board-lane"]);
		const rec = fork(await getDecisions(), "advise me");
		expect(rec).toBeDefined();
		expect((await post("/api/advise", { id: rec.id })).json.ok).toBe(true);
		let err: string | undefined;
		for (let i = 0; i < 60; i++) {
			const cur = fork(await getDecisions(), "advise me");
			if (cur?.adviceError) {
				err = cur.adviceError;
				break;
			}
			await sleep(200);
		}
		expect(err).toBeDefined(); // dead SUSPENDERS_LLM_URL -> error fact -> poll picks it up
	});

	test("blocked item carries its open deps for truthful counts", async () => {
		const w1 = addWork("dep target", ["--scope", "dt"]);
		const w2 = addWork("dependent item", ["--scope", "dd"]);
		run("work.ts", ["block", w2, "--on", w1]);
		const proj = (await getData()).projects[0];
		expect(proj.gated.length).toBe(1);
		expect(proj.gated[0].deps).toEqual([w1]);
	});

	test("failed work is rendered with its error note", async () => {
		const w = addWork("doomed item", ["--scope", "df"]);
		run("work.ts", ["fail", w, "--note", "boom: no compiler"]);
		const failed = (await getData()).projects[0].other.find((x: any) => x.state === "FAILED");
		expect(failed).toBeDefined();
		expect(failed.note).toBe("boom: no compiler");
	});

	test("zombie chips drop the stray leading article", async () => {
		run("coord.ts", ["fact", "set", "zombie.V9", "a board-lane ZOMBIE (hb 52min)"]);
		expect((await getData()).zombies.some((z: any) => z.label === "board-lane ZOMBIE (hb 52min)")).toBe(true);
	});
});
