// hooks/lib/console-session.ts — W175: the console browser session.
// HMAC-signed cookie value over loadSigningKey() — the existing 0600 key from
// W149 (no new key material; BUCKLE_JWT_KEY_FILE/BUCKLE_SECRETS_HOME move it
// for tests). A console session is a DISPLAY identity: what the avatar shows,
// what the dropdown switches, whose spend /console/spend renders. Lane usage
// attribution still rides sessions.actor (coord bootstrap --actor); auth_events
// (via "console:*") is the audit ledger for login/switch/logout.
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { loadSigningKey } from "./auth.ts";

export const SESSION_COOKIE = "cbsess";
export const STATE_COOKIE = "cbstate";

export interface ConsoleSession {
	user?: string;
	actor?: string;
	exp: number; // seconds epoch
}

// 30 days, refreshed on every stamped write (actor switch, login).
export const SESSION_TTL_S = 30 * 86400;
export const STATE_TTL_S = 600;

const b64u = (b: Buffer): string => b.toString("base64url");

// value = base64url(JSON payload) + "." + base64url(HMAC_sha256(key, body))
export function signValue(payload: unknown): string {
	const body = b64u(Buffer.from(JSON.stringify(payload)));
	const mac = createHmac("sha256", loadSigningKey()).update(body).digest();
	return `${body}.${b64u(mac)}`;
}

// null on tamper, bad payload, or expiry — never throws
export function readValue<T extends { exp?: number }>(
	v: string | undefined | null,
): T | null {
	if (!v) return null;
	const i = v.lastIndexOf(".");
	if (i < 0) return null;
	const body = v.slice(0, i);
	let mac: Buffer;
	try {
		mac = Buffer.from(v.slice(i + 1), "base64url");
	} catch {
		return null;
	}
	const expect = createHmac("sha256", loadSigningKey()).update(body).digest();
	const macOk = mac.length === expect.length && timingSafeEqual(mac, expect);
	if (!macOk) return null;
	try {
		const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
		if (typeof p.exp === "number" && p.exp < nowS()) return null;
		return p;
	} catch {
		return null;
	}
}

const nowS = (): number => Math.floor(Date.now() / 1000);

// Cookie header → name/value map (decodeURIComponent on values; a malformed
// pair is skipped, never thrown).
export function parseCookies(h: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!h) return out;
	for (const part of h.split(";")) {
		const i = part.indexOf("=");
		if (i > 0)
			out[part.slice(0, i).trim()] = decodeURIComponent(
				part.slice(i + 1).trim(),
			);
	}
	return out;
}

// Set-Cookie line. No Secure flag: the console serves plain HTTP on loopback
// and the LAN .local names (Caddy http) — Secure would break both. The board's
// writeGuard (same-origin/loopback Host) is the request-side guard.
export function cookieHeader(
	name: string,
	value: string,
	maxAgeS: number,
): string {
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
}

export const clearCookieHeader = (name: string): string =>
	`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// One-time login-state payload riding the short-TTL state cookie.
export interface LoginState {
	state: string;
	verifier: string;
	nonce: string;
	exp: number;
}

export const newLoginState = (): LoginState => ({
	state: randomBytes(16).toString("base64url"),
	verifier: randomBytes(32).toString("base64url"),
	nonce: randomBytes(16).toString("base64url"),
	exp: nowS() + STATE_TTL_S,
});
