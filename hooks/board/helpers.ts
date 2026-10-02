// hooks/board/helpers.ts — http response helpers: json(), writeGuard(),
// hostCheck(), readJson() (W157 board split; W188 write auth).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { createHash, timingSafeEqual } from "node:crypto";
import { BIND } from "./context.ts";

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// write endpoints are for the human at this board, and every one of them
// flows through writeGuard(). Two independent gates:
//
//  • bearer gate (W188) — on when SUSPENDERS_BOARD_TOKEN is set (runtime
//    config, never code): the request must present it as an
//    `Authorization: Bearer` header or a `board_token` cookie (browser
//    bootstrap: POST /console/token). Constant-time compare. 401 without.
//  • host trust — the Host header must be an allowlisted name in BOTH
//    branches (loopback names, SUSPENDERS_BIND, the published
//    suspenders.local mDNS name, SUSPENDERS_BOARD_HOSTS extras). The
//    browser branch's same-origin check alone is rebindable:
//    attacker.example -> 127.0.0.1 makes origin == host ==
//    attacker.example, which passes same-origin but must still fail the
//    allowlist (DNS-rebind protection).
export function writeGuard(req: Request, _url: URL): Response | null {
	if (process.env.SUSPENDERS_BOARD_TOKEN) {
		const presented = bearerOf(req) ?? cookieToken(req);
		if (!presented || !tokenOk(presented))
			return new Response(
				JSON.stringify({ ok: false, error: "board token required" }),
				{
					status: 401,
					headers: {
						"content-type": "application/json",
						"www-authenticate": 'Bearer realm="suspenders-board"',
					},
				},
			);
	}
	return hostCheck(req);
}

// host trust only, no bearer — the /console/token bootstrap uses this: that
// route mints the cookie every guarded write accepts, so demanding the
// bearer there would be circular. The token in its body IS the credential.
export function hostCheck(req: Request): Response | null {
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
		if (!trustedHost(host.replace(/:\d+$/, "")))
			return json({ ok: false, error: "untrusted host" }, 403);
		return null;
	}
	const hname = host.replace(/:\d+$/, "");
	if (!host || !trustedHost(hname))
		return json({ ok: false, error: "untrusted host" }, 403);
	return null;
}

// the Host allowlist: loopback names, the configured bind, the board's own
// published mDNS name (llms.txt publishes it; dns-sd advertises it), plus
// SUSPENDERS_BOARD_HOSTS extras (comma-separated). Bracketed IPv6 and a
// trailing root dot normalize away before the compare.
export function trustedHost(hname: string): boolean {
	const norm = (s: string) =>
		s.toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");
	const h = norm(hname);
	if (["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(h))
		return true;
	if (h === norm(BIND)) return true;
	if (h === "suspenders.local") return true;
	return (process.env.SUSPENDERS_BOARD_HOSTS ?? "")
		.split(",")
		.map((s) => norm(s.trim()))
		.includes(h);
}

// SUSPENDERS_BOARD_TOKEN is the gate secret (env/runtime config). Comparing
// sha256 digests keeps timingSafeEqual length-independent.
export function tokenOk(presented: string): boolean {
	const tok = process.env.SUSPENDERS_BOARD_TOKEN;
	if (!tok) return true;
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(tok).digest();
	return timingSafeEqual(a, b);
}

// `Authorization: Bearer <token>` (scheme case-insensitive) or null
export function bearerOf(req: Request): string | null {
	const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
	return m ? m[1] : null;
}

// the `board_token` cookie POST /console/token mints, or null
export function cookieToken(req: Request): string | null {
	const m = (req.headers.get("cookie") ?? "").match(
		/(?:^|;\s*)board_token=([^;\s]+)/,
	);
	return m ? decodeURIComponent(m[1]) : null;
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
