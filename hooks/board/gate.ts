// hooks/board/gate.ts — W172: the board's LAN trust gate. The board is a
// single-user control plane; the trust model has three rules:
//
//   1. Default posture is loopback-only (127.0.0.1) — zero-config for the one
//      human on the host.
//   2. LAN exposure rides the Caddy PQ-TLS edge (klh-local, suspenders.local
//      → 127.0.0.1:7799) and terminates at that proxy — the board itself
//      never needs a raw LAN bind; when an operator insists on one, the
//      shared-secret gate must be on.
//   3. Shared-secret gate: SUSPENDERS_BOARD_TOKEN set → EVERY request (reads,
//      writes, /status, /metrics) must carry `Authorization: Bearer <token>`,
//      compared constant-time. A non-loopback bind without the token refuses
//      to start.
//
// This is a gate, not an auth system: no accounts, no sessions, no auth-code
// module. Intentionally dependency-free (node:crypto only) so helpers.ts can
// import the wildcard rule without an import cycle.
import { createHash, timingSafeEqual } from "node:crypto";

export const boardToken = (): string =>
	process.env.SUSPENDERS_BOARD_TOKEN ?? "";

// a wildcard bind name is "every interface" — never a trust anchor (Host
// headers can name it from anywhere, so writeGuard must not accept it)
export const wildcardBind = (bind: string): boolean =>
	["", "0.0.0.0", "::", "[::]", "*"].includes(bind.trim().toLowerCase());

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

export const isLoopbackBind = (bind: string): boolean =>
	LOOPBACK_BINDS.has(bind.trim().toLowerCase());

// Start-time trust check. Returns null when the posture is acceptable, else
// the refusal reason (fleet-board.ts prints it and exits 1).
export function bindTrustError(bind: string, token: string): string | null {
	if (isLoopbackBind(bind)) return null;
	if (!token)
		return `refusing to bind ${bind} unauthenticated — LAN exposure needs the shared-secret gate (export SUSPENDERS_BOARD_TOKEN) or the loopback default (unset SUSPENDERS_BIND; LAN access rides the Caddy PQ-TLS edge)`;
	return null;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

// Constant-time shared-secret compare: digest both sides first — equal
// digests mean equal secrets, and timingSafeEqual never sees unequal lengths.
export const secretMatches = (presented: string, secret: string): boolean =>
	presented.length > 0 && timingSafeEqual(sha256(presented), sha256(secret));

const bearerToken = (req: Request): string => {
	const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
	return m?.[1] ? m[1].trim() : "";
};

// Request gate: when the token is set, EVERY request must present it —
// reads and writes, /status and /metrics included (the metrics carry the
// per-project token aggregates the W172 mission calls out).
export function trustGate(req: Request, token: string): Response | null {
	if (!token) return null;
	if (secretMatches(bearerToken(req), token)) return null;
	return new Response(
		JSON.stringify({
			ok: false,
			error: "unauthorized",
			hint: "this board is gated — send Authorization: Bearer $SUSPENDERS_BOARD_TOKEN",
		}),
		{
			status: 401,
			headers: { "content-type": "application/json" },
		},
	);
}

// Serve-side wrapper: the gate wraps OUTSIDE servicemon so its /status and
// /metrics are gated too (sm.wrapped(gated(...)) would leave them open).
export function gated(
	token: string,
	next: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
	return (req) => {
		const deny = trustGate(req, token);
		return deny ? Promise.resolve(deny) : next(req);
	};
}
