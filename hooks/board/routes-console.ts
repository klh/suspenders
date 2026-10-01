// hooks/board/routes-console.ts — W147 console: /console /console/belt /console/local /api/console/me /console/settings(+preview/apply) (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { BELT_REPO, db } from "./context.ts";
import { json, writeGuard } from "./helpers.ts";
import { recentAdminAudit } from "../lib/admin-audit.ts";
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
		// coord bootstrap --actor bootstrap... see console-view's consoleMe
		const m = consoleMe();
		return json({
			ok: true,
			actor: m.actor,
			tags: m.tags,
			actors: m.actors,
			default_actor: m.defaultActor,
		});
	}
	if (url.pathname === "/api/console/audit") {
		// W174: the admin-action trail as JSON — settings/policy applies and
		// key revocations, newest first; ?limit= clamps to 1..200
		const limit = Math.min(
			200,
			Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25),
		);
		return json({ ok: true, audit: recentAdminAudit(db, limit) });
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
				audit: recentAdminAudit(db, 25),
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
	return null;
}
