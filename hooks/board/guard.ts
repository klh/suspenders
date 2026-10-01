// hooks/board/guard.ts — W155 http-citizenship method discipline at the board
// entry (docs/design/http-citizenship.md): OPTIONS → 204 + Allow everywhere;
// known write endpoints are POST-only (405 + Allow); other /api/* read feeds
// are GET/HEAD-only (405 + Allow). The write set mirrors the LLMS_TXT
// "Write endpoints" contract — one contract, two views.
export const BOARD_WRITES: ReadonlySet<string> = new Set([
	"/api/answer",
	"/api/ack",
	"/api/advise",
	"/api/comment",
	"/api/message",
	"/api/start",
	"/api/ship",
	"/api/orchestrate",
	"/api/orchestrate/register",
	"/console/settings/preview",
	"/console/settings/apply",
]);

// Unit-tested (test/citizenship.test.ts) and wired in bin/fleet-board.ts
// before the route-module chain; returns null when the request may proceed.
export function methodGuard(req: Request, url: URL): Response | null {
	const p = url.pathname;
	if (req.method === "OPTIONS")
		return new Response(null, {
			status: 204,
			headers: {
				allow: BOARD_WRITES.has(p)
					? "POST, OPTIONS"
					: "GET, HEAD, POST, OPTIONS",
			},
		});
	if (BOARD_WRITES.has(p)) {
		if (req.method === "POST") return null;
		return new Response(null, {
			status: 405,
			headers: { allow: "POST, OPTIONS" },
		});
	}
	if (p.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD")
		return new Response(null, {
			status: 405,
			headers: { allow: "GET, HEAD, OPTIONS" },
		});
	return null;
}
