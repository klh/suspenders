// test/fleet-board-store.test.ts — W92.2: the fleet board rides the
// control-plane store port. A board bound to GOVERNOR_STORE_URL serves the
// same surface against a REMOTE governor.db (store-server on loopback):
// boot over the wire (module-load decisions DDL + port binding), read feeds
// (/api/data, /api/decisions, /llms.txt, /status), and CLI writes made
// through the same store URL land on the board. Scratch HOME/repo live
// under tmpdir() (fixture convention — identity never walks up into this
// repo) and nothing here opens the live governor.db.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const SERVER = join(BIN, "store-server.ts");
const BOARD = join(BIN, "fleet-board.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-boardstore-"));
const repo = mkdtempSync(join(tmpdir(), "suspenders-boardstorerepo-"));
// an empty .git dir (not a git init) keeps project identity at the repo ROOT
// — same convention as the board fixture; a git-init repo resolves the
// project to the common git dir (repo/.git) instead
mkdirSync(join(repo, ".git"), { recursive: true });
const MY_PROJ = realpathSync(repo);

const procs: Bun.Subprocess[] = [];
const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const startServer = async (
	script: string,
	port: number,
	env: Record<string, string>,
	waitPath: string,
): Promise<void> => {
	const p = Bun.spawn(["bun", script, "--port", String(port)], {
		cwd: repo,
		env: {
			...process.env,
			HOME: home,
			NO_COLOR: "1",
			SUSPENDERS_MDNS: "0",
			...env,
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${base}${waitPath}`)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`${script} did not come up on ${base}`);
};

afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

describe("fleet board over the store port (W92.2)", () => {
	let storeUrl = "";
	let boardBase = "";
	beforeAll(async () => {
		const storePort = await freePort();
		const boardPort = await freePort();
		storeUrl = `http://127.0.0.1:${storePort}`;
		boardBase = `http://127.0.0.1:${boardPort}`;
		await startServer(SERVER, storePort, {}, "/health");
		await startServer(
			BOARD,
			boardPort,
			{ GOVERNOR_STORE_URL: storeUrl },
			"/api/data",
		);
		// the CLI rides the same store URL — a write through the port that
		// the board (also on the port) must render
		const r = Bun.spawnSync(
			["bun", join(BIN, "work.ts"), "add", "remote board sees this item"],
			{
				cwd: repo,
				env: {
					...process.env,
					HOME: home,
					NO_COLOR: "1",
					GOVERNOR_STORE_URL: storeUrl,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(r.exitCode).toBe(0);
		// wait for the board: module-load DDL + binding resolve over the wire
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${boardBase}/api/data`)).ok) break;
			} catch {}
			await new Promise((res) => setTimeout(res, 100));
		}
	});

	test("GET /api/data — remote binding serves the project partition", async () => {
		const d = (await (await fetch(`${boardBase}/api/data`)).json()) as {
			projects: {
				project: string;
				todo: { title: string; state: string }[];
			}[];
		};
		const mine = d.projects.find((p) => p.project === MY_PROJ);
		expect(mine).toBeDefined();
		const item = mine?.todo.find(
			(w) => w.title === "remote board sees this item",
		);
		expect(item?.state).toBe("READY");
	});

	test("GET /api/decisions — decision feed reads through the port", async () => {
		const d = await (await fetch(`${boardBase}/api/decisions`)).json();
		expect(Array.isArray(d.decisions)).toBe(true);
	});

	test("GET /llms.txt + /status — meta and servicemon surfaces alive", async () => {
		const ll = await fetch(`${boardBase}/llms.txt`);
		expect(ll.status).toBe(200);
		expect(ll.headers.get("content-type")).toContain("text/plain");
		expect(await ll.text()).toContain("# suspenders");
		const st = await fetch(`${boardBase}/status`);
		expect(st.status).toBe(200);
		expect(((await st.json()) as { healthy?: boolean }).healthy).toBe(true);
	});
});
