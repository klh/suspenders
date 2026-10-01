// hooks/lib/auth-server.ts — W149: the /auth/* routes on the store server
// (:7794 — it owns the governor tables, so it is the identity surface).
//
//   POST /auth/token    issue a pair    (bearer + write_auth scope)
//   POST /auth/refresh  rotate          (the refresh token IS the grant;
//                                       single-use: old row stamped rotated_at)
//   POST /auth/revoke   jti/actor/team  (bearer + write_auth scope)
//   GET  /auth/whoami   protected echo  (any valid token)
//
// Hypermedia errors per the CLI auth lessons: machine-readable code, a
// refresh_endpoint, and one agent_next_steps sentence; 401s from an expired
// access token carry the x-auth-renew header.
import type { AuthFailure } from "./auth.ts";
import { issueTokens, rotateRefresh, revoke, verifyJwt } from "./auth.ts";
import type { GovernorStore } from "./govdb.ts";

export interface AuthServerOpts {
	store: GovernorStore;
}

// W155 http-citizenship (docs/design/http-citizenship.md): honest in-process
// fixed-minute rpm window. The auth plane is low-volume control-plane
// traffic served by ONE process whose /auth requests serialize on the store
// chain, so a fixed window is truthful; there is no token dimension on this
// surface, so the budget name mirrors the govdb shape as plain rpm.
const AUTH_RPM = (() => {
	const n = Number(process.env.AUTH_RPM_LIMIT ?? 240);
	return Number.isFinite(n) && n > 0 ? n : 240;
})();
const RL_WINDOW_MS = 60_000;
let rlWindowStart = 0;
let rlCount = 0;

const rlRoll = (now: number): void => {
	if (now - rlWindowStart >= RL_WINDOW_MS) {
		rlWindowStart = 60_000 * Math.floor(now / 60_000);
		rlCount = 0;
	}
};

const rlRetryAfterS = (now: number): number =>
	Math.max(1, Math.ceil((rlWindowStart + RL_WINDOW_MS - now) / 1000));

// both header families, always — IETF draft (Reset = seconds until window
// reset) + de-facto x-ratelimit (Reset = unix epoch of window reset)
const rateTrio = (now: number): Record<string, string> => {
	const remaining = Math.max(0, AUTH_RPM - rlCount);
	const resetS = rlRetryAfterS(now);
	const resetEpoch = Math.ceil((rlWindowStart + RL_WINDOW_MS) / 1000);
	const h: Record<string, string> = {
		"ratelimit-limit": String(AUTH_RPM),
		"ratelimit-remaining": String(remaining),
		"ratelimit-reset": String(resetS),
		"ratelimit-policy": `auth-rpm; q=${AUTH_RPM}`,
		"x-ratelimit-limit": String(AUTH_RPM),
		"x-ratelimit-remaining": String(remaining),
		"x-ratelimit-reset": String(resetEpoch),
	};
	return h;
};

// RFC 9457 titles per status — problem+json requires one per error body
const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	429: "Too Many Requests",
};

// RFC 9457 application/problem+json with the fleet extensions (code, why,
// refresh_endpoint, agent_next_steps); the legacy error/error_description
// members ride along so existing readers keep working — the stable code is
// PRESERVED in `code` (docs/design/http-citizenship.md).
function problem(
	req: Request,
	status: number,
	code: string,
	detail: string,
	extra: Record<string, unknown> = {},
): Response {
	const headers = new Headers({
		"content-type": "application/problem+json",
	});
	const body = {
		type: `/problems/${code}`,
		title: TITLES[status] ?? "Error",
		status,
		detail,
		instance: new URL(req.url).pathname,
		code,
		why: detail,
		error: code,
		error_description: detail,
		...extra,
	};
	return new Response(JSON.stringify(body), { status, headers });
}

export function authFailureResponse(r: AuthFailure, req: Request): Response {
	const extra: Record<string, unknown> = r.renew
		? {
				refresh_endpoint: "/auth/refresh",
				agent_next_steps:
					"POST {refresh_endpoint} with {refresh_token} to mint a new pair, then retry once.",
			}
		: {
				...(r.status === 401 ? { refresh_endpoint: "/auth/refresh" } : {}),
				agent_next_steps:
					"Obtain a token with the required scope (POST /auth/token from an admin) and retry.",
			};
	const resp = problem(req, r.status, r.code, r.error, extra);
	if (r.renew) resp.headers.set("x-auth-renew", "/auth/refresh");
	if (r.status === 401)
		resp.headers.set(
			"www-authenticate",
			'Bearer realm="governor-store", error="invalid_token"',
		);
	return resp;
}

interface IssueBody {
	actor?: string;
	team?: string;
	token_class?: string;
	scopes?: string | string[];
	name?: string;
	access_ttl_seconds?: number | null;
	refresh_ttl_seconds?: number | null;
}

const bad = (req: Request, d: string): Response =>
	problem(req, 400, "bad_request", d);

function validateIssueBody(req: Request, body: IssueBody): Response | null {
	if (!body.actor || !body.token_class)
		return bad(
			req,
			"actor and token_class are required (app-role | delegated)",
		);
	if (!["app-role", "delegated"].includes(body.token_class))
		return bad(req, "token_class must be app-role or delegated");
	const scopes = Array.isArray(body.scopes)
		? body.scopes
		: (body.scopes ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	if (!scopes.length) return bad(req, "at least one scope is required");
	return null;
}
async function handleToken(
	req: Request,
	store: GovernorStore,
): Promise<Response> {
	const auth = await verifyJwt(req, "write_auth", { store });
	if (!auth.ok) return authFailureResponse(auth, req);
	const body = (await req.json().catch(() => ({}))) as IssueBody;
	const invalid = validateIssueBody(req, body);
	if (invalid) return invalid;
	const scopes = Array.isArray(body.scopes)
		? body.scopes
		: (body.scopes ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	const ttl = (v: number | null | undefined): number | null =>
		v == null || v <= 0 ? null : v * 1000;
	const pair = issueTokens(store, {
		actor: body.actor ?? "",
		team: body.team ?? null,
		token_class: body.token_class as "app-role" | "delegated",
		scopes,
		name: body.name ?? null,
		accessTtlMs: ttl(body.access_ttl_seconds),
		refreshTtlMs: ttl(body.refresh_ttl_seconds),
		via: "api:/auth/token",
	});
	return Response.json(
		{
			access_token: pair.access,
			token_type: "Bearer",
			refresh_token: pair.refresh,
			expires_at: pair.expires_at,
			refresh_expires_at: pair.refresh_expires_at,
			jti: pair.jti,
			refresh_jti: pair.refresh_jti,
			agent_next_steps:
				"Store access_token for Bearer use; keep refresh_token for single-use rotation at POST /auth/refresh.",
		},
		{ status: 201, headers: { location: "/auth/whoami" } },
	);
}
async function handleRefresh(
	req: Request,
	store: GovernorStore,
): Promise<Response> {
	const body = (await req.json().catch(() => ({}))) as {
		refresh_token?: string;
	};
	if (!body.refresh_token)
		return bad(req, "refresh_token is required in the body");
	const r = rotateRefresh(store, body.refresh_token, "api:/auth/refresh");
	if (!r.ok)
		return authFailureResponse(
			{ status: 401, code: r.code, error: r.error },
			req,
		);
	return Response.json({
		access_token: r.access,
		token_type: "Bearer",
		refresh_token: r.refresh,
		expires_at: r.expires_at,
		refresh_expires_at: r.refresh_expires_at,
		jti: r.jti,
		refresh_jti: r.refresh_jti,
		agent_next_steps:
			"The old refresh token is now invalid (single-use rotation); store the new pair.",
	});
}
interface RevokeBody {
	jti?: string;
	actor?: string;
	team?: string;
}

async function handleRevoke(
	req: Request,
	store: GovernorStore,
): Promise<Response> {
	const auth = await verifyJwt(req, "write_auth", { store });
	if (!auth.ok) return authFailureResponse(auth, req);
	const sel = (await req.json().catch(() => ({}))) as RevokeBody;
	if (!sel.jti && !sel.actor && !sel.team)
		return bad(req, "one of jti, actor, or team is required");
	const out = revoke(store, sel, "api:/auth/revoke");
	return Response.json({
		...out,
		agent_next_steps: "Revoked tokens fail verification immediately.",
	});
}

async function handleWhoami(
	req: Request,
	store: GovernorStore,
): Promise<Response> {
	const auth = await verifyJwt(req, undefined, { store });
	if (!auth.ok) return authFailureResponse(auth, req);
	const c = auth.claims;
	return Response.json({
		actor: c.sub,
		team: c.team,
		scopes: c.scopes,
		token_class: c.token_class,
		jti: c.jti,
		issued_at: c.iat,
		expires_at: c.exp,
		iss: c.iss,
		aud: c.aud,
	});
}
async function route(
	req: Request,
	url: URL,
	opts: AuthServerOpts,
): Promise<Response> {
	const { store } = opts;
	const path = url.pathname;
	const method = req.method;
	// W155 http-citizenship: OPTIONS → 204 + Allow; known auth path with a
	// wrong method → 405 + Allow (docs/design/http-citizenship.md).
	const ALLOW: Record<string, string> = {
		"/auth/token": "POST, OPTIONS",
		"/auth/refresh": "POST, OPTIONS",
		"/auth/revoke": "POST, OPTIONS",
		"/auth/whoami": "GET, HEAD, OPTIONS",
	};
	const allow = ALLOW[path];
	if (allow !== undefined) {
		if (method === "OPTIONS")
			return new Response(null, { status: 204, headers: { allow } });
		const okMethod =
			method === "POST" ||
			(path === "/auth/whoami" && (method === "GET" || method === "HEAD"));
		if (!okMethod) {
			const r = problem(
				req,
				405,
				"auth.method_not_allowed",
				`${method} is not supported on ${path} — the route allows: ${allow}`,
			);
			r.headers.set("allow", allow);
			return r;
		}
	}
	if (path === "/auth/token" && method === "POST")
		return handleToken(req, store);
	if (path === "/auth/refresh" && method === "POST")
		return handleRefresh(req, store);
	if (path === "/auth/revoke" && method === "POST")
		return handleRevoke(req, store);
	if (path === "/auth/whoami" && (method === "GET" || method === "HEAD"))
		return handleWhoami(req, store);
	return problem(req, 404, "auth.not_found", `no such auth route: ${path}`);
}

// W155 http-citizenship wrapper: every /auth/* response carries
// Cache-Control: no-store + the rate-limit trio (both families); the window
// rolls on a fixed minute and over-limit requests get 429 + Retry-After
// (jittered) + RateLimit-Remaining: 0, before any handler runs.
export async function handleAuthRoutes(
	req: Request,
	url: URL,
	opts: AuthServerOpts,
): Promise<Response> {
	const now = Date.now();
	rlRoll(now);
	if (rlCount >= AUTH_RPM) {
		const retry = rlRetryAfterS(now) + Math.floor(Math.random() * 5);
		const r = problem(
			req,
			429,
			"auth.rate_limited",
			"auth rpm window exhausted — retry after the window resets",
		);
		r.headers.set("retry-after", String(retry));
		r.headers.set("ratelimit-remaining", "0");
		r.headers.set("x-ratelimit-remaining", "0");
		for (const [k, v] of Object.entries(rateTrio(now))) r.headers.set(k, v);
		return r;
	}
	rlCount += 1;
	const resp = await route(req, url, opts);
	const headers = new Headers(resp.headers);
	headers.set("cache-control", "no-store");
	for (const [k, v] of Object.entries(rateTrio(now))) headers.set(k, v);
	return new Response(resp.body, { status: resp.status, headers });
}
