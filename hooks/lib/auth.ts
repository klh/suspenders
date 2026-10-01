// hooks/lib/auth.ts — W149 identity layer: HS256 JWT issue/verify over the
// v8 api_keys + auth_events tables (finding.w132-router-tables conventions).
//
// Two token classes (the adopted convention):
//   app-role   — machines (lanes, local LLM services); the client-credentials
//                equivalent. Non-interactive.
//   delegated  — users. Owner: forever access + forever refresh (expires_at
//                NULL). Users: access 30d, refresh NULL = rotate-forever.
//
// Scope naming: `buckle:<resource>:<role>` for roles (exact match),
// `read_<res>`/`write_<res>` coarse scopes with inheritance (write_X implies
// read_X), `buckle:admin` = satisfies everything.
//
// Issuer model (Entra-RP ready, config-only): verifyJwt matches the token's
// `iss` against a config allowlist. Absent config = our own issuer only.
// An oidc-type entry (discovery URL, audience, roles claim) validates an
// external IdP token the way buckle's validate-jwt does — discovery → JWKS →
// RS256, audience, roles — with zero Entra calls in tests (fetchImpl inject).
//
// KEY MATERIAL LAW: the signing key lives at ~/.claude/local-llm/buckle-jwt.key
// (mode 600, the sanctioned secrets home), referenced from config by
// ENV-NAME ONLY (BUCKLE_JWT_KEY_FILE overrides the path). No key value is
// ever embedded here, logged, or committed; fingerprints only.
import {
	createHash,
	createHmac,
	createPublicKey,
	randomBytes,
	randomUUID,
	timingSafeEqual,
	verify as cryptoVerify,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "./govdb.ts";

export const LOCAL_ISSUER = "buckle";
const AUDIENCE = "buckle";

export type TokenClass = "app-role" | "delegated";

export interface JwtClaims {
	sub: string;
	team: string | null;
	scopes: string[];
	token_class: TokenClass;
	jti: string;
	iat: number; // seconds
	exp: number | null; // seconds; null/absent = forever
	aud: string;
	iss: string;
}
// ─── signing key ─────────────────────────────────────────────────────────────

// the sanctioned secrets home; BUCKLE_SECRETS_HOME overrides (tests, crates).
// Env read is LIVE every call — bun caches os.homedir() at process start, so
// runtime HOME mutation does NOT move this; the env override does.
export function secretsHome(): string {
	return (
		process.env.BUCKLE_SECRETS_HOME ?? join(homedir(), ".claude", "local-llm")
	);
}

export function jwtKeyFile(): string {
	return (
		process.env.BUCKLE_JWT_KEY_FILE ?? join(secretsHome(), "buckle-jwt.key")
	);
}

let cachedKey: { path: string; key: Buffer } | null = null;

// load-or-create, self-healing perms to 0600 on every load. The dir gets 0700.
export function loadSigningKey(): Buffer {
	const path = jwtKeyFile();
	if (cachedKey?.path === path) return cachedKey.key;
	if (!existsSync(path)) {
		mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, {
			mode: 0o600,
		});
	}
	chmodSync(path, 0o600);
	const raw = readFileSync(path, "utf8").trim();
	const key = /^[0-9a-f]{64}$/i.test(raw)
		? Buffer.from(raw, "hex")
		: Buffer.from(raw, "utf8");
	cachedKey = { path, key };
	return key;
}

let cachedRing: { path: string; ring: RingKey[] } | null = null;

// test seam: drop the module-level key caches (fresh key file per test HOME)
export function resetAuthCache(): void {
	cachedKey = null;
	cachedRing = null;
}

// ─── signing-key ring (W178 rotation + grace) ────────────────────────────────
// buckle-jwt-ring.json (0600, secrets home) is the JWKS analog for the HS256
// local issuer: retired keys stay loadable through a grace window so rotation
// never breaks live tokens. The legacy buckle-jwt.key file remains the on-disk
// home of the CURRENT material — rotation rewrites it, so pre-ring readers
// (an unrestarted server) adopt the new key too.
export interface RingKey {
	kid: string;
	material: string; // hex
	created_at: number; // ms
	retire_at: number | null; // ms; null = the current signing key
}

const ringFile = (): string => join(secretsHome(), "buckle-jwt-ring.json");

export function loadKeyRing(): RingKey[] {
	const path = ringFile();
	if (cachedRing?.path === path) return cachedRing.ring;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			keys: RingKey[];
		};
		cachedRing = { path, ring: parsed.keys };
		return parsed.keys;
	} catch {
		return []; // no ring yet — legacy single-key deployment
	}
}

function writeKeyRing(ring: RingKey[]): void {
	const path = ringFile();
	mkdirSync(secretsHome(), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ keys: ring }, null, "\t")}\n`, {
		mode: 0o600,
	});
	cachedRing = { path, ring };
}

// the key we sign with: the ring's live entry, else the legacy key file
export function currentSigningKey(): Buffer {
	const live = loadKeyRing().filter((k) => k.retire_at === null);
	if (live.length)
		return Buffer.from(
			live.reduce((a, b) => (b.created_at > a.created_at ? b : a)).material,
			"hex",
		);
	return loadSigningKey();
}

// rotate: mint a new key, retire the old at now + graceMs (rehearsed W178 —
// JWKS overlap convention). graceMs 0 = emergency kill: every token signed by
// the old key fails signature at once. Refresh tokens are opaque (not signed)
// and rotation-proof — clients self-heal via /auth/refresh.
export function rotateSigningKey(graceMs = 86_400_000): {
	kid: string;
	retired_kid: string | null;
	graceUntil: number | null;
} {
	const now = Date.now();
	const prev = loadKeyRing();
	const live = prev.filter((k) => k.retire_at === null);
	const ring = prev.map((k) =>
		k.retire_at === null ? { ...k, retire_at: now + graceMs } : k,
	);
	let adoptedKid: string | null = null;
	if (!prev.length) {
		adoptedKid = `adopted-${randomBytes(4).toString("hex")}`;
		ring.unshift({
			kid: adoptedKid,
			material: currentSigningKey().toString("hex"),
			created_at: now,
			retire_at: now + graceMs,
		});
	}
	const kid = `k${now.toString(36)}-${randomBytes(4).toString("hex")}`;
	const material = randomBytes(32).toString("hex");
	ring.push({ kid, material, created_at: now, retire_at: null });
	// rewrite the legacy file with the new material — pre-ring readers adopt it
	writeFileSync(jwtKeyFile(), `${material}\n`, { mode: 0o600 });
	cachedKey = null; // next sign/verify reads the new material from disk
	writeKeyRing(ring);
	return {
		kid,
		retired_kid: live.at(-1)?.kid ?? adoptedKid,
		graceUntil: graceMs > 0 ? now + graceMs : null,
	};
}

// ─── JWT mechanics (HS256) ───────────────────────────────────────────────────

const enc = (o: unknown): string =>
	Buffer.from(JSON.stringify(o)).toString("base64url");

const b64url = (b: Buffer): string => b.toString("base64url");

const safeEq = (a: string, b: string): boolean => {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
};

function signJwt(payload: JwtClaims, key: Buffer): string {
	const head = enc({ alg: "HS256", typ: "JWT" });
	const data = `${head}.${enc(payload)}`;
	return `${data}.${b64url(createHmac("sha256", key).update(data).digest())}`;
}

// client-side, UNVERIFIED payload read (auth-client freshness checks only —
// never an authorization decision on the server side)
export function decodeJwtUnverified(
	token: string,
): (Partial<JwtClaims> & Record<string, unknown>) | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
}
// ─── scopes ──────────────────────────────────────────────────────────────────

export const ADMIN_SCOPE = "buckle:admin";

// write_X implies read_X; buckle:admin implies everything; role scopes
// (buckle:<resource>:<role>) match exactly.
export function scopeSatisfies(granted: string[], required: string): boolean {
	if (granted.includes(ADMIN_SCOPE)) return true;
	if (granted.includes(required)) return true;
	if (required.startsWith("read_"))
		return granted.includes(`write_${required.slice(5)}`);
	return false;
}

// string = at least one granted scope satisfies it; array = every entry
export function scopeCheck(
	granted: string[],
	required?: string | string[],
): boolean {
	if (!required) return true;
	if (typeof required === "string") return scopeSatisfies(granted, required);
	return required.every((r) => scopeSatisfies(granted, r));
}
// ─── issuer config (Entra RP mode — config-only, no code dependency) ─────────

export interface LocalIssuerConfig {
	type: "local";
	iss: string;
	audience?: string;
}

export interface OidcIssuerConfig {
	type: "oidc";
	iss: string; // must equal the token's iss claim — v2-first allowlist
	discovery: string; // openid-configuration URL
	audience?: string; // the app's Application/Client ID
	roles_claim?: string; // default "roles"
	roles?: string[]; // required roles (any-of); absent = none required
}

export type IssuerConfig = LocalIssuerConfig | OidcIssuerConfig;

export interface AuthConfig {
	issuers: IssuerConfig[];
}

export const authConfigFile = (): string | null =>
	process.env.BUCKLE_AUTH_CONFIG ?? null;

// throws on a malformed file — auth config is load-bearing, fail closed.
// No file = local issuer only. Listing v2 issuers FIRST is the convention
// (v1 sts.windows.net entries are legacy); validation itself is membership.
export function loadAuthConfig(): AuthConfig {
	const f = authConfigFile();
	if (!f) return { issuers: [{ type: "local", iss: LOCAL_ISSUER }] };
	const cfg = JSON.parse(readFileSync(f, "utf8")) as AuthConfig;
	if (!Array.isArray(cfg.issuers))
		throw new Error(`auth config ${f}: issuers array missing`);
	return cfg;
}
// ─── issue / rotate / revoke over the v8 api_keys rows ───────────────────────

const sha256hex = (s: string): string =>
	createHash("sha256").update(s).digest("hex");

interface KeyRow {
	key_id: string;
	jti: string | null;
	actor: string | null;
	team: string | null;
	token_type: string;
	parent_key_id: string | null;
	scopes: string | null;
	name: string | null;
	expires_at: number | null;
	rotated_at: number | null;
	revoked_at: number | null;
	created_at: number;
}

function authEvent(
	store: GovernorStore,
	ts: number,
	actor: string | null,
	event: string,
	jti: string | null,
	via: string,
): void {
	store
		.query(
			"INSERT INTO auth_events (ts, actor, event, jti, via) VALUES (?, ?, ?, ?, ?)",
		)
		.run(ts, actor, event, jti, via);
}
interface RowMeta {
	label: string | null;
	class: TokenClass;
}

// api_keys has no class column (v8 is settled — no migration) — the pair's
// class rides the row's `name` column as JSON {label, class}, written at
// issue, read back at rotation. A plain (legacy) name reads as app-role.
function metaOf(row: KeyRow): RowMeta {
	try {
		const m = JSON.parse(row.name ?? "") as RowMeta;
		if (m.class === "app-role" || m.class === "delegated") return m;
	} catch {
		// plain-text name — class defaults below
	}
	return { label: row.name ?? null, class: "app-role" };
}

const metaJson = (label: string | null | undefined, c: TokenClass): string =>
	JSON.stringify({ label: label ?? null, class: c });
export interface IssueParams {
	actor: string;
	team?: string | null;
	token_class: TokenClass;
	scopes: string[];
	name?: string | null;
	// ms; 0/null/absent = forever (expires_at NULL, no exp claim)
	accessTtlMs?: number | null;
	refreshTtlMs?: number | null;
	via?: string;
}

export interface IssuedPair {
	access: string;
	refresh: string;
	jti: string;
	refresh_jti: string;
	expires_at: number | null; // ms epoch
	refresh_expires_at: number | null;
}

const KEY_INS =
	"INSERT INTO api_keys (key_id, key_hash, jti, name, team, actor, token_type, parent_key_id, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
function buildClaims(p: IssueParams, nowS: number, jti: string): JwtClaims {
	return {
		sub: p.actor,
		team: p.team ?? null,
		scopes: p.scopes,
		token_class: p.token_class,
		jti,
		iat: nowS,
		exp: p.accessTtlMs
			? Math.floor((nowS * 1000 + p.accessTtlMs) / 1000)
			: null,
		aud: AUDIENCE,
		iss: LOCAL_ISSUER,
	};
}
function mintRows(
	store: GovernorStore,
	p: IssueParams,
	now: number,
	via: string,
	access: string,
	refresh: string,
	jtiA: string,
	jtiR: string,
	expiresAt: number | null,
	refreshExpiresAt: number | null,
	parentKeyId?: string,
): void {
	const common = [metaJson(p.name, p.token_class), p.team ?? null, p.actor];
	store
		.query(KEY_INS)
		.run(
			jtiA,
			sha256hex(access),
			jtiA,
			...common,
			"access",
			null,
			JSON.stringify(p.scopes),
			expiresAt,
			now,
		);
	store
		.query(KEY_INS)
		.run(
			jtiR,
			sha256hex(refresh),
			jtiR,
			...common,
			"refresh",
			parentKeyId ?? null,
			JSON.stringify(p.scopes),
			refreshExpiresAt,
			now,
		);
	if (parentKeyId) {
		store
			.query("UPDATE api_keys SET rotated_at = ? WHERE key_id = ?")
			.run(now, parentKeyId);
		authEvent(store, now, p.actor, "rotated", jtiR, via);
		authEvent(store, now, p.actor, "issued", jtiA, via);
		authEvent(store, now, p.actor, "refreshed", jtiR, via);
		return;
	}
	authEvent(store, now, p.actor, "issued", jtiA, via);
	authEvent(store, now, p.actor, "issued", jtiR, via);
}
const runTx = <T>(store: GovernorStore, fn: () => T): T =>
	store.transaction(fn)();

// fresh pair: rows + events inside one transaction
// the shared minter: sign + rows + events, optionally parented on the old
// refresh (rotation). issueTokens is the fresh-pair wrapper.
function mintPair(
	store: GovernorStore,
	p: IssueParams,
	now: number,
	via: string,
	parentKeyId?: string,
): IssuedPair {
	const nowS = Math.floor(now / 1000);
	const jtiA = randomUUID();
	const jtiR = randomUUID();
	const claims = buildClaims(p, nowS, jtiA);
	const access = signJwt(claims, loadSigningKey());
	const refresh = randomBytes(32).toString("base64url");
	const expiresAt = claims.exp ? claims.exp * 1000 : null;
	const refreshExpiresAt = p.refreshTtlMs ? now + p.refreshTtlMs : null;
	mintRows(
		store,
		p,
		now,
		via,
		access,
		refresh,
		jtiA,
		jtiR,
		expiresAt,
		refreshExpiresAt,
		parentKeyId,
	);
	return {
		access,
		refresh,
		jti: jtiA,
		refresh_jti: jtiR,
		expires_at: expiresAt,
		refresh_expires_at: refreshExpiresAt,
	};
}

export function issueTokens(store: GovernorStore, p: IssueParams): IssuedPair {
	return runTx(store, () => mintPair(store, p, Date.now(), p.via ?? "issue"));
}
export type RotateResult =
	| ({ ok: true } & IssuedPair)
	| { ok: false; code: string; error: string };

// single-use rotation: hash-lookup the refresh token, reject
// revoked/rotated/expired (each a 'rejected' auth_event), then mint the next
// pair (new refresh parented on the old) and stamp the old rotated_at.
export function rotateRefresh(
	store: GovernorStore,
	rawRefresh: string,
	via = "api",
): RotateResult {
	const now = Date.now();
	return runTx(store, () => {
		const row = store
			.query("SELECT * FROM api_keys WHERE key_hash = ?")
			.get(sha256hex(rawRefresh)) as KeyRow | undefined;
		const reject = (code: string, error: string): RotateResult => {
			authEvent(
				store,
				now,
				row?.actor ?? null,
				"rejected",
				row?.jti ?? null,
				`${via}: ${code}`,
			);
			return { ok: false, code, error };
		};
		if (!row)
			return reject("unknown_refresh_token", "refresh token not recognized");
		if (row.token_type !== "refresh")
			return reject("not_a_refresh_token", "token is not a refresh token");
		if (row.revoked_at) return reject("token_revoked", "refresh token revoked");
		if (row.rotated_at)
			return reject(
				"refresh_already_used",
				"refresh already rotated (single-use)",
			);
		if (row.expires_at && row.expires_at < now)
			return reject("refresh_expired", "refresh token expired");
		const meta = metaOf(row);
		const p: IssueParams = {
			actor: row.actor ?? "unknown",
			team: row.team,
			token_class: meta.class,
			scopes: JSON.parse(row.scopes ?? "[]") as string[],
			name: meta.label,
			via,
		};
		return { ok: true, ...mintPair(store, p, now, via, row.key_id) };
	});
}
// ─── revocation ──────────────────────────────────────────────────────────────

export type RevokeSelector = { jti?: string; actor?: string; team?: string };

export function revoke(
	store: GovernorStore,
	sel: RevokeSelector,
	via = "api",
): { changes: number; selector: RevokeSelector } {
	const now = Date.now();
	if (!sel.jti && !sel.actor && !sel.team)
		throw new Error("revoke needs a selector: jti, actor, or team");
	return runTx(store, () => {
		let changes = 0;
		const upd = "UPDATE api_keys SET revoked_at = ? WHERE";
		if (sel.jti)
			changes += store
				.query(`${upd} jti = ? AND revoked_at IS NULL`)
				.run(now, sel.jti).changes;
		if (sel.actor)
			changes += store
				.query(`${upd} actor = ? AND revoked_at IS NULL`)
				.run(now, sel.actor).changes;
		if (sel.team)
			changes += store
				.query(`${upd} team = ? AND revoked_at IS NULL`)
				.run(now, sel.team).changes;
		const kind = sel.jti ? "jti" : sel.actor ? "actor" : "team";
		authEvent(
			store,
			now,
			sel.actor ?? null,
			"revoked",
			sel.jti ?? null,
			`${via}: ${kind}=${sel.jti ?? sel.actor ?? sel.team ?? ""}`,
		);
		return { changes, selector: sel };
	});
}
// ─── verify (the middleware helper, exportable to buckle/board) ──────────────

export interface RequestLike {
	headers: { get(name: string): string | null };
}

export interface VerifyOpts {
	// string = any-of, array = all-of
	requiredScope?: string | string[];
	// local-issuer tokens check the api_keys denylist through this store;
	// external IdP tokens skip it (signature+allowlist+roles is the trust)
	store?: GovernorStore;
	config?: AuthConfig | null;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface AuthSuccess {
	ok: true;
	claims: JwtClaims;
	keyId: string;
}

export interface AuthFailure {
	ok: false;
	status: 401 | 403;
	code: string;
	error: string;
	// true → caller sends x-auth-renew: /auth/refresh
	renew?: boolean;
}

export type AuthResult = AuthSuccess | AuthFailure;
interface JwksEntry {
	at: number;
	keys: {
		kid?: string;
		kty?: string;
		[n: string]: unknown;
	}[];
}

const jwksCache = new Map<string, JwksEntry>();
const JWKS_TTL_MS = 600_000;

function tryKey(
	k: JwksEntry["keys"][number],
	data: string,
	kid: string | undefined,
	sig: Buffer,
): boolean {
	if (kid && k.kid && k.kid !== kid) return false;
	if (k.kty !== "RSA") return false;
	try {
		return cryptoVerify(
			"RSA-SHA256",
			Buffer.from(data),
			createPublicKey({ key: k, format: "jwk" }),
			sig,
		);
	} catch {
		return false;
	}
}

async function verifyOidcSignature(
	entry: OidcIssuerConfig,
	data: string,
	kid: string | undefined,
	sig: Buffer,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	const c = jwksCache.get(entry.iss);
	if (c && Date.now() - c.at < JWKS_TTL_MS)
		return c.keys.some((k) => tryKey(k, data, kid, sig));
	const disc = (await (await fetchImpl(entry.discovery)).json()) as {
		jwks_uri?: string;
	};
	if (!disc.jwks_uri) return false;
	const jwks = (await (await fetchImpl(disc.jwks_uri)).json()) as JwksEntry;
	const keys = jwks.keys ?? [];
	jwksCache.set(entry.iss, { at: Date.now(), keys });
	return keys.some((k) => tryKey(k, data, kid, sig));
}
const fail = (
	status: 401 | 403,
	code: string,
	error: string,
	renew = false,
): AuthFailure => ({ ok: false, status, code, error, renew });

function parseBearer(
	req: RequestLike,
): { ok: true; token: string } | AuthFailure {
	const authz = (req.headers.get("authorization") ?? "").trim();
	const m = /^Bearer\s+(.+)$/i.exec(authz);
	if (!m) return fail(401, "missing_token", "Authorization: Bearer required");
	if (m[1].split(".").length !== 3)
		return fail(401, "malformed_token", "token is not a JWT");
	return { ok: true, token: m[1] };
}
interface JwtHeader {
	alg?: string;
	kid?: string;
}

function parseJwt(token: string):
	| {
			ok: true;
			header: JwtHeader;
			payload: Record<string, unknown>;
			claims: JwtClaims;
			data: string;
			sig: Buffer;
	  }
	| AuthFailure {
	try {
		const parts = token.split(".");
		const header = JSON.parse(
			Buffer.from(parts[0], "base64url").toString("utf8"),
		) as JwtHeader;
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const claims = payload as unknown as JwtClaims;
		return {
			ok: true,
			header,
			payload,
			claims,
			data: `${parts[0]}.${parts[1]}`,
			sig: Buffer.from(parts[2], "base64url"),
		};
	} catch {
		return fail(401, "malformed_token", "token is not a JWT");
	}
}
async function checkSignature(
	entry: IssuerConfig,
	nowMs: number,
	j: {
		ok: true;
		header: JwtHeader;
		payload: Record<string, unknown>;
		claims: JwtClaims;
		data: string;
		sig: Buffer;
	},
	fetchImpl: typeof fetch,
): Promise<AuthFailure | null> {
	if (entry.type === "oidc") {
		if (j.header.alg !== "RS256")
			return fail(401, "bad_algorithm", "external issuers require RS256");
		const ok = await verifyOidcSignature(
			entry,
			j.data,
			j.header.kid,
			j.sig,
			fetchImpl,
		);
		return ok
			? null
			: fail(401, "bad_signature", "signature verification failed");
	}
	if (j.header.alg !== "HS256")
		return fail(401, "bad_algorithm", "local issuer requires HS256");
	// ring-aware (W178): current key first, then retired keys inside their
	// grace window — a token signed by a since-rotated key keeps verifying
	// until retire_at, then 401s and clients self-heal via /auth/refresh
	const candidates = [currentSigningKey()];
	for (const k of loadKeyRing())
		if (k.retire_at !== null && k.retire_at > nowMs)
			candidates.push(Buffer.from(k.material, "hex"));
	for (const key of candidates) {
		const expect = b64url(createHmac("sha256", key).update(j.data).digest());
		if (safeEq(expect, j.sig.toString("base64url"))) return null;
	}
	return fail(401, "bad_signature", "signature verification failed");
}
function checkExpiry(claims: JwtClaims, nowS: number): AuthFailure | null {
	if (claims.exp != null && claims.exp < nowS)
		return fail(401, "token_expired", "access token expired", true);
	return null;
}

function checkDenylist(
	store: GovernorStore | undefined,
	jti: string,
): AuthFailure | null {
	if (!store)
		return fail(
			401,
			"store_required",
			"verifyJwt needs a store for local tokens",
		);
	const row = store.query("SELECT * FROM api_keys WHERE jti = ?").get(jti) as
		| KeyRow
		| undefined;
	if (!row)
		return fail(401, "unknown_token", "token not recognized (no api_keys row)");
	if (row.revoked_at)
		return fail(401, "token_revoked", "token has been revoked");
	return null;
}

function checkRoles(
	entry: OidcIssuerConfig,
	payload: Record<string, unknown>,
): AuthFailure | null {
	if (!entry.roles?.length) return null;
	const rc = entry.roles_claim ?? "roles";
	const have = payload[rc];
	const list = Array.isArray(have)
		? have
		: typeof have === "string"
			? [have]
			: [];
	if (!entry.roles.some((r) => list.includes(r)))
		return fail(
			403,
			"missing_role",
			`required role(s): ${entry.roles.join(", ")}`,
		);
	return null;
}
export async function verifyJwt(
	req: RequestLike,
	requiredScope?: string | string[],
	opts: VerifyOpts = {},
): Promise<AuthResult> {
	const nowMs = (opts.now ?? Date.now)(); // ms — the ring grace check wants ms
	const nowS = Math.floor(nowMs / 1000);
	const b = parseBearer(req);
	if (!b.ok) return b;
	const j = parseJwt(b.token);
	if (!j.ok) return j;
	let cfg: AuthConfig;
	try {
		cfg = opts.config ?? loadAuthConfig();
	} catch {
		return fail(401, "auth_config_invalid", "auth config unreadable/malformed");
	}
	const entry = cfg.issuers.find((i) => i.iss === j.claims.iss);
	if (!entry)
		return fail(
			401,
			"issuer_not_allowed",
			`issuer not in allowlist: ${String(j.claims.iss ?? "?")}`,
		);
	const sigFail = await checkSignature(
		entry,
		nowMs,
		j,
		opts.fetchImpl ?? fetch,
	);
	if (sigFail) return sigFail;
	const expFail = checkExpiry(j.claims, nowS);
	if (expFail)
		return fail(expFail.status, expFail.code, expFail.error, expFail.renew);
	if (entry.audience && j.claims.aud !== entry.audience)
		return fail(401, "audience_mismatch", "audience mismatch");
	if (entry.type === "local") {
		const d = checkDenylist(opts.store, j.claims.jti);
		if (d) return d;
	} else {
		const r = checkRoles(entry, j.payload);
		if (r) return r;
	}
	if (
		entry.type === "local" &&
		!scopeCheck(j.claims.scopes ?? [], requiredScope)
	)
		return fail(
			403,
			"insufficient_scope",
			`required scope missing: ${String(requiredScope)}`,
		);
	return { ok: true, claims: j.claims, keyId: j.claims.jti };
}
// fingerprint helper — reports show FIRST/LAST 4 + length, never raw material
export const fingerprint = (t: string): string =>
	`${t.slice(0, 4)}…${t.slice(-4)} (${String(t.length)} chars)`;
