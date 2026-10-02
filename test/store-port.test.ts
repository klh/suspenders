// test/store-port.test.ts — W92.1: the store port (govdb openStore seam).
// 1) the fact-set arg() null-sentinel regression (lesson.coord-arg-null-sentinel)
// 2) binding resolution: in-process default, "local" override, dead-URL fails
//    at open (work.ts's mirror fallback depends on that timing)
// 3) the HTTP transport: CLI verbs byte-identical across bindings,
//    transactions (work add/done id allocation) over the wire, token auth.
// Every subprocess runs against an isolated temp HOME created under the repo
// (never /tmp — the bash gate exempts /tmp paths by design) and never opens
// the live governor.db.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const SERVER = join(BIN, "store-server.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const home = mkdtempSync(join(process.cwd(), ".store-port-test-"));
const repo = mkdtempSync(join(process.cwd(), ".store-port-repo-"));
// a repo here must be a REAL git checkout — project identity resolves the
// common git dir; an empty mkdir would walk up into this repo
Bun.spawnSync(["git", "init", "-q", repo]);

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const cli = (
	name: string,
	args: string[],
	env: Record<string, string> = {},
): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(["bun", join(BIN, name), ...args], {
		cwd: repo,
		env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};

const coord = (args: string[], env: Record<string, string> = {}) =>
	cli("coord.ts", args, env);
const work = (args: string[], env: Record<string, string> = {}) =>
	cli("work.ts", args, env);

const runIn = (code: string, env: Record<string, string> = {}): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`spawn failed: ${p.stderr.toString()}`);
	return p.stdout.toString();
};

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const startServer = async (
	port: number,
	env: Record<string, string> = {},
): Promise<string> => {
	const p = Bun.spawn(["bun", SERVER, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
};

// ── the regression the lane brief calls out (hotfix 62732ab) ────────────────
describe("fact set — arg() null sentinel (lesson.coord-arg-null-sentinel)", () => {
	test("positional value lands", () => {
		const r = coord(["fact", "set", "w921.pos", "positional-value"]);
		expect(r.code).toBe(0);
		expect(r.out).toBe("fact w921.pos = positional-value\n");
	});
	test("--text value lands verbatim", () => {
		const r = coord(["fact", "set", "w921.text", "--text", "multi word value"]);
		expect(r.code).toBe(0);
		expect(r.out).toBe("fact w921.text = multi word value\n");
	});
	test("bare --text dies with usage (the hotfixed path)", () => {
		const r = coord(["fact", "set", "w921.bad", "--text"]);
		expect(r.code).toBe(2);
		expect(r.err).toBe(
			"coord: usage: fact set <key> <value> | fact set <key> --text <text> [--source s]\n",
		);
	});
	test("get round-trips both shapes", () => {
		expect(coord(["fact", "get", "w921.pos"]).out).toBe(
			"positional-value (v1)\n",
		);
		expect(coord(["fact", "get", "w921.text"]).out).toBe(
			"multi word value (v1)\n",
		);
	});
});

describe("openStore() binding resolution", () => {
	test("default binding is in-process and local", () => {
		const out = runIn(
			`const { openStore } = await import(${JSON.stringify(GOVDB)});
const s = openStore();
console.log(JSON.stringify({ local: s.local, one: s.query("SELECT 1 AS one").get() }));`,
		);
		expect(JSON.parse(out)).toEqual({ local: true, one: { one: 1 } });
	});
	test("GOVERNOR_STORE_URL=local forces in-process", () => {
		const out = runIn(
			`const { openStore } = await import(${JSON.stringify(GOVDB)});
const s = openStore();
console.log(JSON.stringify({ local: s.local }));`,
			{ GOVERNOR_STORE_URL: "local" },
		);
		expect(JSON.parse(out)).toEqual({ local: true });
	});
	test("dead URL fails AT OPEN (transport probe, not first query)", () => {
		const r = coord(["fact", "get", "x"], {
			GOVERNOR_STORE_URL: "http://127.0.0.1:1",
		});
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("unreachable");
	});
});

describe("HTTP transport (store-server.ts)", () => {
	let url = "";
	beforeAll(async () => {
		// W196 — the wire requires a token (fail-closed); CLIs carry it via env
		url = await startServer(await freePort(), {
			GOVERNOR_STORE_TOKEN: "wire-tok",
		});
	});
	test("work verbs with transactions ride the wire", () => {
		expect(
			work(["add", "http item", "--by", "lane-h"], hdr(url)).out,
		).toContain("✓ W1 READY");
		expect(work(["take", "W1", "--as", "lane-h"], hdr(url)).out).toContain(
			"✓ W1 claimed by lane-h",
		);
		expect(work(["done", "W1", "--sha", "f00dfeed"], hdr(url)).out).toBe(
			"✓ W1 DONE @f00dfeed\n",
		);
		expect(work(["list"], hdr(url)).out).toBe("(none)\n");
	});
	test("fact + event verbs byte-identical over HTTP", () => {
		expect(coord(["fact", "set", "k.h", "hello"], hdr(url)).out).toBe(
			"fact k.h = hello\n",
		);
		expect(coord(["fact", "get", "k.h"], hdr(url)).out).toBe("hello (v1)\n");
		expect(coord(["fact", "list"], hdr(url)).out).toContain("k.h = hello");
		expect(coord(["emit", "test.x", "--as", "lane-h"], hdr(url)).out).toContain(
			"event queued #",
		);
		expect(coord(["inbox", "--as", "nobody"], hdr(url)).out).toBe(
			"(inbox empty)\n",
		);
	});
	test("token auth: open loopback endpoint takes the shared token", async () => {
		const port = await freePort();
		const turl = await startServer(port, { GOVERNOR_STORE_TOKEN: "t0ken" });
		expect(
			coord(["fact", "get", "k.h"], {
				GOVERNOR_STORE_URL: turl,
				GOVERNOR_STORE_TOKEN: "t0ken",
			}).out,
		).toBe("hello (v1)\n");
		const refused = coord(["fact", "get", "k.h"], {
			GOVERNOR_STORE_URL: turl,
		});
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("unreachable");
	});
});

function hdr(url: string): Record<string, string> {
	return { GOVERNOR_STORE_URL: url, GOVERNOR_STORE_TOKEN: "wire-tok" };
}

// W196 — POST /rpc via curl, return the HTTP status. curl (not fetch) because
// the Host header must be overridable for the rebinding test.
async function codeOf(url: string, headers: string[]): Promise<string> {
	const p = Bun.spawnSync(
		[
			"curl",
			"-sS",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code}",
			"-X",
			"POST",
			`${url}/rpc`,
			...headers,
			"--data-binary",
			'{"mode":"get","sql":"SELECT 1","params":[]}',
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return p.stdout.toString();
}

// W196 — fail-closed token: the store executes ARBITRARY SQL on governor.db,
// so an unconfigured GOVERNOR_STORE_TOKEN must seal /rpc (403 everything,
// even a guessed token) while /health stays observable.
describe("W196 fail-closed", () => {
	test("tokenless boot seals /rpc — health stays observable", async () => {
		const surl = await startServer(await freePort());
		const health = await (await fetch(`${surl}/health`)).json();
		expect(health.sealed).toBe(true);
		expect(
			await codeOf(surl, [
				"-H",
				"x-governor-token: guessed",
				"-H",
				"content-type: application/json",
			]),
		).toBe("403");
		const r = coord(["fact", "get", "k.h"], { GOVERNOR_STORE_URL: surl });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("unreachable");
	});
});

// W196 — wire hygiene: non-JSON bodies (cross-origin simple-request path)
// and non-loopback Hosts (DNS rebinding) are refused even with a valid token.
describe("W196 wire hygiene", () => {
	test("non-JSON content-type → 415; non-loopback Host → 403", async () => {
		const surl = await startServer(await freePort(), {
			GOVERNOR_STORE_TOKEN: "t0ken",
		});
		expect(
			await codeOf(surl, [
				"-H",
				"x-governor-token: t0ken",
				"-H",
				"content-type: text/plain",
			]),
		).toBe("415");
		expect(
			await codeOf(surl, [
				"-H",
				"Host: evil.example",
				"-H",
				"x-governor-token: t0ken",
				"-H",
				"content-type: application/json",
			]),
		).toBe("403");
	});
});
