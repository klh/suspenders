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
import { isDecisionKind, openGovernorDb } from "../lib/govdb.ts";
import {
	chatRemote,
	endpointsWithRole,
	ensureEndpoint,
	type RemoteEndpoint,
	type RemoteMachine,
} from "../lib/remotes.ts";

const id = Number(process.argv[2] ?? 0);
if (!id) {
	console.error("usage: bun hooks/bin/advise.ts <event-id>");
	process.exit(1);
}
const URL_ =
	process.env.SUSPENDERS_LLM_URL ?? "http://127.0.0.1:8901/v1/chat/completions";
// safe parse — a malformed SUSPENDERS_LLM_URL must not throw inside the catch
// below: the failure path itself has to be throw-proof (same guard as the
// board's LLM_ORIGIN)
const LLM_HOST = (() => {
	try {
		return new URL(URL_).host;
	} catch {
		return "(unparseable SUSPENDERS_LLM_URL)";
	}
})();
const KEY = process.env.SUSPENDERS_LLM_KEY;
const MODEL =
	process.env.SUSPENDERS_LLM_MODEL ?? (await defaultModel(URL_, KEY));
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
const ev = db
	.query(
		"SELECT id, ts, source, kind, scope, payload, target FROM events WHERE id = ?",
	)
	.get(id) as {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
	target: string | null;
} | null;
if (!ev || !isDecisionKind(ev.kind)) {
	console.error(
		`event #${id} is ${ev ? ev.kind : "missing"} — advise wants a NEED% fork`,
	);
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
const claims = db
	.query(
		"SELECT scope, intent FROM claims WHERE sid = ? ORDER BY ts DESC LIMIT 5",
	)
	.all(ev.source) as { scope: string; intent: string | null }[];
const recent = db
	.query(
		"SELECT kind, scope, payload FROM events WHERE source = ? ORDER BY id DESC LIMIT 8",
	)
	.all(ev.source) as {
	kind: string;
	scope: string | null;
	payload: string | null;
}[];
const shape = db
	.query(
		"SELECT state, COUNT(*) AS n FROM work_items WHERE state IN ('READY','CLAIMED','RUNNING','BLOCKED','DONE') GROUP BY state",
	)
	.all() as { state: string; n: number }[];
const zombies = db
	.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'")
	.all() as { key: string; value: string }[];

const ctx = [
	`asker: ${ev.source}${claims.length ? ` (claims: ${claims.map((c) => `${c.scope}${c.intent ? ` — ${c.intent}` : ""}`).join("; ")})` : ""}`,
	`event: #${id} ${ev.kind}${ev.scope ? ` scope=${ev.scope}` : ""}, age ${Math.round((now - ev.ts) / 60000)}min`,
	`asker's last bus events: ${recent.map((r) => r.kind + (r.scope ? `(${r.scope})` : "")).join(", ") || "(none)"}`,
	`work graph: ${shape.map((s) => `${s.n} ${s.state}`).join(", ") || "empty"}`,
	zombies.length
		? `zombie flags: ${zombies.map((z) => z.value).join(" | ")}`
		: "",
]
	.filter(Boolean)
	.join("\n");

const sys = `You advise the human operator of a multi-agent coding fleet (governor.db control plane: work graph, event bus, claims, zombies). A lane raised a decision fork. Analyze the context and answer with EXACTLY this shape:
RECOMMENDATION: <the decision, one concrete sentence — pick an option if options are implied>
RATIONALE: <2-4 short bullets, grounded in the context>
RISK: <the main risk of your recommendation, one line>
Be decisive. Never recommend "gather more information" unless the context is truly undecidable. Never invent facts.`;

type LlmUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
};

let text = "";
/** Parse the RECOMMENDATION/RATIONALE/RISK shape, persist the advice fact,
 *  and emit the ADVICE event — shared by the local and remote-fallback
 *  paths (W90). */
function storeAdvice(text: string, meta: { model: string; host: string }) {
	const grab = (m: string) =>
		text
			.split(new RegExp(`^${m}:`, "m"))[1]
			?.split(/^[A-Z]+:/m)[0]
			?.trim() ?? "";
	const rec =
		grab("RECOMMENDATION") || text.split("\n")[0]?.trim() || "(empty)";
	const rationale = grab("RATIONALE");
	const risk = grab("RISK");
	const advice = JSON.stringify({
		rec: rec.slice(0, 500),
		rationale: rationale.slice(0, 900),
		risk: risk.slice(0, 300),
		model: meta.model,
		ts: now,
	});
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
	).run(fk, advice, Date.now());
	db.query("DELETE FROM facts WHERE key = ?").run(`${fk}.error`);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'ADVICE', ?, ?, ?)",
	).run(
		Date.now(),
		ev.scope,
		JSON.stringify({ for: id, rec: rec.slice(0, 160) }),
		ev.source, // back to the asker: their fork has advice waiting
	);
	console.log(`advised #${id}: ${rec.slice(0, 100)}`);
}

/** One remote advise attempt (W90): ensure (WoL if asleep), chat, record
 *  telemetry, store, exit 0. Throws past a dead endpoint → next candidate. */
async function tryRemoteAdvise(
	machine: RemoteMachine,
	endpoint: RemoteEndpoint,
) {
	const h = await ensureEndpoint(machine, endpoint);
	if (!h.alive) return;
	const out = await chatRemote(
		machine,
		endpoint,
		[
			{ role: "system", content: sys },
			{
				role: "user",
				content: `DECISION FORK:\n${question}\n\nCONTROL-PLANE CONTEXT:\n${ctx}`,
			},
		],
		{ maxTokens: 500, timeoutMs: 300_000 },
	);
	const host = `${machine.name}:${endpoint.port}`;
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({
			for: id,
			model: out.model,
			host,
			pt: 0,
			ct: 0,
			tt: 0,
			ms: out.ms,
		}),
	);
	storeAdvice(out.text, { model: out.model, host });
	console.error(`advise #${id}: local LLM down — answered by remote ${host}`);
	process.exit(0);
}

/** W89.2 — belt as FIRST candidate: POST /api/route {role:"advise",
 *  execute:true} lets belt pick the best healthy target from its own
 *  metrics (local swarm, NAS, cloud). Null when belt is unreachable —
 *  the local and remote paths below stay as fallbacks. */
async function tryBeltRoute(
	sys: string,
	question: string,
): Promise<{ text: string; model: string; host: string; ms: number } | null> {
	const base = process.env.SUSPENDERS_BELT_URL ?? "http://127.0.0.1:7791";
	try {
		const r = await fetch(`${base}/api/route`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				role: "advise",
				execute: true,
				max_tokens: 500,
				temperature: 0.2,
				messages: [
					{ role: "system", content: sys },
					{
						role: "user",
						content: `DECISION FORK:\n${question}\n\nCONTROL-PLANE CONTEXT:\n${ctx}`,
					},
				],
			}),
			signal: AbortSignal.timeout(300_000),
		});
		if (!r.ok) return null;
		const j = (await r.json()) as {
			reply?: string;
			target?: { model?: string; machine?: string; port?: number };
			ms?: number;
		};
		if (!j.reply) return null;
		return {
			text: j.reply,
			model: j.target?.model ?? "belt",
			host: `belt(${j.target?.machine ?? "?"})`,
			ms: j.ms ?? 0,
		};
	} catch {
		return null;
	}
}

// W89.2: belt picks first — metrics-based routing across the whole fleet;
// local SUSPENDERS_LLM_URL and the remote registry stay as fallbacks
const belt = await tryBeltRoute(sys, question);
if (belt) {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({
			for: id,
			model: belt.model,
			host: belt.host,
			pt: 0,
			ct: 0,
			tt: 0,
			ms: belt.ms,
		}),
	);
	storeAdvice(belt.text, { model: belt.model, host: belt.host });
	process.exit(0);
}

const t0 = Date.now();
try {
	const r = await fetch(URL_, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: sys },
				{
					role: "user",
					content: `DECISION FORK:\n${question}\n\nCONTROL-PLANE CONTEXT:\n${ctx}`,
				},
			],
			max_tokens: 500,
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!r.ok)
		throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: LlmUsage;
	};
	text = j.choices?.[0]?.message?.content ?? "";
	// W28 routing telemetry: every advise round-trip becomes an llm.call
	// event — the board's LLM telemetry block sums today's tokens per model
	// against optional llm.budget.<model> facts. Usage may be absent (some
	// local servers omit it) — record zeros rather than skipping, so the
	// routing log still shows the call. On failure: still logged, with error.
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({
			for: id,
			model: MODEL,
			host: LLM_HOST,
			pt: j.usage?.prompt_tokens ?? 0,
			ct: j.usage?.completion_tokens ?? 0,
			tt:
				j.usage?.total_tokens ??
				(j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0),
			ms: Date.now() - t0,
		}),
	);
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	// telemetry even on failure — the routing log shows failed calls too (W28)
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'advise', 'llm.call', NULL, ?, NULL)",
	).run(
		Date.now(),
		JSON.stringify({
			for: id,
			model: MODEL,
			host: LLM_HOST,
			pt: 0,
			ct: 0,
			tt: 0,
			ms: Date.now() - t0,
			error: msg.slice(0, 200),
		}),
	);
	// connection refused / timeout = no advice LLM reachable (machine without
	// the local fleet, belt down): a graceful skip, not a failure. The fork
	// stays open for the human; a cloud SUSPENDERS_LLM_URL unchanged —
	// this branch is only the fetch throwing, i.e. no HTTP answer at all
	// (HTTP failures throw the `LLM <status>` error above and stay failures).
	const unavailable = !msg.startsWith("LLM ");
	if (unavailable) {
		// W90 remote fallback: local advice LLM down → route the fork to
		// "advise"-role endpoints in the remote registry, WoL-ensure included.
		for (const { machine, endpoint } of endpointsWithRole("advise")) {
			await tryRemoteAdvise(machine, endpoint);
		}
	}
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'advise', 1, ?)",
	).run(`${fk}.error`, unavailable ? `unavailable: ${msg}` : msg, Date.now());
	console.error(
		unavailable
			? `advise #${id}: no advice LLM at ${LLM_HOST} (${msg.slice(0, 120)}) — advice unavailable, fork stays open`
			: `advise #${id} failed: ${msg}`,
	);
	process.exit(unavailable ? 0 : 2);
}

storeAdvice(text, { model: MODEL, host: LLM_HOST });
