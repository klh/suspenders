// fleet-board.test.ts — the fleet-board HTTP surface (W157 split; the
// factory fixture in test/helpers/board-fixture.ts gives every test
// file its own scratch HOME + board; flows live in fleet-board-flows.
import { afterAll, describe, expect, test } from "bun:test";

import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isDecisionKind } from "../hooks/lib/govdb.ts";
import { boardFixture } from "./helpers/board-fixture.ts";
const {
	HOME,
	REPO,
	GREPO,
	env,
	bin,
	PORT,
	BASE,
	run,
	q,
	sleep,
	getData,
	myProject,
	getDecisions,
	post,
	rawPost,
	fork,
	addWork,
	waitUp,
	demoProc,
	setDemoProc,
} = await boardFixture(7847, afterAll);

describe("served page", () => {
	test("inline script parses as JS (catches template corruption)", async () => {
		const r = await fetch(`${BASE}/`);
		expect(r.status).toBe(200);
		const page = await r.text();
		// only the corruption check is stable across UI rewrites — panel
		// internals belong to the UI and its own tests. Per-block, non-greedy:
		// the topbar probe script (2ae8d41) made the old greedy match span
		// both blocks + the markup between them, so it never parsed again
		const blocks = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
			(m) => m[1],
		);
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		for (const b of blocks) expect(() => new Function(b)).not.toThrow();
	});

	test("GET /llms.txt — plain-text agent contract", async () => {
		const r = await fetch(`${BASE}/llms.txt`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/plain");
		const txt = await r.text();
		expect(txt).toContain("# suspenders");
		expect(txt).toContain("/api/data");
		expect(txt).toContain("/api/start");
		expect(txt).toContain("http://www.threads.dk");
	});

	test("served page wires the #filter= hash deep-link (statusline worker links)", async () => {
		const r = await fetch(`${BASE}/`);
		expect(r.status).toBe(200);
		const page = await r.text();
		// hash contract: change listener + needle matcher + chip clear affordance
		expect(page).toContain("hashchange");
		expect(page).toContain("#filter=");
		expect(page).toContain("hfclear");
	});
});

describe("decision lifecycle (docs/decisions-api.md)", () => {
	test("fork survives inbox ack; answer rotates the token; replay 200, stale 409, then ack", async () => {
		expect(
			run("coord.ts", ["bootstrap", "--as", "board-lane", "--role", "worker"])
				.code,
		).toBe(0);
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"board-lane",
				"--scope",
				"W9",
				"--note",
				"ship or hold?",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "ship or hold?");
		expect(rec).toBeDefined();
		expect(rec.state).toBe("OPEN");
		expect(rec.asked_by).toBe("board-lane");
		expect(rec.delivery).toBe("DELIVERED");
		expect(typeof rec.answer_token).toBe("string");
		// the regression: the recipient reads their inbox — cursor moves past
		// the fork, but the fork must stay OPEN on the board
		expect(run("coord.ts", ["inbox", "--as", "board-lane", "--ack"]).code).toBe(
			0,
		);
		expect(fork(await getDecisions(), "ship or hold?").state).toBe("OPEN");
		// answer requires the answer_token the client read
		const ans = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "ship it",
			token: rec.answer_token,
		});
		expect(ans.status).toBe(200);
		expect(ans.json.ok).toBe(true);
		const answered = fork(await getDecisions(), "ship or hold?");
		expect(answered.state).toBe("ANSWERED");
		expect(answered.answer_note).toBe("ship it");
		expect(answered.answer_to).toBe("board-lane");
		expect(answered.answered_ts).toBeGreaterThan(0);
		expect(answered.answer_token).not.toBe(rec.answer_token); // rotated
		// idempotent replay: same note on the answered fork → 200 replay:true
		const replay = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "ship it",
			token: rec.answer_token,
		});
		expect(replay.status).toBe(200);
		expect(replay.json.ok).toBe(true);
		expect(replay.json.replay).toBe(true);
		// stale view (another tab answered differently since) → 409 stale
		const stale = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "actually hold",
			token: rec.answer_token,
		});
		expect(stale.status).toBe(409);
		expect(stale.json.error).toBe("stale");
		// ACKNOWLEDGED heuristic: lane checkpoint after answered_ts, token rotates again
		const tok2 = answered.answer_token;
		expect(
			run("coord.ts", [
				"emit",
				"checkpoint",
				"--as",
				"board-lane",
				"--note",
				"shipping",
			]).code,
		).toBe(0);
		const acked = fork(await getDecisions(), "ship or hold?");
		expect(acked.state).toBe("ACKNOWLEDGED");
		expect(acked.ack_ts).toBeGreaterThan(0);
		expect(acked.answer_token).not.toBe(tok2);
	});

	test("dismiss = CANCELLED, idempotent, refused after an answer; answering a dismissed fork is stale", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"dismiss me",
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "dismiss me");
		expect(rec).toBeDefined();
		for (let i = 0; i < 2; i++) {
			const ack = await post("/api/ack", { id: rec.id });
			expect(ack.status).toBe(200);
			expect(ack.json.ok).toBe(true); // idempotent
		}
		expect(fork(await getDecisions(), "dismiss me").state).toBe("CANCELLED");
		// answering a dismissed fork with the pre-dismiss token is stale
		const late = await post("/api/answer", {
			id: rec.id,
			to: "board-lane",
			note: "too late",
			token: rec.answer_token,
		});
		expect(late.status).toBe(409);
		// monotonic: an ANSWERED fork cannot be dismissed
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"answer then keep",
			"--as",
			"board-lane",
		]);
		const rec2 = fork(await getDecisions(), "answer then keep");
		expect(rec2).toBeDefined();
		expect(
			(
				await post("/api/answer", {
					id: rec2.id,
					to: "board-lane",
					note: "kept",
					token: rec2.answer_token,
				})
			).status,
		).toBe(200);
		const dismiss = await post("/api/ack", { id: rec2.id });
		expect(dismiss.status).toBe(409);
		expect(dismiss.json.error).toBe("already answered");
	});

	test("v1 DISMISSED rows fold into CANCELLED on sync", async () => {
		// a NEED event with no target never backfills — host for a legacy row
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--note",
				"legacy fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ev = db
			.query(
				"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND target IS NULL ORDER BY id DESC LIMIT 1",
			)
			.get() as { id: number };
		db.run(
			"INSERT OR IGNORE INTO decisions (event_id, target, state, created_at) VALUES (?, 'board-lane', 'DISMISSED', ?)",
			ev.id,
			Date.now(),
		);
		db.close();
		const rec = fork(await getDecisions(), "legacy fork");
		expect(rec.state).toBe("CANCELLED");
		expect(rec.asked_by).toBe("board-lane"); // enrichment backfilled from the event
	});

	test("task_title joins from work_items; work supersede cancels the open fork", async () => {
		const wid = addWork("superseded target");
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"hold the rework?",
			`--work=${wid}`,
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "hold the rework?");
		expect(rec).toBeDefined();
		expect(rec.task_id).toBe(wid);
		expect(rec.task_title).toBe("superseded target");
		expect(
			run("coord.ts", [
				"emit",
				"work.superseded",
				`--work=${wid}`,
				"--as",
				"work",
			]).code,
		).toBe(0);
		const after = fork(await getDecisions(), "hold the rework?");
		expect(after.state).toBe("CANCELLED");
	});

	test("delivery: live target DELIVERED, unknown target FAILED", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"ghost-lane",
			"--note",
			"nobody home",
			"--as",
			"board-lane",
		]);
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
		const open = feed.decisions.filter((d: Row) => d.state === "OPEN");
		expect(feed.count).toBe(open.length);
		expect(feed.byProject[open[0].project]).toBeGreaterThan(0);
		const sum = Object.values(feed.byProject).reduce(
			(a, b) => (a as number) + (b as number),
			0,
		) as number;
		expect(sum).toBe(feed.count);
		const d = await getData();
		expect(typeof d.decisionsTs).toBe("number");
		expect(d.needs).toBeUndefined();
	});
});

describe("endpoint hardening", () => {
	test("unknown and non-decision event ids are rejected, not no-opped", async () => {
		expect((await post("/api/ack", { id: 999999 })).status).toBe(404);
		const unknownAns = await post("/api/answer", {
			id: 999999,
			to: "board-lane",
			note: "x",
			token: "t",
		});
		expect(unknownAns.status).toBe(404);
		expect((await post("/api/advise", { id: 999999 })).status).toBe(404);
		// a real event that is not a NEED% fork
		run("coord.ts", [
			"emit",
			"NOTE",
			"--to",
			"board-lane",
			"--note",
			"not a fork",
			"--as",
			"board-lane",
		]);
		const nonNeed = (await getData()).events.find(
			(e: Row) => e.kind === "NOTE",
		).id;
		expect((await post("/api/ack", { id: nonNeed })).status).toBe(400);
	});

	test("decision-kind variants (need-decision/need_decision) list AND advise — W54 regression", async () => {
		// a lane emitted need-decision; the board listed it (SQL LIKE 'NEED%'
		// is case-insensitive) then /api/advise refused it (400 "not a decision
		// event"). Both gates now share isDecisionKind().
		expect(
			run("coord.ts", [
				"emit",
				"need-decision",
				"--to",
				"board-lane",
				"--note",
				"advise the lowercase fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const lower = fork(await getDecisions(), "advise the lowercase fork");
		expect(lower).toBeDefined();
		expect((await post("/api/advise", { id: lower.id })).json.ok).toBe(true);
		expect(
			run("coord.ts", [
				"emit",
				"need_decision",
				"--to",
				"board-lane",
				"--note",
				"ack the underscore fork",
				"--as",
				"board-lane",
			]).code,
		).toBe(0);
		const under = fork(await getDecisions(), "ack the underscore fork");
		expect(under).toBeDefined();
		expect((await post("/api/ack", { id: under.id })).json.ok).toBe(true);
	});

	test("isDecisionKind accepts NEED_DECISION/need-decision/need_decision, rejects other kinds", () => {
		for (const k of [
			"NEED_DECISION",
			"need-decision",
			"need_decision",
			"NEED_INFO",
		])
			expect(isDecisionKind(k)).toBe(true);
		for (const k of [
			"NOTE",
			"work.claimed",
			"decision",
			"awaiting-input",
			"",
			"xNEED",
		])
			expect(isDecisionKind(k)).toBe(false);
	});

	test("advise entry accepts need-decision (pre-seeded advice fact → idempotent exit, no LLM call)", () => {
		run("coord.ts", [
			"emit",
			"need-decision",
			"--to",
			"board-lane",
			"--note",
			"entry gate",
			"--as",
			"board-lane",
		]);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		const ev = db
			.query(
				"SELECT id FROM events WHERE kind = 'need-decision' AND json_extract(payload, '$.note') = 'entry gate'",
			)
			.get() as { id: number };
		// advise.ts checks the fact BEFORE any fetch — seeding it proves the
		// kind gate passed without ever reaching the (dead) LLM URL
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
		).run(`advice.${ev.id}`, JSON.stringify({ rec: "seeded" }), Date.now());
		db.close();
		const r = run("advise.ts", [String(ev.id)]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("already advised");
	});

	test("answer validation: id, to, note and token are all required", async () => {
		expect(
			(await post("/api/answer", { to: "board-lane", note: "x", token: "t" }))
				.status,
		).toBe(400);
		expect(
			(await post("/api/answer", { id: 1, note: "x", token: "t" })).status,
		).toBe(400);
		expect(
			(await post("/api/answer", { id: 1, to: "board-lane", token: "t" }))
				.status,
		).toBe(400);
		expect(
			(await post("/api/answer", { id: 1, to: "board-lane", note: "x" }))
				.status,
		).toBe(400);
	});

	test("host, origin, and content-type guards", async () => {
		const evilHost = await rawPost(
			{ host: "evil.example", "content-type": "application/json" },
			'{"id":1}',
		);
		expect(evilHost.status).toBe(403);
		const evilOrigin = await rawPost(
			{
				host: `127.0.0.1:${PORT}`,
				origin: "http://evil.example:8080",
				"content-type": "application/json",
			},
			'{"id":1}',
		);
		expect(evilOrigin.status).toBe(403);
		const nullOrigin = await rawPost(
			{
				host: `127.0.0.1:${PORT}`,
				origin: "null",
				"content-type": "application/json",
			},
			'{"id":1}',
		);
		expect(nullOrigin.status).toBe(403);
		const plain = await fetch(`${BASE}/api/ack`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: '{"id":1}',
		});
		expect(plain.status).toBe(415);
		const noCt = await fetch(`${BASE}/api/ack`, {
			method: "POST",
			body: '{"id":1}',
		});
		expect(noCt.status).toBe(415);
		const malformed = await post("/api/ack", undefined);
		expect(malformed.status).toBe(400);
	});
});

describe("dashboard accuracy", () => {
	test("advise job reconciles: error fact clears the spinner state", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"advise me",
			"--as",
			"board-lane",
		]);
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
		const proj = await myProject();
		expect(proj.gated.length).toBe(1);
		expect(proj.gated[0].deps).toEqual([w1]);
	});

	test("failed work is rendered with its error note", async () => {
		const w = addWork("doomed item", ["--scope", "df"]);
		run("work.ts", ["fail", w, "--note", "boom: no compiler"]);
		const failed = (await myProject()).other.find(
			(x: Row) => x.state === "FAILED",
		);
		expect(failed).toBeDefined();
		expect(failed.note).toBe("boom: no compiler");
	});

	test("zombie chips drop the stray leading article", async () => {
		run("coord.ts", [
			"fact",
			"set",
			"zombie.V9",
			"a board-lane ZOMBIE (hb 52min)",
		]);
		expect(
			(await getData()).zombies.some(
				(z: Row) => z.label === "board-lane ZOMBIE (hb 52min)",
			),
		).toBe(true);
	});
});

describe("board api v3 (docs/board-api.md)", () => {
	// the temp repo has a bare .git dir (no refs) — projectIdentity() falls
	// back to the cwd realpath, /var/folders symlinks resolve to /private/var
	const proj = realpathSync(REPO);

	test("/api/tasks: contract shape, newest activity first, project filter, open_decisions, owner_label", async () => {
		const w1 = addWork("tasks demo alpha", ["--scope", "ta"]);
		const w2 = addWork("tasks demo beta", [
			"--scope",
			"tb",
			"--requires",
			"shell",
		]);
		// the shell-requiring item needs a capable session on record
		expect(
			run("coord.ts", [
				"bootstrap",
				"--as",
				"board-lane",
				"--role",
				"worker",
				"--caps",
				"shell",
			]).code,
		).toBe(0);
		expect(run("work.ts", ["take", w2, "--as", "board-lane"]).code).toBe(0);
		// claim intent → owner_label (claim.ts validates live transcripts, which
		// a temp HOME lacks — seed the row directly, same recipe as the v1 rows)
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		db.run(
			"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts) VALUES ('board-lane', 'ta', 'tasks lane', 0, ?)",
			Date.now(),
		);
		db.close();
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"tasks fork?",
			`--work=${w1}`,
			"--as",
			"board-lane",
		]);
		const all = await (await fetch(`${BASE}/api/tasks`)).json();
		expect(all.ok).toBe(true);
		expect(all.projects).toContain(proj);
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(feed.ok).toBe(true);
		expect(feed.tasks.length).toBeGreaterThan(1);
		for (const t of feed.tasks) {
			expect(t.project).toBe(proj);
			expect(Object.keys(t).sort()).toEqual([
				"age_s",
				"executor",
				"id",
				"locality",
				"model",
				"open_decisions",
				"owner_label",
				"owner_sid",
				"parent_id",
				"project",
				"requires",
				"scope",
				"state",
				"tail",
				"title",
				"unblocked_by",
			]);
		}
		const alpha = feed.tasks.find((t: Row) => t.id === w1);
		const beta = feed.tasks.find((t: Row) => t.id === w2);
		// newest activity first: beta was taken after alpha was added
		expect(feed.tasks.findIndex((t: Row) => t.id === w2)).toBeLessThan(
			feed.tasks.findIndex((t: Row) => t.id === w1),
		);
		expect(beta.state).toBe("CLAIMED");
		expect(beta.owner_sid).toBe("board-lane");
		expect(beta.owner_label).toBe("tasks lane"); // claim intent, not the raw sid
		expect(beta.requires).toBe("shell");
		expect(beta.scope).toBe("tb");
		expect(beta.open_decisions).toBe(0);
		expect(typeof beta.age_s).toBe("number");
		expect(alpha.owner_sid).toBeNull();
		expect(alpha.owner_label).toBeNull();
		expect(alpha.open_decisions).toBe(1); // the fork emitted with --work
		// the `all` literal returns every project's items
		const everything = await (
			await fetch(`${BASE}/api/tasks?project=all`)
		).json();
		expect(everything.tasks.find((t: Row) => t.id === w1)).toBeDefined();
		// superseding removes the item from the feed
		expect(run("work.ts", ["supersede", w2, "--by", w1]).code).toBe(0);
		const after = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(after.tasks.find((t: Row) => t.id === w2)).toBeUndefined();
	});

	test("/api/tasks: done→ready auto-start — unblocked_by flags the freed dependent", async () => {
		const w1 = addWork("auto-start root", ["--scope", "asr"]);
		const w2 = addWork("auto-start dependent", ["--scope", "asd"]);
		run("work.ts", ["block", w2, "--on", w1]);
		// done emits work.ready; the flag rides the newest unblock event
		expect(run("work.ts", ["take", w1, "--as", "w50-tester"]).code).toBe(0);
		expect(
			run("work.ts", ["done", w1, "--as", "w50-tester", "--sha", "abc1234"])
				.code,
		).toBe(0);
		const feed = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		const dep = feed.tasks.find((t: Row) => t.id === w2);
		expect(dep.state).toBe("READY");
		expect(dep.unblocked_by).toBe(w1);
		// the drawer's task object shares the shape ("…as above" in board-api.md)
		const drawer = await (
			await fetch(`${BASE}/api/task?project=${q(proj)}&id=${w2}`)
		).json();
		expect(drawer.task.unblocked_by).toBe(w1);
		// self-clearing: once the freed item is claimed, the flag drops
		expect(run("work.ts", ["take", w2, "--as", "w50-tester"]).code).toBe(0);
		const later = await (
			await fetch(`${BASE}/api/tasks?project=${q(proj)}`)
		).json();
		expect(later.tasks.find((t: Row) => t.id === w2).unblocked_by).toBeNull();
	});

	test("/api/task: 404 shape for a missing id; events + decisions linkage, newest first", async () => {
		const miss = await fetch(`${BASE}/api/task?project=${q(proj)}&id=NOPE`);
		expect(miss.status).toBe(404);
		expect((await miss.json()).ok).toBe(false);
		const wid = addWork("detail demo", ["--scope", "td"]);
		run("coord.ts", [
			"emit",
			"checkpoint",
			"--scope",
			wid,
			"--note",
			"scope-tied note",
			"--as",
			"board-lane",
		]);
		run("coord.ts", [
			"emit",
			"checkpoint",
			`--work=${wid}`,
			"--note",
			"work-tied note",
			"--as",
			"board-lane",
		]);
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"detail fork?",
			`--work=${wid}`,
			"--as",
			"board-lane",
		]);
		const r = await (
			await fetch(`${BASE}/api/task?project=${q(proj)}&id=${wid}`)
		).json();
		expect(r.ok).toBe(true);
		expect(r.projects).toContain(proj);
		expect(r.task.id).toBe(wid);
		expect(r.task.title).toBe("detail demo");
		expect(r.task.open_decisions).toBe(1);
		expect(r.events.length).toBeGreaterThanOrEqual(4); // added + scope checkpoint + work checkpoint + fork
		const ids = r.events.map((e: Row) => e.id);
		expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids); // newest first
		for (const e of r.events) {
			expect(Object.keys(e).sort()).toEqual([
				"id",
				"kind",
				"note",
				"sha",
				"source",
				"ts",
			]);
			expect(e.ts).toBeGreaterThan(0);
		}
		expect(r.events.map((e: Row) => e.note)).toContain("scope-tied note"); // scope match
		expect(r.events.map((e: Row) => e.note)).toContain("work-tied note"); // payload.work match
		const dec = r.decisions.find((d: Row) => d.question === "detail fork?");
		expect(dec.state).toBe("OPEN");
		expect(dec.answer_note).toBeNull();
		expect(Object.keys(dec).sort()).toEqual([
			"answer_note",
			"event_id",
			"question",
			"state",
		]);
	});

	test("/api/activity: default 80, capped at 300, newest first, per-event project and filter", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ins = db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'activity-burst', 'NOTE', NULL, ?, NULL)",
		);
		for (let i = 0; i < 320; i++)
			ins.run(
				Date.now(),
				JSON.stringify({
					project: proj,
					note: `burst ${i}`,
					...(i === 319 ? { sha: "abc1234" } : {}),
				}),
			);
		ins.run(
			Date.now(),
			JSON.stringify({ project: "/elsewhere/.git", note: "not yours" }),
		);
		db.close();
		const def = await (await fetch(`${BASE}/api/activity`)).json();
		expect(def.ok).toBe(true);
		expect(def.events.length).toBe(80);
		const ids = def.events.map((e: Row) => e.id);
		expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids);
		expect(def.events[0].note).toBe("not yours");
		expect(def.events[0].project).toBe("/elsewhere/.git");
		const capped = await (
			await fetch(`${BASE}/api/activity?limit=5000`)
		).json();
		expect(capped.events.length).toBe(300);
		const five = await (await fetch(`${BASE}/api/activity?limit=5`)).json();
		expect(five.events.length).toBe(5);
		for (const e of five.events)
			expect(Object.keys(e).sort()).toEqual([
				"id",
				"kind",
				"note",
				"project",
				"sha",
				"source",
				"target",
				"ts",
			]);
		expect(five.events[1].sha).toBe("abc1234"); // newest of the burst carries its sha
		const foreign = await (
			await fetch(`${BASE}/api/activity?project=${q("/elsewhere/.git")}`)
		).json();
		expect(foreign.events.length).toBe(1);
		expect(foreign.events[0].note).toBe("not yours");
	});

	test("/api/decisions: default stays OPEN-only; &history=1 adds resolved rows with answer fields", async () => {
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"history fork",
			"--as",
			"board-lane",
		]);
		const rec = fork(await getDecisions(), "history fork");
		expect(
			(
				await post("/api/answer", {
					id: rec.id,
					to: "board-lane",
					note: "resolved",
					token: rec.answer_token,
				})
			).status,
		).toBe(200);
		run("coord.ts", [
			"emit",
			"NEED_DECISION",
			"--to",
			"board-lane",
			"--note",
			"history dismiss",
			"--as",
			"board-lane",
		]);
		const rec2 = fork(await getDecisions(), "history dismiss");
		expect((await post("/api/ack", { id: rec2.id })).status).toBe(200);
		const hist = await (await fetch(`${BASE}/api/decisions?history=1`)).json();
		const ans = hist.decisions.find((d: Row) => d.question === "history fork");
		expect(ans.state).toBe("ANSWERED");
		expect(ans.answer_note).toBe("resolved");
		expect(ans.answered_ts).toBeGreaterThan(0);
		expect("ack_ts" in ans).toBe(true);
		const cancelled = hist.decisions.find(
			(d: Row) => d.question === "history dismiss",
		);
		expect(cancelled.state).toBe("CANCELLED");
		expect(cancelled.answer_note).toBeNull();
		expect(cancelled.answered_ts).toBeNull();
		const def = await (await fetch(`${BASE}/api/decisions`)).json();
		expect(def.decisions.every((d: Row) => d.state === "OPEN")).toBe(true);
		expect(
			def.decisions.find((d: Row) => d.question === "history fork"),
		).toBeUndefined();
	});

	test("/api/setup: six advisory checks, unwired in temp HOME, llm failure neither hangs nor throws", async () => {
		const t0 = Date.now();
		const r = await (await fetch(`${BASE}/api/setup`)).json();
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(r.ok).toBe(true);
		expect(r.checks.map((c: Row) => c.id)).toEqual([
			"db",
			"hooks-wired",
			"session-start",
			"monitor-agent",
			"llm",
			"bind",
		]);
		for (const c of r.checks) {
			expect(Object.keys(c).sort()).toEqual([
				"detail",
				"fix",
				"id",
				"label",
				"ok",
			]);
			expect(typeof c.label).toBe("string");
			expect(typeof c.ok).toBe("boolean");
			expect(typeof c.detail).toBe("string");
			expect(c.fix === null || typeof c.fix === "string").toBe(true);
		}
		const byId = Object.fromEntries(r.checks.map((c: Row) => [c.id, c]));
		expect(byId.db.ok).toBe(true);
		expect(byId.db.fix).toBeNull();
		expect(byId["hooks-wired"].ok).toBe(false); // temp HOME wires nothing
		expect(byId["hooks-wired"].fix).toBe("./install.sh --wire");
		expect(byId["session-start"].ok).toBe(false);
		expect(byId["monitor-agent"].ok).toBe(false);
		expect(byId.llm.ok).toBe(false); // dead SUSPENDERS_LLM_URL — advisory only
		expect(byId.llm.detail).toContain("127.0.0.1:1");
		expect(byId.bind.detail).toBe("127.0.0.1");
	});
});

describe("demo mode (--demo)", () => {
	const DEMO_PORT = 7848;
	const DEMO_BASE = `http://127.0.0.1:${DEMO_PORT}`;
	const demoProj = `${HOME}/.cache/claude-governor/demo`;
	setDemoProc(
		Bun.spawn(
			[
				"bun",
				join(bin, "fleet-board.ts"),
				"--demo",
				"--port",
				String(DEMO_PORT),
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		),
	);

	test("seeds sessions, claim labels, 4 mixed items, 2 OPEN + 2 ANSWERED forks, a dozen events", async () => {
		await waitUp(DEMO_BASE);
		const feed = await (await fetch(`${DEMO_BASE}/api/tasks`)).json();
		expect(feed.projects).toContain(demoProj);
		const dt = feed.tasks.filter((t: Row) => t.project === demoProj);
		expect(dt.length).toBe(4);
		expect(new Set(dt.map((t: Row) => t.state))).toEqual(
			new Set(["READY", "CLAIMED", "BLOCKED", "DONE"]),
		);
		const claimed = dt.find((t: Row) => t.state === "CLAIMED");
		expect(claimed.owner_label).toBe("backend lane"); // claim intent, not the sid
		const dec = await (await fetch(`${DEMO_BASE}/api/decisions`)).json();
		const demoOpen = dec.decisions.filter((d: Row) => d.project === demoProj);
		expect(demoOpen.length).toBe(2);
		expect(
			demoOpen.every(
				(d: Row) => d.state === "OPEN" && d.delivery === "DELIVERED",
			),
		).toBe(true);
		const hist = await (
			await fetch(`${DEMO_BASE}/api/decisions?history=1`)
		).json();
		const demoAns = hist.decisions.filter(
			(d: Row) => d.project === demoProj && d.state === "ANSWERED",
		);
		expect(demoAns.length).toBe(2);
		for (const d of demoAns) {
			expect(d.answer_note).toBeTruthy();
			expect(d.answered_ts).toBeGreaterThan(0);
		}
		// the waiting lane's drawer: claimed item carries events + both forks
		const detail = await (
			await fetch(
				`${DEMO_BASE}/api/task?project=${q(demoProj)}&id=${claimed.id}`,
			)
		).json();
		expect(detail.task.open_decisions).toBe(1);
		expect(detail.events.length).toBeGreaterThanOrEqual(4);
		expect(detail.decisions.some((d: Row) => d.state === "OPEN")).toBe(true);
		expect(detail.decisions.some((d: Row) => d.state === "ANSWERED")).toBe(
			true,
		);
		// the bus: a dozen events, all demo-stamped, never a real project
		const act = await (
			await fetch(`${DEMO_BASE}/api/activity?project=${q(demoProj)}`)
		).json();
		expect(act.events.length).toBeGreaterThanOrEqual(12);
		for (const e of act.events) expect(e.project).toBe(demoProj);
		// the dead lane surfaces as a zombie chip
		const data = await (await fetch(`${DEMO_BASE}/api/data`)).json();
		expect(
			data.zombies.some(
				(z: Row) => z.item === "W3" && z.label.includes("ZOMBIE"),
			),
		).toBe(true);
	});

	test("re-seed on restart is a no-op — no duplicate partition", async () => {
		demoProc?.kill();
		await demoProc?.exited;
		setDemoProc(
			Bun.spawn(
				[
					"bun",
					join(bin, "fleet-board.ts"),
					"--demo",
					"--port",
					String(DEMO_PORT),
				],
				{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
			),
		);
		await waitUp(DEMO_BASE);
		const feed = await (await fetch(`${DEMO_BASE}/api/tasks`)).json();
		expect(feed.tasks.filter((t: Row) => t.project === demoProj).length).toBe(
			4,
		);
	});

	test("/api/start refuses to spawn lanes from a demo board", async () => {
		const r = await fetch(`${DEMO_BASE}/api/start`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: demoProj, id: "W1" }),
		});
		expect(r.status).toBe(409);
		expect((await r.json()).error).toContain("demo board");
	});

	test("/api/ship refuses to ship from a demo board (W64)", async () => {
		const r = await fetch(`${DEMO_BASE}/api/ship`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project: demoProj, id: "W1" }),
		});
		expect(r.status).toBe(409);
		expect((await r.json()).error).toContain("demo board");
	});
});

// W28 — llm.call telemetry: advise.ts emits an llm.call event per LLM
// round-trip (usage zeros if the server omits usage; failures carry error);
// the board aggregates today's calls into per-model token sums, joined
// against optional llm.budget.<model> facts.
describe("W28 llm telemetry", () => {
	test("routing log + per-model budgets reach /api/data", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		const t = Date.now();
		// insert oldest-first: the routing log orders by row id (insert order),
		// not ts — backdated inserts must respect that or "newest" flips
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			t - 2000,
			JSON.stringify({
				for: "D3",
				model: "test-b",
				host: "127.0.0.3:9",
				pt: 0,
				ct: 0,
				tt: 0,
				ms: 50,
				error: "LLM 500",
			}),
		);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			t - 1000,
			JSON.stringify({
				for: "D2",
				model: "test-a",
				host: "127.0.0.2:9",
				pt: 50,
				ct: 10,
				tt: 60,
				ms: 400,
			}),
		);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
		).run(
			t,
			JSON.stringify({
				for: "D1",
				model: "test-a",
				host: "127.0.0.1:9",
				pt: 100,
				ct: 20,
				tt: 120,
				ms: 900,
			}),
		);
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES ('llm.budget.test-a', '500', 'owner', 1, ?)",
		).run(t);
		db.close();
		const d = await getData();
		const u = d.llm.usage.find((x: Row) => x.model === "test-a");
		expect(u.tokens).toBe(180); // 120 + 60 — budget-joined
		expect(u.budget).toBe(500);
		expect(u.calls).toBe(2);
		const b = d.llm.usage.find((x: Row) => x.model === "test-b");
		expect(b.tokens).toBe(0);
		expect(b.budget).toBeNull();
		expect(d.llm.calls.length).toBeGreaterThanOrEqual(3);
		const last = d.llm.calls[0]; // newest first
		expect(last.model).toBe("test-a");
		expect(last.tt).toBe(120);
		expect(d.llm.calls.some((c: Row) => c.error === "LLM 500")).toBe(true); // failures are in the log
	});
});

// W55 — per-item diff + review line-comments: GET /api/diff resolves the
// item's repo + suspenders/<id> branch (worktree.ts naming) and diffs it
// against the merge-base with main; POST /api/comment routes a review note
// to the owning lane over the coord bus.
describe("W55 per-item diff + review comments", () => {
	test("served page wires the diff toggle + comment flow; llms.txt lists both routes", async () => {
		const page = await (await fetch(`${BASE}/`)).text();
		expect(page).toContain("diffbtn");
		expect(page).toContain("/api/diff");
		expect(page).toContain("/api/comment");
		const txt = await (await fetch(`${BASE}/llms.txt`)).text();
		expect(txt).toContain("/api/diff");
		expect(txt).toContain("/api/comment");
	});

	test("/api/diff on an unknown id is a 404 JSON", async () => {
		const r = await fetch(`${BASE}/api/diff?id=NOPE`);
		expect(r.status).toBe(404);
		expect((await r.json()).ok).toBe(false);
	});

	test("/api/diff: stat + diff for a seeded suspenders/<id> branch", async () => {
		const g = (args: string[], cwd = GREPO) => {
			const p = Bun.spawnSync(["/usr/bin/git", ...args], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			return { out: p.stdout.toString(), code: p.exitCode };
		};
		expect(g(["init", "-b", "main"]).code).toBe(0);
		g(["config", "user.email", "t@threads.dk"]);
		g(["config", "user.name", "t"]);
		await Bun.write(join(GREPO, "f.txt"), "one\n");
		g(["add", "."]);
		expect(g(["commit", "-m", "base"]).code).toBe(0);
		// a lane worktree: branch suspenders/WDIFF1 off main, edit, commit
		expect(
			g(["worktree", "add", "-b", "suspenders/WDIFF1", join(GREPO, "wt")]).code,
		).toBe(0);
		await Bun.write(join(GREPO, "wt", "f.txt"), "one\ntwo\n");
		expect(g(["add", "."], join(GREPO, "wt")).code).toBe(0);
		expect(g(["commit", "-m", "lane change"], join(GREPO, "wt")).code).toBe(0);
		// the board resolves the item's repo from work_items.project — insert
		// the row directly (GREPO, not the empty-.git REPO fixture)
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WDIFF1', 'diff demo', 'CLAIMED', 'board-lane', 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const r = await fetch(`${BASE}/api/diff?id=WDIFF1`);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(j.ok).toBe(true);
		expect(j.branch).toBe("suspenders/WDIFF1");
		expect(j.base).toMatch(/^[0-9a-f]{40,64}$/);
		expect(j.stat).toContain("f.txt");
		expect(j.diff).toContain("+two");
	});
	test("/api/comment routes a review note to the owning lane over coord", async () => {
		const sent = await post("/api/comment", {
			id: "WDIFF1",
			file: "f.txt",
			line: "2",
			note: "why two?",
		});
		expect(sent.status).toBe(200);
		expect(sent.json.ok).toBe(true);
		expect(sent.json.to).toBe("board-lane");
		// the emit rides coord — the NOTE lands in the lane's inbox events
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4000");
		const ev = db
			.query(
				"SELECT payload FROM events WHERE kind = 'NOTE' AND target = 'board-lane' ORDER BY id DESC LIMIT 1",
			)
			.get() as { payload: string };
		db.close();
		expect(ev.payload).toContain("f.txt:2");
		expect(ev.payload).toContain("why two?");
	});
	test("/api/comment validation: missing fields 400, unknown id 404, ownerless 404, content-type 415", async () => {
		expect(
			(await post("/api/comment", { id: "WDIFF1", file: "f.txt", line: "2" }))
				.status,
		).toBe(400);
		// unknown id → 404
		expect(
			(
				await post("/api/comment", {
					id: "NOPE",
					file: "f.txt",
					line: "2",
					note: "x",
				})
			).status,
		).toBe(404);
		// ownerless item — no lane to route to
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WDIFF2', 'ownerless', 'READY', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const orphan = await post("/api/comment", {
			id: "WDIFF2",
			file: "f.txt",
			line: "1",
			note: "x",
		});
		expect(orphan.status).toBe(404);
		expect(orphan.json.error).toContain("no owning lane");
		const plain = await fetch(`${BASE}/api/comment`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: '{"id":"WDIFF1","file":"f.txt","line":"1","note":"x"}',
		});
		expect(plain.status).toBe(415);
	});
	test("/api/start validation: missing fields 400, unknown 404, claimed 409, not-READY 409", async () => {
		// missing fields
		expect((await post("/api/start", { project: GREPO })).status).toBe(400);
		// unknown item
		const unknown = await post("/api/start", { project: GREPO, id: "WNOPE" });
		expect(unknown.status).toBe(404);
		// claimed item (WDIFF1 — owner board-lane)
		const claimed = await post("/api/start", { project: GREPO, id: "WDIFF1" });
		expect(claimed.status).toBe(409);
		expect(claimed.json.error).toContain("already claimed");
		// non-READY item (insert a BLOCKED row — never reaches the spawn)
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WSTART1', 'blocked demo', 'BLOCKED', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const notReady = await post("/api/start", {
			project: GREPO,
			id: "WSTART1",
		});
		expect(notReady.status).toBe(409);
		expect(notReady.json.error).toContain("only READY items");
	});
});

// W76 — live lane tail (lane log + transcript fallback) and message-to-lane
// (coord NOTE as the published coordinator identity, fallback fleet-board).
describe("W76 lane tail + message-to-lane", () => {
	test("served page wires the tail toggle + message input; llms.txt lists both routes", async () => {
		const page = await (await fetch(`${BASE}/`)).text();
		expect(page).toContain("tailbtn");
		expect(page).toContain("lanemsg");
		expect(page).toContain("/api/tail");
		expect(page).toContain("/api/message");
		const txt = await (await fetch(`${BASE}/llms.txt`)).text();
		expect(txt).toContain("/api/tail");
		expect(txt).toContain("/api/message");
	});

	test("/api/tail: lane log text + transcript fields for a claimed item", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WTAIL1', 'tail demo', 'CLAIMED', 'board-lane', 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		await Bun.write(
			join(GREPO, ".fleet", "lane-board-lane.log"),
			"booting lane...\nbuilding the thing\nDONE abc1234\n",
		);
		const r = await fetch(`${BASE}/api/tail?id=WTAIL1`);
		expect(r.status).toBe(200);
		const j = await r.json();
		expect(j.ok).toBe(true);
		expect(j.sid).toBe("board-lane");
		expect(j.log.text).toContain("building the thing");
		expect(j.log.truncated).toBe(false);
		expect(Array.isArray(j.recent)).toBe(true);
	});

	test("/api/tail validation: unknown 404, ownerless 404, bad id 404", async () => {
		expect((await fetch(`${BASE}/api/tail?id=NOPE`)).status).toBe(404);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, 'WTAIL2', 'ownerless tail', 'READY', NULL, 'test', ?, ?)",
		).run(GREPO, Date.now(), Date.now());
		db.close();
		const orphan = await fetch(`${BASE}/api/tail?id=WTAIL2`);
		expect(orphan.status).toBe(404);
		expect((await orphan.json()).error).toContain("no owning lane");
		expect((await fetch(`${BASE}/api/tail?id=..%2Fx`)).status).toBe(404);
	});

	test("/api/message routes to the owning lane as fleet-board when no coordinator fact", async () => {
		const sent = await post("/api/message", {
			id: "WTAIL1",
			note: "pause and wait for the owner",
		});
		expect(sent.status).toBe(200);
		expect(sent.json.ok).toBe(true);
		expect(sent.json.to).toBe("board-lane");
		expect(sent.json.as).toBe("fleet-board");
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		const ev = db
			.query(
				"SELECT source, payload FROM events WHERE kind = 'NOTE' AND target = 'board-lane' ORDER BY id DESC LIMIT 1",
			)
			.get() as { source: string; payload: string };
		db.close();
		expect(ev.source).toBe("fleet-board");
		expect(ev.payload).toContain("board WTAIL1 —");
		expect(ev.payload).toContain("pause and wait");
	});

	test("/api/message: coordinator identity when the fact is set; validation 400/404", async () => {
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES ('coordinator.sid', 'coord-test', 'test', 1, ?)",
		).run(Date.now());
		db.close();
		const sent = await post("/api/message", { id: "WTAIL1", note: "second" });
		expect(sent.json.ok).toBe(true);
		expect(sent.json.as).toBe("coord-test");
		const db2 = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db2.run("PRAGMA busy_timeout = 4500");
		const ev = db2
			.query(
				"SELECT source FROM events WHERE kind = 'NOTE' AND target = 'board-lane' ORDER BY id DESC LIMIT 1",
			)
			.get() as { source: string };
		db2.close();
		expect(ev.source).toBe("coord-test");
	});
	test("/api/message validation: missing 400, unknown 404, ownerless 404, plain 415", async () => {
		expect((await post("/api/message", { id: "WTAIL1" })).status).toBe(400);
		expect((await post("/api/message", { id: "NOPE", note: "x" })).status).toBe(
			404,
		);
		expect(
			(await post("/api/message", { id: "WTAIL2", note: "x" })).status,
		).toBe(404);
		const plain = await fetch(`${BASE}/api/message`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: '{"id":"WTAIL1","note":"x"}',
		});
		expect(plain.status).toBe(415);
	});
});
