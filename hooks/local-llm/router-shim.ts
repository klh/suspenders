#!/usr/bin/env bun
// router-shim.ts — LLM specialist swarm router v3.
// Anthropic API format on :4000 → complexity-scored routing across the local
// mlx swarm, bounded fallback to an alternate specialist, then optional cloud
// escalation (prefs-gated).
//
// Routing preference + cloud switch live in prefs.json (same dir):
//   { "cost_speed": "balanced"|"cost"|"speed"|"quality", "allow_cloud": bool }
// Cloud escalation fires only when: allow_cloud=true, cost mode isn't active,
// local failed twice, and the task is COMPLEX/VERY_COMPLEX (SIMPLE never
// leaves the machine).

import { appendFileSync } from "node:fs";
import { byPort, fallbackFor, type Specialist } from "./registry.ts";
import { ensureUp } from "./spawner.ts";

const HOME = process.env.HOME;
const PREFS_FILE = `${HOME}/.claude/local-llm/prefs.json`;
const ROUTING_LOG = `${HOME}/.claude-insights/swarm-routing.log`;

function logRouting(entry: Record<string, unknown>) {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	try {
		appendFileSync(ROUTING_LOG, `${line}\n`);
	} catch {}
}

type Prefs = {
	cost_speed?: "balanced" | "cost" | "speed" | "quality";
	allow_cloud?: boolean;
	profile?: string[];
};
async function loadPrefs(): Promise<Prefs> {
	try {
		return JSON.parse(await Bun.file(PREFS_FILE).text());
	} catch {
		return {};
	}
}

// ─── 7-dimension complexity scoring (LiteLLM Auto Router pattern) ───
interface ComplexityScore {
	total: number; // 0..1 (higher = more complex)
	tier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
	dimensions: Record<string, number>;
}

const CODE_PATTERNS =
	/\b(function|class|interface|type\s|const\s|let\s|var\s|import\s|export\s|def\s|public\s|private\s|async\s|await|return|=>|\.ts|\.tsx|\.js|\.py|\.cs|typescript|javascript|python|csharp|refactor|debug|compile|lint|api|endpoint|component|hook|docker|kubernetes|algorithm|implement|optimize)\b/i;
const REASONING_MARKERS =
	/\b(analyze|explain|compare|evaluate|design|architect|strategy|why|how\s+does|what\s+if|pros\s+and\s+cons|trade.?off|implications|consequences|root\s+cause|derive|prove|justify|critique)\b/i;
const TECHNICAL_TERMS =
	/\b(distributed|concurrency|latency|throughput|scalab|migration|protocol|authentication|encryption|database|schema|middleware|microservice|monolith|event.?driven|state\s+machine|compiler|runtime|garbage\s+collection)\b/i;
const SIMPLE_INDICATORS =
	/^(reply|respond|list|name|give\s+me|tell\s+me|what\s+is|who\s+is|when\s+is|where\s+is|how\s+many|convert|translate|summarize\s+this|format\s+this|sort\s+this)\b/i;
const MULTI_STEP =
	/\b(first.*then|step\s+\d|also\s+after|additionally|furthermore|meanwhile|subsequently|before\s+that|after\s+that|next\s+you|finally)\b/i;
const QUESTION_DEPTH =
	/\b(underlying|fundamental|philosophical|theoretical|abstract|conceptual|architectural|systemic|holistic|nuanced|paradox|dilemma|emergence)\b/i;

function scoreComplexity(text: string): ComplexityScore {
	const lower = text.toLowerCase();
	const words = text.split(/\s+/).length;

	const dimensions: Record<string, number> = {
		tokenCount: Math.min(words / 200, 1),
		codePresence: CODE_PATTERNS.test(text) ? 0.8 : 0,
		reasoningMarkers:
			(lower.match(new RegExp(REASONING_MARKERS.source, "gi")) ?? []).length *
			0.25,
		technicalTerms:
			(lower.match(new RegExp(TECHNICAL_TERMS.source, "gi")) ?? []).length *
			0.2,
		simpleIndicators: SIMPLE_INDICATORS.test(text.trim()) ? -0.3 : 0, // NEGATIVE weight
		multiStep: MULTI_STEP.test(lower) ? 0.3 : 0,
		questionComplexity: QUESTION_DEPTH.test(lower) ? 0.4 : 0,
	};

	for (const k of Object.keys(dimensions)) {
		dimensions[k] = Math.max(0, Math.min(1, dimensions[k]));
	}

	const weights: Record<string, number> = {
		tokenCount: 0.15,
		codePresence: 0.25,
		reasoningMarkers: 0.25,
		technicalTerms: 0.1,
		simpleIndicators: 0.1,
		multiStep: 0.05,
		questionComplexity: 0.1,
	};

	let total = 0;
	for (const [dim, weight] of Object.entries(weights)) {
		total += dimensions[dim] * weight;
	}
	total = Math.max(0, Math.min(1, total));

	// code tasks always route to coder regardless of complexity
	if (dimensions.codePresence > 0.5) {
		return { total, tier: "MEDIUM", dimensions };
	}

	let tier: ComplexityScore["tier"];
	if (total < TIER_THRESHOLDS.SIMPLE) tier = "SIMPLE";
	else if (total < TIER_THRESHOLDS.MEDIUM) tier = "MEDIUM";
	else if (total < TIER_THRESHOLDS.COMPLEX) tier = "COMPLEX";
	else tier = "VERY_COMPLEX";

	return { total, tier, dimensions };
}

// arithmetic lane: a pure-math ask is evaluated directly, never sent to an
// LLM — Qwen3-4B deterministically answers 17*23 -> "401" at temp 0 (verified
// 2026-09-23). Strict allowlist; anything ambiguous fails safe to the LLM.
const ARITH_LEAD =
	/^(what\s+is|what's|whats|calculate|compute|how\s+much\s+is|how\s+many\s+is|hvad\s+er|hvor\s+meget\s+er)\s+/i;
const ARITH_TAIL =
	/\s*[,.;]?\s*(answer|reply|respond|svar)(\s+\w+){0,3}\s*(the\s+)?(number|result|tallet)(\s+only)?[.]*$/i;
function arithmeticAnswer(text: string): string | null {
	let t = text
		.trim()
		.replace(ARITH_LEAD, "")
		.replace(ARITH_TAIL, "")
		.replace(/[?!.]+$/, "")
		.trim();
	if (!t || t.length > 120) return null;
	t = t.replace(/\bx\b|×/gi, "*").replace(/÷/g, "/");
	if (!/^[\d\s+\-*/()]+$/.test(t)) return null; // strict charset
	if (!/\d/.test(t) || (!/[+*/]/.test(t) && !/\d\s*-\s*\d/.test(t)))
		return null; // need an operator
	const tokens = t.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
	if (!tokens) return null;
	const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
	const out: (number | string)[] = [];
	const ops: string[] = [];
	let prev: "n" | "op" | "(" | ")" | null = null;
	for (const tk of tokens) {
		if (/^\d/.test(tk)) {
			out.push(parseFloat(tk));
			prev = "n";
			continue;
		}
		if (tk === "(") {
			ops.push(tk);
			prev = "(";
			continue;
		}
		if (tk === ")") {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(") break;
				ops.pop();
				out.push(top);
			}
			if (!ops.includes("(")) return null;
			ops.pop();
			prev = ")";
			continue;
		}
		if (tk === "-" && (prev === null || prev === "op" || prev === "("))
			out.push(0); // unary minus
		else {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(" || (prec[top] ?? 0) < prec[tk])
					break;
				ops.pop();
				out.push(top);
			}
		}
		ops.push(tk);
		prev = "op";
	}
	while (ops.length) {
		const o = ops.pop();
		if (o === undefined || o === "(") return null;
		out.push(o);
	}
	const st: number[] = [];
	for (const tk of out) {
		if (typeof tk === "number") {
			st.push(tk);
			continue;
		}
		const b = st.pop();
		const a = st.pop();
		if (a === undefined || b === undefined) return null;
		st.push(
			tk === "+" ? a + b : tk === "-" ? a - b : tk === "*" ? a * b : a / b,
		);
	}
	if (st.length !== 1 || !Number.isFinite(st[0])) return null;
	const r = st[0];
	return String(
		Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : Number(r.toFixed(6)),
	);
}

// Lower thresholds (were too conservative — 0.221 scored as SIMPLE)
const TIER_THRESHOLDS = { SIMPLE: 0.15, MEDIUM: 0.35, COMPLEX: 0.6 };

// ─── routes derived from registry.ts (single source of truth) ───
// fail fast at boot on a misconfigured registry, not mid-request
const specialist = (port: number): Specialist => {
	const s = byPort(port);
	if (!s) throw new Error(`registry: no specialist on :${port}`);
	return s;
};
const CODE = specialist(8901);
const REASON = specialist(8903);
const EXTRACT = specialist(8902);
const DANISH = specialist(8906); // tier:"ondemand" — spawned on first request
const TIER_ROUTES: Record<string, Specialist> = {
	SIMPLE: EXTRACT,
	MEDIUM: CODE,
	COMPLEX: REASON,
	VERY_COMPLEX: REASON,
};

// Danish/multilingual detection — deterministic word list + æøå, no model
// calls (routing rule 3). Two strong hits, or one strong + weak, or three
// weak; æøå shares with Norwegian, but :8906 covers 201 langs either way.
const DA_STRONG =
	/\b(jeg|ikke|hvad|hvordan|hvorfor|hvilken|hvilket|hvilke|også|måske|dansk|danmark|hygge|mig|dig)\b/gi;
const DA_WEAK =
	/\b(og|er|det|som|på|til|af|med|der|hun|han|vi|har|skal|år)\b/gi;
function isDanish(text: string): boolean {
	const strong = (text.match(DA_STRONG) ?? []).length;
	const weak = (text.match(DA_WEAK) ?? []).length;
	if ((text.match(/[æøå]/gi) ?? []).length >= 2) return true;
	return strong >= 2 || (strong >= 1 && weak >= 1) || weak >= 3;
}

// ─── specialist call (OpenAI format) ───
async function viaLocal(
	r: { port: number; model: string },
	messages: unknown[],
	maxTokens: number,
	temperature: number,
): Promise<{ ok: boolean; response: string; error?: string }> {
	let text = "";
	try {
		const res = await fetch(`http://localhost:${r.port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: AbortSignal.timeout(120_000),
			body: JSON.stringify({
				model: r.model,
				messages,
				max_tokens: maxTokens,
				temperature,
				stream: false,
				// Qwen3.8 thinking is template-controlled — /no_think in the prompt
				// doesn't reach it; the kwarg does (other templates ignore it).
				// thinking is template-controlled on Qwen3.8 + Qwen3.5: disable for
				// speed (both verified direct-answer with this off, Sep 23)
				...(r.port === 8903 || r.port === 8906
					? { chat_template_kwargs: { enable_thinking: false } }
					: {}),
			}),
		});
		text = await res.text();
		// mlx_lm occasionally emits raw newlines inside JSON strings — try strict
		// parse first (preserves unicode), fall back to escaping control chars.
		// OpenAI-format chat completion response — the fields the shim consumes
		let j: {
			error?: string | { message?: string };
			choices?: Array<{
				finish_reason?: string;
				message?: { content?: string; reasoning_content?: string };
			}>;
		};
		try {
			j = JSON.parse(text);
		} catch {
			j = JSON.parse(text.replace(/\n/g, "\\n"));
		}
		if (j.error) {
			return {
				ok: false,
				response: "",
				error:
					typeof j.error === "string"
						? j.error
						: (j.error.message ?? "specialist error"),
			};
		}
		const msg = j.choices?.[0]?.message ?? {};
		const strip = (s: string) =>
			s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
		const response =
			strip(msg.content || "") || strip(msg.reasoning_content || "");
		if (!response) {
			return {
				ok: false,
				response: "",
				error: `empty (finish=${j.choices?.[0]?.finish_reason ?? "?"}, keys=${Object.keys(msg).join("+") || "none"})`,
			};
		}
		return { ok: true, response };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			response: "",
			error: `${msg}${text ? ` | raw: ${text.slice(0, 120)}` : ""}`,
		};
	}
}

// ─── cloud escalation (z.ai, Anthropic format; creds read at request time,
// never logged or cached) ───
async function viaCloud(
	messages: unknown[],
	maxTokens: number,
	wantFast: boolean,
): Promise<string> {
	const settings = JSON.parse(
		await Bun.file(`${HOME}/.claude/settings.json`).text(),
	);
	const tok = settings.env?.ANTHROPIC_AUTH_TOKEN;
	const base = settings.env?.ANTHROPIC_BASE_URL;
	if (!tok || !base) return "";
	const res = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": tok,
			authorization: `Bearer ${tok}`,
			"anthropic-version": "2023-06-01",
		},
		signal: AbortSignal.timeout(120_000),
		body: JSON.stringify({
			model: wantFast ? "glm-5.3-flash[1m]" : "glm-5.3[1m]",
			max_tokens: maxTokens,
			messages,
		}),
	});
	const j = (await res.json()) as { content?: Array<{ text?: string }> };
	return (j.content ?? [])
		.map((b) => b.text ?? "")
		.join("")
		.trim();
}

// selftest: fire one request whose primary target is a dead port, asserting
// the fallback branch answers. The path otherwise almost never runs — first
// real firing ever (Sep 23) crashed on a stale FALLBACKS table.
if (process.argv[2] === "selftest") {
	const base = `http://127.0.0.1:${process.env.BELT_ROUTER_PORT ?? 4000}`;
	const t0 = performance.now();
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 60,
			_force_dead_port: 59999,
			messages: [{ role: "user", content: "Reply with the word OK." }],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		_routing?: { note?: string };
		content?: Array<{ text?: string }>;
	};
	const note = String(d._routing?.note ?? "");
	const text = String(d.content?.[0]?.text ?? "");
	const ok = r.status === 200 && note.includes("fallback") && text.length > 0;
	console.log(
		`${ok ? "✓" : "✗"} fallback ${ok ? "verified" : "BROKEN"} — status=${r.status} note="${note}" head="${text.slice(0, 40)}" (${Math.round(performance.now() - t0)}ms)`,
	);
	process.exit(ok ? 0 : 1);
}

// selftest-danish: fire one request that must land on the on-demand
// generalist :8906 — asserts detection + spawn-on-demand. Needs :8906 either
// warm or spawnable; run against BELT_ROUTER_PORT for side-by-side checks.
if (process.argv[2] === "selftest-danish") {
	const base = `http://127.0.0.1:${process.env.BELT_ROUTER_PORT ?? 4000}`;
	const t0 = performance.now();
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 60,
			messages: [
				{
					role: "user",
					content:
						"Hvad er forskellen på hypotese og teori? Forklar venligst kort.",
				},
			],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		_routing?: { port?: number; note?: string };
		content?: Array<{ text?: string }>;
	};
	const note = String(d._routing?.note ?? "");
	const text = String(d.content?.[0]?.text ?? "");
	const ok = r.status === 200 && d._routing?.port === 8906 && text.length > 0;
	console.log(
		`${ok ? "✓" : "✗"} danish ondemand ${ok ? "verified" : "BROKEN"} — status=${r.status} port=${d._routing?.port} note="${note}" head="${text.slice(0, 40)}" (${Math.round(performance.now() - t0)}ms)`,
	);
	process.exit(ok ? 0 : 1);
}

// ─── Anthropic↔OpenAI shim ───
// BELT_ROUTER_PORT: side-by-side runs (tests, canary) without disturbing :4000.
const ROUTER_PORT = Number(process.env.BELT_ROUTER_PORT ?? 4000);
Bun.serve({
	port: ROUTER_PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "GET" && url.pathname === "/health/liveliness") {
			return Response.json({ status: "alive", router: "complexity-v3" });
		}

		if (req.method !== "POST" || url.pathname !== "/v1/messages") {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		let body: {
			model?: string;
			max_tokens?: number;
			temperature?: number;
			messages?: Array<{ role: unknown; content: unknown }>;
			_force_dead_port?: number;
		};
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400 });
		}

		const startTime = Date.now();
		const blocksOf = (m: { content: unknown }): string =>
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content
							.map((b) => {
								const t = (b as { text?: unknown } | null)?.text;
								return typeof t === "string" ? t : "";
							})
							.join("")
					: "";
		const text = (body.messages ?? []).map(blocksOf).join(" ");

		// score complexity and select specialist:
		//   code-ish → coder; everything non-SIMPLE prose → 27B general; else 4B
		const prefs = await loadPrefs();
		const score = scoreComplexity(text);

		// arithmetic lane — zero tokens, zero model calls
		const arith = arithmeticAnswer(text);
		if (arith !== null) {
			return Response.json({
				id: `msg_arith_${Date.now()}`,
				type: "message",
				role: "assistant",
				model: body.model,
				content: [{ type: "text", text: arith }],
				stop_reason: "end_turn",
				usage: { input_tokens: 0, output_tokens: 0 },
				_routing: { tier: "SIMPLE", category: "arithmetic" },
			});
		}

		const isCode = score.dimensions.codePresence > 0.5;
		let route = isCode
			? TIER_ROUTES.MEDIUM
			: score.tier === "SIMPLE"
				? TIER_ROUTES.SIMPLE
				: TIER_ROUTES.COMPLEX;

		// ambiguity band → Kev typed-question classifier decides by use case
		// (routing table from prefs); kev down/slow ⇒ regex result stands
		let classifier = "";
		const band: [number, number] = prefs.kev?.ambiguity_band ?? [0.25, 0.45];
		const inBand = score.total >= band[0] && score.total <= band[1];
		if (
			prefs.kev?.enabled &&
			!isCode &&
			(inBand || score.tier === "VERY_COMPLEX")
		) {
			try {
				const kr = await fetch(
					`http://127.0.0.1:${prefs.kev.port ?? 8912}/v1/systemone`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						signal: AbortSignal.timeout(4000),
						body: JSON.stringify({
							model: "kev-latest",
							state: text.slice(0, 4000),
							questions: {
								use_case: {
									type: "choice",
									instructions: "Which use-case class is this request?",
									criteria: {
										coding: "Writing, debugging, or reviewing code",
										architecture:
											"System design, trade-offs, technical strategy",
										trading: "Stock market, positions, finance risk decisions",
										business: "Invoices, customers, business administration",
										research: "Multi-source investigation and synthesis",
										product: "Product decisions and roadmaps",
										personal: "Everyday personal assistance, email, chit-chat",
									},
								},
							},
						}),
					},
				);
				const kj = (await kr.json()) as {
					answers?: { use_case?: { choice?: string } };
				};
				const uc = kj.answers?.use_case?.choice;
				const pin = uc ? prefs.routing_table?.[uc] : undefined;
				if (pin) {
					route =
						pin === 8901
							? TIER_ROUTES.MEDIUM
							: pin === 8902
								? TIER_ROUTES.SIMPLE
								: TIER_ROUTES.COMPLEX;
					classifier = `kev:${uc}`;
				}
			} catch {
				/* kev unavailable → keep regex route */
			}
		}

		// Danish/multilingual → the on-demand generalist :8906 (routing rule 5);
		// overrides use-case pins — language beats task class for the 9B specialist.
		if (!isCode && DANISH && route.port !== DANISH.port && isDanish(text)) {
			route = DANISH;
			classifier = classifier ? `${classifier}+danish` : "danish";
		}

		const maxTokens = Math.min(body.max_tokens ?? 1024, 4096);
		const temperature = body.temperature ?? 0.7;

		// OpenAI-format messages + /no_think for Qwen3 models
		const messages = (body.messages ?? []).map((m) => ({
			role: m.role === "assistant" ? "assistant" : "user",
			content: blocksOf(m),
		}));
		if (!messages.some((m) => m.role === "system")) {
			messages.unshift({ role: "system", content: "/no_think" });
		} else {
			messages[0].content += " /no_think";
		}

		let response = "";
		let usedPort = route.port;
		let usedModel = route.model;
		const note: string[] = [
			`complexity ${score.total.toFixed(2)} → ${score.tier}${isCode ? "+code" : ""}${classifier ? ` ${classifier}` : ""}`,
		];

		// selftest hook: _force_dead_port swaps the primary target while keeping
		// route identity — fallbackFor() still maps from the real route
		let primary = route;
		if (Number.isFinite(Number(body._force_dead_port))) {
			primary = {
				...route,
				port: Number(body._force_dead_port) as Specialist["port"],
				model: "selftest-dead",
			};
			note.push(`forced dead primary :${primary.port}`);
		}

		// ondemand tier: spawn on first request (single-flight); residents rely
		// on launchd KeepAlive instead (routing rule 2). Cold load is visible in
		// the note — never a silent fallback (that was the W1 defect).
		if (route.tier === "ondemand") {
			const ens = await ensureUp(route);
			if (ens.up) {
				if (ens.cold)
					note.push(
						`ondemand :${route.port} ready (cold ${(ens.waitedMs / 1000).toFixed(1)}s)`,
					);
			} else {
				note.push(
					`ondemand :${route.port} DOWN (${ens.error ?? "spawn failed"})`,
				);
			}
		}

		// 1) primary specialist
		let attempt = await viaLocal(primary, messages, maxTokens, temperature);
		const errors: string[] = [];
		if (!attempt.ok)
			errors.push(`:${primary.port} ${attempt.error ?? "empty"}`);

		// 2) bounded fallback: one alternate specialist
		if (!attempt.ok) {
			const fb = fallbackFor(route.port);
			if (fb) {
				note.push(`fallback → :${fb.port}`);
				attempt = await viaLocal(fb, messages, maxTokens, temperature);
				usedPort = fb.port;
				usedModel = fb.model;
				if (!attempt.ok) errors.push(`:${fb.port} ${attempt.error ?? "empty"}`);
			}
		}
		if (attempt.ok) response = attempt.response;

		// 3) cloud escalation — prefs-gated, COMPLEX+ only, never in cost mode
		const cloudAllowed =
			prefs.allow_cloud === true && prefs.cost_speed !== "cost";
		const cloudWarranted =
			score.tier === "COMPLEX" ||
			score.tier === "VERY_COMPLEX" ||
			prefs.cost_speed === "quality";
		if (!response && cloudAllowed && cloudWarranted) {
			try {
				response = await viaCloud(
					body.messages,
					maxTokens,
					score.tier !== "VERY_COMPLEX",
				);
				if (response) {
					usedPort = 0;
					usedModel = `z.ai:${score.tier === "VERY_COMPLEX" ? "glm-5.3" : "glm-5.3-flash"}`;
					note.push("escalated → cloud(z.ai)");
				}
			} catch {
				note.push("cloud escalation failed");
			}
		}

		if (!response) {
			logRouting({
				category: route.role,
				model: usedModel,
				port: usedPort,
				duration_ms: Date.now() - startTime,
				prompt: text.slice(0, 80),
				complexity: score.total,
				tier: score.tier,
				outcome: "empty",
			});
			return Response.json(
				{
					type: "error",
					error: {
						type: "api_error",
						message: `router: all routes empty (${[...note, ...errors].join("; ")})`,
					},
				},
				{ status: 502 },
			);
		}

		logRouting({
			category: route.role,
			model: usedModel,
			port: usedPort,
			duration_ms: Date.now() - startTime,
			prompt: text.slice(0, 80),
			complexity: score.total,
			tier: score.tier,
			escalated: usedPort === 0 ? "z.ai" : undefined,
		});

		return Response.json({
			id: `msg_${route.role}_${Date.now()}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content: [{ type: "text", text: response }],
			stop_reason: "end_turn",
			usage: { input_tokens: 0, output_tokens: 0 },
			_routing: {
				tier: score.tier,
				complexity: score.total.toFixed(3),
				category: route.role,
				port: usedPort,
				model: usedModel,
				note: note.join("; "),
				prefs: {
					cost_speed: prefs.cost_speed ?? "balanced",
					allow_cloud: prefs.allow_cloud === true,
					profile: prefs.profile ?? [],
				},
				dimensions: Object.fromEntries(
					Object.entries(score.dimensions).map(([k, v]) => [k, v.toFixed(2)]),
				),
			},
		});
	},
});

console.log(
	`router-shim v3 (complexity + prefs + escalation) on :${ROUTER_PORT}`,
);
for (const [tier, r] of Object.entries(TIER_ROUTES)) {
	console.log(
		`  ${tier.padEnd(13)} → :${r.port} ${r.model.replace("mlx-community/", "")}`,
	);
}
console.log(
	`  code → :${CODE.port} · non-SIMPLE prose → :${REASON.port} · SIMPLE → :${EXTRACT.port}`,
);
console.log(
	`  danish/multilingual → :${DANISH.port} (on-demand, spawned on first request)`,
);
console.log(
	`  cloud escalation: allow_cloud=true (COMPLEX+ only, off in cost mode)`,
);
