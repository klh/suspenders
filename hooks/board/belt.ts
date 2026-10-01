// hooks/board/belt.ts — belt endpoint probing (check + registry + locality, 60s caches) (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { CLI, BELT_REPO } from "./context.ts";
import { json } from "./helpers.ts";
import { board } from "./data.ts";
import { resolveBelt } from "../lib/belt-locate.ts";

export interface BeltEndpoint {
	machine?: string;
	port?: number;
	protocol?: string;
	model?: string;
	ok?: boolean;
	roles?: string[];
	ip?: string;
	host?: string;
}
export let beltCache: { at: number; rows: BeltEndpoint[] } | null = null;
export const beltCheck = async (): Promise<BeltEndpoint[]> => {
	if (beltCache && Date.now() - beltCache.at < 60_000) return beltCache.rows;
	let rows: BeltEndpoint[] = [];
	try {
		const p = Bun.spawn(
			[process.execPath, `${BELT_REPO}/bin/remotes.ts`, "check", "--json"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const out = await new Response(p.stdout).text();
		await p.exited;
		const parsed: unknown = JSON.parse(out);
		if (Array.isArray(parsed)) rows = parsed as BeltEndpoint[];
	} catch {}
	beltCache = { at: Date.now(), rows };
	return rows;
};
// W105 — model + locality visibility. belt's registry at the resolveBelt
// chain (belt-locate.ts: env → belt.json → belt.local → localhost:7791) with
// the belt-tokens.json bearer; the remotes.ts CLI spawn stays as the fallback
// when belt's HTTP API is unreachable. Cached 60s — the board polls every
// second, the probes are multi-second.
export let regCache: { at: number; rows: BeltEndpoint[] } | null = null;
export const beltRegistry = async (): Promise<BeltEndpoint[]> => {
	if (regCache && Date.now() - regCache.at < 60_000) return regCache.rows;
	let rows: BeltEndpoint[] = [];
	const belt = await resolveBelt();
	if (belt) {
		try {
			const r = await fetch(`${belt.url}/api/remotes`, {
				headers: belt.token ? { authorization: `Bearer ${belt.token}` } : {},
				signal: AbortSignal.timeout(5000),
			});
			if (r.ok) {
				const j = (await r.json()) as { rows?: BeltEndpoint[] };
				if (Array.isArray(j.rows)) rows = j.rows;
			}
		} catch {}
	}
	if (!rows.length) rows = await beltCheck(); // same registry, CLI path
	regCache = { at: Date.now(), rows };
	return rows;
};
// LOCAL = LAN/loopback endpoint (private ip, .local mDNS name); REMOTE =
// everything else — the routing doctrine's default (glm-5.3-flash via z.ai)
// and the stock CLI model endpoints (Anthropic/OpenAI) are cloud-hosted.
export const rowLocality = (r: {
	ip?: string;
	host?: string;
}): "local" | "remote" => {
	const ip = r.ip ?? "";
	const host = (r.host ?? "").toLowerCase();
	return host.endsWith(".local") ||
		ip === "::1" ||
		ip.startsWith("127.") ||
		ip.startsWith("192.168.") ||
		ip.startsWith("10.") ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(ip)
		? "local"
		: "remote";
};
// one bun sibling-CLI call — stdout+stderr folded, trimmed
