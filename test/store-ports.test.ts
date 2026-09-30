// store-ports.test.ts — W92: embedded (SQLite) and HTTP transports answer
// IDENTICALLY — the colocation-free property the whole item rests on. Runs
// the real store-api.ts as a subprocess against a temp governor.db and
// drives the SAME op sequence through both adapters.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-store-"));
process.env.HOME = HOME; // govdb binds REG at import time — before dynamic import
const { openGovernorDb } = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const { SqliteControlPlaneStore, HttpControlPlaneStore, resolveStore } =
	await import("../hooks/lib/store-ports.ts");

const db = openGovernorDb();
const embedded = new SqliteControlPlaneStore(db);

const PORT = 7796 + (process.pid % 500); // collision-free per-process port
const URL_ = `http://127.0.0.1:${PORT}`;
let http: InstanceType<typeof HttpControlPlaneStore>;
let child: Bun.Subprocess;

beforeAll(async () => {
	child = Bun.spawn({
		cmd: [process.execPath, "hooks/bin/store-api.ts", "--port", String(PORT)],
		env: { ...process.env, HOME },
		stdout: "pipe",
		stderr: "pipe",
	});
	// poll: the server boots (imports + migrations) well within 5s
	let up = false;
	for (let i = 0; i < 50 && !up; i++) {
		up = await fetch(`${URL_}/health`).then(
			(r) => r.ok,
			() => false,
		);
		if (!up) await Bun.sleep(100);
	}
	expect(up).toBe(true);
	http = new HttpControlPlaneStore({ url: URL_, via: "test" });
});

afterAll(() => {
	child?.kill();
	db.close();
	rmSync(HOME, { recursive: true, force: true });
});

// the op sequence both transports must answer identically (parity)
async function exercise(
	s: import("../hooks/lib/store-ports.ts").ControlPlaneStore,
	tag: string,
): Promise<void> {
	const id = await s.emitEvent({
		source: `w92-test-${tag}`,
		kind: "smoke.parity",
		payload: JSON.stringify({ tag }),
		target: null,
	});
	expect(id > 0).toBe(true);
	const ev = await s.event(id);
	expect(ev?.kind).toBe("smoke.parity");
	const rows = await s.events({ kinds: ["smoke.parity"], limit: 10 });
	expect(rows.some((r) => r.id === id)).toBe(true);
	// inbox: directed event → collect → empty on second collect (cursor moved)
	const direct = await s.emitEvent({
		source: "w92-test",
		kind: "smoke.direct",
		target: tag,
	});
	expect(direct > 0).toBe(true);
	const inbox = await s.collectInbox(tag);
	expect(inbox.some((e) => e.id === direct)).toBe(true);
	expect((await s.collectInbox(tag)).length).toBe(0);
	// facts
	await s.factSet(`smoke.${tag}.k`, "v1", "w92-test");
	expect(await s.fact(`smoke.${tag}.k`)).toBe("v1");
	await s.factSet(`smoke.${tag}.k`, "v2", "w92-test");
	expect(await s.fact(`smoke.${tag}.k`)).toBe("v2");
	const list = await s.factList(`smoke.${tag}.`);
	expect(list.map((f) => f.key)).toContain(`smoke.${tag}.k`);
	await s.factDelete(`smoke.${tag}.k`);
	expect(await s.fact(`smoke.${tag}.k`)).toBe(null);
	// work reads
	const shape = await s.workShape();
	expect(Array.isArray(shape)).toBe(true);
	await s.workReadyCount("no-such-project");
	await s.workOwned("no-such-project", tag);
	await s.workClosedOwners("no-such-project");
	// knowledge proxy
	const qid = await s.knEnqueue({
		source: "w92-test",
		payload: "parity probe payload",
	});
	expect(qid > 0).toBe(true);
}

describe("W92 store ports: embedded == HTTP parity", () => {
	test("same ops, same answers, both transports", async () => {
		await exercise(embedded, "emb");
		await exercise(http, "htt");
	});

	test("sessions + sweep", async () => {
		await embedded.sessionUpsert({
			sid: "sess-emb",
			project: "/p",
			parentSid: null,
			caps: "shell,git",
			transcriptPath: null,
		});
		await http.sessionUpsert({
			sid: "sess-http",
			project: "/p",
			parentSid: null,
			caps: "shell,git",
			transcriptPath: null,
		});
		expect(await embedded.sweepSessions()).toBe(0); // fresh rows stay alive
		expect(await http.sweepSessions()).toBe(0);
	});

	test("resolver: env pin wins", async () => {
		// deterministic even on a box running the real server on :7796 — the
		// env pin answers before any probe
		process.env.SUSPENDERS_STORE_URL = URL_;
		expect((await resolveStore())?.url).toBe(URL_);
		expect((await resolveStore())?.via).toBe("env");
		process.env.SUSPENDERS_STORE_URL = "";
	});
});
