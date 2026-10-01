// hooks/board/suggest.ts — W163 composer suggest: the local minimal model
// (the :8902-class resident — smallest model that fits the job) expands a
// terse draft from the orchestrate box into a brief-shaped prompt. Context =
// the running lanes (sessions + claims + owned work items — the same plane
// `coord fleet` reads). On-demand spawn via local-llm/spawner (single-flight;
// skipped when SUSPENDERS_SUGGEST_URL overrides the endpoint). Responses are
// cached draft-for-prompt so a re-click never re-bills the model.

import { db } from "./context.ts";
import { byPort, residentSet, type Specialist } from "../local-llm/registry.ts";
import { ensureUp } from "../local-llm/spawner.ts";

export const SUGGEST = {
	DRAFT_MIN: 8,
	DRAFT_MAX: 2000,
	PROMPT_MIN: 40,
	PROMPT_MAX: 4000,
	CTX_LANES: 16,
	CACHE_MAX: 32,
	CACHE_TTL_MS: 10 * 60 * 1000,
	TIMEOUT_MS: 60_000,
	MAX_TOKENS: 700,
} as const;

// registry-first: :8902 extract (2GB resident, "fast cheap drafting") IS the
// two-stage fit for a composer expansion — a bigger resident is the fallback,
// never the default (the fit law: smallest model that fits the job).
export function suggestSpec(): Specialist | undefined {
	return (
		byPort(8902) ??
		residentSet().find((s) => s.role === "extract") ??
		residentSet()[0]
	);
}

const ENV_URL = process.env.SUSPENDERS_SUGGEST_URL ?? "";
const URL_OVERRIDE = ENV_URL.length > 0;
export const SUGGEST_URL =
	ENV_URL ||
	`http://127.0.0.1:${suggestSpec()?.port ?? 8902}/v1/chat/completions`;
export const SUGGEST_HOST = (() => {
	try {
		return new URL(SUGGEST_URL).host;
	} catch {
		return "(unparseable SUSPENDERS_SUGGEST_URL)";
	}
})();

let sugModel: string | null = null;
export async function suggestModelResolve(): Promise<string> {
	if (sugModel) return sugModel;
	try {
		const r = await fetch(
			SUGGEST_URL.replace(/\/chat\/completions$/, "/models"),
			{ signal: AbortSignal.timeout(5000) },
		);
		if (r.ok) {
			const j = (await r.json()) as { data?: { id?: string }[] };
			sugModel = j.data?.[0]?.id ?? suggestSpec()?.model ?? "local";
			return sugModel;
		}
	} catch {}
	sugModel = suggestSpec()?.model ?? "local";
	return sugModel;
}

export const SUGGEST_SYS = `You expand terse project goals into brief-shaped prompts for a coding-agent fleet. Output ONLY the expanded prompt text — no preamble, no quotes, no markdown fences.
Shape: MISSION — what is being built and the done-when. PROTOCOL — worktree/branch, gates, commit discipline in a line or two. CONTEXT — constraints drawn from the draft and the running-lane list when relevant.
Rules: imperative voice; concrete; under 150 words; never invent ids, paths, names or requirements not present in the draft or the context; keep every hard requirement of the draft.`;

// running lanes, fleet-wide (the composer's project filter only colors the
// "this project" tag): sessions LEFT JOIN their claims and open owned work —
// deduped per sid, bounded, each line capped so the prompt stays small.
export function laneContext(project: string): string {
	const rows = db
		.query(
			`SELECT s.sid, s.project, c.intent, w.id AS wid, w.title AS wtitle
			 FROM sessions s
			 LEFT JOIN claims c ON c.sid = s.sid
			 LEFT JOIN work_items w ON w.owner_sid = s.sid
			   AND w.state NOT IN ('DONE','SUPERSEDED','SHATTERED')
			 WHERE s.state = 'RUNNING'
			 ORDER BY s.sid
			 LIMIT ?`,
		)
		.all(SUGGEST.CTX_LANES) as {
		sid: string;
		project: string | null;
		intent: string | null;
		wid: string | null;
		wtitle: string | null;
	}[];
	const seen = new Set<string>();
	const lanes: string[] = [];
	for (const r of rows) {
		if (seen.has(r.sid)) continue;
		seen.add(r.sid);
		const here = r.project === project ? " (this project)" : "";
		const doing = r.wid
			? `${r.wid} ${r.wtitle ?? ""}`
			: r.intent || "no claim — idle";
		lanes.push(`- ${r.sid}${here}: ${doing}`.slice(0, 200));
	}
	return `RUNNING LANES:\n${lanes.join("\n") || "(none)"}`;
}

// tolerate the 4B failure modes: <think> blocks, fence prose, runaway
// blank-line runs. Null when too little survives — the route answers 502.
export function parseSuggestion(text: string): string | null {
	const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const clean = noThink
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, SUGGEST.PROMPT_MAX);
	return clean.length >= SUGGEST.PROMPT_MIN ? clean : null;
}

// bounded LRU + TTL — a re-click on the same draft re-serves, never re-bills
const cache = new Map<string, { at: number; model: string; prompt: string }>();
function cacheGet(key: string): { model: string; prompt: string } | null {
	const e = cache.get(key);
	if (!e) return null;
	if (Date.now() - e.at > SUGGEST.CACHE_TTL_MS) {
		cache.delete(key);
		return null;
	}
	cache.delete(key);
	cache.set(key, e); // LRU refresh
	return { model: e.model, prompt: e.prompt };
}
function cacheSet(key: string, model: string, prompt: string): void {
	cache.delete(key);
	while (cache.size >= SUGGEST.CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	cache.set(key, { at: Date.now(), model, prompt });
}

// one llm.call telemetry event per suggest round-trip — the routing log
// shows failed calls too (orchestrate/advise pattern)
export function suggestTelemetry(payload: Record<string, unknown>): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'suggest', 'llm.call', NULL, ?, NULL)",
	).run(Date.now(), JSON.stringify(payload));
}

export async function suggest(
	project: string,
	draft: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const key = `${project}\u0000${draft}`;
	const hit = cacheGet(key);
	if (hit)
		return {
			status: 200,
			body: {
				ok: true,
				prompt: hit.prompt,
				model: hit.model,
				ms: 0,
				cached: true,
			},
		};
	const ctx = laneContext(project);
	const t0 = Date.now();
	let cold = false;
	if (!URL_OVERRIDE) {
		// the registry port is the real target — spawn the resident on demand
		// (single-flight; an already-warm :8902 returns immediately)
		const spec = suggestSpec();
		if (spec) {
			const up = await ensureUp(spec);
			if (!up.up)
				return {
					status: 502,
					body: {
						ok: false,
						error: `local model :${spec.port} not up: ${up.error ?? "no readiness"}`,
					},
				};
			cold = up.cold;
		}
	}
	const model = await suggestModelResolve();
	let content = "";
	let pt = 0;
	let ct = 0;
	let tt = 0;
	let llmError: string | null = null;
	try {
		const r = await fetch(SUGGEST_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: SUGGEST_SYS },
					{
						role: "user",
						content: `DRAFT:\n${draft}\n\n${ctx}`,
					},
				],
				max_tokens: SUGGEST.MAX_TOKENS,
				temperature: 0.3,
			}),
			signal: AbortSignal.timeout(SUGGEST.TIMEOUT_MS),
		});
		if (!r.ok)
			throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: {
				prompt_tokens?: number;
				completion_tokens?: number;
				total_tokens?: number;
			};
		};
		content = j.choices?.[0]?.message?.content ?? "";
		pt = j.usage?.prompt_tokens ?? 0;
		ct = j.usage?.completion_tokens ?? 0;
		tt = j.usage?.total_tokens ?? pt + ct;
	} catch (e) {
		llmError = e instanceof Error ? e.message : String(e);
	}
	suggestTelemetry({
		for: "suggest",
		model,
		host: SUGGEST_HOST,
		pt,
		ct,
		tt,
		ms: Date.now() - t0,
		...(cold ? { cold } : {}),
		...(llmError ? { error: llmError.slice(0, 200) } : {}),
	});
	if (llmError)
		return { status: 502, body: { ok: false, error: llmError.slice(0, 300) } };
	const prompt = parseSuggestion(content);
	if (!prompt)
		return {
			status: 502,
			body: {
				ok: false,
				error:
					"model returned no usable suggestion — rephrase the draft and retry",
			},
		};
	cacheSet(key, model, prompt);
	return {
		status: 200,
		body: {
			ok: true,
			prompt,
			model,
			ms: Date.now() - t0,
			...(cold ? { cold } : {}),
		},
	};
}
