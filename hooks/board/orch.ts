// hooks/board/orch.ts — W57 orchestrate: LLM plan proposal + registration (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { CLI, db } from "./context.ts";
import { json } from "./helpers.ts";
import { board, events, llm, payload } from "./data.ts";
import { tokenUsage } from "../lib/govdb.ts";
import { scrub } from "../lib/servicemon.ts";
import { existsSync, readdirSync } from "node:fs";

export const ORCH = {
	MIN_CHILDREN: 2,
	MAX_CHILDREN: 8,
	TITLE_MAX: 120,
	BRIEF_MAX: 400,
	GOAL_MAX: 2000,
	CTX_ITEMS: 40,
	CTX_ENTRIES: 60,
};

// same endpoint contract as advise.ts (full chat-completions URL)
export const ORCH_URL =
	process.env.SUSPENDERS_LLM_URL ?? "http://127.0.0.1:8901/v1/chat/completions";
export const ORCH_KEY = process.env.SUSPENDERS_LLM_KEY;
export const ORCH_HOST = (() => {
	try {
		return new URL(ORCH_URL).host;
	} catch {
		return "(unparseable SUSPENDERS_LLM_URL)";
	}
})();
export let orchModel: string | null = null;
export async function orchModelResolve(): Promise<string> {
	if (orchModel) return orchModel;
	try {
		const r = await fetch(ORCH_URL.replace(/\/chat\/completions$/, "/models"), {
			headers: ORCH_KEY ? { authorization: `Bearer ${ORCH_KEY}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		if (r.ok) {
			const j = (await r.json()) as { data?: { id?: string }[] };
			orchModel = j.data?.[0]?.id ?? "local";
			return orchModel;
		}
	} catch {}
	return "local";
}
export const ORCH_SYS = `You propose work decompositions for a coding-agent fleet. From the goal and repo context, output STRICT JSON only — no prose, no markdown fences:
{"title": "<plan title, imperative, <=120 chars>", "children": [{"title": "<child task title, imperative, independently actionable, <=120 chars>", "brief": "<one sentence of scope guidance, <=400 chars>"}]}
Rules: 2-6 children; children run in parallel — no shared-file edits, no ordering between them; never invent ids.`;

export interface OrchProposal {
	title: string;
	children: { title: string; brief: string }[];
}

// tolerate the failure modes local models actually produce: <think> blocks,
// markdown fences, prose around the object. Returns null when nothing
// proposal-shaped survives — the endpoint answers 502 and the human retries.
export function parseProposal(text: string): OrchProposal | null {
	const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const start = noThink.indexOf("{");
	const end = noThink.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let j: unknown;
	try {
		j = JSON.parse(noThink.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof j !== "object" || j === null) return null;
	const o = j as Record<string, unknown>;
	if (typeof o.title !== "string" || !Array.isArray(o.children)) return null;
	const kids: { title: string; brief: string }[] = [];
	for (const c of o.children) {
		if (typeof c !== "object" || c === null) continue;
		const co = c as Record<string, unknown>;
		const t =
			typeof co.title === "string"
				? co.title.trim().slice(0, ORCH.TITLE_MAX)
				: "";
		const b =
			typeof co.brief === "string"
				? co.brief.trim().slice(0, ORCH.BRIEF_MAX)
				: "";
		if (t) kids.push({ title: t, brief: b });
	}
	const title = o.title.trim().slice(0, ORCH.TITLE_MAX);
	if (!title || kids.length < ORCH.MIN_CHILDREN) return null;
	return { title, children: kids.slice(0, ORCH.MAX_CHILDREN) };
}

// bounded repo context: open work items (dedupe vs the goal is the model's
// job) + top-level entries as a cheap shape hint
export function orchContext(project: string, repo: string): string {
	const items = (
		db
			.query(
				"SELECT id, state, title FROM work_items WHERE project = ? AND state NOT IN ('DONE','SUPERSEDED','SHATTERED') ORDER BY id LIMIT ?",
			)
			.all(project, ORCH.CTX_ITEMS) as {
			id: string;
			state: string;
			title: string;
		}[]
	)
		.map((r) => `- ${r.id} ${r.state}: ${r.title}`)
		.join("\n");
	const entries = readdirSync(repo)
		.filter((e) => e !== ".git" && e !== "node_modules")
		.sort()
		.slice(0, ORCH.CTX_ENTRIES)
		.join(", ");
	return `OPEN WORK ITEMS:\n${items || "(none)"}\nTOP-LEVEL: ${entries}`;
}

// one llm.call telemetry event per orchestrate round-trip, success or not —
// the routing log shows failed calls too (advise.ts W28 pattern)
export function orchTelemetry(payload: Record<string, unknown>): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'orchestrate', 'llm.call', NULL, ?, NULL)",
	).run(Date.now(), JSON.stringify(payload));
}

export async function orchestrate(
	project: string,
	goal: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const repo = project.replace(/\/\.git$/, "");
	if (!existsSync(repo))
		return {
			status: 404,
			body: { ok: false, error: `project directory missing: ${repo}` },
		};
	const ctx = orchContext(project, repo);
	const t0 = Date.now();
	const model = await orchModelResolve();
	let content = "";
	let pt = 0;
	let ct = 0;
	let tt = 0;
	let llmError: string | null = null;
	try {
		const r = await fetch(ORCH_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(ORCH_KEY ? { authorization: `Bearer ${ORCH_KEY}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: ORCH_SYS },
					{
						role: "user",
						content: `GOAL:\n${goal}\n\nREPO CONTEXT:\n${ctx}`,
					},
				],
				max_tokens: 1200,
				temperature: 0.2,
			}),
			signal: AbortSignal.timeout(120_000),
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
	orchTelemetry({
		for: "orchestrate",
		model,
		host: ORCH_HOST,
		pt,
		ct,
		tt,
		ms: Date.now() - t0,
		...(llmError ? { error: llmError.slice(0, 200) } : {}),
	});
	if (llmError)
		return { status: 502, body: { ok: false, error: llmError.slice(0, 300) } };
	const proposal = parseProposal(content);
	if (!proposal)
		return {
			status: 502,
			body: {
				ok: false,
				error:
					"orchestrator returned no parseable plan (want JSON {title, children[]}) — rephrase the goal and retry",
			},
		};
	return {
		status: 200,
		body: { ok: true, proposal, model, ms: Date.now() - t0 },
	};
}

// register: plan item first, then the plan-gated split — the plan item IS
// the split parent (AGENTS.md flow). Children ids are read back from the
// work graph, not parsed out of CLI prose (lesson.silent-noop-mutations).
export function orchRegister(
	project: string,
	title: string,
	kids: string[],
): { status: number; body: Record<string, unknown> } {
	const repo = project.replace(/\/\.git$/, "");
	if (!existsSync(repo))
		return {
			status: 404,
			body: { ok: false, error: `project directory missing: ${repo}` },
		};
	const run = (args: string[]): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync([process.execPath, CLI("work.ts"), ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString(),
			err: p.stderr.toString(),
			code: p.exitCode,
		};
	};
	const add = run(["add", `plan: ${title}`, "--by", "board"]);
	if (add.code !== 0)
		return {
			status: 500,
			body: {
				ok: false,
				error: `plan registration failed: ${(add.err || add.out).slice(0, 300)}`,
			},
		};
	const m = add.out.split("\n")[0]?.match(/(W\d+(?:\.\d+)*) READY/);
	if (!m)
		return {
			status: 500,
			body: {
				ok: false,
				error: `plan registered but id unparsable: ${add.out.slice(0, 200)}`,
			},
		};
	const pid = m[1];
	const split = run([
		"split",
		pid,
		...kids,
		"--reason",
		"independent-scopes",
		"--plan",
		pid,
	]);
	if (split.code !== 0)
		return {
			status: 500,
			body: {
				ok: false,
				error: `split failed: ${(split.err || split.out).slice(0, 300)}`,
			},
		};
	const children = (
		db
			.query(
				"SELECT id, title FROM work_items WHERE project = ? AND parent_id = ? ORDER BY id",
			)
			.all(project, pid) as { id: string; title: string }[]
	).map((r) => ({ id: r.id, title: r.title }));
	return { status: 200, body: { ok: true, plan: pid, children } };
}

// W125 — tokens_total for /metrics: the per-item token metrics (govdb
// tokenUsage) aggregated per project. tokenUsage parses lane transcripts
// (facts-cache keyed by mtime) — the aggregate refresh rides the /status TTL
// window, NEVER per scrape: a 293-transcript fleet must not be re-read on
// every poll. scrub keeps /Users paths out of the project labels.
