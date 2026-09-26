// advise.ts — LLM advisor for decision forks. Reads a NEED% event from
// governor.db, gathers control-plane context, asks the configured
// OpenAI-compatible endpoint for a recommendation, stores it as fact
// advice.<event-id> (+ ADVICE event back to the asker). The board renders
// the advice inline; a HUMAN always accepts/edits before anything is sent —
// this tool never answers a fork by itself.
// usage: bun hooks/bin/advise.ts <event-id>
// env:   SUSPENDERS_LLM_URL   (default http://127.0.0.1:8901/v1/chat/completions)
//        SUSPENDERS_LLM_MODEL (default "local")
//        SUSPENDERS_LLM_KEY   (optional bearer token)
import { openGovernorDb } from "../lib/govdb.ts";

const id = Number(process.argv[2] ?? 0);
if (!id) {
	console.error("usage: bun hooks/bin/advise.ts <event-id>");
	process.exit(1);
}
const URL_ = process.env.SUSPENDERS_LLM_URL ?? "http://127.0.0.1:8901/v1/chat/completions";
const KEY = process.env.SUSPENDERS_LLM_KEY;
const MODEL = process.env.SUSPENDERS_LLM_MODEL ?? (await defaultModel(URL_, KEY));
const now = Date.now();

// no model configured → ask the endpoint what it serves (first entry); works
// for MLX server, llama.cpp, vLLM, or any OpenAI-compatible shim
async function defaultModel(url: string, key?: string): Promise<string> {
	try {
		const r = await fetch(url.replace(/\/chat\/completions$/, "/models"), {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		const j = (await r.json()) as { data?: { id: string }[] };
		return j.data?.[0]?.id ?? "local";
	} catch {
		return "local";
	}
}

const db = openGovernorDb();
const ev = db.query("SELECT id, ts, source, kind, scope, payload, target FROM events WHERE id = ?").get(id) as
	| { id: number; ts: number; source: string; kind: string; scope: string | null; payload: string | null; target: string | null }
	| null;
if (!ev || !ev.kind.startsWith("NEED")) {
	console.error(`event #${id} is ${ev ? ev.kind : "missing"} — advise wants a NEED% fork`);
	process.exit(1);
}

// already advised? (idempotent — board retries shouldn't re-bill the LLM)
const fk = `advice.${id}`;
if (db.query("SELECT 1 AS x FROM facts WHERE key = ?").get(fk)) {
	console.log(`#${id} already advised (${fk})`);
	process.exit(0);
}

let question = "";
try {
	const p = ev.payload ? JSON.parse(ev.payload) : {};
	question = String(p.note ?? p.question ?? ev.payload ?? "");
} catch {
	question = String(ev.payload ?? "");
}

// context: who is asking (claims/intent), their recent bus traffic, fleet shape
const claims = db.query("SELECT scope, intent FROM claims WHERE sid = ? ORDER BY ts DESC LIMIT 5").all(ev.source) as { scope: string; intent: string | null }[];
const recent = db
	.query("SELECT kind, scope, payload FROM events WHERE source = ? ORDER BY id DESC LIMIT 8")
	.all(ev.source) as { kind: string; scope: string | null; payload: string | null }[];
const shape = db
	.query(
		"SELECT state, COUNT(*) AS n FROM work_items WHERE state IN ('READY','CLAIMED','RUNNING','BLOCKED','DONE') GROUP BY state",
	)
	.all() as { state: string; n: number }[];
const zombies = db.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'").all() as { key: string; value: string }[];

const ctx = [
	`asker: ${ev.source}${claims.length ? ` (claims: ${claims.map((c) => `${c.scope}${c.intent ? ` — ${c.intent}` : ""}`).join("; ")})` : ""}`,
	`event: #${id} ${ev.kind}${ev.scope ? ` scope=${ev.scope}` : ""}, age ${Math.round((now - ev.ts) / 60000)}min`,
	`asker's last bus events: ${recent.map((r) => r.kind + (r.scope ? `(${r.scope})` : "")).join(", ") || "(none)"}`,
	`work graph: ${shape.map((s) => `${s.n} ${s.state}`).join(", ") || "empty"}`,
	zombies.length ? `zombie flags: ${zombies.map((z) => z.value).join(" | ")}` : "",
]
	.filter(Boolean)
	.join("\n");

const sys = `You advise the human operator of a multi-agent coding fleet (governor.db control plane: work graph, event bus, claims, zombies). A lane raised a decision fork. Analyze the context and answer with EXACTLY this shape:
RECOMMENDATION: <the decision, one concrete sentence — pick an option if options are implied>
RATIONALE: <2-4 short bullets, grounded in the context>
RISK: <the main risk of your recommendation, one line>
Be decisive. Never recommend "gather more information" unless the context is truly undecidable. Never invent facts.`;

let text = "";
const t0 = Date.now();
try {
	const r = await fetch(URL_, {
		method: "POST",
		headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: sys },
				{ role: "user", content: `DECISION FORK:\n${question}\n\nCONTROL-PLANE CONTEXT:\n${ctx}` },
			],
			max_tokens: 500,
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as any;
	text = j.choices?.[0]?.message?.content ?? "";
	// W28 routing telemetry: every advise round-trip becomes an llm.call
	// event — the board's LLM telemetry block sums today's tokens per model
	// against optional llm.budget.<model> facts. Usage may be absent (some
	// local servers omit it) — record zeros rather than skipping, so the
	// routing log still shows the call. On failure: still logged, with error.
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)").run(
		Date.now(),
		JSON.stringify({ for: id, model: MODEL, host: new URL(URL_).host, pt: j.usage?.prompt_tokens ?? 0, ct: j.usage?.completion_tokens ?? 0, tt: j.usage?.total_tokens ?? (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0), ms: Date.now() - t0 }),
	);
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	// telemetry even on failure — the routing log shows failed calls too (W28)
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)").run(
		Date.now(),
		JSON.stringify({ for: id, model: MODEL, host: new URL(URL_).host, pt: 0, ct: 0, tt: 0, ms: Date.now() - t0, error: msg.slice(0, 200) }),
	);
	db.query("INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)").run(`${fk}.error`, msg, Date.now());
	console.error(`advise #${id} failed: ${msg}`);
	process.exit(2);
}

const grab = (m: string) =>
	text
		.split(new RegExp(`^${m}:`, "m"))[1]
		?.split(/^[A-Z]+:/m)[0]
		?.trim() ?? "";
const rec = grab("RECOMMENDATION") || text.split("\n")[0]?.trim() || "(empty)";
const rationale = grab("RATIONALE");
const risk = grab("RISK");

const advice = JSON.stringify({ rec: rec.slice(0, 500), rationale: rationale.slice(0, 900), risk: risk.slice(0, 300), model: MODEL, ts: now });
db.query("INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)").run(fk, advice, Date.now());
db.query("DELETE FROM facts WHERE key = ?").run(`${fk}.error`);
db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'ADVICE', ?, ?, ?)").run(
	Date.now(),
	ev.scope,
	JSON.stringify({ for: id, rec: rec.slice(0, 160) }),
	ev.source, // back to the asker: their fork has advice waiting
);
console.log(`advised #${id}: ${rec.slice(0, 100)}`);
