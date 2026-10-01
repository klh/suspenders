// console-login.test.ts — W175: console session + OIDC login + live actor
// switch + my-spend. Unit: session crypto, oidc plumbing, id_token verify
// (real RSA JWKS via stubbed fetch), budget/usage queries on a temp db.
// HTTP: the routes against a real board on a throwaway port (temp HOME).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HOME is a temp dir set BEFORE the dynamic imports below — govdb binds the
// db path at module load, so the test process must never import it with the
// real HOME (auth.test.ts pattern; a static import would hit the live db).
const REAL_HOME = process.env.HOME;
const REAL_SECRETS = process.env.BUCKLE_SECRETS_HOME;
const HOME = mkdtempSync(join(process.cwd(), ".w175-test-home-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");

const { clearCookieHeader, cookieHeader, parseCookies, readValue, signValue } =
	await import("../hooks/lib/console-session.ts");
const {
	authorizeUrl,
	discoveryUrl,
	exchangeCode,
	oidcConfig,
	oidcDiscover,
	pkce,
} = await import("../hooks/lib/console-oidc.ts");
const { verifyIdToken, resetAuthCache } = await import("../hooks/lib/auth.ts");
const { openGovernorDb } = await import("../hooks/lib/govdb.ts");
const { actorAuthEvents, actorBudgets, actorUsage } = await import(
	"../hooks/board/console-view.ts"
);

mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
const REPO = mkdtempSync(join(tmpdir(), "w175-repo-"));
const PORT = 7892;
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
	...process.env,
	HOME,
	SUSPENDERS_MDNS: "0",
	SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
};
const bin = join(import.meta.dir, "..", "hooks", "bin");
const proc = Bun.spawn(
	["bun", join(bin, "fleet-board.ts"), "--port", String(PORT)],
	{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${BASE}/api/data`)).ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error("login test board did not start");
}
beforeAll(async () => {
	await waitUp();
});

afterAll(async () => {
	proc.kill();
	await proc.exited;
	process.env.HOME = REAL_HOME;
	process.env.BUCKLE_SECRETS_HOME = REAL_SECRETS;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const postJson = (path: string, body: unknown): Promise<Response> =>
	fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", host: `127.0.0.1:${PORT}` },
		body: JSON.stringify(body),
	});

describe("console session crypto (W175)", () => {
	test("sign/read round-trip; tamper and expiry rejected", () => {
		const v = signValue({ a: "x", exp: Math.floor(Date.now() / 1000) + 60 });
		expect(readValue<{ a: string }>(v)?.a).toBe("x");
		expect(readValue(`${v}z`)).toBe(null);
		expect(readValue(signValue({ exp: 1 }))).toBe(null);
		expect(readValue(undefined)).toBe(null);
	});
	test("parseCookies + cookieHeader + clear shapes", () => {
		const h = cookieHeader("cbsess", "v a/l", 60);
		expect(h).toContain("HttpOnly");
		expect(h).toContain("SameSite=Lax");
		const clear = clearCookieHeader("cbsess");
		expect(clear).toContain("Max-Age=0");
		const map = parseCookies("a=1; cbsess=v%20x; bad; =3");
		expect(map.a).toBe("1");
		expect(map.cbsess).toBe("v x");
	});
});

describe("oidc plumbing (stub issuer)", () => {
	const disc = {
		authorization_endpoint: "https://idp.test/auth",
		token_endpoint: "https://idp.test/token",
		jwks_uri: "https://idp.test/jwks",
	};
	const stubFetch = async (_url: string | URL): Promise<Response> =>
		new Response(JSON.stringify(disc), {
			headers: { "content-type": "application/json" },
		});
	test("oidcConfig: both knobs or neither", () => {
		expect(
			oidcConfig({ oidc_issuer: "https://i/", oidc_client_id: "c" }),
		).toEqual({ issuer: "https://i/", clientId: "c" });
		expect(oidcConfig({ oidc_issuer: "https://i/" })).toBe(null);
		expect(oidcConfig(null)).toBe(null);
	});
	test("discovery + pkce + authorizeUrl + exchange", async () => {
		resetAuthCache();
		const eps = await oidcDiscover(
			{ issuer: "https://i.test/", clientId: "c" },
			stubFetch,
		);
		expect(eps.authorization_endpoint).toBe("https://idp.test/auth");
		expect(discoveryUrl("https://i.test")).toBe(
			"https://i.test/.well-known/openid-configuration",
		);
		const p = pkce();
		const sha = createHash("sha256").update(p.verifier).digest("base64url");
		expect(p.challenge).toBe(sha);
		const url = authorizeUrl({
			endpoints: eps,
			clientId: "c",
			redirectUri: "http://b/console/callback",
			state: "s",
			challenge: p.challenge,
			nonce: "n",
		});
		expect(url).toContain("code_challenge_method=S256");
		const tok = await exchangeCode({
			endpoints: eps,
			clientId: "c",
			redirectUri: "r",
			code: "k",
			verifier: p.verifier,
			fetchImpl: async () =>
				new Response(JSON.stringify({ id_token: "t.t.t" })),
		});
		expect(tok.ok).toBe(true);
		const bad = await exchangeCode({
			endpoints: eps,
			clientId: "c",
			redirectUri: "r",
			code: "k",
			verifier: p.verifier,
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: "denied" }), { status: 400 }),
		});
		expect(bad.ok).toBe(false);
	});
});

describe("verifyIdToken (real RSA trust chain)", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
	const now = Math.floor(Date.now() / 1000);
	const b64u = (o: unknown): string =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	const signRs256 = (payload: Record<string, unknown>): string => {
		const head = Buffer.from(
			JSON.stringify({ alg: "RS256", typ: "JWT" }),
		).toString("base64url");
		const data = `${head}.${b64u(payload)}`;
		const sig = createSign("RSA-SHA256")
			.update(data)
			.sign(privateKey, "base64url" as BinaryToTextEncoding);
		return `${data}.${sig}`;
	};
	const disc = {
		authorization_endpoint: "https://auth.test/auth",
		token_endpoint: "https://auth.test/token",
		jwks_uri: "https://auth.test/jwks",
	};
	const stub = async (url: string | URL): Promise<Response> => {
		const u = String(url);
		if (u.includes("openid-configuration"))
			return new Response(JSON.stringify(disc));
		if (u.includes("jwks"))
			return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }));
		throw new Error(`stub got ${u}`);
	};
	test("accepts a good token; rejects wrong iss/aud/exp/nonce/tamper", async () => {
		resetAuthCache();
		const expected = {
			iss: "https://auth.test",
			audience: "c1",
			discovery: discoveryUrl("https://auth.test"),
		};
		const good = signRs256({
			iss: "https://auth.test",
			aud: "c1",
			sub: "u1",
			preferred_username: "klaus",
			exp: now + 300,
			iat: now,
		});
		const okRes = await verifyIdToken(good, { ...expected, fetchImpl: stub });
		expect(okRes.ok).toBe(true);
		if (okRes.ok) expect(okRes.username).toBe("klaus");
		const badIss = signRs256({
			iss: "https://evil.test",
			aud: "c1",
			sub: "u",
			exp: now + 300,
		});
		expect(
			(await verifyIdToken(badIss, { ...expected, fetchImpl: stub })).ok,
		).toBe(false);
		const badAud = signRs256({
			iss: "https://auth.test",
			aud: "other",
			sub: "u",
			exp: now + 300,
		});
		expect(
			(await verifyIdToken(badAud, { ...expected, fetchImpl: stub })).ok,
		).toBe(false);
		const expired = signRs256({
			iss: "https://auth.test",
			aud: "c1",
			sub: "u",
			exp: now - 10,
		});
		expect(
			(await verifyIdToken(expired, { ...expected, fetchImpl: stub })).ok,
		).toBe(false);
		const nonceTok = signRs256({
			iss: "https://auth.test",
			aud: "c1",
			sub: "u",
			exp: now + 300,
			nonce: "n1",
		});
		expect(
			(
				await verifyIdToken(nonceTok, {
					...expected,
					nonce: "n2",
					fetchImpl: stub,
				})
			).ok,
		).toBe(false);
		expect(
			(
				await verifyIdToken(nonceTok, {
					...expected,
					nonce: "n1",
					fetchImpl: stub,
				})
			).ok,
		).toBe(true);
		const tampered = good.replace(/\.[^.]+$/, ".JUNKJUNK");
		expect(
			(await verifyIdToken(tampered, { ...expected, fetchImpl: stub })).ok,
		).toBe(false);
	});
});

describe("my-spend data (temp db)", () => {
	const db = openGovernorDb();
	const now = Date.now();
	test("actorUsage/actorBudgets/actorAuthEvents", () => {
		db.query(
			"INSERT INTO sessions (sid, project, role, started_at, hb, state, actor) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run("ls1", "p", "worker", now, now, "RUNNING", "spend-user");
		db.query(
			"INSERT OR REPLACE INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?,?,?,?,?,?,?,?,?)",
		).run(
			now - 3600_000,
			"spend-user",
			"glm-5.3-flash",
			"flash",
			100,
			200,
			50,
			50,
			3,
		);
		db.query(
			"INSERT INTO api_keys (key_id, key_hash, name, team, actor, token_type, scopes, rpm_limit, tpm_limit, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
		).run(
			"spend-key",
			"h",
			JSON.stringify({ label: "my key", class: "app-role" }),
			"eng",
			"spend-user",
			"access",
			"[]",
			60,
			90000,
			now,
		);
		db.query(
			"INSERT INTO budget_state (key_id, window, used_rpm, used_tpm, window_start) VALUES (?,?,?,?,?)",
		).run("spend-key", "minute", 4, 900, now);
		db.query(
			"INSERT INTO auth_events (ts, actor, event, via) VALUES (?,?,?,?)",
		).run(now, "spend-user", "issued", "cli:auth.ts");
		const u = actorUsage(db, "spend-user", 28, now);
		expect(u.tokens).toBe(400);
		expect(u.requests).toBe(3);
		expect(u.byModel[0]?.model).toBe("glm-5.3-flash");
		const b = actorBudgets(db, "spend-user");
		expect(b[0]?.label).toBe("my key");
		expect(b[0]?.rows[0]?.used_rpm).toBe(4);
		const e = actorAuthEvents(db, "spend-user");
		expect(e[0]?.event).toBe("issued");
	});
});

describe("console routes (real board)", () => {
	test("/api/console/me + login unconfigured card", async () => {
		const me = (await (await fetch(`${BASE}/api/console/me`)).json()) as Record<
			string,
			unknown
		>;
		expect(me.ok).toBe(true);
		expect("user" in me).toBe(true);
		expect("has_login" in me).toBe(true);
		const login = await (await fetch(`${BASE}/console/login`)).text();
		expect(login).toContain("No identity provider configured");
	});
	test("live actor switch: 400 on unknown, 200 + cookie + ledger on known", async () => {
		const bad = await postJson("/console/actor", { actor: "nope" });
		expect(bad.status).toBe(400);
		const bl = (await bad.json()) as { actors: string[] };
		expect(Array.isArray(bl.actors)).toBe(true);
		const { spawnSync } = await import("node:child_process");
		spawnSync(
			"bun",
			[
				join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
				"bootstrap",
				"--as",
				"login-lane",
				"--actor",
				"klaus",
			],
			{ env: { ...process.env, HOME } },
		);
		const r = await postJson("/console/actor", { actor: "klaus" });
		expect(r.status).toBe(200);
		const sc = r.headers.get("set-cookie") ?? "";
		expect(sc).toStartWith("cbsess=");
		const me = (await (
			await fetch(`${BASE}/api/console/me`, {
				headers: { cookie: sc.split(";")[0] },
			})
		).json()) as Record<string, unknown>;
		expect(me.actor).toBe("klaus");
	});
	test("spend page renders for the switched actor", async () => {
		const v = signValue({
			actor: "klaus",
			exp: Math.floor(Date.now() / 1000) + 600,
		});
		const html = await (
			await fetch(`${BASE}/console/spend`, {
				headers: { cookie: `cbsess=${v}` },
			})
		).text();
		expect(html).toContain("MY SPEND · klaus");
		expect(html).toContain("identity ledger");
	});
});
