// W229 universal lane insertion: ONE applicator + per-executor DATA.
// Adding an executor is a table row here, never a new branch in dispatch
// code. Unknown executors fall back to the base-URL union — whatever var
// the executor honors, it lands on the stack. Config over code:
// KLH_ENGINE_BASE / KLH_DEFAULT_MODEL override the constants; pre-set env
// always wins (the applicator only fills unset vars).

export interface InsertionCtx {
	anthropicBase: string;
	openaiBase: string;
	model: string | null;
	defaultModel: string;
}

export type InsertionVars = Record<
	string,
	string | ((c: InsertionCtx) => string | undefined)
>;

// Base-URL union — the universal fallback for executors without a recipe.
export const UNION_VARS: InsertionVars = {
	ANTHROPIC_BASE_URL: (c) => c.anthropicBase,
	OPENAI_BASE_URL: (c) => c.openaiBase,
	OPENAI_API_BASE: (c) => c.openaiBase,
};

export const INSERTION_RECIPES: Record<string, InsertionVars> = {
	// claude: base rides in via the launchd plist (laneEnv inherits it); the
	// model pin is ours, and only meaningful behind belt (belt routes by id).
	claude: {
		ANTHROPIC_BASE_URL: (c) => c.anthropicBase,
		ANTHROPIC_MODEL: (c) => c.model ?? undefined,
	},
	// copilot (BYOK, proven): openai wire at the engine base; /v1 suffix is
	// REQUIRED here (anthropic-wire + /v1 double-prefixes and dies silently).
	// To ride real GitHub Copilot instead, preset these vars — insertion
	// never overrides.
	copilot: {
		COPILOT_PROVIDER_BASE_URL: (c) => c.openaiBase,
		COPILOT_PROVIDER_TYPE: () => "openai",
		COPILOT_MODEL: (c) => c.model ?? c.defaultModel,
	},
};

export const insertionCtx = (
	env: Record<string, string>,
	model: string | null = null,
): InsertionCtx => ({
	anthropicBase: env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:4000",
	openaiBase: process.env.KLH_ENGINE_BASE ?? "http://127.0.0.1:4100/v1",
	model,
	defaultModel:
		process.env.KLH_DEFAULT_MODEL ?? "mlx-community/Qwen3.5-35B-A3B-4bit",
});

// Apply the recipe for `id` onto env in place.
export const applyInsertion = (
	env: Record<string, string>,
	id: string,
	ctx: InsertionCtx,
): void => {
	const recipe = INSERTION_RECIPES[id] ?? UNION_VARS;
	for (const [k, v] of Object.entries(recipe)) {
		const val = typeof v === "function" ? v(ctx) : v;
		if (val !== undefined && env[k] === undefined) env[k] = val;
	}
	env.KLH_LANE = env.KLH_LANE ?? id;
};
