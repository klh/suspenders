// test/federation-pull.test.ts — W154 spoke pull client: fresh pull stores
// last-known + feeds the echo menu; hub-down degrades honestly (keeps
// last-known, never throws); provenance seed derives data_domain from what
// actually served (default private, hub only for hub-entitled groups).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	lastKnownPath,
	loadLastKnown,
	pullFederation,
	type FederationEnv,
} from "../hooks/lib/federation.ts";
import { deriveDataDomain, hubModelIdsFrom } from "../hooks/lib/provenance.ts";
import { atomicWrite } from "../hooks/lib/board-config.ts";

const FIXTURE_ENTITLEMENTS = {
	models: [
		{
			id: "glm-5.3-flash",
			family: "openai-compat",
			tier: "general",
			locality: "hub-local",
			available: true,
		},
		{
			id: "gpt-5.2",
			family: null,
			tier: "frontier",
			locality: "cloud",
			available: false,
		},
	],
};

const FIXTURE_MANIFEST = {
	version: "fed-test-1",
	rules: [{ id: "gateway.knobs" }],
	cr_queue: [
		{
			id: "cr-x",
			action: "adopt-policy",
			target: "policy@1",
			declared_at: "2026-10-01T00:00:00Z",
			state: "declared",
		},
	],
};

function tmpEnv(): FederationEnv {
	const home = join(
		tmpdir(),
		`w154-spoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(home, { recursive: true });
	return { BUCKLE_SECRETS_HOME: home, HOME: home };
}

function stubHub(): string {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/federation/policy-manifest")
				return Response.json(FIXTURE_MANIFEST);
			if (path === "/federation/entitlements")
				return Response.json(FIXTURE_ENTITLEMENTS);
			return new Response(null, { status: 404 });
		},
	});
	return `http://127.0.0.1:${String(server.port)}`;
}

describe("pull: fresh pull stores last-known + echo menu", () => {
	test("pull → ok, last-known written, hub menu mirrored", async () => {
		const env = tmpEnv();
		const url = stubHub();
		const out = await pullFederation({ env, hubUrl: url });
		expect(out.ok).toBe(true);
		expect(out.degraded).toBe(false);
		expect(out.menu.hub_models).toHaveLength(2);
		expect(out.menu.local_entries).toEqual([]);
		expect(out.manifest?.version).toBe("fed-test-1");
		expect(out.manifest?.cr_queue).toHaveLength(1);
		const lk = loadLastKnown(env);
		expect(lk).not.toBeNull();
		expect(lk?.hub_url).toBe(url);
		expect(lk?.entitlements?.models).toHaveLength(2);
		expect(existsSync(lastKnownPath(env))).toBe(true);
	});
});

describe("pull: degradation law (hub-down keeps last-known)", () => {
	test("hub down → degraded, last-known preserved, menu from old data", async () => {
		const env = tmpEnv();
		const old = {
			pulled_at: "2026-09-01T00:00:00Z",
			hub_url: "http://127.0.0.1:1",
			manifest: FIXTURE_MANIFEST,
			entitlements: FIXTURE_ENTITLEMENTS,
		};
		atomicWrite(lastKnownPath(env), JSON.stringify(old));
		const before = loadLastKnown(env);
		const out = await pullFederation({
			env,
			hubUrl: "http://127.0.0.1:1", // nothing listens there
			timeoutMs: 800,
		});
		expect(out.ok).toBe(false);
		expect(out.degraded).toBe(true);
		expect(out.manifest?.version).toBe("fed-test-1");
		expect(out.menu.hub_models).toHaveLength(2);
		expect(loadLastKnown(env)).toEqual(before);
	});
});

describe("provenance: data_domain seed (domain-separation law)", () => {
	test("default private; hub only for hub-entitled groups; null → private", () => {
		const hubIds = ["glm-5.3-flash", "gpt-5.2"];
		expect(deriveDataDomain("glm-5.3-flash", hubIds)).toBe("hub");
		expect(deriveDataDomain("local-swarm", hubIds)).toBe("private");
		expect(deriveDataDomain(null, hubIds)).toBe("private");
		expect(deriveDataDomain(undefined, hubIds)).toBe("private");
		expect(deriveDataDomain("", hubIds)).toBe("private");
	});
	test("hub id set loads from last-known entitlements", () => {
		const lk = {
			manifest: null,
			entitlements: FIXTURE_ENTITLEMENTS,
			pulled_at: "",
			hub_url: "",
		};
		const ids = hubModelIdsFrom(lk);
		expect(ids.has("glm-5.3-flash")).toBe(true);
		expect(ids.has("local-swarm")).toBe(false);
	});
});
