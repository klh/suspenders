// hooks/lib/auth-client.ts — W149: the client-side refresher. Belt (gateway)
// holds the refresh token; lanes and local LLM services call authFetch and
// never see expiry: it refreshes PROACTIVELY inside a 60s skew window
// (exp - now < skew) or REACTIVELY on a 401 (retry once). Raw tokens land in
// the sanctioned secrets home (~/.claude/local-llm/, mode 600) via
// saveTokenFiles/loadTokenFiles; the onRefresh callback lets the caller
// persist rotation results.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretsHome } from "./auth.ts";

export interface TokenPair {
	access: string;
	refresh: string;
}

// unverified exp read (seconds) — a freshness HINT, never an authz decision
export function decodeExp(token: string): number | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const p = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as {
			exp?: number;
		};
		return typeof p.exp === "number" ? p.exp : null;
	} catch {
		return null;
	}
}
export const tokenFileBase = (base: string): string =>
	join(secretsHome(), `buckle-${base}`);

export function saveTokenFiles(base: string, pair: TokenPair): void {
	const p = tokenFileBase(base);
	writeFileSync(`${p}.token`, pair.access, { mode: 0o600 });
	writeFileSync(`${p}.refresh`, pair.refresh, { mode: 0o600 });
	chmodSync(`${p}.token`, 0o600);
	chmodSync(`${p}.refresh`, 0o600);
}

export function loadTokenFiles(base: string): TokenPair | null {
	const p = tokenFileBase(base);
	try {
		return {
			access: readFileSync(`${p}.token`, "utf8").trim(),
			refresh: readFileSync(`${p}.refresh`, "utf8").trim(),
		};
	} catch {
		return null;
	}
}
export interface AuthFetchOpts {
	baseUrl: string;
	access: string;
	refresh: string;
	// refresh when exp - now < skew (default 60s, per the W149 brief)
	skewMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
	onRefresh?: (next: TokenPair) => void;
}
// the never-see-expiry fetch wrapper: proactive refresh inside the skew
// window, reactive refresh + RETRY ONCE on a 401.
export function authFetch(
	o: AuthFetchOpts,
): (path: string, init?: RequestInit) => Promise<Response> {
	const f = o.fetchImpl ?? fetch;
	const now = o.now ?? Date.now;
	const skew = o.skewMs ?? 60_000;
	let access = o.access;
	let refresh = o.refresh;
	const doRefresh = async (): Promise<boolean> => {
		const r = await f(`${o.baseUrl}/auth/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: refresh }),
		});
		if (!r.ok) return false;
		const b = (await r.json()) as {
			access_token: string;
			refresh_token: string;
		};
		access = b.access_token;
		refresh = b.refresh_token;
		o.onRefresh?.({ access, refresh });
		return true;
	};
	return (path, init = {}) => {
		const send = (tok: string): Promise<Response> =>
			f(`${o.baseUrl}${path}`, {
				...init,
				headers: { ...init.headers, authorization: `Bearer ${tok}` },
			});
		const run = async (): Promise<Response> => {
			const exp = decodeExp(access);
			if (exp !== null && exp * 1000 - now() < skew) await doRefresh();
			let res = await send(access);
			if (res.status === 401 && (await doRefresh())) res = await send(access);
			return res;
		};
		return run();
	};
}
