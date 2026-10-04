// test/host-guard.test.ts — W264 perimeter guard units (hooks/lib/host-guard.ts)
// plus the loopback-default binding contract of the launchd plists/services.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureWriteToken,
	hostAllowlist,
	hostGuard,
	hostnameOf,
	withWriteCookie,
} from "../hooks/lib/host-guard.ts";

const TOKEN = "a".repeat(64);
const env = { HOME: "/nonexistent" } as NodeJS.ProcessEnv;
const req = (headers: Record<string, string>, method = "POST"): Request =>
	new Request("http://127.0.0.1:7799/api/ack", { method, headers });
const guard = (r: Request, write = true, bind = "127.0.0.1") =>
	hostGuard(r, { bind, write, env, token: () => TOKEN });
const err = async (r: Response | null) =>
	r ? ((await r.json()) as { error: string }).error : null;

describe("host allowlist", () => {
	test("loopback + suspenders.local by default; wildcard binds never join", () => {
		const a = hostAllowlist("0.0.0.0", env);
		expect([...a].sort()).toEqual(
			[
				"0:0:0:0:0:0:0:1",
				"127.0.0.1",
				"::1",
				"localhost",
				"suspenders.local",
			].sort(),
		);
		expect(hostAllowlist("::", env).has("::")).toBe(false);
	});
	test("env names: only *.local accepted; explicit bind opts in", () => {
		const a = hostAllowlist("192.168.9.9", {
			SUSPENDERS_ALLOWED_HOSTS: "Board.Local., evil.example, x.local",
		});
		expect(a.has("board.local")).toBe(true);
		expect(a.has("x.local")).toBe(true);
		expect(a.has("evil.example")).toBe(false);
		expect(a.has("suspenders.local")).toBe(false); // env replaces default
		expect(a.has("192.168.9.9")).toBe(true);
	});
	test("hostnameOf strips ports and IPv6 brackets", () => {
		expect(hostnameOf("127.0.0.1:7799")).toBe("127.0.0.1");
		expect(hostnameOf("[::1]:7799")).toBe("::1");
		expect(hostnameOf("Suspenders.Local.")).toBe("suspenders.local");
	});
});

describe("hostGuard", () => {
	test("spoofed Host rejected even with a valid token", async () => {
		for (const host of ["evil.example", "0.0.0.0:7799", "10.0.0.5"]) {
			const r = guard(req({ host, "x-klh-write-token": TOKEN }));
			expect(r?.status).toBe(403);
			expect(await err(r)).toBe("untrusted host");
		}
		expect(guard(req({}))?.status).toBe(403); // no Host at all
	});
	test("DNS rebinding: Origin == Host but not allowlisted → 403", async () => {
		const host = "rebind.example:7799";
		const r = guard(
			req({ host, origin: `http://${host}`, "x-klh-write-token": TOKEN }),
		);
		expect(r?.status).toBe(403);
		// a GET is host-gated as well
		expect(guard(req({ host }, "GET"), false)?.status).toBe(403);
	});
	test("browser branch: origin must be allowlisted AND equal Host", async () => {
		const host = "127.0.0.1:7799";
		const t = { "x-klh-write-token": TOKEN };
		expect(
			await err(guard(req({ ...t, host, origin: "http://evil.example:7799" }))),
		).toBe("untrusted origin");
		expect(
			await err(guard(req({ ...t, host, origin: "http://localhost:7799" }))),
		).toBe("cross-origin request");
		expect(await err(guard(req({ ...t, host, origin: "null" })))).toBe(
			"bad origin",
		);
		expect(guard(req({ ...t, host, origin: `http://${host}` }))).toBeNull();
	});
	test("write token: missing / wrong / unavailable → 403; header or cookie ok", async () => {
		const host = "localhost:7799";
		expect(await err(guard(req({ host })))).toBe("write token required");
		expect(
			await err(guard(req({ host, "x-klh-write-token": "b".repeat(64) }))),
		).toBe("bad write token");
		expect(await err(guard(req({ host, "x-klh-write-token": "short" })))).toBe(
			"bad write token",
		);
		const none = hostGuard(req({ host, "x-klh-write-token": TOKEN }), {
			bind: "127.0.0.1",
			write: true,
			env,
			token: () => null,
		});
		expect(none?.status).toBe(403);
		expect(await err(none)).toBe("write token unavailable");
		expect(guard(req({ host, "x-klh-write-token": TOKEN }))).toBeNull();
		expect(
			guard(req({ host, cookie: `a=b; klh_write_token=${TOKEN}` })),
		).toBeNull();
		// reads need no token
		expect(guard(req({ host }, "GET"), false)).toBeNull();
	});
});

describe("write token file", () => {
	const dir = mkdtempSync(join(tmpdir(), "w264-token-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	test("generated once, 0600, stable across calls", () => {
		const p = join(dir, "state", "write-token");
		const a = ensureWriteToken(p);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(ensureWriteToken(p)).toBe(a);
	});
	test("unwritable location → null (caller answers 403, never 500)", () => {
		expect(ensureWriteToken("/dev/null/nope/write-token")).toBeNull();
	});
	test("cookie only on HTML responses, and only for a local client", () => {
		const localReq = new Request("http://suspenders.local/", {
			headers: { "x-forwarded-for": "127.0.0.1" },
		});
		const html = withWriteCookie(
			new Response("<p>", { headers: { "content-type": "text/html" } }),
			localReq,
			"127.0.0.1",
			TOKEN,
		);
		expect(html.headers.get("set-cookie")).toContain("HttpOnly");
		const js = withWriteCookie(Response.json({}), localReq, "127.0.0.1", TOKEN);
		expect(js.headers.get("set-cookie")).toBeNull();
	});
	test("C1: a LAN client reaching the board via Caddy gets NO cookie", () => {
		// Caddy's reverse_proxy sets/appends the true peer IP as the last
		// X-Forwarded-For entry — a LAN host (not loopback, not our own
		// interface) must not be handed the write-auth cookie just because
		// suspenders.local passed the host allowlist.
		const lanReq = new Request("http://suspenders.local/", {
			headers: { "x-forwarded-for": "192.168.1.77" },
		});
		const res = withWriteCookie(
			new Response("<p>", { headers: { "content-type": "text/html" } }),
			lanReq,
			"127.0.0.1", // Caddy itself connects to the board over loopback
			TOKEN,
		);
		expect(res.headers.get("set-cookie")).toBeNull();
	});
	test("C1: a direct loopback client (no proxy) still gets the cookie", () => {
		const directReq = new Request("http://127.0.0.1:7799/", { headers: {} });
		const res = withWriteCookie(
			new Response("<p>", { headers: { "content-type": "text/html" } }),
			directReq,
			"127.0.0.1",
			TOKEN,
		);
		expect(res.headers.get("set-cookie")).toContain("HttpOnly");
	});
});

describe("loopback default binding", () => {
	const root = join(import.meta.dir, "..", "hooks");
	const read = (p: string) => readFileSync(join(root, p), "utf8");
	test("board plist sets no wildcard bind and no /tmp log", () => {
		const plist = read("launchd/com.suspenders.board.plist");
		expect(plist).not.toContain("SUSPENDERS_BIND");
		expect(plist).not.toContain("0.0.0.0");
		expect(plist).not.toContain("/tmp/");
	});
	test("board + knowledge-api default to 127.0.0.1", () => {
		expect(read("board/context.ts")).toContain(
			'process.env.SUSPENDERS_BIND ?? "127.0.0.1"',
		);
		const api = read("bin/knowledge-api.ts");
		expect(api).toContain('process.env.KNOWLEDGE_API_BIND ?? "127.0.0.1"');
		expect(api).toContain("hostname: BIND");
	});
});
