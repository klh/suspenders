// registry.ts — SINGLE SOURCE OF TRUTH for the local-llm swarm.
// swarm.ts (lifecycle) and router-shim.ts (routing) both import this.
// Port↔model pairs exist ONLY here. Change a model here; both tools follow.

export interface Specialist {
	port: SPECIALIST_PORTS;
	model: string; // exact mlx-community id — mlx_lm validates it
	label: string; // display + routing role
	role: "code" | "extract" | "reason" | "embed" | "rerank" | "general";
	ram_gb: number;
	tier: "resident" | "ondemand";
	engine?: "mlx_lm" | "rapid"; // default mlx_lm; rapid = rapid-mlx (MTP, prefix cache, batching)
	flags?: string[]; // extra server args for the chosen engine
	// terse capability tags, comma-separated — written so an LLM picking an
	// agent-LLM from a fleet manifest chooses the right specialist
	good_at: string;
}

// Wire protocol per row: specialists speak OpenAI-compatible /v1 (rapid-mlx /
// mlx_lm servers); only the :4000 router speaks Anthropic. Exposed so the
// dashboard and LLM-facing manifests can state the protocol per entry.
export const SPECIALIST_PROTOCOL = "openai";
export const ROUTER_PROTOCOL = "anthropic-shim";

// The :4000 router is not a Specialist (no model of its own — it fronts the
// fleet and, when allowed, the cloud), but LLM-facing manifests list it
// alongside them.
export const ROUTER = {
	port: 4000,
	label: "router",
	role: "router",
	protocol: ROUTER_PROTOCOL,
	model_served: null,
	good_at:
		"anthropic-protocol clients, deterministic role routing, fleet-wide access, cloud fallback",
} as const;

export type SPECIALIST_PORTS =
	| 8901
	| 8902
	| 8903
	| 8904
	| 8905
	| 8906
	| 8911
	| 8913;

export const SPECIALISTS: Specialist[] = [
	{
		// 2026-09-21 swap: Qwen3-Coder-30B-A3B (MoE, 3B active) replaces
		// Qwen2.5-Coder-32B (dense, prev gen) — faster inference + newer coder.
		// 2026-09-23: engine -> rapid (bench-suite A/B: 121.8 vs 91.9 tok/s).
		port: 8901,
		model: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
		label: "⚡ code",
		role: "code",
		ram_gb: 16,
		tier: "resident",
		engine: "rapid",
		flags: ["--enable-prefix-cache", "--response-cache-entries", "128"],
		// 2026-09-23 A/B: --kv-cache-dtype int8 = 87.3 vs 117.7 tok/s median (-26%)
		// at short contexts — dequant overhead dominates; bf16 KV stays.
		good_at:
			"code generation, multi-file edits, repo-scale refactors, long context",
	},
	{
		port: 8902,
		model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
		label: "🏠 extract",
		role: "extract",
		ram_gb: 2,
		tier: "resident",
		engine: "rapid",
		flags: ["--enable-prefix-cache", "--response-cache-entries", "128"],
		good_at:
			"structured extraction, json shaping, summarization, fast cheap drafting",
	},
	{
		// 2026-09-23 swap: Qwen3.5-35B-A3B (MoE, 3B active, 4bit ≈20GB) replaces
		// Qwen3.8-27B (dense, 15GB) — battery 138.5 vs 28.3 tok/s at equal 6/6 on
		// determinate-answer probes; newer gen, multimodal.
		port: 8903,
		model: "mlx-community/Qwen3.5-35B-A3B-4bit",
		label: "🧠 reason",
		role: "reason",
		ram_gb: 20,
		tier: "resident",
		engine: "rapid",
		flags: [
			"--reasoning",
			"--enable-prefix-cache",
			"--response-cache-entries",
			"128",
		],
		good_at:
			"multi-step reasoning, planning, hard analysis, determinate answers",
	},
	// 8904/8905 (embed/rerank) retired 2026-09-23: mlx_lm 0.31.x server dropped
	// /v1/embeddings + /v1/rerank routes. Embeddings live on :8907 (context-rag
	// embed_server.py, mlx_embeddings) — started on demand by context-rag/mail-rag.
	{
		port: 8906,
		model: "mlx-community/Qwen3.5-9B-MLX-4bit",
		label: "🌐 danish/general",
		role: "general",
		ram_gb: 5.6,
		tier: "ondemand",
		engine: "rapid",
		flags: [
			"--reasoning",
			"--enable-prefix-cache",
			"--response-cache-entries",
			"128",
		],
		good_at: "danish, general chat, translation, light on-demand reasoning",
	},
	{
		// 2026-09-24 adoption: found running stray on the brew 0.14.3 binary,
		// relaunched under the uv 0.15.x engine. Closes the doc-rerank gap left
		// by the 8904/8905 retirement (context-rag / mail-rag rerank consumers).
		port: 8913,
		model: "mlx-community/Qwen3-Reranker-0.6B-4bit",
		label: "🔀 rerank",
		role: "rerank",
		ram_gb: 1,
		tier: "resident",
		engine: "rapid",
		flags: ["--enable-prefix-cache"],
		good_at: "document reranking, relevance ordering, query-passage scoring",
	},
];

export const DOWNLOAD_MODELS: string[] = [
	...SPECIALISTS.map((s) => s.model),
	"mlx-community/translategemma-4b-it-4bit",
];

export const byPort = (port: number): Specialist | undefined =>
	SPECIALISTS.find((s) => s.port === port);

// ─── install tier ───
// BELT_TIER scopes the resident fleet: "full" (default) keeps every resident
// specialist; "minimal" keeps only ram_gb ≤ 4 (extract :8902 2GB, rerank
// :8913 1GB) — the fleet a 16GB machine holds. A filter over this registry,
// not new infrastructure: on-demand models, the router and the dashboard are
// unchanged. Read once at import; consumers import `residentSet()`.
export const BELT_TIER: "full" | "minimal" =
	process.env.BELT_TIER === "minimal" ? "minimal" : "full";
export const TIER_MAX_RAM_GB = 4;

export function residentSet(): Specialist[] {
	const resident = SPECIALISTS.filter((s) => s.tier === "resident");
	return BELT_TIER === "minimal"
		? resident.filter((s) => s.ram_gb <= TIER_MAX_RAM_GB)
		: resident;
}

// bounded fallback: heavy specialists cover each other; 4B falls up to the 27B.
// Derived from the registry — no second port↔model table to drift.
export function fallbackFor(port: number): Specialist | undefined {
	if (port === 8901) return byPort(8903); // coder → reason
	if (port === 8902) return byPort(8903); // extract → reason
	if (port === 8903) return byPort(8901); // reason → coder
	if (port === 8906) return byPort(8903); // danish/general → reason
	return undefined;
}
