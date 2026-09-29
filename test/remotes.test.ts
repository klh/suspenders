// test/remotes.test.ts — hooks/lib/remotes.ts: config loading, DNS-first
// resolution with ip_fallback, protocol probes, and openai chat routing —
// proven against a real local stub server (Bun.serve), not mocks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	chatRemote,
	configPath,
	ensureEndpoint,
	endpointsWithRole,
	loadRemotes,
	probeEndpoint,
	type RemoteEndpoint,
	type RemoteMachine,
	resolveHost,
	sendWoL,
} from "../hooks/lib/remotes.ts";

// ─── stub remote: an openai-shaped endpoint on 127.0.0.1 ──────────────────
const HITS: string[] = [];
const stub = Bun.serve({
	port: 0, // OS-assigned
	fetch(req) {
		const url = new URL(req.url);
		HITS.push(url.pathname);
		if (url.pathname === "/v1/models")
			return Response.json({ data: [{ id: "stub-model" }] });
		if (url.pathname === "/v1/chat/completions")
			return Response.json({
				choices: [{ message: { content: "STUB-ANSWER" } }],
			});
		return new Response("nope", { status: 404 });
	},
});

// ─── fixture config: HOME pointed at a temp dir ───────────────────────────
const TMP = `${import.meta.dir}/.tmp-remotes-home`;
const EP: RemoteEndpoint = {
	port: stub.port,
	protocol: "openai",
	roles: ["general", "advise"],
	model: "stub-model",
	keepwarm_probe: true,
};
const MACHINE: RemoteMachine = {
	name: "stub",
	host: "stub.invalid", // unresolvable → forces the ip_fallback path
	ip_fallback: "127.0.0.1",
	endpoints: [EP],
};

beforeAll(() => {
	mkdirSync(`${TMP}/.claude/local-llm`, { recursive: true });
	process.env.HOME = TMP;
	writeFileSync(configPath(), JSON.stringify({ machines: [MACHINE] }));
});

afterAll(() => {
	stub.stop(true);
	rmSync(TMP, { recursive: true, force: true });
	if (REAL_HOME) process.env.HOME = REAL_HOME;
});

/** configPath() reads HOME at call time — the fixture points HOME at TMP for
 *  this file's tests and afterAll restores the real one (a leaked HOME
 *  poisons later test files that assert against $HOME paths). */
const REAL_HOME = process.env.HOME;

describe("remotes registry", () => {
	test("configPath follows HOME", () => {
		expect(configPath()).toBe(`${TMP}/.claude/local-llm/remotes.json`);
	});

	test("loadRemotes parses the fixture", () => {
		expect(loadRemotes()).toHaveLength(1);
		expect(endpointsWithRole("advise")).toHaveLength(1);
	});

	test("resolveHost falls back when DNS fails", async () => {
		const ip = await resolveHost("stub.invalid", "127.0.0.1");
		expect(ip).toBe("127.0.0.1");
	});

	test("probeEndpoint reports alive with latency", async () => {
		const h = await probeEndpoint(MACHINE, EP);
		expect(h.alive).toBe(true);
		expect(h.ms).toBeGreaterThanOrEqual(0);
		expect(HITS).toContain("/v1/models");
	});

	test("chatRemote routes and returns the answer", async () => {
		const out = await chatRemote(MACHINE, EP, [
			{ role: "user", content: "hello" },
		]);
		expect(out.text).toBe("STUB-ANSWER");
		expect(out.model).toBe("stub-model");
		expect(HITS).toContain("/v1/chat/completions");
	});

	test("ensureEndpoint without mac returns probe result", async () => {
		const h = await ensureEndpoint(MACHINE, EP);
		expect(h.alive).toBe(true);
	});

	test("dead endpoint probes dead", async () => {
		const dead: RemoteMachine = {
			name: "dead",
			host: "dead.invalid",
			ip_fallback: "127.0.0.1",
			endpoints: [{ port: 1, protocol: "openai", roles: [] }],
		};
		const ep = dead.endpoints[0];
		if (!ep) throw new Error("fixture");
		const h = await probeEndpoint(dead, ep);
		expect(h.alive).toBe(false);
	});

	test("sendWoL rejects a malformed MAC without sending", async () => {
		expect(await sendWoL("not-a-mac", "127.0.0.1:9")).toBe(false);
	});
});
