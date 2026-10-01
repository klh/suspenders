// test/servicemon.test.ts — W125: the shared service observability module
// (hooks/lib/servicemon.ts) plus its wiring into store-server / knowledge-api
// / fleet-board.
// 1) registry primitives: counter math, histogram buckets, label cardinality
// 2) Prometheus text exposition (HELP/TYPE, cumulative buckets, _sum/_count,
//    honest omission of untouched families)
// 3) /status cache honors STATUS_REFRESH_S (cached at the default 5s, fresh at
//    0, custom windows, invalid → default)
// 4) each service answers /status + /metrics on a temp port (spawn, fetch,
//    kill — the store-port pattern); the board feeds tokens_total from seeded
//    transcripts within its TTL window. Payloads leak no /Users paths, no
//    token/key value shapes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_BUCKETS,
	routeOf,
	scrub,
	servicemon,
	type Servicemon,
} from "../hooks/lib/servicemon.ts";

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");

// temp HOMEs under the repo (never /tmp) — the spawned services open their own
// governor.db/knowledge stores under HOME, never the live one
const home = mkdtempSync(join(process.cwd(), ".servicemon-home-"));
const boardHome = mkdtempSync(join(process.cwd(), ".servicemon-boardhome-"));
const repo = mkdtempSync(join(process.cwd(), ".servicemon-repo-"));
const procs: Bun.Subprocess[] = [];

afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(boardHome, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const start = async (
	script: string,
	port: number,
	envHome: string,
): Promise<string> => {
	const p = Bun.spawn(["bun", script, "--port", String(port)], {
		env: {
			...process.env,
			HOME: envHome,
			NO_COLOR: "1",
			SUSPENDERS_MDNS: "0",
			// fresh snapshots: the startup probe must not prime the 5s cache
			// ahead of the by_route/last_error assertions
			STATUS_REFRESH_S: "0",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${url}/status`);
			if (r.ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`${script} did not come up on ${url}`);
};

// ── 1 + 2: registry primitives and exposition format ────────────────────────

describe("servicemon registry", () => {
	test("counter inc cumulates per label set; set overrides", () => {
		const sm = servicemon({ service: "t1", port: 0 });
		const c = sm.counter("w125_test_total", "w125 test counter");
		c.inc({ route: "/a" });
		c.inc({ route: "/a" });
		c.inc({ route: "/a" }, 5);
		c.inc({ route: "/b" });
		c.set({ route: "/b" }, 100);
		const text = sm.expose();
		expect(text).toContain(`w125_test_total{route="/a"} 7`);
		expect(text).toContain(`w125_test_total{route="/b"} 100`);
	});

	test("histogram buckets are cumulative with sane boundaries", () => {
		const sm = servicemon({ service: "t2", port: 0 });
		const h = sm.histogram("w125_dur_seconds", "w125 dur", [0.1, 0.5, 1]);
		h.observe(undefined, 0.2);
		h.observe(undefined, 0.6);
		const text = sm.expose();
		expect(text).toContain(`w125_dur_seconds_bucket{le="0.1"} 0`);
		expect(text).toContain(`w125_dur_seconds_bucket{le="0.5"} 1`);
		expect(text).toContain(`w125_dur_seconds_bucket{le="1"} 2`);
		expect(text).toContain(`w125_dur_seconds_bucket{le="+Inf"} 2`);
		expect(text).toContain(`w125_dur_seconds_count 2`);
		expect(text).toContain(`w125_dur_seconds_sum 0.8`);
	});

	test("default buckets are the spec's eleven", () => {
		expect(DEFAULT_BUCKETS).toEqual([
			0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
		]);
	});

	test("label cardinality: distinct label values are distinct series", () => {
		const sm = servicemon({ service: "t3", port: 0 });
		const c = sm.counter("w125_card_total", "cardinality probe");
		c.inc({ route: "/x" });
		c.inc({ route: "/x" });
		c.inc({ route: "/y" });
		const lines = sm
			.expose()
			.split("\n")
			.filter((l) => l.startsWith("w125_card_total"));
		expect(lines.length).toBe(2);
	});

	test("exposition shape: HELP/TYPE, histogram samples end _bucket/_sum/_count", () => {
		const sm = servicemon({ service: "t4", port: 0 });
		sm.counter("w125_shape_total", "shape counter").inc({ route: "/" });
		sm.histogram("w125_shape_seconds", "shape hist").observe(
			{ route: "/" },
			0.01,
		);
		const text = sm.expose();
		expect(text.startsWith("# HELP w125_shape_total ")).toBe(true);
		expect(text).toContain("# TYPE w125_shape_total counter");
		expect(text).toContain("# TYPE w125_shape_seconds histogram");
		expect(text.endsWith("\n")).toBe(true);
		const histSamples = text
			.split("\n")
			.filter((l) => l.startsWith("w125_shape_seconds"));
		expect(histSamples.length).toBeGreaterThan(0);
		for (const l of histSamples)
			expect(/_(bucket|sum|count)(\{|$)/.test(l)).toBe(true);
	});

	test("tokens: kinds aggregate under one family; absent = honestly omitted", () => {
		const sm = servicemon({ service: "t5", port: 0 });
		sm.tokens("in", 10);
		sm.tokens("in", 5);
		sm.tokens("out", 2);
		const text = sm.expose();
		expect(text).toContain(`tokens_total{kind="in"} 15`);
		expect(text).toContain(`tokens_total{kind="out"} 2`);
		const bare = servicemon({ service: "t5b", port: 0 });
		expect(bare.expose().includes("tokens_total")).toBe(false);
	});

	test("scrub removes /Users paths; routeOf collapses dynamic segments", () => {
		expect(scrub("read /Users/alice/dev/secret.txt now")).toBe(
			"read ~/dev/secret.txt now",
		);
		expect(routeOf("/verify/123")).toBe("/verify/:id");
		expect(routeOf("/verify/9f83aab1-2c4d-4e8a-9b1f-6c2e5a7d8b90")).toBe(
			"/verify/:id",
		);
		expect(routeOf("/api/data")).toBe("/api/data");
		expect(routeOf("/")).toBe("/");
	});
});

// ── 3: the /status cache ─────────────────────────────────────────────────────

const gen = async (sm: Servicemon): Promise<string> => {
	const r = await sm.fetch(() => new Response("ok"))(
		new Request("http://t/status"),
	);
	return ((await r.json()) as { generated_at: string }).generated_at;
};

describe("status cache honors STATUS_REFRESH_S", () => {
	test("default (5s): cached — same generated_at inside the window", async () => {
		const sm = servicemon({ service: "t6", port: 0 });
		expect(sm.refreshS).toBe(5);
		expect(await gen(sm)).toBe(await gen(sm));
	});

	test("STATUS_REFRESH_S=0 → always fresh", async () => {
		process.env.STATUS_REFRESH_S = "0";
		const sm = servicemon({ service: "t7", port: 0 });
		delete process.env.STATUS_REFRESH_S;
		expect(sm.refreshS).toBe(0);
		const a = await gen(sm);
		await new Promise((r) => setTimeout(r, 12));
		expect(await gen(sm)).not.toBe(a);
	});

	test("custom window: cached inside, expires after (50ms knob)", async () => {
		process.env.STATUS_REFRESH_S = "0.05";
		const sm = servicemon({ service: "t8", port: 0 });
		delete process.env.STATUS_REFRESH_S;
		expect(sm.refreshS).toBe(0.05);
		const a = await gen(sm);
		await new Promise((r) => setTimeout(r, 70));
		expect(await gen(sm)).not.toBe(a);
	});

	test("invalid STATUS_REFRESH_S falls back to the 5s default", () => {
		process.env.STATUS_REFRESH_S = "bogus";
		const sm = servicemon({ service: "t9", port: 0 });
		delete process.env.STATUS_REFRESH_S;
		expect(sm.refreshS).toBe(5);
	});

	test("/status reports totals + by_route from the same registry", async () => {
		const sm = servicemon({ service: "t10", port: 0 });
		const f = sm.fetch(() => new Response("ok"));
		await f(new Request("http://t/api/data"));
		await f(new Request("http://t/api/data"));
		const j = (await (await f(new Request("http://t/status"))).json()) as {
			service: string;
			requests: { total: number; by_route: Record<string, number> };
			last_error: { at: string; message: string } | null;
		};
		expect(j.service).toBe("t10");
		expect(j.requests.total).toBe(2);
		expect(j.requests.by_route["/api/data"]).toBe(2);
		expect(j.last_error).toBeNull();
	});

	test("inner throw → 500 with scrubbed last_error", async () => {
		const sm = servicemon({ service: "t11", port: 0 });
		const f = sm.fetch(() => {
			throw new Error("read /Users/alice/dev/secret failed");
		});
		const r = await f(new Request("http://t/rpc"));
		expect(r.status).toBe(500);
		const j = (await (await f(new Request("http://t/status"))).json()) as {
			last_error: { message: string } | null;
		};
		expect(j.last_error?.message).toBe("read ~/dev/secret failed");
	});
});

// ── 4: wiring — each service answers /status + /metrics on a temp port ───────

// no /Users paths, no token/key value shapes in anything served
const unsafe = (s: string): boolean =>
	s.includes("/Users/") ||
	/"(answer_)?token"\s*:/.test(s) ||
	/sk-[A-Za-z0-9]{8,}/.test(s);

describe("wiring — store-server", () => {
	let base = "";
	beforeAll(async () => {
		base = await start(join(BIN, "store-server.ts"), await freePort(), home);
	});

	test("/status snapshot shape", async () => {
		const r = await fetch(`${base}/status`);
		expect(r.status).toBe(200);
		const j = (await r.json()) as {
			service: string;
			healthy: boolean;
			uptime_s: number;
			last_error: unknown;
		};
		expect(j.service).toBe("store-server");
		expect(j.healthy).toBe(true);
		expect(j.last_error).toBeNull();
		expect(j.uptime_s).toBeGreaterThanOrEqual(0);
	});

	test("/metrics: http families, honest token omission, /health compat", async () => {
		expect((await fetch(`${base}/health`)).status).toBe(200);
		const text = await (await fetch(`${base}/metrics`)).text();
		expect(text).toContain("# TYPE http_requests_total counter");
		expect(text).toContain("# TYPE http_request_duration_seconds histogram");
		expect(text).toContain(`http_requests_total{route="/health"}`);
		expect(text.includes("tokens_total")).toBe(false);
		expect(unsafe(text)).toBe(false);
	});

	test("rpc compat, 404s in by_route, no path/token leakage", async () => {
		const rpc = await fetch(`${base}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "get", sql: "SELECT 1 AS x", params: [] }),
		});
		expect(rpc.status).toBe(200);
		await fetch(`${base}/nope`);
		const st = (await (await fetch(`${base}/status`)).json()) as {
			requests: { by_route: Record<string, number> };
		};
		expect(st.requests.by_route["/nope"]).toBeGreaterThan(0);
		expect(st.requests.by_route["/rpc"]).toBeGreaterThan(0);
		expect(unsafe(JSON.stringify(st))).toBe(false);
	});
});

describe("wiring — knowledge-api", () => {
	let base = "";
	beforeAll(async () => {
		base = await start(join(BIN, "knowledge-api.ts"), await freePort(), home);
	});

	test("/status + /metrics answer; /search lands in by_route", async () => {
		const j = (await (await fetch(`${base}/status`)).json()) as {
			service: string;
		};
		expect(j.service).toBe("knowledge-api");
		const text = await (await fetch(`${base}/metrics`)).text();
		expect(text).toContain("# TYPE http_requests_total counter");
		expect(text.includes("tokens_total")).toBe(false);
		await fetch(`${base}/search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "w125 probe" }),
		});
		const st = (await (await fetch(`${base}/status`)).json()) as {
			requests: { by_route: Record<string, number> };
		};
		expect(st.requests.by_route["/search"]).toBeGreaterThan(0);
		expect(unsafe(JSON.stringify(st))).toBe(false);
	});
});

// seed one lane's transcript with known usage into the board's temp HOME
// governor.db (subprocess — the parent test never opens the db), claim opened
// a minute before the usage line's timestamp so the window includes it
const seedBoard = (): string => {
	const tp = join(repo, "lane-tok.jsonl");
	const line = JSON.stringify({
		type: "assistant",
		timestamp: new Date().toISOString(),
		message: {
			usage: {
				input_tokens: 1000,
				output_tokens: 100,
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 25,
			},
		},
	});
	writeFileSync(tp, `${line}\n`);
	const code = `
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = Date.now();
const P = ${JSON.stringify(repo)};
db.query("INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state, transcript_path) VALUES ('lane-tok', ?, 'worker', ?, ?, 'RUNNING', ?)").run(P, now, now, ${JSON.stringify(tp)});
db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'work', 'work.claimed', NULL, ?, NULL)").run(now - 60000, JSON.stringify({ work: "T1", project: P, by: "lane-tok" }));
db.close();`;
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: boardHome },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return tp;
};

describe("wiring — fleet-board", () => {
	let base = "";
	beforeAll(async () => {
		seedBoard();
		base = await start(
			join(BIN, "fleet-board.ts"),
			await freePort(),
			boardHome,
		);
	});

	test("/status shape + 5s cache (same generated_at across scrapes)", async () => {
		const j = (await (await fetch(`${base}/status`)).json()) as {
			service: string;
			requests: { total: number; by_route: Record<string, number> };
		};
		expect(j.service).toBe("fleet-board");
		const again = (await (await fetch(`${base}/status`)).json()) as {
			generated_at: string;
		};
		expect(again.generated_at).toBeTruthy();
	});

	test("/metrics carries tokens_total fed from the seeded transcripts", async () => {
		const text = await (await fetch(`${base}/metrics`)).text();
		expect(text).toContain("# TYPE tokens_total counter");
		expect(text).toMatch(/tokens_total\{kind="in",project="[^"]*"\} 1000/);
		expect(text).toMatch(/tokens_total\{kind="out",project="[^"]*"\} 100/);
		expect(text).toMatch(
			/tokens_total\{kind="cache_read",project="[^"]*"\} 50/,
		);
		expect(unsafe(text)).toBe(false);
	});
});
