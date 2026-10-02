// test/auth-w194.test.ts — W194: the auth hardening suite. Bounded default
// TTLs (omitted ≠ forever), the mint scope-subset rule over the live
// /auth/token route, the refresh-theft cascade (family dies on replay), and
// JWKS pinning (embedded keys verify fully offline; pinned jwks_uri skips
// discovery). Same canonical-server pattern as test/auth.test.ts: one store
// server per file, HOME a temp dir set BEFORE the dynamic imports.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync, createSign } from "node:crypto";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const HOME = mkdtempSync(join(process.cwd(), ".auth-w194-home-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");

const REAL_SECRETS = process.env.BUCKLE_SECRETS_HOME;
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
	for (const p of procs) p.kill();
	process.env.HOME = REAL_HOME;
	process.env.BUCKLE_SECRETS_HOME = REAL_SECRETS;
	rmSync(HOME, { recursive: true, force: true });
});
// ONE canonical server per file: the test process binds its store to it over
// HTTP (GOVERNOR_STORE_URL), so tokens issued via the lib live in the SAME db
// every spawned server verifies against — immune to module-load REG binding.
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
	throw new Error("canonical store server did not come up");
})();
const auth = await import("../hooks/lib/auth.ts");
const govdb = await import("../hooks/lib/govdb.ts");
const client = await import("../hooks/lib/auth-client.ts");

const store = new govdb.HttpGovernorStore(URL0, null); // the canonical db
const req = (
	tok: string | null,
): { headers: { get(n: string): string | null } } => ({
	headers: {
		get: (n: string) =>
			n.toLowerCase() === "authorization"
				? tok === null
					? null
					: `Bearer ${tok}`
				: null,
	},
});
// ─── shared RS256 test material (no network; fetchImpl always injected) ─────
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB_JWK = RSA.publicKey.export({ format: "jwk" }) as Record<
	string,
	unknown
>;
const signRs256 = (
	payload: Record<string, unknown>,
	privateKey: string,
	kid: string,
): string => {
	const head = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
	).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signer = createSign("RSA-SHA256");
	signer.update(`${head}.${body}`);
	return `${head}.${body}.${signer.sign(privateKey, "base64url")}`;
};
const DAY = 86_400_000;
const nowS = (): number => Math.floor(Date.now() / 1000);

test("W194: omitted TTLs → access bounded at the 30d default, not forever", () => {
	const pair = auth.issueTokens(store, {
		actor: "bound:1",
		token_class: "app-role",
		scopes: ["read_x"],
	});
	const exp = client.decodeExp(pair.access);
	expect(exp).not.toBeNull();
	const e = exp ?? 0;
	expect(e).toBeGreaterThan(nowS() + 29 * 86400);
	expect(e).toBeLessThanOrEqual(nowS() + 31 * 86400);
	expect(pair.expires_at).not.toBeNull();
});

test("W194: explicit 0 stays forever; >365d clamps to MAX_TOKEN_TTL_MS", () => {
	const f = auth.issueTokens(store, {
		actor: "bound:2",
		token_class: "app-role",
		scopes: [],
		accessTtlMs: 0,
	});
	expect(client.decodeExp(f.access)).toBeNull();
	const c = auth.issueTokens(store, {
		actor: "bound:3",
		token_class: "app-role",
		scopes: [],
		accessTtlMs: 400 * DAY,
	});
	const e = client.decodeExp(c.access) ?? 0;
	expect(e).toBeLessThanOrEqual(nowS() + auth.MAX_TOKEN_TTL_MS / 1000 + 60);
	expect(e).toBeGreaterThan(nowS() + 364 * 86400);
});
test("W194 rotation: access gets the bounded default, refresh inherits remaining", () => {
	const p = auth.issueTokens(store, {
		actor: "bound:rot",
		token_class: "app-role",
		scopes: ["read_x"],
		accessTtlMs: 3600_000,
		refreshTtlMs: 7 * DAY,
	});
	const r = auth.rotateRefresh(store, p.refresh, "test");
	expect(r.ok).toBe(true);
	if (!r.ok) return;
	// the rotated-in access is bounded (30d), NOT the old silent forever
	expect(client.decodeExp(r.access)).not.toBeNull();
	const parent = store
		.query("SELECT expires_at FROM api_keys WHERE jti = ?")
		.get(p.refresh_jti) as { expires_at: number | null };
	const child = store
		.query("SELECT expires_at FROM api_keys WHERE jti = ?")
		.get(r.refresh_jti) as { expires_at: number | null };
	expect(parent.expires_at).not.toBeNull();
	expect(child.expires_at).not.toBeNull();
	expect((child.expires_at ?? 0) <= (parent.expires_at ?? 0)).toBe(true);
});
test("W194 rotation: forever refresh (owner) rotates to forever refresh", () => {
	const p = auth.issueTokens(store, {
		actor: "bound:rot2",
		token_class: "app-role",
		scopes: ["read_x"],
		accessTtlMs: 3600_000,
		refreshTtlMs: 0,
	});
	const r = auth.rotateRefresh(store, p.refresh, "test");
	expect(r.ok).toBe(true);
	if (!r.ok) return;
	const child = store
		.query("SELECT expires_at FROM api_keys WHERE jti = ?")
		.get(r.refresh_jti) as { expires_at: number | null };
	expect(child.expires_at).toBeNull();
});
// W194 mint scope-subset rule over the live route
const mintOverHttp = async (
	caller: string,
	scopes: string,
): Promise<Response> => {
	const pair = auth.issueTokens(store, {
		actor: caller,
		token_class: "app-role",
		scopes: ["write_auth", "read_usage"],
		accessTtlMs: 3600_000,
	});
	return fetch(`${URL0}/auth/token`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${pair.access}`,
		},
		body: JSON.stringify({
			actor: "mint:victim",
			token_class: "app-role",
			scopes,
			access_ttl_seconds: 3600,
		}),
	});
};

test("W194 mint rule: a subset request passes (201)", async () => {
	const ok = await mintOverHttp("mint:limited", "read_usage");
	expect(ok.status).toBe(201);
});
test("W194 mint rule: escalation attempts are 403 scope_escalation", async () => {
	const esc = await mintOverHttp("mint:limited2", "buckle:admin");
	expect(esc.status).toBe(403);
	const eb = (await esc.json()) as { error: string };
	expect(eb.error).toBe("scope_escalation");
	const esc2 = await mintOverHttp("mint:limited3", "write_route");
	expect(esc2.status).toBe(403);
});

test("W194 mint rule: buckle:admin still mints anything (bootstrap)", async () => {
	const admin = auth.issueTokens(store, {
		actor: "mint:admin",
		token_class: "app-role",
		scopes: ["buckle:admin"],
		accessTtlMs: 3600_000,
	});
	const r = await fetch(`${URL0}/auth/token`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${admin.access}`,
		},
		body: JSON.stringify({
			actor: "mint:anything",
			token_class: "app-role",
			scopes: ["write_budget", "read_x"],
			access_ttl_seconds: 3600,
		}),
	});
	expect(r.status).toBe(201);
});
test("W194 theft cascade: replayed refresh revokes the family", async () => {
	const p1 = auth.issueTokens(store, {
		actor: "theft:1",
		token_class: "app-role",
		scopes: ["read_x"],
		accessTtlMs: 3600_000,
		refreshTtlMs: null,
	});
	const r1 = auth.rotateRefresh(store, p1.refresh, "test");
	expect(r1.ok).toBe(true);
	if (!r1.ok) return;
	const pre = await auth.verifyJwt(req(r1.access), undefined, { store });
	expect(pre.ok).toBe(true);
	// theft: the ORIGINAL refresh is replayed after the first use
	const replay = auth.rotateRefresh(store, p1.refresh, "test");
	expect(replay.ok).toBe(false);
	if (!replay.ok) {
		expect(replay.code).toBe("refresh_already_used");
		expect(replay.cascade_revoked ?? 0).toBeGreaterThanOrEqual(2);
	}
	const post = await auth.verifyJwt(req(r1.access), undefined, { store });
	expect(post.ok).toBe(false);
	if (!post.ok) expect(post.code).toBe("token_revoked");
	const r2 = auth.rotateRefresh(store, r1.refresh, "test");
	expect(r2.ok).toBe(false);
	if (!r2.ok) expect(r2.code).toBe("token_revoked");
	const ev = store
		.query(
			"SELECT COUNT(*) AS n FROM auth_events WHERE actor = 'theft:1' AND event = 'theft_cascade'",
		)
		.get() as { n: number };
	expect(ev.n).toBe(1);
});
test("W194 theft cascade: the 401 body carries theft_cascade", async () => {
	const p = auth.issueTokens(store, {
		actor: "theft:2",
		token_class: "app-role",
		scopes: ["read_x"],
		accessTtlMs: 3600_000,
	});
	const rot = await fetch(`${URL0}/auth/refresh`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refresh_token: p.refresh }),
	});
	expect(rot.status).toBe(200);
	const replay = await fetch(`${URL0}/auth/refresh`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refresh_token: p.refresh }),
	});
	expect(replay.status).toBe(401);
	const rb = (await replay.json()) as {
		error: string;
		theft_cascade: number;
	};
	expect(rb.error).toBe("refresh_already_used");
	expect(rb.theft_cascade).toBeGreaterThanOrEqual(2);
});
test("W194 JWKS pinning: embedded keys verify fully offline", async () => {
	const tok = signRs256(
		{
			iss: "https://pin-a.invalid",
			aud: "api://buckle",
			sub: "u",
			exp: nowS() + 600,
		},
		RSA.privateKey,
		"k1",
	);
	const r = await auth.verifyJwt(req(tok), undefined, {
		config: {
			issuers: [
				{
					type: "oidc",
					iss: "https://pin-a.invalid",
					jwks: [{ ...PUB_JWK, kid: "k1" }],
					audience: "api://buckle",
				},
			],
		},
		fetchImpl: (async (): Promise<Response> => {
			throw new Error("pinned keys must verify offline");
		}) as typeof fetch,
	});
	expect(r.ok).toBe(true);
});
test("W194 JWKS pinning: jwks_uri fetched directly, discovery skipped", async () => {
	const seen: string[] = [];
	const f = (async (url: string | URL | Request): Promise<Response> => {
		seen.push(String(url));
		return Response.json({ keys: [{ ...PUB_JWK, kid: "k2" }] });
	}) as typeof fetch;
	const tok = signRs256(
		{
			iss: "https://pin-b.invalid",
			aud: "api://buckle",
			sub: "u",
			exp: nowS() + 600,
		},
		RSA.privateKey,
		"k2",
	);
	const r = await auth.verifyJwt(req(tok), undefined, {
		config: {
			issuers: [
				{
					type: "oidc",
					iss: "https://pin-b.invalid",
					jwks_uri: "https://pinned.invalid/jwks",
					audience: "api://buckle",
				},
			],
		},
		fetchImpl: f,
	});
	expect(r.ok).toBe(true);
	expect(seen).toEqual(["https://pinned.invalid/jwks"]);
});
test("W194 JWKS pinning: wrong key against pinned jwks → bad_signature", async () => {
	const { privateKey: other } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const tok = signRs256(
		{
			iss: "https://pin-c.invalid",
			aud: "api://buckle",
			sub: "u",
			exp: nowS() + 600,
		},
		other,
		"k3",
	);
	const r = await auth.verifyJwt(req(tok), undefined, {
		config: {
			issuers: [
				{
					type: "oidc",
					iss: "https://pin-c.invalid",
					jwks: [{ ...PUB_JWK, kid: "k3" }],
					audience: "api://buckle",
				},
			],
		},
		fetchImpl: (async (): Promise<Response> => {
			throw new Error("pinned keys must verify offline");
		}) as typeof fetch,
	});
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.code).toBe("bad_signature");
});
// w194-end
