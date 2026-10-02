// board-write-auth.test.ts — W188: the write-auth bearer gate + the Host
// allowlist in both writeGuard branches. Two real boards: one open (host
// guards only), one with SUSPENDERS_BOARD_TOKEN set. Hostile-Host probes
// ride raw node:http (fetch refuses to set Host).
import { afterAll, describe, expect, test } from "bun:test";
import { boardFixture } from "./helpers/board-fixture.ts";

const TOKEN = "sekrit-w188-test-token";

const openB = await boardFixture(7855, afterAll, {
	SUSPENDERS_BOARD_HOSTS: "board.internal",
});
const gated = await boardFixture(7856, afterAll, {
	SUSPENDERS_BOARD_TOKEN: TOKEN,
});
// guard-pass discriminator: POST /api/start with an empty body passes the
// guards and dies in the handler's 400 (missing project/id) — 401/403 mean
// the gate or the host allowlist stopped it
describe("W188 open board: legacy loopback + rebind", () => {
	test("legacy loopback write still passes", async () => {
		const r = await openB.post("/api/start", {});
		expect(r.status).toBe(400);
	});

	test("rebind pair (origin == host == evil.example) hits the allowlist", async () => {
		const r = await openB.rawPost(
			{
				host: "evil.example",
				origin: "http://evil.example",
				"content-type": "application/json",
			},
			"{}",
			"/api/start",
		);
		expect(r.status).toBe(403);
		expect(r.body).toContain("untrusted host");
	});
});
describe("W188 open board: allowlist names", () => {
	test("published suspenders.local Host trusted (non-browser branch)", async () => {
		const r = await openB.rawPost(
			{ host: "suspenders.local", "content-type": "application/json" },
			"{}",
			"/api/start",
		);
		expect(r.status).toBe(400);
	});

	test("SUSPENDERS_BOARD_HOSTS extra trusted", async () => {
		const r = await openB.rawPost(
			{ host: "board.internal", "content-type": "application/json" },
			"{}",
			"/api/start",
		);
		expect(r.status).toBe(400);
	});

	test("unknown Host rejected", async () => {
		const r = await openB.rawPost(
			{ host: "other.example", "content-type": "application/json" },
			"{}",
			"/api/start",
		);
		expect(r.status).toBe(403);
	});
});
describe("W188 open board: LAN origin pair + setup row", () => {
	test("LAN-browser same-origin pair on suspenders.local passes the Origin branch", async () => {
		const r = await openB.rawPost(
			{
				host: "suspenders.local:7855",
				origin: "http://suspenders.local:7855",
				"content-type": "application/json",
			},
			"{}",
			"/api/start",
		);
		expect(r.status).toBe(400);
	});

	test("/api/setup carries the auth posture row", async () => {
		const d = (await (await fetch(`${openB.BASE}/api/setup`)).json()) as {
			checks: { id: string; detail: string }[];
		};
		const auth = d.checks.find((c) => c.id === "auth");
		expect(auth?.detail).toContain("host-trust only");
	});
});
describe("W188 gated board: bearer gate", () => {
	test("write without auth → 401 + WWW-Authenticate", async () => {
		const r = await fetch(`${gated.BASE}/api/start`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(r.status).toBe(401);
		expect(r.headers.get("www-authenticate")).toContain("Bearer");
	});

	test("wrong bearer → 401; right bearer passes the gate (→ handler 400)", async () => {
		const wrong = await gated.post(
			"/api/start",
			{},
			{ authorization: "Bearer wrong" },
		);
		expect(wrong.status).toBe(401);
		const right = await gated.post(
			"/api/start",
			{},
			{
				authorization: `Bearer ${TOKEN}`,
			},
		);
		expect(right.status).toBe(400);
	});

	test("reads stay open while writes are gated", async () => {
		const r = await fetch(`${gated.BASE}/`);
		expect(r.status).toBe(200);
	});
});
describe("W188 gated board: token bootstrap", () => {
	test("/console/token GET renders the bootstrap page", async () => {
		const r = await fetch(`${gated.BASE}/console/token`);
		expect(r.status).toBe(200);
		expect(await r.text()).toContain("SUSPENDERS_BOARD_TOKEN");
	});

	test("form: wrong token → 401 page", async () => {
		const bad = await fetch(`${gated.BASE}/console/token`, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: "nope" }).toString(),
		});
		expect(bad.status).toBe(401);
		expect(await bad.text()).toContain("not this board's");
	});

	test("form: right token → 303, cookie minted, cookie replay passes the gate", async () => {
		const ok = await fetch(`${gated.BASE}/console/token`, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: TOKEN }).toString(),
		});
		expect(ok.status).toBe(303);
		const setCookie = ok.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("board_token=");
		const cookie = setCookie.split(";")[0];
		const replay = await fetch(`${gated.BASE}/api/start`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: "{}",
		});
		expect(replay.status).toBe(400);
	});
});
describe("W188 gated board: bootstrap hard cases", () => {
	test("Bearer header path mints the cookie too", async () => {
		const r = await fetch(`${gated.BASE}/console/token`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(r.status).toBe(200);
		expect(r.headers.get("set-cookie")).toContain("board_token=");
	});

	test("bootstrap is host-guarded: right token, hostile Host → 403", async () => {
		const r = await gated.rawPost(
			{
				host: "evil.example",
				"content-type": "application/x-www-form-urlencoded",
			},
			"token=sekrit-w188-test-token",
			"/console/token",
		);
		expect(r.status).toBe(403);
	});
});
