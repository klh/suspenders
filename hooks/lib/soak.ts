// hooks/lib/soak.ts — W179.3: nightly real-provider soak engine. Library +
// thin CLI (hooks/bin/soak.ts). Drives small REAL completions through belt
// (/api/route) on a schedule, meters observed usage, and stops on hard caps:
//   token cap  — enforced on OBSERVED usage; the request shape also bounds
//                the worst case (iters × per-call max_tokens), so the bound
//                holds even when belt reports no usage at all.
//   USD cap    — enforced on PRICED tokens only; unpriced models are counted
//                but costed as unknown (omit-when-unknown — servicemon
//                doctrine). Pin real $/Mtok in
//                ~/.claude/local-llm/soak-pricing.json to arm it
//                (config-over-code; secrets/config never in a repo).
//   iteration / duration / per-call max_tokens — the bounding box.
// Stop reasons: completed | usd-cap | token-cap | duration-cap | belt-down.
// Exit: 0 clean (a cap hit is the cap WORKING — noted, not failed),
// 2 = REDs, 1 = harness error (belt unreachable). Same row/exit vocabulary
// as sim/smoke.ts. Streams-over-buffers via hooks/lib/http.ts.

import { readCapped } from "./http.ts";

export type Outcome = "PASS" | "RED" | "ERR";
export interface SoakRow {
	name: `soak/${number}/${string}`;
	out: Outcome;
	note: string;
}

export type StopReason =
	| "completed"
	| "usd-cap"
	| "token-cap"
	| "duration-cap"
	| "belt-down";

export interface Caps {
	maxUsd: number; // 0 disables the USD cap
	maxTokens: number; // observed usage tokens; 0 disables
	iters: number; // max route iterations
	maxMinutes: number; // wall-clock bound; 0 disables
	gapMs: number; // sleep between iterations
	maxTokensPerCall: number; // per-request max_tokens bound
}

const num = (raw: string | undefined, fallback: number): number => {
	const v = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
};

export const soakCapsFromEnv = (
	env: Record<string, string | undefined> = process.env,
): Caps => ({
	maxUsd: num(env.SOAK_MAX_USD, 0.25),
	maxTokens: num(env.SOAK_MAX_TOKENS, 40_000),
	iters: num(env.SOAK_ITERS, 48),
	maxMinutes: num(env.SOAK_MAX_MINUTES, 20),
	gapMs: num(env.SOAK_GAP_MS, 2_000),
	maxTokensPerCall: num(env.SOAK_MAX_TOKENS_PER_CALL, 32),
});

// $/Mtok (in, out). null = pricing unknown — rows say so; the token cap and
// the request-shape bound still hold (a cap that cannot price cannot lie).
export interface Price {
	in: number;
	out: number;
}

// substring rules, first match wins; null price = free tier (local weights)
export type PriceTable = { match: string; price: Price | null }[];

// derivable fact: local weights cost nothing. Mirrors modelGroup()'s local
// arm in hooks/bin/usage-harvest.ts — kept here to avoid the govdb import.
export const DEFAULT_PRICES: PriceTable = [
	{ match: "local", price: { in: 0, out: 0 } },
	{ match: "mlx", price: { in: 0, out: 0 } },
	{ match: "ollama", price: { in: 0, out: 0 } },
	{ match: "gguf", price: { in: 0, out: 0 } },
	{ match: "swarm", price: { in: 0, out: 0 } },
];

// owner-pinned prices: soak-pricing.json = [{match, price:{in,out}|null}],
// read next to belt.json/belt-tokens.json (mode 600, never in a repo)
export const PRICING_FILE = `${process.env.HOME}/.claude/local-llm/soak-pricing.json`;

export const loadPricing = async (path = PRICING_FILE): Promise<PriceTable> => {
	const user = await Bun.file(path)
		.json()
		.catch(() => null);
	if (!Array.isArray(user)) return DEFAULT_PRICES;
	return [...user, ...DEFAULT_PRICES]; // pinned rules win over defaults
};

export const priceFor = (table: PriceTable, model: string): Price | null => {
	const m = model.toLowerCase();
	for (const rule of table) {
		if (m.includes(rule.match.toLowerCase())) return rule.price;
	}
	return null; // unknown — counted, not costed
};

// observed usage: belt may echo anthropic or openai token field names
export interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	prompt_tokens?: number;
	completion_tokens?: number;
}

const pos = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

export interface SpendState {
	usd: number;
	inTok: number;
	outTok: number;
	calls: number;
	unpricedCalls: number; // usage or pricing missing — honest counter
}

export interface MeterAdd {
	charged: number; // USD added by this call
	tokens: number; // observed tokens added
	unknown: boolean; // pricing unknown or usage unreported
}

export const newMeter = (): SpendState & {
	add: (model: string, usage: Usage | undefined, table: PriceTable) => MeterAdd;
	capReason: (caps: Caps) => StopReason | null;
} => {
	const s: SpendState = {
		usd: 0,
		inTok: 0,
		outTok: 0,
		calls: 0,
		unpricedCalls: 0,
	};
	return {
		get usd() {
			return s.usd;
		},
		get inTok() {
			return s.inTok;
		},
		get outTok() {
			return s.outTok;
		},
		get calls() {
			return s.calls;
		},
		get unpricedCalls() {
			return s.unpricedCalls;
		},
		add(model, usage, table) {
			const inTok = pos(usage?.input_tokens ?? usage?.prompt_tokens);
			const outTok = pos(usage?.output_tokens ?? usage?.completion_tokens);
			const price = priceFor(table, model);
			const unknown = price === null || (inTok === 0 && outTok === 0);
			let charged = 0;
			if (price !== null) {
				charged = (inTok * price.in + outTok * price.out) / 1_000_000;
			}
			s.usd += charged;
			s.inTok += inTok;
			s.outTok += outTok;
			s.calls += 1;
			if (unknown) s.unpricedCalls += 1;
			return { charged, tokens: inTok + outTok, unknown };
		},
		capReason(caps) {
			if (caps.maxUsd > 0 && s.usd > caps.maxUsd) return "usd-cap";
			if (caps.maxTokens > 0 && s.inTok + s.outTok > caps.maxTokens)
				return "token-cap";
			return null;
		},
	};
};

export interface SoakDeps {
	belt: { url: string; token?: string };
	caps: Caps;
	table: PriceTable;
	role?: string; // belt routing role (default "general")
	fetcher?: typeof fetch; // injectable — tests never touch the network
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	log?: (row: SoakRow) => void; // live row printer (CLI)
}

export interface SoakResult {
	rows: SoakRow[];
	meter: SpendState;
	stop: StopReason;
}

// one belt status probe — transport failure is belt-down; HTTP-level
// failure is an honest RED (belt answered, something upstream is off)
export const statusOnce = async (
	deps: Pick<SoakDeps, "belt" | "fetcher">,
	i: number,
): Promise<SoakRow> => {
	try {
		const res = await (deps.fetcher ?? fetch)(`${deps.belt.url}/api/status`, {
			headers: deps.belt.token
				? { authorization: `Bearer ${deps.belt.token}` }
				: {},
			signal: AbortSignal.timeout(15_000),
		});
		if (!res) throw new Error("no fetcher");
		const { text } = await readCapped(res);
		return {
			name: `soak/${String(i)}/belt-status`,
			out: res.status === 200 ? "PASS" : "RED",
			note: `GET /api/status ${String(res.status)} ${text.slice(0, 60)}`,
		};
	} catch (e) {
		return {
			name: `soak/${String(i)}/belt-status`,
			out: "ERR",
			note: String(e),
		};
	}
};

// the /api/route outcome: raw fields; the loop meters and narrates
export interface RouteOutcome {
	err?: string; // transport-level failure → belt-down
	ok: boolean; // HTTP 200 + non-empty reply
	status: number;
	ms: number;
	reply: string;
	model: string;
	usage: Usage | undefined;
}

// parse the /api/route response body (capped-read text in, honest fields out)
export const parseRouteBody = (
	text: string,
): { reply: string; model: string; usage: Usage | undefined } => {
	let body: unknown = null;
	try {
		body = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	const b = typeof body === "object" && body !== null ? body : {};
	const reply = typeof b.reply === "string" ? b.reply : "";
	const target =
		typeof b.target === "object" && b.target !== null
			? (b.target as { model?: unknown })
			: {};
	const model = typeof target.model === "string" ? target.model : "belt";
	const usage =
		typeof b.usage === "object" && b.usage !== null
			? (b.usage as Usage)
			: undefined;
	return { reply, model, usage };
};

// one small REAL completion through belt's router (the advise.ts call shape:
// POST /api/route {role, execute:true, max_tokens, temperature, messages})
export const routeOnce = async (deps: SoakDeps): Promise<RouteOutcome> => {
	const t0 = deps.now?.() ?? Date.now();
	try {
		const res = await (deps.fetcher ?? fetch)(`${deps.belt.url}/api/route`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(deps.belt.token
					? { authorization: `Bearer ${deps.belt.token}` }
					: {}),
			},
			body: JSON.stringify({
				role: deps.role ?? "general",
				execute: true,
				max_tokens: deps.caps.maxTokensPerCall,
				temperature: 0,
				messages: [
					{
						role: "user",
						content: `soak ${String(t0)} — reply with the single word ok`,
					},
				],
			}),
			signal: AbortSignal.timeout(120_000),
		});
		const { text } = await readCapped(res);
		const p = parseRouteBody(text);
		return {
			ok: res.status === 200 && p.reply.length > 0,
			status: res.status,
			ms: Math.max(0, Math.round((deps.now?.() ?? Date.now()) - t0)),
			reply: p.reply,
			model: p.model,
			usage: p.usage,
		};
	} catch (e) {
		return {
			err: String(e),
			ok: false,
			status: 0,
			ms: 0,
			reply: "",
			model: "belt",
			usage: undefined,
		};
	}
};

// one soak pass over belt: belt-status + one small REAL completion per
// iteration, capped; never throws — every failure becomes a row + stop
export const runSoak = async (deps: SoakDeps): Promise<SoakResult> => {
	const {
		caps,
		table,
		now = Date.now,
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		log = () => {},
	} = deps;
	const rows: SoakRow[] = [];
	const push = (row: SoakRow): void => {
		rows.push(row);
		log(row);
	};
	const meter = newMeter();
	const t0 = now();
	for (let i = 1; i <= caps.iters; i++) {
		if (caps.maxMinutes > 0 && (now() - t0) / 60_000 > caps.maxMinutes) {
			return { rows, meter, stop: "duration-cap" };
		}
		const st = await statusOnce(deps, i);
		push(st);
		if (st.out === "ERR") return { rows, meter, stop: "belt-down" };
		const r = await routeOnce(deps);
		if (r.err !== undefined) {
			push({
				name: `soak/${String(i)}/route`,
				out: "ERR",
				note: `transport: ${r.err}`,
			});
			return { rows, meter, stop: "belt-down" };
		}
		const m = meter.add(r.model, r.usage, table);
		push({
			name: `soak/${String(i)}/route`,
			out: r.ok ? "PASS" : "RED",
			note: `POST /api/route ${String(r.status)} ${r.model} ms=${String(r.ms)} charged=${String(m.charged.toFixed(4))} tok=${String(m.tokens)}${m.unknown ? " (usage-unreported-or-unpriced)" : ""}`,
		});
		const cap = meter.capReason(caps);
		if (cap !== null) return { rows, meter, stop: cap };
		if (i < caps.iters) await sleep(caps.gapMs);
	}
	return { rows, meter, stop: "completed" };
};

// exit-code mapping, shared by CLI and tests: 0 clean, 2 reds, 1 harness
// error (belt-down; same vocabulary as sim/smoke.ts)
export const classifyExit = (r: SoakResult): 0 | 1 | 2 => {
	if (r.stop === "belt-down") return 1;
	if (r.rows.some((row) => row.out === "RED")) return 2;
	return 0;
};
