#!/usr/bin/env bun
// hooks/bin/soak.ts — W179.3 nightly real-provider soak, thin CLI over
// hooks/lib/soak.ts. launchd (com.suspenders.soak, nightly 03:15) runs it
// with tiny caps; humans run it ad hoc (--iters 1) as a real-upstream probe.
// Belt resolves through the shared chain (hooks/lib/belt-locate.ts: env →
// belt.json → belt.local → localhost:7791).
//
//   bun hooks/bin/soak.ts [--iters N] [--max-usd X] [--max-tokens N]
//       [--max-minutes M] [--gap-ms MS] [--max-tokens-per-call N]
//       [--url URL] [--token TOK] [--role ROLE] [--pricing FILE]
//
// Env (plist/install-time): SOAK_MAX_USD SOAK_MAX_TOKENS SOAK_ITERS
// SOAK_MAX_MINUTES SOAK_GAP_MS SOAK_MAX_TOKENS_PER_CALL SOAK_ROLE
// SOAK_URL SOAK_TOKEN
// Exit: 0 clean or cap-hit (the cap working), 2 = REDs, 1 = belt unreachable.
import { resolveBelt } from "../lib/belt-locate.ts";
import {
	classifyExit,
	loadPricing,
	runSoak,
	soakCapsFromEnv,
} from "../lib/soak.ts";

const flag = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

// CLI flag over env default — a bad flag value falls back to the default
// rather than NaN-poisoning the caps (same guard as lib num())
const over = (raw: string | undefined, base: number): number => {
	if (raw === undefined) return base;
	const v = Number(raw);
	return Number.isFinite(v) && v >= 0 ? v : base;
};

const envCaps = soakCapsFromEnv();
const caps = {
	maxUsd: over(flag("--max-usd"), envCaps.maxUsd),
	maxTokens: over(flag("--max-tokens"), envCaps.maxTokens),
	iters: over(flag("--iters"), envCaps.iters),
	maxMinutes: over(flag("--max-minutes"), envCaps.maxMinutes),
	gapMs: over(flag("--gap-ms"), envCaps.gapMs),
	maxTokensPerCall: over(
		flag("--max-tokens-per-call"),
		envCaps.maxTokensPerCall,
	),
};

const run = async (): Promise<0 | 1 | 2> => {
	const url = flag("--url");
	const belt = url
		? {
				url: url.replace(/\/$/, ""),
				token: flag("--token") ?? undefined,
			}
		: await resolveBelt();
	if (belt === null) {
		console.log(
			"[err ] belt unreachable — chain: SUSPENDERS_BELT_URL → ~/.claude/local-llm/belt.json → belt.local → localhost:7791",
		);
		return 1;
	}
	// bearer: explicit flag → belt-locate's resolved token (the
	// belt-tokens.json key — verified live against :7791, W179.3)
	const token = flag("--token") ?? belt.token;
	const table = await loadPricing(flag("--pricing"));
	console.log(
		`soak ${String(new Date().toISOString())} belt=${belt.url} (via ${belt.via}) role=${String(flag("--role") ?? "general")} caps: usd=${String(caps.maxUsd)} tokens=${String(caps.maxTokens)} iters=${String(caps.iters)} min=${String(caps.maxMinutes)}`,
	);
	const result = await runSoak({
		belt: { url: belt.url, token },
		caps,
		table,
		role: flag("--role") ?? undefined,
		log: (row) => {
			console.log(`[${row.out.toLowerCase()}] ${row.name} — ${row.note}`);
		},
	});
	const m = result.meter;
	const pass = result.rows.filter((r) => r.out === "PASS").length;
	const red = result.rows.filter((r) => r.out === "RED").length;
	const err = result.rows.filter((r) => r.out === "ERR").length;
	console.log(
		`summary: ${String(pass)} pass, ${String(red)} red, ${String(err)} err — stop=${result.stop} calls=${String(m.calls)} in=${String(m.inTok)} out=${String(m.outTok)} unpriced=${String(m.unpricedCalls)} usd=${String(m.usd.toFixed(4))}`,
	);
	return classifyExit(result);
};

if (import.meta.main) process.exit(await run());
