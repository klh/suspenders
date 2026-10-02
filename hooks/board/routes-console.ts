// hooks/board/routes-console.ts — W147 console: /console /console/belt /console/local /api/console/me /console/settings(+preview/apply) (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { BELT_REPO } from "./context.ts";
import { json, writeGuard, hostCheck, tokenOk, bearerOf } from "./helpers.ts";
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
	previewPage,
	settingsFormPage,
	settingsIndexPage,
} from "../bin/console-html.ts";

// board_token cookie: HttpOnly + SameSite=Lax (a cross-site form POST does
// not carry it), 30-day lifetime; http LAN board, so no Secure flag
const tokenCookie = (tok: string): string =>
	`board_token=${encodeURIComponent(tok)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;

// one-field bootstrap page: paste SUSPENDERS_BOARD_TOKEN once, get the
// cookie every guarded write accepts
const tokenPage = (err?: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>board write auth</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { background:#141413; color:#e8e6e1; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; }
form { background:#1c1b19; border:1px solid rgba(255,255,255,.12); border-radius:2px; padding:22px; width:min(380px,92vw); }
h1 { font-size:13px; letter-spacing:.08em; text-transform:uppercase; margin:0 0 8px; }
p { color:#98958e; margin:0 0 12px; }
input { width:100%; background:#141413; color:#e8e6e1; border:1px solid rgba(255,255,255,.18); border-radius:2px; padding:7px 9px; font:inherit; }
input:focus { outline:1px solid #d8900f; }
.btnrow { display:flex; gap:8px; margin-top:12px; align-items:center; }
button { background:#d8900f; color:#141413; border:1px solid #d8900f; border-radius:2px; padding:6px 14px; font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.err { color:#c96a4f; margin:10px 0 0; }
</style></head><body>
<form method="post" action="/console/token">
<h1>Board write auth</h1>
<p>Writes are gated on this board's SUSPENDERS_BOARD_TOKEN (runtime config). Paste it once &mdash; it lands as a board_token cookie every guarded write accepts, and stays in this browser for 30 days.</p>
<input type="password" name="token" placeholder="SUSPENDERS_BOARD_TOKEN" autofocus required>
<div class="btnrow"><button type="submit">store token</button></div>
${err ? `<p class="err">${err}</p>` : ""}
</form>
</body></html>`;

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
		// avatar dropdown data: board host's latest actor (unassigned until
		// coord bootstrap --actor stamps it) + tags + distinct known actors
		// + the settings-file default for the demo select
		const m = consoleMe();
		return json({
			ok: true,
			actor: m.actor,
			tags: m.tags,
			actors: m.actors,
			default_actor: m.defaultActor,
			executor_prefs: readBoardSettings().settings.default_executors ?? [],
		});
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
	if (req.method === "GET" && url.pathname === "/console/token") {
		return new Response(tokenPage(), { headers: htmlHdr() });
	}
	if (req.method === "POST" && url.pathname === "/console/token") {
		const guard = hostCheck(req);
		if (guard) return guard;
		const hdr = bearerOf(req);
		if (hdr) {
			if (!tokenOk(hdr)) return json({ ok: false, error: "bad token" }, 401);
			return new Response(JSON.stringify({ ok: true }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": tokenCookie(hdr),
				},
			});
		}
		const ct = (req.headers.get("content-type") ?? "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		if (ct !== "application/x-www-form-urlencoded")
			return json(
				{ ok: false, error: "expected the form or an Authorization header" },
				415,
			);
		const f = new URLSearchParams(await req.text());
		const tok = f.get("token") ?? "";
		if (!tokenOk(tok)) {
			return new Response(
				tokenPage("no — that is not this board's SUSPENDERS_BOARD_TOKEN"),
				{ status: 401, headers: htmlHdr() },
			);
		}
		return new Response(null, {
			status: 303,
			headers: {
				location: "/console/settings",
				"set-cookie": tokenCookie(tok),
			},
		});
	}
	return null;
}
