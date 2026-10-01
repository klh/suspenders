// hooks/board/routes-console.ts — W147 console: /console /console/belt /console/local /api/console/me /console/settings(+preview/apply) (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { BELT_REPO, db } from "./context.ts";
import { json, writeGuard } from "./helpers.ts";
import { consoleMe, gatherBeltView, gatherLocalView } from "./console-view.ts";
import {
	htmlHdr,
	suspPreview,
	policyPreview,
	settingsApply,
} from "./settings.ts";
import { scrub } from "../lib/servicemon.ts";
import {
	ConfigError,
	parsePolicy,
	policyWritePath,
	readBoardSettings,
	resolvePolicy,
} from "../lib/board-config.ts";
import type { PolicyGatewayParsed } from "../lib/board-config.ts";
import {
	beltPage,
	localPage,
	type Feature,
	loginPage,
	previewPage,
	settingsFormPage,
	settingsIndexPage,
	spendPage,
} from "../bin/console-html.ts";
import {
	cookieHeader,
	clearCookieHeader,
	parseCookies,
	SESSION_COOKIE,
	STATE_COOKIE,
	readValue,
	signValue,
	SESSION_TTL_S,
	STATE_TTL_S,
	newLoginState,
} from "../lib/console-session.ts";
import type { ConsoleSession, LoginState } from "../lib/console-session.ts";
import {
	authorizeUrl,
	discoveryUrl,
	exchangeCode,
	oidcConfig,
	oidcDiscover,
	pkce,
	redirectUriFor,
} from "../lib/console-oidc.ts";
import { actorAuthEvents, actorBudgets, actorUsage } from "./console-view.ts";
import { verifyIdToken } from "../lib/auth.ts";

// ─── W175: console session (signed cookie) + login/switch routes ──────────
// The console session is a display identity: it picks whose spend
// /console/spend renders and what the avatar shows. auth_events is the
// audit ledger. Lane usage attribution still rides sessions.actor.
const hasOidc = (): boolean => !!oidcConfig(readBoardSettings().settings);

const meFor = (req: Request): ConsoleMe => {
	const cookies = parseCookies(req.headers.get("cookie"));
	const sess = readValue<ConsoleSession>(cookies[SESSION_COOKIE]);
	const base = consoleMe();
	const user = sess?.user ?? null;
	const raw = base.actor !== "unassigned" ? base.actor : base.defaultActor;
	const actor = sess?.actor ?? (raw || "unassigned");
	return { ...base, actor, user, hasLogin: hasOidc() };
};

const authEvent = (actor: string | null, event: string, via: string): void => {
	db.query(
		"INSERT INTO auth_events (ts, actor, event, via) VALUES (?, ?, ?, ?)",
	).run(Date.now(), actor, event, via);
};

const msgOf = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

// mint the console session + redirect after a verified id_token (W175)
const finishLogin = (user: string): Response => {
	authEvent(user, "login", "console:oidc");
	const sess: ConsoleSession = {
		user,
		actor: user,
		exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
	};
	const h = new Headers({ location: "/console/spend" });
	h.set(
		"set-cookie",
		cookieHeader(SESSION_COOKIE, signValue(sess), SESSION_TTL_S),
	);
	h.set("cache-control", "no-store");
	return new Response(null, { status: 303, headers: h });
};

// state cookie → discovery → code exchange → the id_token, or a login-page
// error Response. The first half of the /console/callback route (W175).
const oidcIdTokenFromCode = async (
	req: Request,
	url: URL,
): Promise<
	{ ok: true; id_token: string; st: LoginState } | { ok: false; resp: Response }
> => {
	const me = meFor(req);
	const fail = (msg: string): Response =>
		new Response(loginPage({ configured: true, error: msg }, me), {
			headers: HTML_HDRS(),
		});
	const st = readValue<LoginState>(
		parseCookies(req.headers.get("cookie"))[STATE_COOKIE],
	);
	const code = url.searchParams.get("code") ?? "";
	const state = url.searchParams.get("state") ?? "";
	if (!st || st.state !== state)
		return {
			ok: false,
			resp: fail(
				"login state expired or mismatched — restart at /console/login",
			),
		};
	const cfg = oidcConfig(readBoardSettings().settings);
	if (!cfg) return { ok: false, resp: fail("login is not configured") };
	const eps = await oidcDiscover(cfg).catch((e: unknown) => ({
		discError: msgOf(e),
	}));
	if ("discError" in eps) return { ok: false, resp: fail(eps.discError) };
	const tok = await exchangeCode({
		endpoints: eps,
		clientId: cfg.clientId,
		redirectUri: redirectUriFor(req),
		code,
		verifier: st.verifier,
	});
	if (!tok.ok)
		return { ok: false, resp: fail(`token exchange failed: ${tok.error}`) };
	return { ok: true, id_token: tok.id_token, st };
};

// id_token verify + session mint — the second half of /console/callback
const consoleCallbackTail = async (
	req: Request,
	id_token: string,
	st: LoginState,
): Promise<Response> => {
	const me = meFor(req);
	const cfg = oidcConfig(readBoardSettings().settings);
	if (!cfg)
		return new Response(loginPage({ configured: false }, me), {
			headers: HTML_HDRS(),
		});
	const idt = await verifyIdToken(id_token, {
		iss: cfg.issuer,
		audience: cfg.clientId,
		discovery: discoveryUrl(cfg.issuer),
		nonce: st.nonce,
	});
	if (!idt.ok)
		return new Response(
			loginPage(
				{ configured: true, error: `id_token rejected: ${idt.error}` },
				me,
			),
			{
				headers: HTML_HDRS(),
			},
		);
	const sub = idt.claims.sub;
	const user = idt.username ?? (typeof sub === "string" ? sub : "unknown-user");
	return finishLogin(user);
};

const HTML_HDRS = (setCookie?: string): Headers => {
	const h = new Headers({ "content-type": "text/html; charset=utf-8" });
	if (setCookie) h.set("set-cookie", setCookie);
	h.set("cache-control", "no-store");
	return h;
};

export async function handleConsole(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/console")
		return Response.redirect(new URL("/console/belt", url).toString(), 302);
	if (url.pathname === "/console/belt") {
		const me = consoleMe();
		return new Response(await beltPage(await gatherBeltView(), me), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}
	if (url.pathname === "/console/local")
		return new Response(localPage(gatherLocalView(), consoleMe()), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	if (url.pathname === "/api/console/me") {
		// avatar dropdown data: the console session's actor (cookie; falls back
		// to the host's latest stamped session, then the settings default) +
		// tags + known actors + W175 login state
		const m = meFor(req);
		return json({
			ok: true,
			actor: m.actor,
			tags: m.tags,
			actors: m.actors,
			default_actor: m.defaultActor,
			user: m.user,
			has_login: m.hasLogin,
		});
	}
	if (url.pathname === "/console/spend") {
		// self-service my-spend: the console session's actor, real usage + W141
		// budget counters + the actor's auth_events tail
		const m = meFor(req);
		const rawDays = Number(url.searchParams.get("days") ?? 28) || 28;
		const days = Math.min(90, Math.max(1, rawDays));
		const usage = actorUsage(db, m.actor, days);
		return new Response(
			spendPage(
				{
					actor: m.actor,
					user: m.user,
					days,
					tokens: usage.tokens,
					requests: usage.requests,
					byDay: usage.byDay,
					byModel: usage.byModel,
					budgets: actorBudgets(db, m.actor),
					events: actorAuthEvents(db, m.actor),
				},
				m,
			),
			{ headers: HTML_HDRS() },
		);
	}
	if (url.pathname === "/console/login" && req.method === "GET") {
		const cfg = oidcConfig(readBoardSettings().settings);
		if (!cfg)
			return new Response(loginPage({ configured: false }, meFor(req)), {
				headers: HTML_HDRS(),
			});
		try {
			const endpoints = await oidcDiscover(cfg);
			const pk = pkce();
			const st = newLoginState();
			const target = authorizeUrl({
				endpoints,
				clientId: cfg.clientId,
				redirectUri: redirectUriFor(req),
				state: st.state,
				challenge: pk.challenge,
				nonce: st.nonce,
			});
			const h = new Headers({ location: target });
			h.set(
				"set-cookie",
				cookieHeader(STATE_COOKIE, signValue(st), STATE_TTL_S),
			);
			h.set("cache-control", "no-store");
			return new Response(null, { status: 302, headers: h });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return new Response(
				loginPage({ configured: true, error: msg }, meFor(req)),
				{
					headers: HTML_HDRS(),
				},
			);
		}
	}
	if (url.pathname === "/console/settings") {
		const pol = resolvePolicy({ beltRepo: BELT_REPO });
		let gw: PolicyGatewayParsed | null = null;
		let perr: string | null = null;
		if (pol) {
			try {
				gw = parsePolicy(pol.text);
			} catch (e) {
				perr = e instanceof ConfigError ? e.message : String(e);
			}
		}
		return new Response(
			settingsIndexPage({
				pol: pol
					? {
							path: pol.path,
							source: pol.source,
							gateway: gw,
							error: perr,
						}
					: null,
				set: readBoardSettings(),
				me: consoleMe(),
			}),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (url.pathname.startsWith("/console/settings/") && req.method === "GET") {
		// settings form pages — one per feature with its REAL config surface
		const f = url.pathname.slice("/console/settings/".length);
		if (f !== "belt" && f !== "buckle" && f !== "suspenders")
			return new Response("not found", { status: 404 });
		const feature: Feature = f;
		const pol = resolvePolicy({ beltRepo: BELT_REPO });
		let gw: PolicyGatewayParsed | null = null;
		let perr: string | null = null;
		if (pol) {
			try {
				gw = parsePolicy(pol.text);
			} catch (e) {
				perr = e instanceof ConfigError ? e.message : String(e);
			}
		}
		return new Response(
			settingsFormPage(
				feature,
				{
					gateway: gw,
					polError: perr,
					target:
						feature === "suspenders"
							? readBoardSettings().path
							: scrub(policyWritePath()),
					set: readBoardSettings(),
				},
				consoleMe(),
			),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (req.method === "POST" && url.pathname === "/console/settings/preview") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const f = new URLSearchParams(await req.text());
		const feat = f.get("feature") ?? "";
		if (feat !== "belt" && feat !== "buckle" && feat !== "suspenders")
			return json({ ok: false, error: "unknown feature" }, 400);
		const me = consoleMe();
		return feat === "suspenders"
			? suspPreview(f, me)
			: policyPreview(feat, f, me);
	}
	if (req.method === "POST" && url.pathname === "/console/settings/apply") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const f = new URLSearchParams(await req.text());
		try {
			return settingsApply(f);
		} catch (e) {
			const a = {
				feature: f.get("feature") ?? "belt",
				diff: [] as string[],
				valuesJson: "",
				mtimeMs: "0",
				target: scrub(policyWritePath()),
				error: e instanceof Error ? e.message : String(e),
			};
			return new Response(previewPage(a, consoleMe()), {
				headers: htmlHdr(),
			});
		}
	}
	if (url.pathname === "/console/callback" && req.method === "GET") {
		const r = await oidcIdTokenFromCode(req, url);
		if (!r.ok) return r.resp;
		return consoleCallbackTail(req, r.id_token, r.st);
	}
	if (req.method === "POST" && url.pathname === "/console/actor") {
		// the LIVE actor switch: stamps the session cookie + the auth ledger
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const body = (await req.json().catch(() => ({}))) as { actor?: string };
		const actor = (body.actor ?? "").trim().slice(0, 200);
		const base = consoleMe();
		const m = meFor(req);
		const allowed = new Set(
			[...base.actors, base.defaultActor, m.actor].filter(Boolean),
		);
		if (m.user) allowed.add(m.user);
		if (!actor || !allowed.has(actor))
			return json(
				{ ok: false, error: "unknown actor", actors: [...allowed].sort() },
				400,
			);
		const sess: ConsoleSession = {
			user: m.user ?? undefined,
			actor,
			exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
		};
		authEvent(m.user ?? actor, "actor_switched", `console: ${actor}`);
		const h = new Headers();
		h.set(
			"set-cookie",
			cookieHeader(SESSION_COOKIE, signValue(sess), SESSION_TTL_S),
		);
		h.set("cache-control", "no-store");
		return new Response(JSON.stringify({ ok: true, actor }), {
			headers: h,
		});
	}
	if (req.method === "POST" && url.pathname === "/console/logout") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const m = meFor(req);
		if (m.user) authEvent(m.user, "logout", "console");
		const h = new Headers({ location: "/console/belt" });
		h.set("set-cookie", clearCookieHeader(SESSION_COOKIE));
		h.set("cache-control", "no-store");
		return new Response(null, { status: 303, headers: h });
	}
	return null;
}
