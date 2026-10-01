// test/auth.test.ts — W149: the identity layer. Issue/verify round-trips for
// both token classes, forever tokens, single-use rotation with the parent
// chain, revocation by jti/actor/team, scope prefixes + inheritance, Entra-RP
// issuer config (local allowlist + injected-fetch RS256, no network), the
// store-server /auth routes, the auth-client refresher, and the CLI (raw
// tokens never on stdout, key + token files at mode 600).
// HOME is a temp dir set BEFORE the dynamic imports — govdb binds REG at
// module load (the govdb-router-tables.test.ts pattern), and the auth libs
// resolve the secrets home from homedir() per call.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { generateKeyPairSync, createSign } from "node:crypto";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const HOME = mkdtempSync(join(process.cwd(), ".auth-test-home-"));
process.env.HOME = HOME;
// bun caches os.homedir() at process start — the secrets home is env-pinned
// instead (live read in the libs, inherited by spawned servers/CLIs)
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");

// ONE canonical server for the whole file: the test process binds its store
// to it over HTTP (GOVERNOR_STORE_URL), so tokens issued via the lib live in
// the SAME db every spawned server verifies against — immune to the
// module-load REG binding order of govdb when test files share a process.
const procs: ReturnType<typeof Bun.spawn>[] = [];
const REAL_SECRETS = process.env.BUCKLE_SECRETS_HOME;
afterAll(() => {
	for (const p of procs) p.kill();
	auth.resetAuthCache();
	process.env.HOME = REAL_HOME;
	process.env.BUCKLE_SECRETS_HOME = REAL_SECRETS;
	rmSync(HOME, { recursive: true, force: true });
});

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

// W156: the canonical db rides the identity path — auth lib writes land in
// identity.db via /identity, the same statement protocol one path over.
const store = new govdb.HttpGovernorStore(URL0, null, "/identity");
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

// ─── key material + perms ────────────────────────────────────────────────────

describe("signing key", () => {
	test("generated once to the secrets home at mode 600 (dir 700)", () => {
		auth.loadSigningKey();
		const kf = join(HOME, "secrets", "buckle-jwt.key");
		const st = statSync(kf);
		expect((st.mode & 0o777) === 0o600).toBe(true);
		const dir = statSync(join(HOME, "secrets"));
		expect((dir.mode & 0o777) === 0o700).toBe(true);
		const first = auth.loadSigningKey();
		auth.resetAuthCache();
		const second = auth.loadSigningKey();
		expect(first.equals(second)).toBe(true); // stable across cache resets
	});
});
// ─── issue/verify round-trips ────────────────────────────────────────────────

describe("issue/verify round-trips", () => {
	test("app-role machine token verifies with its claims", async () => {
		const pair = auth.issueTokens(store, {
			actor: "lane:w149",
			token_class: "app-role",
			scopes: ["read_route_audit", "write_budget"],
			accessTtlMs: 3600_000,
			refreshTtlMs: null,
		});
		const r = await auth.verifyJwt(req(pair.access), undefined, { store });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.claims.sub).toBe("lane:w149");
		expect(r.claims.token_class).toBe("app-role");
		expect(r.claims.scopes).toEqual(["read_route_audit", "write_budget"]);
		expect(r.claims.iss).toBe(auth.LOCAL_ISSUER);
	});
});
describe("issue/verify round-trips (more)", () => {
	test("delegated (user) class round-trips", async () => {
		const pair = auth.issueTokens(store, {
			actor: "demo:verify",
			token_class: "delegated",
			scopes: ["read_usage"],
			accessTtlMs: 3600_000,
			refreshTtlMs: null,
		});
		const r = await auth.verifyJwt(req(pair.access), undefined, { store });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.claims.token_class).toBe("delegated");
		expect(r.claims.team).toBeNull();
	});

	test("forever token: no exp claim, row expires_at NULL, verifies at now+10y", async () => {
		const pair = auth.issueTokens(store, {
			actor: "klh-verify",
			token_class: "app-role",
			scopes: ["buckle:admin"],
			accessTtlMs: 0,
			refreshTtlMs: 0,
		});
		const decoded = auth.decodeJwtUnverified(pair.access);
		expect(decoded?.exp ?? null).toBeNull();
		const row = store
			.query("SELECT expires_at FROM api_keys WHERE jti = ?")
			.get(pair.jti) as { expires_at: number | null };
		expect(row.expires_at).toBeNull();
		const r = await auth.verifyJwt(req(pair.access), undefined, {
			store,
			now: () => Date.now() + 315_360_000_000,
		});
		expect(r.ok).toBe(true);
	});
});
describe("tamper + expiry", () => {
	test("tampered JWT rejected (bad_signature)", async () => {
		const pair = auth.issueTokens(store, {
			actor: "tamper:1",
			token_class: "app-role",
			scopes: ["read_x"],
			accessTtlMs: 3600_000,
		});
		const bad = `${pair.access.slice(0, -2)}xx`;
		const r = await auth.verifyJwt(req(bad), undefined, { store });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.status).toBe(401);
		expect(r.code).toBe("bad_signature");
	});

	test("expired access → 401 token_expired with the renew flag", async () => {
		const pair = auth.issueTokens(store, {
			actor: "exp:1",
			token_class: "app-role",
			scopes: ["read_x"],
			accessTtlMs: -1000, // already expired
		});
		const r = await auth.verifyJwt(req(pair.access), undefined, { store });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.code).toBe("token_expired");
		expect(r.renew).toBe(true);
	});
});
describe("scope prefixes + inheritance", () => {
	test("write_X implies read_X; admin implies all; roles match exactly", () => {
		expect(auth.scopeSatisfies(["write_route"], "read_route")).toBe(true);
		expect(auth.scopeSatisfies(["read_route"], "write_route")).toBe(false);
		expect(auth.scopeSatisfies(["buckle:admin"], "write_auth")).toBe(true);
		expect(
			auth.scopeSatisfies(["buckle:router:admin"], "buckle:router:admin"),
		).toBe(true);
		expect(auth.scopeSatisfies(["buckle:router:admin"], "read_router")).toBe(
			false,
		);
	});

	test("verifyJwt enforces requiredScope (403 insufficient_scope)", async () => {
		const pair = auth.issueTokens(store, {
			actor: "scope:1",
			token_class: "app-role",
			scopes: ["read_route"],
			accessTtlMs: 3600_000,
		});
		const okRead = await auth.verifyJwt(req(pair.access), "read_route", {
			store,
		});
		expect(okRead.ok).toBe(true);
		const okViaWrite = await auth.verifyJwt(req(pair.access), "write_route", {
			store,
		});
		expect(okViaWrite.ok).toBe(false);
		if (!okViaWrite.ok) expect(okViaWrite.code).toBe("insufficient_scope");
		const okStatus = okViaWrite.ok ? null : okViaWrite.status;
		expect(okStatus).toBe(403);
	});

	test("scopeCheck array semantics: all-of", () => {
		expect(auth.scopeCheck(["write_x", "read_y"], ["read_x", "read_y"])).toBe(
			true,
		);
		expect(auth.scopeCheck(["read_x"], ["read_x", "read_y"])).toBe(false);
	});
});
describe("rotation (single-use)", () => {
	test("rotate mints a parented pair, stamps rotated_at, replay rejected", async () => {
		const actor = "rot:1";
		const p1 = auth.issueTokens(store, {
			actor,
			token_class: "app-role",
			scopes: ["read_a"],
			accessTtlMs: 3600_000,
			refreshTtlMs: null,
		});
		const oldRefreshRow = store
			.query("SELECT key_id FROM api_keys WHERE jti = ?")
			.get(p1.refresh_jti) as { key_id: string };
		const r1 = auth.rotateRefresh(store, p1.refresh, "test");
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		// old refresh stamped, new refresh parented on it
		const oldRow = store
			.query("SELECT rotated_at FROM api_keys WHERE jti = ?")
			.get(p1.refresh_jti) as { rotated_at: number | null };
		expect(oldRow.rotated_at).not.toBeNull();
		const newRefreshRow = store
			.query("SELECT parent_key_id FROM api_keys WHERE jti = ?")
			.get(r1.refresh_jti) as { parent_key_id: string | null };
		expect(newRefreshRow.parent_key_id).toBe(oldRefreshRow.key_id);
		// the rotated-in access token verifies
		const v = await auth.verifyJwt(req(r1.access), undefined, { store });
		expect(v.ok).toBe(true);
		// single-use: replaying the OLD refresh is rejected
		const replay = auth.rotateRefresh(store, p1.refresh, "test");
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.code).toBe("refresh_already_used");
	});

	test("delegated class survives rotation; revoked refresh rejected", async () => {
		const p = auth.issueTokens(store, {
			actor: "rot:2",
			token_class: "delegated",
			scopes: ["read_b"],
			accessTtlMs: 3600_000,
			refreshTtlMs: null,
		});
		const r = auth.rotateRefresh(store, p.refresh, "test");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const v = await auth.verifyJwt(req(r.access), undefined, { store });
		if (v.ok) expect(v.claims.token_class).toBe("delegated");
		auth.revoke(store, { jti: r.refresh_jti }, "test");
		const again = auth.rotateRefresh(store, r.refresh, "test");
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.code).toBe("token_revoked");
	});
});
describe("revocation", () => {
	test("by jti — token fails verification immediately", async () => {
		const pair = auth.issueTokens(store, {
			actor: "rev:jti",
			token_class: "app-role",
			scopes: ["read_c"],
			accessTtlMs: 3600_000,
		});
		const before = await auth.verifyJwt(req(pair.access), undefined, { store });
		expect(before.ok).toBe(true);
		const out = auth.revoke(store, { jti: pair.jti }, "test");
		expect(out.changes).toBeGreaterThanOrEqual(1);
		const after = await auth.verifyJwt(req(pair.access), undefined, { store });
		expect(after.ok).toBe(false);
		if (!after.ok) expect(after.code).toBe("token_revoked");
	});

	test("by actor — every row of the actor dies", async () => {
		const mk = () =>
			auth.issueTokens(store, {
				actor: "rev:actor",
				token_class: "app-role",
				scopes: ["read_c"],
				accessTtlMs: 3600_000,
			});
		mk();
		mk();
		const out = auth.revoke(store, { actor: "rev:actor" }, "test");
		expect(out.changes).toBeGreaterThanOrEqual(4);
		const rows = store
			.query(
				"SELECT COUNT(*) AS n FROM api_keys WHERE actor = 'rev:actor' AND revoked_at IS NULL",
			)
			.get() as { n: number };
		expect(rows.n).toBe(0);
	});

	test("by team", async () => {
		auth.issueTokens(store, {
			actor: "rev:team-a",
			team: "revteam",
			token_class: "app-role",
			scopes: ["read_c"],
			accessTtlMs: 3600_000,
		});
		auth.issueTokens(store, {
			actor: "rev:team-b",
			team: "revteam",
			token_class: "app-role",
			scopes: ["read_c"],
			accessTtlMs: 3600_000,
		});
		auth.revoke(store, { team: "revteam" }, "test");
		const rows = store
			.query(
				"SELECT COUNT(*) AS n FROM api_keys WHERE team = 'revteam' AND revoked_at IS NULL",
			)
			.get() as { n: number };
		expect(rows.n).toBe(0);
	});
});
// ─── Entra RP mode: issuer allowlist + injected-fetch RS256 ─────────────────

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
// shared Entra test material — module level so the RS256 describe can use it
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB_JWK = RSA.publicKey.export({ format: "jwk" }) as Record<
	string,
	unknown
>;
const ISS_ENTRA = "https://login.microsoftonline.com/test-tenant/v2.0";
const ENTRA_FETCH = (async (url: string | URL | Request): Promise<Response> => {
	const u = String(url);
	if (u.includes("openid-configuration"))
		return Response.json({
			jwks_uri: "https://example.invalid/jwks",
			issuer: ISS_ENTRA,
		});
	return Response.json({ keys: [PUB_JWK] });
}) as typeof fetch;

describe("Entra RP issuer config", () => {
	test("unknown issuer → 401 issuer_not_allowed", async () => {
		const pair = auth.issueTokens(store, {
			actor: "entra:x",
			token_class: "app-role",
			scopes: [],
			accessTtlMs: 3600_000,
		});
		const r = await auth.verifyJwt(req(pair.access), undefined, {
			config: { issuers: [{ type: "local", iss: "some-other-issuer" }] },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("issuer_not_allowed");
	});
});
describe("Entra RP RS256 via injected fetch", () => {
	test("external IdP token verifies (discovery + JWKS + audience + roles)", async () => {
		const now = Math.floor(Date.now() / 1000);
		const tok = signRs256(
			{
				iss: ISS_ENTRA,
				aud: "api://buckle",
				sub: "user@tenant",
				roles: ["buckle.admin"],
				exp: now + 600,
			},
			RSA.privateKey,
			"kid-1",
		);
		const r = await auth.verifyJwt(req(tok), undefined, {
			config: {
				issuers: [
					{
						type: "oidc",
						iss: ISS_ENTRA,
						discovery:
							"https://example.invalid/.well-known/openid-configuration",
						audience: "api://buckle",
						roles: ["buckle.admin"],
					},
				],
			},
			fetchImpl: ENTRA_FETCH,
		});
		expect(r.ok).toBe(true);
	});
});
describe("Entra RP RS256 negative paths", () => {
	const CFG = {
		issuers: [
			{
				type: "oidc" as const,
				iss: ISS_ENTRA,
				discovery: "https://example.invalid/.well-known/openid-configuration",
				audience: "api://buckle",
				roles: ["buckle.admin"],
			},
		],
	};
	test("wrong signing key → 401 bad_signature", async () => {
		const now = Math.floor(Date.now() / 1000);
		const { privateKey: other } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const bad = signRs256(
			{
				iss: ISS_ENTRA,
				aud: "api://buckle",
				sub: "u",
				roles: ["buckle.admin"],
				exp: now + 600,
			},
			other,
			"kid-1",
		);
		const r = await auth.verifyJwt(req(bad), undefined, {
			config: CFG,
			fetchImpl: ENTRA_FETCH,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("bad_signature");
	});

	test("missing required role → 403 missing_role", async () => {
		const now = Math.floor(Date.now() / 1000);
		const noRole = signRs256(
			{
				iss: ISS_ENTRA,
				aud: "api://buckle",
				sub: "u",
				roles: ["something.else"],
				exp: now + 600,
			},
			RSA.privateKey,
			"kid-1",
		);
		const r = await auth.verifyJwt(req(noRole), undefined, {
			config: CFG,
			fetchImpl: ENTRA_FETCH,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("missing_role");
	});
});
// ─── live server: /auth routes + auth-client refresher + CLI ─────────────────

describe("/auth routes on the live store server", () => {
	const url = URL0;

	test("whoami without token → 401 hypermedia", async () => {
		const r = await fetch(`${url}/auth/whoami`);
		expect(r.status).toBe(401);
		const b = (await r.json()) as { error: string; agent_next_steps: string };
		expect(b.error).toBe("missing_token");
		expect(b.agent_next_steps).toContain("auth/token");
	});

	test("admin issues a pair via POST /auth/token; refresh rotation + replay 401 over HTTP", async () => {
		// bootstrap admin via the lib (the documented loopback-trust path)
		const admin = auth.issueTokens(store, {
			actor: "admin:boot",
			token_class: "app-role",
			scopes: ["buckle:admin"],
			accessTtlMs: 0,
			refreshTtlMs: 0,
		});
		const res = await fetch(`${url}/auth/token`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${admin.access}`,
			},
			body: JSON.stringify({
				actor: "demo:alice",
				token_class: "delegated",
				team: "demo",
				scopes: ["read_usage"],
				access_ttl_seconds: 2592000,
				refresh_ttl_seconds: 0,
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			access_token: string;
			refresh_token: string;
			jti: string;
			refresh_jti: string;
		};
		const who = await fetch(`${url}/auth/whoami`, {
			headers: { authorization: `Bearer ${body.access_token}` },
		});
		expect(who.status).toBe(200);
		const wb = (await who.json()) as { actor: string; token_class: string };
		expect(wb.actor).toBe("demo:alice");
		expect(wb.token_class).toBe("delegated");
		const rot = await fetch(`${url}/auth/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: body.refresh_token }),
		});
		expect(rot.status).toBe(200);
		const rotB = (await rot.json()) as { refresh_token: string };
		const replay = await fetch(`${url}/auth/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: body.refresh_token }),
		});
		expect(replay.status).toBe(401);
		const replayB = (await replay.json()) as { error: string };
		expect(replayB.error).toBe("refresh_already_used");
		expect(rotB.refresh_token).toBeTruthy();
	});
});
describe("/auth revoke + expired-token renew hint (live)", () => {
	const url = URL0;

	test("expired access → 401 with x-auth-renew header + refresh_endpoint body", async () => {
		const short = auth.issueTokens(store, {
			actor: "live:short",
			token_class: "app-role",
			scopes: ["read_x"],
			accessTtlMs: -1000,
		});
		const r = await fetch(`${url}/auth/whoami`, {
			headers: { authorization: `Bearer ${short.access}` },
		});
		expect(r.status).toBe(401);
		expect(r.headers.get("x-auth-renew")).toBe("/auth/refresh");
		const b = (await r.json()) as { error: string; refresh_endpoint: string };
		expect(b.error).toBe("token_expired");
		expect(b.refresh_endpoint).toBe("/auth/refresh");
	});

	test("revoke by jti → whoami 401 token_revoked; non-admin cannot revoke", async () => {
		const pair = auth.issueTokens(store, {
			actor: "live:rev",
			token_class: "app-role",
			scopes: ["read_x"],
			accessTtlMs: 3600_000,
		});
		const admin = auth.issueTokens(store, {
			actor: "admin:rev",
			token_class: "app-role",
			scopes: ["buckle:admin"],
			accessTtlMs: 3600_000,
		});
		const deny = await fetch(`${url}/auth/revoke`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${pair.access}`,
			},
			body: JSON.stringify({ jti: pair.jti }),
		});
		expect(deny.status).toBe(403);
		const ok = await fetch(`${url}/auth/revoke`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${admin.access}`,
			},
			body: JSON.stringify({ jti: pair.jti }),
		});
		expect(ok.status).toBe(200);
		const out = (await ok.json()) as { changes: number };
		expect(out.changes).toBeGreaterThanOrEqual(1);
		const after = await fetch(`${url}/auth/whoami`, {
			headers: { authorization: `Bearer ${pair.access}` },
		});
		expect(after.status).toBe(401);
		const ab = (await after.json()) as { error: string };
		expect(ab.error).toBe("token_revoked");
	});
});
describe("auth-client refresher (live)", () => {
	const url = URL0;

	test("401 → refresh → retry once; proactive refresh inside the 60s skew", async () => {
		const pair = auth.issueTokens(store, {
			actor: "client:1",
			token_class: "app-role",
			scopes: ["read_x"],
			accessTtlMs: 30_000,
			refreshTtlMs: null,
		});
		let refreshed = 0;
		const call = client.authFetch({
			baseUrl: url,
			access: pair.access,
			refresh: pair.refresh,
			onRefresh: () => {
				refreshed++;
			},
		});
		// 30s TTL < 60s skew → proactive refresh fires BEFORE the first send;
		// the old refresh must already be rotated (single-use)
		const r = await call("/auth/whoami");
		expect(r.status).toBe(200);
		expect(refreshed).toBe(1);
		// rotation events landed for the proactive refresh
		const ev = store
			.query(
				"SELECT COUNT(*) AS n FROM auth_events WHERE actor = 'client:1' AND event = 'rotated'",
			)
			.get() as { n: number };
		expect(ev.n).toBeGreaterThanOrEqual(1);
	});

	test("decodeExp + saveTokenFiles/loadTokenFiles round trip (600)", () => {
		const pair = auth.issueTokens(store, {
			actor: "client:files",
			token_class: "app-role",
			scopes: [],
			accessTtlMs: 3600_000,
		});
		client.saveTokenFiles("t-client", {
			access: pair.access,
			refresh: pair.refresh,
		});
		const st = statSync(`${client.tokenFileBase("t-client")}.token`);
		expect((st.mode & 0o777) === 0o600).toBe(true);
		const back = client.loadTokenFiles("t-client");
		expect(back?.access).toBe(pair.access);
		expect(back?.refresh).toBe(pair.refresh);
		expect(client.decodeExp(pair.access)).toBeGreaterThan(0);
		expect(client.decodeExp("not-a-jwt")).toBeNull();
	});
});
describe("auth CLI", () => {
	const bin = join(import.meta.dir, "..", "hooks", "bin", "auth.ts");
	const run = (args: string[]): { code: number; out: string; err: string } => {
		const p = Bun.spawnSync(["bun", bin, ...args], {
			env: { ...process.env, HOME, NO_COLOR: "1", GOVERNOR_STORE_URL: "local" },
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};

	test("issue --save writes 600 files and never prints raw tokens", () => {
		const r = run([
			"issue",
			"--actor",
			"cli:1",
			"--class",
			"delegated",
			"--scopes",
			"read_x",
			"--access-ttl-days",
			"30",
			"--refresh-ttl-days",
			"0",
			"--save",
			"t-cli",
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("issued pair for cli:1");
		const tok = client.loadTokenFiles("t-cli");
		expect(tok).not.toBeNull();
		expect(r.out.includes(tok?.access ?? "")).toBe(false);
		expect(r.out.includes(tok?.refresh ?? "")).toBe(false);
		const st = statSync(`${client.tokenFileBase("t-cli")}.refresh`);
		expect((st.mode & 0o777) === 0o600).toBe(true);
	});

	test("list shows rows without hashes; forever rendered", () => {
		const r = run(["list"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("forever");
		expect(r.out.includes("key_hash")).toBe(false);
	});

	test("revoke --actor works", () => {
		const i = run([
			"issue",
			"--actor",
			"cli:rev",
			"--class",
			"app-role",
			"--scopes",
			"read_x",
			"--access-ttl-days",
			"1",
			"--refresh-ttl-days",
			"1",
		]);
		expect(i.code).toBe(0);
		const r = run(["revoke", "--actor", "cli:rev"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("revoked");
	});
});
