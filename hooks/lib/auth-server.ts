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
import {
	DEFAULT_ACCESS_TTL_MS,
	issueTokens,
	rotateRefresh,
	revoke,
	scopeEscalations,
	verifyJwt,
} from "./auth.ts";
import type { GovernorStore } from "./govdb.ts";

export interface AuthServerOpts {
	store: GovernorStore;
}

export function authFailureResponse(r: AuthFailure): Response {
	const headers = new Headers({ "content-type": "application/json" });
	if (r.renew) headers.set("x-auth-renew", "/auth/refresh");
	return Response.json(
		{
			error: r.code,
			error_description: r.error,
			...(r.renew ? { refresh_endpoint: "/auth/refresh" } : {}),
			...(r.cascade != null ? { theft_cascade: r.cascade } : {}),
			agent_next_steps: r.renew
				? "POST {refresh_endpoint} with {refresh_token} to mint a new pair, then retry once."
				: "Obtain a token with the required scope (POST /auth/token from an admin) and retry.",
		},
		{ status: r.status, headers },
	);
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

const bad = (d: string): Response =>
	Response.json(
		{ error: "bad_request", error_description: d },
		{ status: 400 },
	);

function validateIssueBody(body: IssueBody): Response | null {
	if (!body.actor || !body.token_class)
		return bad("actor and token_class are required (app-role | delegated)");
	if (!["app-role", "delegated"].includes(body.token_class))
		return bad("token_class must be app-role or delegated");
	const scopes = Array.isArray(body.scopes)
		? body.scopes
		: (body.scopes ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	if (!scopes.length) return bad("at least one scope is required");
	return null;
}
async function handleToken(
	req: Request,
	store: GovernorStore,
): Promise<Response> {
	const auth = await verifyJwt(req, "write_auth", { store });
	if (!auth.ok) return authFailureResponse(auth);
	const body = (await req.json().catch(() => ({}))) as IssueBody;
	const invalid = validateIssueBody(body);
	if (invalid) return invalid;
	const scopes = Array.isArray(body.scopes)
		? body.scopes
		: (body.scopes ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
	// W194 mint rule: the requested scopes must be a subset of the caller's
	// own grant — a write_auth holder cannot mint buckle:admin (or any scope
	// it does not itself hold) for another actor
	const esc = scopeEscalations(scopes, auth.claims.scopes ?? []);
	if (esc.length)
		return authFailureResponse({
			ok: false,
			status: 403,
			code: "scope_escalation",
			error: `requested scopes exceed the caller's grant: ${esc.join(", ")}`,
		});
	const ttl = (v: number | null | undefined): number | null =>
		v == null || v <= 0 ? null : v * 1000;
	const pair = issueTokens(store, {
		actor: body.actor ?? "",
		team: body.team ?? null,
		token_class: body.token_class as "app-role" | "delegated",
		scopes,
		name: body.name ?? null,
		// W194: an omitted access TTL takes the bounded default (30d), never
		// forever-by-omission; explicit 0 stays the forever escape
		accessTtlMs:
			body.access_ttl_seconds == null
				? DEFAULT_ACCESS_TTL_MS
				: ttl(body.access_ttl_seconds),
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
		{ status: 201 },
	);
}
async function handleRefresh(
	req: Request,
	store: GovernorStore,
): Promise<Response> {
	const body = (await req.json().catch(() => ({}))) as {
		refresh_token?: string;
	};
	if (!body.refresh_token) return bad("refresh_token is required in the body");
	const r = rotateRefresh(store, body.refresh_token, "api:/auth/refresh");
	if (!r.ok)
		return authFailureResponse({
			status: 401,
			code: r.code,
			error: r.error,
			...(r.cascade_revoked !== undefined
				? { cascade: r.cascade_revoked }
				: {}),
		});
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
	if (!auth.ok) return authFailureResponse(auth);
	const sel = (await req.json().catch(() => ({}))) as RevokeBody;
	if (!sel.jti && !sel.actor && !sel.team)
		return bad("one of jti, actor, or team is required");
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
	if (!auth.ok) return authFailureResponse(auth);
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
export async function handleAuthRoutes(
	req: Request,
	url: URL,
	opts: AuthServerOpts,
): Promise<Response> {
	const { store } = opts;
	const path = url.pathname;
	const method = req.method;
	if (path === "/auth/token" && method === "POST")
		return handleToken(req, store);
	if (path === "/auth/refresh" && method === "POST")
		return handleRefresh(req, store);
	if (path === "/auth/revoke" && method === "POST")
		return handleRevoke(req, store);
	if (path === "/auth/whoami" && method === "GET")
		return handleWhoami(req, store);
	return new Response("not found", { status: 404 });
}
