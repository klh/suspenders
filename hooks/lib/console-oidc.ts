// hooks/lib/console-oidc.ts — W175: OIDC authorization-code + PKCE login for
// the console, authentik-first per the W151 verdict (MIT core, free SCIM both
// ways, OIDC brokering). Any compliant issuer works: set oidc_issuer +
// oidc_client_id on the suspenders settings page (suspenders-board.json —
// config-over-code). Public PKCE client: no secret in the settings file.
// SCIM pre-provisioning is a later item (W151 §4); de-provisioning still
// holds without SCIM — a user the issuer no longer authenticates cannot log
// in, and the 30d console session expires.
import { createHash, randomBytes } from "node:crypto";
import type { BoardSettings } from "./board-config.ts";

export interface OidcConfig {
	issuer: string;
	clientId: string;
}

// both knobs or neither — a half-configured login must say so honestly
export const oidcConfig = (
	s: BoardSettings | null | undefined,
): OidcConfig | null => {
	const issuer = s?.oidc_issuer?.trim() || "";
	const clientId = s?.oidc_client_id?.trim() || "";
	if (!issuer || !clientId) return null;
	return { issuer, clientId };
};

export interface OidcEndpoints {
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
}

// cached discovery — read once per TTL per issuer; 10-minute TTL matches the
// JWKS cache in auth.ts.
const discCache = new Map<string, { at: number; doc: OidcEndpoints }>();
const DISC_TTL_MS = 600_000;

export const discoveryUrl = (issuer: string): string =>
	`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

export async function oidcDiscover(
	cfg: OidcConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<OidcEndpoints> {
	const c = discCache.get(cfg.issuer);
	if (c && Date.now() - c.at < DISC_TTL_MS) return c.doc;
	const url = discoveryUrl(cfg.issuer);
	const r = await fetchImpl(url);
	if (!r.ok)
		throw new Error(`discovery failed: HTTP ${r.status} for ${cfg.issuer}`);
	const doc = (await r.json()) as Partial<OidcEndpoints>;
	if (!doc.authorization_endpoint || !doc.token_endpoint)
		throw new Error(`discovery doc missing endpoints for ${cfg.issuer}`);
	discCache.set(cfg.issuer, { at: Date.now(), doc: doc as OidcEndpoints });
	return doc as OidcEndpoints;
}

// RFC 7636 S256: verifier = 32 random bytes base64url; challenge =
// base64url(sha256(verifier)). The verifier rides the signed state cookie.
export function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

// The callback address the issuer must be configured to allow — built from
// the incoming request so loopback:port and the .local name both work.
export function redirectUriFor(req: Request): string {
	return `${new URL(req.url).origin}/console/callback`;
}

export function authorizeUrl(args: {
	endpoints: OidcEndpoints;
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
	nonce: string;
}): string {
	const q = new URLSearchParams({
		response_type: "code",
		client_id: args.clientId,
		redirect_uri: args.redirectUri,
		scope: "openid profile email",
		state: args.state,
		nonce: args.nonce,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
	});
	return `${args.endpoints.authorization_endpoint}?${q.toString()}`;
}

export interface TokenOutcome {
	ok: boolean;
	id_token?: string;
	error?: string;
}

export async function exchangeCode(args: {
	endpoints: OidcEndpoints;
	clientId: string;
	redirectUri: string;
	code: string;
	verifier: string;
	fetchImpl?: typeof fetch;
}): Promise<TokenOutcome> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: args.code,
		redirect_uri: args.redirectUri,
		client_id: args.clientId,
		code_verifier: args.verifier,
	});
	const r = await (args.fetchImpl ?? fetch)(args.endpoints.token_endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	const j = (await r.json().catch(() => ({}))) as {
		id_token?: string;
		error?: string;
	};
	if (!r.ok || !j.id_token)
		return {
			ok: false,
			error: j.error ?? `token endpoint HTTP ${r.status}`,
		};
	return { ok: true, id_token: j.id_token };
}
