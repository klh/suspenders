// test/citizenship.test.ts — W155 http-citizenship: the servicemon seam
// (/status GET/HEAD/OPTIONS/405 + ETag/304), the store-server method gates,
// the /auth/* citizenship wrapper (no-store + rate trio + problem+json +
// OPTIONS/405), and the board methodGuard + withEtag helpers.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const HOME = mkdtempSync(join(process.cwd(), ".citizenship-test-home-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
	for (const p of procs) p.kill();
	process.env.HOME = REAL_HOME;
	process.env.BUCKLE_SECRETS_HOME = REAL_SECRETS;
	rmSync(HOME, { recursive: true, force: true });
});
const REAL_SECRETS = process.env.BUCKLE_SECRETS_HOME;

// dynamic imports AFTER the HOME pin (the auth.test.ts pattern — govdb binds
// the registry at module load); guard.ts is pure, helpers.ts opens the
// scratch governor.db the pin provides
const { servicemon } = await import("../hooks/lib/servicemon.ts");
const { methodGuard } = await import("../hooks/board/guard.ts");
const { withEtag } = await import("../hooks/board/helpers.ts");

// canonical store server (the auth.test.ts pattern): one live server, /auth/*
// and /rpc answers carry the citizenship headers this file asserts
const URL0 = await (async (): Promise<string> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = s.port;
	s.stop(true);
	const p = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "..", "hooks", "bin", "store-server.ts"),
			"--port",
			String(port),
		],
		{
			env: { ...process.env, HOME, NO_COLOR: "1" },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	procs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("citizenship store server did not come up");
})();

describe("servicemon /status seam", () => {
	// default 5s TTL — with refreshS 0 every call re-snapshots (uptime_s
	// advances), so the If-None-Match pair would never share a body
	const sm = servicemon({ service: "citizenship-t", port: 0 });
	const h = sm.fetch(() => new Response("inner"));

	test("GET /status 200 + strong ETag", async () => {
		const r = await h(new Request("http://x/status"));
		expect(r.status).toBe(200);
		const etag = r.headers.get("etag") ?? "";
		expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
	});

	test("If-None-Match hit → 304 with ETag echo", async () => {
		const r1 = await h(new Request("http://x/status"));
		const etag = r1.headers.get("etag") ?? "";
		const r2 = await h(
			new Request("http://x/status", { headers: { "if-none-match": etag } }),
		);
		expect(r2.status).toBe(304);
		expect(r2.headers.get("etag")).toBe(etag);
	});

	test("DELETE /status → 405 + Allow; OPTIONS → 204 + Allow", async () => {
		const del = await h(new Request("http://x/status", { method: "DELETE" }));
		expect(del.status).toBe(405);
		expect(del.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
		const opt = await h(new Request("http://x/status", { method: "OPTIONS" }));
		expect(opt.status).toBe(204);
		expect(opt.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});
});

describe("store-server citizenship", () => {
	test("GET /status → 200 + ETag (store rides the seam)", async () => {
		const r = await fetch(`${URL0}/status`);
		expect(r.status).toBe(200);
		expect(r.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
	});

	test("DELETE /status → 405 + Allow", async () => {
		const r = await fetch(`${URL0}/status`, { method: "DELETE" });
		expect(r.status).toBe(405);
		expect(r.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});

	test("GET /rpc → 405 + Allow POST; OPTIONS /rpc → 204", async () => {
		const r = await fetch(`${URL0}/rpc`);
		expect(r.status).toBe(405);
		expect(r.headers.get("allow")).toBe("POST, OPTIONS");
		const o = await fetch(`${URL0}/rpc`, { method: "OPTIONS" });
		expect(o.status).toBe(204);
	});

	test("401 /auth/whoami: problem+json + legacy members + WWW-Authenticate + no-store + trio", async () => {
		const r = await fetch(`${URL0}/auth/whoami`);
		expect(r.status).toBe(401);
		expect(r.headers.get("content-type")).toBe("application/problem+json");
		expect(r.headers.get("www-authenticate")).toContain("invalid_token");
		expect(r.headers.get("cache-control")).toBe("no-store");
		expect(r.headers.get("ratelimit-limit")).not.toBeNull();
		expect(r.headers.get("ratelimit-remaining")).not.toBeNull();
		expect(r.headers.get("ratelimit-reset")).not.toBeNull();
		expect(r.headers.get("x-ratelimit-limit")).not.toBeNull();
		const b = (await r.json()) as Record<string, unknown>;
		expect(b.code).toBe("missing_token");
		expect(b.error).toBe("missing_token"); // legacy reader preserved
		expect(b.refresh_endpoint).toBe("/auth/refresh");
		expect(b.agent_next_steps).toBeString();
	});

	test("OPTIONS /auth/whoami → 204 + Allow", async () => {
		const r = await fetch(`${URL0}/auth/whoami`, { method: "OPTIONS" });
		expect(r.status).toBe(204);
		expect(r.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});

	test("GET /auth/token → 405 + Allow POST", async () => {
		const r = await fetch(`${URL0}/auth/token`);
		expect(r.status).toBe(405);
		expect(r.headers.get("allow")).toBe("POST, OPTIONS");
	});

	test("DELETE /auth/nope → 404 problem+json", async () => {
		const r = await fetch(`${URL0}/auth/nope`, { method: "DELETE" });
		expect(r.status).toBe(404);
		expect(r.headers.get("content-type")).toBe("application/problem+json");
	});
});

describe("board methodGuard", () => {
	test("OPTIONS: 204 + per-path Allow", () => {
		const feed = methodGuard(
			new Request("http://x/api/tasks", { method: "OPTIONS" }),
			new URL("http://x/api/tasks"),
		);
		expect(feed?.status).toBe(204);
		expect(feed?.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
		const write = methodGuard(
			new Request("http://x/api/answer", { method: "OPTIONS" }),
			new URL("http://x/api/answer"),
		);
		expect(write?.status).toBe(204);
		expect(write?.headers.get("allow")).toBe("POST, OPTIONS");
	});

	test("known write path with wrong method → 405 + Allow POST", () => {
		const r = methodGuard(
			new Request("http://x/api/answer", { method: "GET" }),
			new URL("http://x/api/answer"),
		);
		expect(r?.status).toBe(405);
		expect(r?.headers.get("allow")).toBe("POST, OPTIONS");
	});

	test("read feed with wrong method → 405 + Allow GET", () => {
		const r = methodGuard(
			new Request("http://x/api/tasks", { method: "DELETE" }),
			new URL("http://x/api/tasks"),
		);
		expect(r?.status).toBe(405);
		expect(r?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});

	test("legitimate methods pass through (null)", () => {
		expect(
			methodGuard(
				new Request("http://x/api/tasks"),
				new URL("http://x/api/tasks"),
			),
		).toBeNull();
		expect(
			methodGuard(
				new Request("http://x/api/ship", { method: "POST" }),
				new URL("http://x/api/ship"),
			),
		).toBeNull();
		expect(
			methodGuard(new Request("http://x/"), new URL("http://x/")),
		).toBeNull();
	});
});

describe("board withEtag", () => {
	const jsonResp = (): Response =>
		new Response(JSON.stringify({ ok: true, n: 42 }), {
			headers: { "content-type": "application/json" },
		});

	test("first GET → 200 + ETag + revalidate caching", async () => {
		const r = await withEtag(new Request("http://x/api/tasks"), jsonResp());
		expect(r.status).toBe(200);
		expect(r.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
		expect(r.headers.get("cache-control")).toBe(
			"private, max-age=0, must-revalidate",
		);
	});

	test("If-None-Match hit → 304", async () => {
		const r1 = await withEtag(new Request("http://x/api/tasks"), jsonResp());
		const etag = r1.headers.get("etag") ?? "";
		const r2 = await withEtag(
			new Request("http://x/api/tasks", {
				headers: { "if-none-match": etag },
			}),
			jsonResp(),
		);
		expect(r2.status).toBe(304);
		expect(r2.headers.get("etag")).toBe(etag);
	});

	test("HEAD and non-JSON pass through untouched", async () => {
		const head = new Request("http://x/api/tasks", { method: "HEAD" });
		const hr = await withEtag(head, jsonResp());
		expect(hr.status).toBe(200);
		expect(hr.headers.get("etag")).toBeNull();
		const html = new Response("<b>x</b>", {
			headers: { "content-type": "text/html" },
		});
		const hp = await withEtag(new Request("http://x/"), html);
		expect(hp.headers.get("etag")).toBeNull();
	});
});
