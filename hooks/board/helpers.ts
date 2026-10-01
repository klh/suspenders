// hooks/board/helpers.ts — http response helpers: json(), writeGuard(), readJson() (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { BIND } from "./context.ts";
import { sessions, board, payload } from "./data.ts";

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// write endpoints are for the human at this board. Two paths:
//  • browser (Origin present): same-origin only — Origin host must equal the
//    Host header (CSRF protection). The nginx front only routes trusted
//    names (default_server 444), so a non-loopback Host here is the proxy.
//  • non-browser (no Origin — curl, hooks): Host must be loopback or the
//    configured bind (DNS-rebind protection).
export function writeGuard(req: Request, _url: URL): Response | null {
	const host = (req.headers.get("host") ?? "").toLowerCase().replace(/\.$/, "");
	if (req.headers.get("origin")) {
		let ohost = "";
		try {
			ohost = new URL(req.headers.get("origin") as string).host
				.toLowerCase()
				.replace(/\.$/, "");
		} catch {
			return json({ ok: false, error: "bad origin" }, 403);
		}
		if (!host || ohost !== host)
			return json({ ok: false, error: "cross-origin request" }, 403);
		return null;
	}
	const hname = host.replace(/:\d+$/, "");
	const okHost =
		["localhost", "127.0.0.1", "::1", "[::1]", "[0:0:0:0:0:0:0:1]"].includes(
			hname,
		) ||
		hname === BIND.toLowerCase() ||
		hname === `[${BIND.toLowerCase()}]`;
	if (!host || !okHost)
		return json({ ok: false, error: "untrusted host" }, 403);
	return null;
}

// JSON-body endpoints must declare application/json (a plain form POST from
// another site can't forge it cross-origin) and must parse.
export async function readJson(
	req: Request,
): Promise<
	{ ok: true; body: Record<string, unknown> } | { ok: false; resp: Response }
> {
	const ct = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (ct !== "application/json")
		return {
			ok: false,
			resp: json(
				{ ok: false, error: "content-type must be application/json" },
				415,
			),
		};
	try {
		return { ok: true, body: await req.json() };
	} catch {
		return {
			ok: false,
			resp: json({ ok: false, error: "malformed json body" }, 400),
		};
	}
}

// failure notes ride the work.failed event payload ($.work = item id) — the
// board shows why a lane died, not just that it died
// W64 ship-trigger helpers — merging a lane branch is safe only when no live
// lane still owns it. Two registries: .fleet/lanes.json (dispatched lanes,
// pid-guard) and the sessions table (interactive lanes — hb updates only at
// bootstrap, so the transcript mtime is the liveness signal, per the zombie
// lesson); the ladder comes from <repo>/.fleet/ship.json (owner config).
