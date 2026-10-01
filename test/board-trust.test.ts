// test/board-trust.test.ts — W172 LAN trust gate: unit tests for the gate
// rules plus live-board spawns proving startup refusal, the shared-secret
// request gate (reads, writes, /status, /metrics), and the writeGuard
// wildcard-host hole. Each case spawns its own board on a scratch HOME.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	bindTrustError,
	isLoopbackBind,
	secretMatches,
	trustGate,
	wildcardBind,
} from "../hooks/board/gate.ts";

const BIN = join(import.meta.dir, "..", "hooks", "bin", "fleet-board.ts");
const HOME_DIR = mkdtempSync(join(tmpdir(), "suspenders-trust-"));

afterAll(() => {
	rmSync(HOME_DIR, { recursive: true, force: true });
});

// fetch() refuses to set Host — raw node:http for the hostile-header cases
function raw(
	port: number,
	path: string,
	headers: Record<string, string>,
	body?: string,
): Promise<{ status: number | undefined; body: string }> {
	return new Promise((resolve) => {
		const rq = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method: body === undefined ? "GET" : "POST",
				headers,
			},
			(res) => {
				let b = "";
				res.on("data", (c: Buffer) => {
					b += c;
				});
				res.on("end", () => resolve({ status: res.statusCode, body: b }));
			},
		);
		rq.end(body);
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// spawn a board; waitUp polls until the port answers anything at all (a 401
// is as alive as a 200 — the gate answers before the routes do)
async function spawnBoard(port: number, extraEnv: Record<string, string>) {
	const proc = Bun.spawn(["bun", BIN, "--port", String(port)], {
		env: { ...process.env, SUSPENDERS_MDNS: "0", HOME: HOME_DIR, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	for (let i = 0; i < 100; i++) {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return proc;
		} catch {
			await sleep(100);
		}
	}
	proc.kill();
	throw new Error(`board did not start on :${port}`);
}

describe("gate rules (unit)", () => {
	test("loopback binds are always allowed, token or not", () => {
		expect(bindTrustError("127.0.0.1", "")).toBeNull();
		expect(bindTrustError("::1", "")).toBeNull();
		expect(bindTrustError("localhost", "")).toBeNull();
		expect(bindTrustError("127.0.0.1", "x")).toBeNull();
		expect(isLoopbackBind("127.0.0.1")).toBe(true);
		expect(isLoopbackBind("0.0.0.0")).toBe(false);
	});

	test("non-loopback bind without a token is refused, with one it is allowed", () => {
		expect(bindTrustError("0.0.0.0", "")).toContain("refusing to bind");
		expect(bindTrustError("192.168.1.10", "")).toContain("refusing to bind");
		expect(bindTrustError("0.0.0.0", "sekrit")).toBeNull();
		expect(bindTrustError("192.168.1.10", "sekrit")).toBeNull();
	});

	test("wildcard bind names are never trust anchors", () => {
		expect(wildcardBind("0.0.0.0")).toBe(true);
		expect(wildcardBind("::")).toBe(true);
		expect(wildcardBind("")).toBe(true);
		expect(wildcardBind("192.168.1.10")).toBe(false);
		expect(wildcardBind("127.0.0.1")).toBe(false);
	});

	test("secretMatches is constant-time-safe and exact", () => {
		expect(secretMatches("sekrit", "sekrit")).toBe(true);
		expect(secretMatches("wrong", "sekrit")).toBe(false);
		expect(secretMatches("", "sekrit")).toBe(false);
	});

	test("trustGate answers 401 JSON without a valid bearer, null with one", async () => {
		const req = (h?: Record<string, string>) =>
			new Request("http://127.0.0.1:7799/api/data", { headers: h ?? {} });
		const deny = trustGate(req(), "sekrit");
		expect(deny).not.toBeNull();
		expect(deny?.status).toBe(401);
		const denyWrong = trustGate(
			req({ authorization: "Bearer nope" }),
			"sekrit",
		);
		expect(denyWrong?.status).toBe(401);
		const allow = trustGate(req({ authorization: "Bearer sekrit" }), "sekrit");
		expect(allow).toBeNull();
		// token unset — the gate is transparent (loopback posture)
		expect(trustGate(req(), "")).toBeNull();
	});
});

describe("live board trust postures", () => {
	test(
		"open loopback: no token, every plain request answers 200",
		async () => {
			const proc = await spawnBoard(7891, {});
			try {
				const r = await fetch("http://127.0.0.1:7891/api/data");
				expect(r.status).toBe(200);
				const meta = await fetch("http://127.0.0.1:7891/llms.txt");
				expect(await meta.text()).toContain("trust gate, not an auth system");
			} finally {
				proc.kill();
				await proc.exited;
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"gated board: 401 everywhere without the bearer, 200 with it (/status + /metrics included)",
		async () => {
			const proc = await spawnBoard(7892, {
				SUSPENDERS_BOARD_TOKEN: "sekrit-w172",
			});
			try {
				const base = "http://127.0.0.1:7892";
				expect((await fetch(`${base}/api/data`)).status).toBe(401);
				expect(
					(
						await fetch(`${base}/api/data`, {
							headers: { authorization: "Bearer wrong" },
						})
					).status,
				).toBe(401);
				const auth = { authorization: "Bearer sekrit-w172" };
				expect(
					(await fetch(`${base}/api/data`, { headers: auth })).status,
				).toBe(200);
				// the gate wraps OUTSIDE servicemon — observability endpoints too
				expect((await fetch(`${base}/status`)).status).toBe(401);
				expect((await fetch(`${base}/status`, { headers: auth })).status).toBe(
					200,
				);
				expect((await fetch(`${base}/metrics`)).status).toBe(401);
				expect((await fetch(`${base}/metrics`, { headers: auth })).status).toBe(
					200,
				);
				// a write endpoint reached with the token answers from the ROUTE
				// (404 unknown id), not from the gate (401) or the host guard (403)
				const ack = await fetch(`${base}/api/ack`, {
					method: "POST",
					headers: { "content-type": "application/json", ...auth },
					body: JSON.stringify({ id: 999999 }),
				});
				expect(ack.status).toBe(404);
			} finally {
				proc.kill();
				await proc.exited;
			}
		},
		{ timeout: 30_000 },
	);

	test(
		"ungated non-loopback bind refuses to start",
		() => {
			const p = Bun.spawnSync(["bun", BIN, "--port", "7894"], {
				env: {
					...process.env,
					SUSPENDERS_MDNS: "0",
					HOME: HOME_DIR,
					SUSPENDERS_BIND: "0.0.0.0",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(p.exitCode).not.toBe(0);
			expect(p.stderr.toString()).toContain("refusing to bind");
		},
		{ timeout: 30_000 },
	);

	test(
		"gated wildcard bind: bearer passes, Host: 0.0.0.0 is not a trust anchor",
		async () => {
			const proc = await spawnBoard(7893, {
				SUSPENDERS_BOARD_TOKEN: "sekrit-w172",
				SUSPENDERS_BIND: "0.0.0.0",
			});
			try {
				const auth = { authorization: "Bearer sekrit-w172" };
				expect(
					(await fetch("http://127.0.0.1:7893/api/data", { headers: auth }))
						.status,
				).toBe(200);
				// the old hole: a non-browser POST naming the wildcard bind as
				// Host passed writeGuard when SUSPENDERS_BIND=0.0.0.0 — now 403
				const hostile = await raw(
					7893,
					"/api/ack",
					{
						host: "0.0.0.0",
						"content-type": "application/json",
						...auth,
					},
					JSON.stringify({ id: 999999 }),
				);
				expect(hostile.status).toBe(403);
				const sane = await raw(
					7893,
					"/api/ack",
					{
						host: "127.0.0.1",
						"content-type": "application/json",
						...auth,
					},
					JSON.stringify({ id: 999999 }),
				);
				expect(sane.status).toBe(404);
			} finally {
				proc.kill();
				await proc.exited;
			}
		},
		{ timeout: 30_000 },
	);
});
