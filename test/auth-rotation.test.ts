// test/auth-rotation.test.ts — W178: the signing-key ring. Rotation with
// grace windows (old tokens verify until retire_at, then 401 bad_signature),
// the emergency grace-0 kill, rotation-proof opaque refresh tokens, and ring
// file hygiene (0600/0700). HOME is a temp dir set BEFORE the dynamic imports
// (the auth.test.ts pattern).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const REAL_SECRETS = process.env.BUCKLE_SECRETS_HOME;
const REAL_STORE = process.env.GOVERNOR_STORE_URL;
const HOME = mkdtempSync(join(process.cwd(), ".auth-rot-test-home-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");
process.env.GOVERNOR_STORE_URL = "local";

const auth = await import("../hooks/lib/auth.ts");
const govdb = await import("../hooks/lib/govdb.ts");

afterAll(() => {
	auth.resetAuthCache();
	// restore EVERYTHING this file pinned — test files share one process and
	// later files (fleet-board, w159-settle) must not inherit this sandbox.
	// delete-or-assign: env-assigning undefined coerces to "undefined" in bun
	process.env.HOME = REAL_HOME;
	if (REAL_SECRETS === undefined) delete process.env.BUCKLE_SECRETS_HOME;
	else process.env.BUCKLE_SECRETS_HOME = REAL_SECRETS;
	if (REAL_STORE === undefined) delete process.env.GOVERNOR_STORE_URL;
	else process.env.GOVERNOR_STORE_URL = REAL_STORE;
	rmSync(HOME, { recursive: true, force: true });
});

const store = govdb.openStore();
const issue = (actor: string) =>
	auth.issueTokens(store, {
		actor,
		token_class: "app-role",
		scopes: ["buckle:admin"],
		accessTtlMs: 3600_000,
		refreshTtlMs: null,
	});
const req = (tok: string) => ({
	headers: {
		get: (n: string) =>
			n.toLowerCase() === "authorization" ? `Bearer ${tok}` : null,
	},
});

describe("signing-key ring (W178)", () => {
	test("legacy deployment: no ring file, currentSigningKey = the key file", () => {
		expect(auth.loadKeyRing()).toEqual([]);
		expect(auth.currentSigningKey().equals(auth.loadSigningKey())).toBe(true);
	});

	test("rotate adopts the legacy key and mints a current one (0600 files)", () => {
		const r = auth.rotateSigningKey(2000);
		expect(r.retired_kid?.startsWith("adopted-")).toBe(true);
		expect(r.graceUntil ?? 0).toBeGreaterThan(Date.now());
		const ring = auth.loadKeyRing();
		expect(ring.length).toBe(2); // adopted old + new current
		expect(ring.filter((k) => k.retire_at === null).length).toBe(1);
		const st = statSync(join(HOME, "secrets", "buckle-jwt-ring.json"));
		expect((st.mode & 0o777) === 0o600).toBe(true);
	});
});

describe("grace windows", () => {
	test("old token verifies during grace, 401s after retire_at", async () => {
		const pair = issue("lane:grace");
		auth.rotateSigningKey(2000); // 2s grace
		expect(
			(await auth.verifyJwt(req(pair.access), undefined, { store })).ok,
		).toBe(true);
		const post = await auth.verifyJwt(req(pair.access), undefined, {
			store,
			now: () => Date.now() + 5000,
		});
		expect(post.ok).toBe(false);
		if (!post.ok) expect(post.code).toBe("bad_signature");
	});
});

describe("emergency kill + refresh flow", () => {
	test("grace 0 kills old tokens at once; opaque refresh self-heals", async () => {
		const pair = issue("lane:kill");
		const r = auth.rotateSigningKey(0);
		expect(r.graceUntil).toBeNull();
		const dead = await auth.verifyJwt(req(pair.access), undefined, { store });
		expect(dead.ok).toBe(false);
		if (!dead.ok) expect(dead.code).toBe("bad_signature");
		// refresh tokens are opaque — rotation-proof, self-heals under the new key
		const rr = auth.rotateRefresh(store, pair.refresh);
		expect(rr.ok).toBe(true);
		if (!rr.ok) return;
		expect(
			(await auth.verifyJwt(req(rr.access), undefined, { store })).ok,
		).toBe(true);
	});

	test("repeat rotation keeps exactly one CURRENT entry", () => {
		auth.rotateSigningKey(2000);
		const ring = auth.loadKeyRing();
		expect(ring.filter((k) => k.retire_at === null).length).toBe(1);
		// the legacy key file always carries the CURRENT material
		const file = readFileSync(auth.jwtKeyFile(), "utf8").trim();
		const cur = ring.find((k) => k.retire_at === null);
		expect(file).toBe(cur?.material);
	});
});
