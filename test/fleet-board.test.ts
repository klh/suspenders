// fleet-board.test.ts — decision lifecycle + endpoint hardening against a
// real board on a throwaway port, isolated HOME (same recipe as smoke.test.ts).
// Covers review findings 5, 8-11, 13 at the CLI/API level; browser-only
// behavior (focus retention, click paths) ships as served-HTML assertions.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-board-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-boardrepo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME, SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions" };
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
	test("decision panel path exists and the selector starts ASCII (findings 8, 11)", () => {
		return fetch(BASE + "/").then(async (r) => {
			const page = await r.text();
			expect(page).toContain("function openNeeds");
			expect(page).toContain("function openItem");
			expect(page).toContain('id="fails"');
			expect(page).toContain('<option value="">all</option>');
			expect(page).toContain('<button id="needsn" type="button">');
			// the inline script must parse as JS — catches template corruption
			// the browser would trip over before any interaction works
			const script = page.match(/<script>([\s\S]*)<\/script>/)![1];
			expect(() => new Function(script)).not.toThrow();
		});
	});
});

describe("decision lifecycle (finding 5)", () => {
	test("fork survives a recipient inbox ack", async () => {
		expect(run("coord.ts", ["bootstrap", "--as", "board-lane", "--role", "worker"]).code).toBe(0);
		expect(run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--scope", "W9", "--note", "ship or hold?", "--as", "board-lane"]).code).toBe(0);
		let d = await getData();
		const fork = d.needs["board-lane"]?.[0];
		expect(fork).toBeDefined();
		expect(fork.note).toBe("ship or hold?");
		// the regression: the recipient reads their inbox — cursor moves past
		// the fork, but the fork must stay OPEN on the board
		expect(run("coord.ts", ["inbox", "--as", "board-lane", "--ack"]).code).toBe(0);
		d = await getData();
		expect(d.needs["board-lane"]?.some((n: any) => n.id === fork.id)).toBe(true);
		// answers correlate: state row keyed by the fork's event id
		const ans = await post("/api/answer", { to: "board-lane", note: "ship it", forEvent: fork.id });
		expect(ans.status).toBe(200);
		expect(ans.json.ok).toBe(true);
		d = await getData();
		expect(d.needs["board-lane"]?.some((n: any) => n.id === fork.id) ?? false).toBe(false);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, { readonly: true });
		const row = db.query("SELECT state, answer_note, answer_to, answered_at FROM decisions WHERE event_id = ?").get(fork.id) as any;
		db.close();
		expect(row.state).toBe("ANSWERED");
		expect(row.answer_note).toBe("ship it");
		expect(row.answer_to).toBe("board-lane");
	});

	test("dismiss is persistent and idempotent", async () => {
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--note", "dismiss me", "--as", "board-lane"]);
		const d = await getData();
		const fork = d.needs["board-lane"].find((n: any) => n.note === "dismiss me");
		expect(fork).toBeDefined();
		for (let i = 0; i < 2; i++) {
			const ack = await post("/api/ack", { id: fork.id });
			expect(ack.status).toBe(200);
			expect(ack.json.ok).toBe(true);
		}
		const d2 = await getData();
		expect(d2.needs["board-lane"]?.some((n: any) => n.id === fork.id) ?? false).toBe(false);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`, { readonly: true });
		const row = db.query("SELECT state FROM decisions WHERE event_id = ?").get(fork.id) as any;
		db.close();
		expect(row.state).toBe("DISMISSED");
	});
});

describe("endpoint hardening (finding 13)", () => {
	test("unknown and non-decision event ids are rejected, not no-opped", async () => {
		const unknown = await post("/api/ack", { id: 999999 });
		expect(unknown.status).toBe(404);
		const unknownAns = await post("/api/answer", { to: "board-lane", note: "x", forEvent: 999999 });
		expect(unknownAns.status).toBe(404);
		const unknownAdv = await post("/api/advise", { id: 999999 });
		expect(unknownAdv.status).toBe(404);
		// the ANSWER event emitted earlier is real but not a NEED% fork
		run("coord.ts", ["emit", "NOTE", "--to", "board-lane", "--note", "not a fork", "--as", "board-lane"]);
		const d = await getData();
		const nonNeed = d.events.find((e: any) => e.kind === "NOTE").id;
		const notFork = await post("/api/ack", { id: nonNeed });
		expect(notFork.status).toBe(400);
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

describe("dashboard accuracy (findings 10, 11)", () => {
	test("blocked item carries its open deps for truthful counts", async () => {
		run("work.ts", ["add", "dep target", "--scope", "dt"]);
		run("work.ts", ["add", "dependent item", "--scope", "dd"]);
		run("work.ts", ["block", "W2", "--on", "W1"]);
		const d = await getData();
		const proj = d.projects[0];
		expect(proj.gated.length).toBe(1);
		expect(proj.gated[0].deps).toEqual(["W1"]);
	});

	test("failed work is rendered with its error note", async () => {
		run("work.ts", ["add", "doomed item", "--scope", "df"]);
		run("work.ts", ["fail", "W3", "--note", "boom: no compiler"]);
		const d = await getData();
		const failed = d.projects[0].other.find((w: any) => w.state === "FAILED");
		expect(failed).toBeDefined();
		expect(failed.note).toBe("boom: no compiler");
	});

	test("advise job reconciles: error fact clears the spinner state", async () => {
		run("coord.ts", ["emit", "NEED_DECISION", "--to", "board-lane", "--note", "advise me", "--as", "board-lane"]);
		const d = await getData();
		const fork = d.needs["board-lane"].find((n: any) => n.note === "advise me");
		const started = await post("/api/advise", { id: fork.id });
		expect(started.json.ok).toBe(true);
		let err: string | undefined;
		for (let i = 0; i < 60; i++) {
			const cur = (await getData()).needs["board-lane"].find((n: any) => n.id === fork.id);
			if (cur?.adviceError) {
				err = cur.adviceError;
				break;
			}
			await sleep(200);
		}
		expect(err).toBeDefined(); // dead SUSPENDERS_LLM_URL -> error fact -> poll picks it up
	});

	test("zombie chips drop the stray leading article", async () => {
		run("coord.ts", ["fact", "set", "zombie.V9", "a board-lane ZOMBIE (hb 52min)"]);
		const d = await getData();
		expect(d.zombies.some((z: any) => z.label === "board-lane ZOMBIE (hb 52min)")).toBe(true);
	});
});
