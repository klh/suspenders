// soak.test.ts — W179.3 engine unit tests. Pure: injected fetcher + clock,
// zero network. Covers pricing (defaults, pinned rules win, unknown),
// env caps parsing, meter math (both usage dialects, USD + token caps),
// runSoak paths (happy, reds-complete, belt-down, token/usd/duration caps),
// and the exit-code mapping.
import { describe, expect, test } from "bun:test";
import {
	classifyExit,
	DEFAULT_PRICES,
	loadPricing,
	newMeter,
	priceFor,
	runSoak,
	soakCapsFromEnv,
	type Caps,
	type PriceTable,
	type SoakDeps,
} from "../hooks/lib/soak.ts";

const jsonRes = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status });

interface FakeBeltState {
	calls: number;
	model?: string;
	usage?: unknown;
	routeStatus?: number;
}

// a belt that answers /api/health + /api/route and counts every hit
const beltFetcher =
	(state: FakeBeltState) =>
	async (url: string | URL | Request): Promise<Response> => {
		state.calls += 1;
		const u = String(url);
		if (u.endsWith("/api/status")) return jsonRes({ ok: true });
		if (u.endsWith("/api/route")) {
			const body: Record<string, unknown> = {
				reply: "ok",
				target: { model: state.model ?? "glm-5.3-flash" },
			};
			if (state.usage !== undefined) body.usage = state.usage;
			return jsonRes(body, state.routeStatus ?? 200);
		}
		throw new Error(`unexpected url ${u}`);
	};

const mkDeps = (
	fetcher: typeof fetch,
	caps: Partial<Caps> = {},
	clock: { t: number } = { t: 1_700_000_000_000 },
): SoakDeps => ({
	belt: { url: "http://belt.test" },
	caps: {
		maxUsd: 0.25,
		maxTokens: 40_000,
		iters: 3,
		maxMinutes: 0, // disabled unless a test opts in
		gapMs: 0,
		maxTokensPerCall: 8,
		...caps,
	},
	table: DEFAULT_PRICES,
	fetcher,
	now: () => clock.t,
	sleep: async () => {},
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pricing", () => {
	test("local families are free, unknown models are null", () => {
		expect(priceFor(DEFAULT_PRICES, "MLX-Community/Qwen3-Coder")).toEqual({
			in: 0,
			out: 0,
		});
		expect(priceFor(DEFAULT_PRICES, "glm-5.3-flash")).toBeNull();
	});

	test("pinned rules win over the free-tier defaults", async () => {
		const dir = mkdtempSync(join(tmpdir(), "soak-pricing-"));
		const path = join(dir, "soak-pricing.json");
		await Bun.write(
			path,
			JSON.stringify([{ match: "swarm", price: { in: 0.5, out: 1.5 } }]),
		);
		const table = await loadPricing(path);
		expect(priceFor(table, "swarm/model-x")).toEqual({ in: 0.5, out: 1.5 });
		expect(priceFor(table, "mlx-model")).toEqual({ in: 0, out: 0 });
		rmSync(dir, { recursive: true, force: true });
	});

	test("missing file → defaults only", async () => {
		const table = await loadPricing("/tmp/soak-test-no-such-file.json");
		expect(table).toEqual(DEFAULT_PRICES);
	});
});

describe("env caps", () => {
	test("defaults are tiny and safe", () => {
		const c = soakCapsFromEnv({});
		expect(c.maxUsd).toBe(0.25);
		expect(c.maxTokens).toBe(40_000);
		expect(c.iters).toBe(48);
		expect(c.maxMinutes).toBe(20);
		expect(c.maxTokensPerCall).toBe(32);
	});

	test("overrides apply; garbage falls back", () => {
		const c = soakCapsFromEnv({
			SOAK_MAX_USD: "2",
			SOAK_ITERS: "0",
			SOAK_MAX_TOKENS: "not-a-number",
		});
		expect(c.maxUsd).toBe(2);
		expect(c.iters).toBe(0); // explicit 0 = run no iterations
		expect(c.maxTokens).toBe(40_000);
	});
});

test("meter meters both usage dialects with USD math on pinned prices", () => {
	const table: PriceTable = [{ match: "glm", price: { in: 1, out: 2 } }];
	const m = newMeter();
	m.add(
		"glm-5.3-flash",
		{ input_tokens: 100_000, output_tokens: 50_000 },
		table,
	);
	expect(m.usd).toBeCloseTo(0.2, 5); // 100k×$1/M + 50k×$2/M
	expect(m.inTok).toBe(100_000);
	expect(m.outTok).toBe(50_000);
	m.add(
		"glm-5.3-flash",
		{ prompt_tokens: 10, completion_tokens: 5 }, // openai dialect
		table,
	);
	expect(m.inTok).toBe(100_010);
});

test("meter: unpriced usage is counted, not costed", () => {
	const m = newMeter();
	m.add("mystery/model", { input_tokens: 7, output_tokens: 3 }, DEFAULT_PRICES);
	expect(m.calls).toBe(1);
	expect(m.unpricedCalls).toBe(1);
	expect(m.usd).toBe(0);
});

test("meter: caps trip as usd-cap and token-cap", () => {
	const base: Caps = {
		maxUsd: 0,
		maxTokens: 0,
		iters: 9,
		maxMinutes: 0,
		gapMs: 0,
		maxTokensPerCall: 1,
	};
	const table: PriceTable = [{ match: "glm", price: { in: 1, out: 1 } }];
	const m = newMeter();
	m.add("glm", { input_tokens: 600_000, output_tokens: 0 }, table);
	m.add("glm", { input_tokens: 600_000, output_tokens: 0 }, table);
	expect(m.capReason({ ...base, maxUsd: 1 })).toBe("usd-cap");
	const t = newMeter();
	t.add("glm", { input_tokens: 41_000, output_tokens: 0 }, table);
	expect(t.capReason({ ...base, maxTokens: 40_000 })).toBe("token-cap");
});

describe("runSoak", () => {
	test("happy path: all iters run, usage meters, stop=completed", async () => {
		const state = { calls: 0, usage: { input_tokens: 10, output_tokens: 5 } };
		const r = await runSoak(mkDeps(beltFetcher(state), { iters: 3 }));
		expect(r.stop).toBe("completed");
		expect(r.meter.calls).toBe(3);
		expect(r.meter.inTok).toBe(30);
		expect(r.meter.outTok).toBe(15);
		expect(r.rows.every((row) => row.out === "PASS")).toBe(true);
		expect(classifyExit(r)).toBe(0);
	});

	test("reds complete the run — soak observes, it does not bail", async () => {
		const state = { calls: 0, routeStatus: 500 };
		const r = await runSoak(mkDeps(beltFetcher(state), { iters: 2 }));
		expect(r.stop).toBe("completed");
		expect(r.rows.filter((row) => row.out === "RED").length).toBe(2);
		expect(classifyExit(r)).toBe(2);
	});

	test("transport failure = belt-down, stops immediately, exit 1", async () => {
		let hits = 0;
		const r = await runSoak(
			mkDeps(async () => {
				hits += 1;
				throw new Error("ECONNREFUSED");
			}),
		);
		expect(r.stop).toBe("belt-down");
		expect(r.rows).toHaveLength(1); // only the status row
		expect(hits).toBe(1); // route never ran
		expect(classifyExit(r)).toBe(1);
	});

	test("token cap trips mid-run and stops scheduling", async () => {
		const state = { calls: 0, usage: { output_tokens: 15 } };
		const r = await runSoak(
			mkDeps(beltFetcher(state), { iters: 10, maxTokens: 25 }),
		);
		expect(r.stop).toBe("token-cap");
		expect(r.meter.calls).toBe(2); // 15 tok after iter1, 30 > 25 after iter2
		expect(state.calls).toBe(4); // 2 iters × (health + route)
		expect(classifyExit(r)).toBe(0); // the cap working is clean
	});

	test("usd cap trips on priced spend", async () => {
		const state = {
			calls: 0,
			usage: { input_tokens: 100_000, output_tokens: 100_000 },
		};
		const table = [{ match: "glm", price: { in: 1, out: 1 } }];
		const r = await runSoak({
			...mkDeps(beltFetcher(state), { iters: 10, maxUsd: 0.5, maxTokens: 0 }),
			table,
		});
		expect(r.stop).toBe("usd-cap");
		expect(r.meter.calls).toBe(3); // $0.2/iter → trips after iter 3 ($0.6 > $0.5)
		expect(r.meter.usd).toBeCloseTo(0.6, 5);
	});

	test("duration cap trips on the fake clock", async () => {
		const state = { calls: 0 };
		const clock = { t: 1_700_000_000_000 };
		const r = await runSoak({
			...mkDeps(beltFetcher(state), { iters: 9, maxMinutes: 1 }),
			now: () => (clock.t += 61_000),
		});
		expect(r.stop).toBe("duration-cap");
		expect(r.meter.calls).toBe(0); // elapsed before the first iteration
	});

	test("usage-unreported models still bound by the request shape", async () => {
		const state = { calls: 0 }; // no usage in responses
		const r = await runSoak(mkDeps(beltFetcher(state), { iters: 2 }));
		expect(r.meter.unpricedCalls).toBe(2);
		expect(
			r.rows.some((row) => row.note.includes("usage-unreported-or-unpriced")),
		).toBe(true);
	});
});
