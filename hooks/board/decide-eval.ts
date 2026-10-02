// hooks/board/decide-eval.ts — W217 decision re-evaluation. Each click on a
// decision card's re-evaluate button runs a FRESH evaluation through the
// local belt (:4000 shim — the proven anthropic→swarm path; W201: local/z.ai
// only), appends it to facts decision.eval.<event_id> (JSON array, capped),
// and returns the latest. No rate limit (owner: ad nauseum) — every click is
// stamped and kept so the owner can compare evaluations over time.
import { db } from "./context.ts";
import { readBoardSettings } from "../lib/board-config.ts";

const CAP = 10;

// model discovery fallback (mirrors advise.ts defaultModel): an explicit
// SUSPENDERS_LLM_MODEL wins; otherwise ask the endpoint what it serves
let cachedModel: string | null = null;
async function evalModel(): Promise<string> {
	const want = readBoardSettings().settings.recommendation_model;
	if (want) return want;
	if (process.env.SUSPENDERS_LLM_MODEL) return process.env.SUSPENDERS_LLM_MODEL;
	if (cachedModel) return cachedModel;
	const base = llmBase();
	try {
		const r = await fetch(`${base}/models`);
		if (r.ok) {
			const d = (await r.json()) as { data?: { id?: string }[] };
			cachedModel = d.data?.[0]?.id ?? null;
		}
	} catch {
		// discovery failed — fall through to the generic id
	}
	return cachedModel ?? "default";
}

function llmBase(): string {
	const u =
		readBoardSettings().settings.recommendation_url ??
		process.env.SUSPENDERS_LLM_URL ??
		"http://127.0.0.1:8901/v1/chat/completions";
	return u.replace(/\/chat\/completions$/, "");
}

type EvalEntry = { ts: number; text: string };

const evalKey = (id: number): string => `decision.eval.${id}`;

export function decisionEvals(id: number): EvalEntry[] {
	const row = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(evalKey(id)) as { value: string | null } | null;
	try {
		const parsed = JSON.parse(row?.value ?? "[]") as EvalEntry[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** One fresh evaluation: the decision question + its linked work item. */
export async function evaluateDecision(id: number): Promise<EvalEntry> {
	const d = db
		.query(
			"SELECT question, task_id, project, state FROM decisions WHERE event_id = ?",
		)
		.get(id) as {
		question: string | null;
		task_id: string | null;
		project: string | null;
		state: string;
	} | null;
	if (!d) throw new Error(`unknown decision id: ${id}`);
	if (d.state !== "OPEN")
		throw new Error(`decision ${id} is ${d.state} — only OPEN evaluates`);

	// linked work-item context (task_id + project, the decisionRecords join)
	let itemCtx = "";
	if (d.task_id && d.project) {
		const it = db
			.query(
				"SELECT id, title, state, owner_sid FROM work_items WHERE project = ? AND id = ?",
			)
			.get(d.project, d.task_id) as {
			id: string;
			title: string;
			state: string;
			owner_sid: string | null;
		} | null;
		if (it)
			itemCtx = `\n- ${it.id} [${it.state}]${it.owner_sid ? ` owner ${it.owner_sid.slice(0, 8)}` : ""}: ${it.title}`;
	}

	const prompt = [
		"You are evaluating a pending decision for a human operator.",
		"Decision under evaluation:",
		String(d.question ?? "").slice(0, 4000),
		itemCtx ? `\nLinked work items:${itemCtx}` : "",
		"",
		"Produce a fresh, independent evaluation: (1) restate the options you see,",
		"(2) name risks/second-order effects, (3) give a one-line recommendation.",
		"Be specific to this decision, not generic. Max ~200 words.",
	].join("\n");

	const actor = readBoardSettings().settings.default_actor ?? "unassigned";
	// same executor contract as hooks/bin/advise.ts: SUSPENDERS_LLM_URL/KEY/
	// MODEL (openai-compat — the local swarm / z.ai path, W201 policy)
	const llmUrl = `${llmBase()}/chat/completions`;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (process.env.SUSPENDERS_LLM_KEY)
		headers.authorization = `Bearer ${process.env.SUSPENDERS_LLM_KEY}`;
	const res = await fetch(llmUrl, {
		method: "POST",
		headers: headers,
		body: JSON.stringify({
			model: await evalModel(),
			max_tokens: 600,
			messages: [{ role: "user", content: prompt }],
			user: actor,
		}),
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new Error(`eval upstream ${res.status}: ${t.slice(0, 200)}`);
	}
	const wire = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	const text = (wire.choices?.[0]?.message?.content ?? "").trim();
	if (!text) throw new Error("eval upstream returned no text");

	const entry: EvalEntry = { ts: Date.now(), text };
	const all = [...decisionEvals(id), entry].slice(-CAP);
	db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, 'decision-eval', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts",
	).run(evalKey(id), JSON.stringify(all), Date.now());
	return entry;
}
