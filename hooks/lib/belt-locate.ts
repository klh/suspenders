// hooks/lib/belt-locate.ts — W91 #9a: belt is a NAMED SERVICE, not an
// address. resolveBelt() walks a fallback chain and returns url + auth; every
// belt-calling path (knowledge worker distill, advise.ts) resolves through
// it — nothing in the knowledge layer hardcodes a belt address, and in an
// enterprise deployment "belt" is the customer's gateway (APIM/Foundry):
// same resolver, their config, the caller cannot tell the difference.
//
// chain: env override → operator config → DNS-style belt.local (klh-local/
// Caddy registry) → same-box dev default → null (callers degrade: queued
// jobs stay queued and retry — durability, never loss).
import { readFileSync } from "node:fs";

export interface BeltLocation {
	url: string;
	token?: string;
	via: string;
}

// bearer bootstrap: belt-tokens.json first key (the advise.ts pattern) —
// secrets live in ~/.claude/local-llm/, never in any repo
export function beltTokenFromFile(): string | undefined {
	try {
		const keys = Object.keys(
			JSON.parse(
				readFileSync(
					`${process.env.HOME}/.claude/local-llm/belt-tokens.json`,
					"utf8",
				),
			) as Record<string, unknown>,
		);
		return keys[0];
	} catch {
		return undefined;
	}
}

// a server that answers AT ALL counts as present (even a 404) — we are
// locating a host, not a route
async function alive(base: string): Promise<boolean> {
	for (const path of ["/api/health", "/"]) {
		try {
			await fetch(base.replace(/\/$/, "") + path, {
				signal: AbortSignal.timeout(1500),
			});
			return true; // any HTTP answer = something is listening
		} catch {}
	}
	return false;
}

export async function resolveBelt(): Promise<BeltLocation | null> {
	// 1. explicit env override
	const envUrl = process.env.SUSPENDERS_BELT_URL;
	if (envUrl)
		return {
			url: envUrl.replace(/\/$/, ""),
			token: process.env.SUSPENDERS_BELT_TOKEN ?? beltTokenFromFile(),
			via: "env",
		};
	// 2. operator-pinned config (mode 600, secrets never in repo)
	try {
		const cfg = JSON.parse(
			readFileSync(`${process.env.HOME}/.claude/local-llm/belt.json`, "utf8"),
		) as { url?: string; token?: string };
		if (cfg.url)
			return {
				url: cfg.url.replace(/\/$/, ""),
				token: cfg.token ?? beltTokenFromFile(),
				via: "config belt.json",
			};
	} catch {}
	const token = beltTokenFromFile();
	// 3. DNS-style: belt.local — the klh-local/Caddy registry advertises it
	// 4. mDNS/DNS-SD browse lands here too: probing the candidate host reuses
	//    the remotes.ts discovery pattern (locate a listening endpoint)
	for (const cand of ["http://belt.local", "http://belt.local:7791"]) {
		if (await alive(cand)) return { url: cand, token, via: "dns belt.local" };
	}
	// 5. last resort: same-box dev default
	const def = "http://127.0.0.1:7791";
	if (await alive(def)) return { url: def, token, via: "localhost default" };
	return null; // belt unreachable — callers degrade, never lose jobs
}
