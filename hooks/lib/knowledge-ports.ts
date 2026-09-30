// hooks/lib/knowledge-ports.ts — W91 #9: the knowledge layer's ports. The
// worker loop consumes INTERFACES, never concrete tech, so an enterprise
// deployment can swap the store (Azure Blob / Postgres / Service Bus) or the
// distill endpoint (their Foundry/Azure OpenAI via belt, or any
// OpenAI-compatible URL) without touching the loop. Only the LOCAL adapters
// are implemented here — the seam is the deliverable, remote adapters are
// deliberately not written.
//
//   KnowledgeStore — queue semantics + candidate storage + search. The FTS5
//     specifics live in the SQLite adapter; a remote store implements search
//     with its own engine. Remote manners: batch claim/complete, never
//     chatty per-row round trips.
//   DistillClient — payload → candidate JSON (knowledgeworker.md prepended
//     here, per directive #6). Local impl targets :8903; any
//     OpenAI-compatible URL works — belt's /api/route is exactly that, so
//     fleet routing needs only env, no code.
//
// Config seam: a plain switch at daemon startup (env), no plugin framework.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	findNearDuplicate,
	knowledgeSearch,
	type KnowledgeHit,
} from "./knowledge.ts";
import { openGovernorDb } from "./govdb.ts";
import { resolveBelt } from "./belt-locate.ts";

export type { KnowledgeHit };

export interface KnowledgeJob {
	id: number;
	source: string;
	payload: string;
	attempts: number;
	domain: string | null;
	area: string | null;
	codeOrigin: string | null;
	originSid: string | null;
	sourceHash: string;
}

export interface KnowledgeUpsert {
	topic: string;
	fact: string;
	confidence: number;
	domain: string | null;
	area: string | null;
	originKind: string | null;
	originSystem: string | null;
	sourceRef: string | null;
	sourceHash: string;
	originSid: string | null;
	supersedesId: number | null;
}

export interface KnowledgeSearchFilters {
	query: string;
	limit?: number;
	domain?: string | null;
	area?: string | null;
	originKind?: string | null;
	originSystem?: string | null;
}

export interface KnowledgeStore {
	// queue semantics (directive #8 shape stays a worker-loop concern; the
	// store only guarantees claim/complete/fail)
	peekNext(): Promise<{ id: number } | null>;
	claim(id: number): Promise<KnowledgeJob | null>;
	complete(
		id: number,
		ledger: { written: number[]; skipped: string[] },
		domain: string | null,
		by: string | null,
	): Promise<void>;
	fail(id: number, err: string, poison: boolean): Promise<void>;
	// storage + retrieval
	upsert(row: KnowledgeUpsert): Promise<number>;
	dedupeCheck(cand: {
		topic: string;
		fact: string;
	}): Promise<{ id: number; topic: string; fact: string } | null>;
	search(filters: KnowledgeSearchFilters): Promise<KnowledgeHit[]>;
	emitLanded(
		domain: string | null,
		written: number[],
		queueId: number,
		by: string | null,
	): Promise<void>;
	recoverOrphans(olderThanMs: number): Promise<void>;
	queuedCount(): Promise<number>;
	// lifecycle (human/merge-gated; mechanical micro-updates)
	promote(id: number): Promise<boolean>;
	retire(id: number, supersededBy: number | null): Promise<boolean>;
	note(id: number, sid: string, what: string): Promise<number>;
	verifyRows(
		id: number | null,
	): Promise<
		{ id: number; topic: string; sourceRef: string; sourceHash: string }[]
	>;
}

export interface DistillClient {
	distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<
		{
			topic: string;
			fact: string;
			confidence: number;
			domain: string | null;
			area: string | null;
			originKind: string | null;
			originSystem: string | null;
			supersedesId: number | null;
		}[]
	>;
}

// ─── local adapter: governor.db (SQLite/WAL) + FTS5 + knowledge_queue ───
// the ONLY place in the knowledge layer allowed to open governor.db (#9b)
export class SqliteKnowledgeStore implements KnowledgeStore {
	constructor(private db: Database) {}

	async peekNext(): Promise<{ id: number } | null> {
		return (
			(this.db
				.query(
					"SELECT id FROM knowledge_queue WHERE state = 'queued' ORDER BY ts, id LIMIT 1",
				)
				.get() as { id: number } | null) ?? null
		);
	}

	async claim(id: number): Promise<KnowledgeJob | null> {
		const row = this.db
			.query(
				"SELECT source, payload, attempts, domain, area, code_origin, origin_sid FROM knowledge_queue WHERE id = ? AND state = 'queued'",
			)
			.get(id) as
			| {
					source: string;
					payload: string;
					attempts: number;
					domain: string | null;
					area: string | null;
					code_origin: string | null;
					origin_sid: string | null;
			  }
			| undefined;
		if (!row) return null;
		this.db
			.query(
				"UPDATE knowledge_queue SET state = 'started', attempts = attempts + 1, started_at = ? WHERE id = ?",
			)
			.run(Date.now(), id);
		return {
			id,
			source: row.source,
			payload: row.payload,
			attempts: row.attempts + 1,
			domain: row.domain,
			area: row.area,
			codeOrigin: row.code_origin,
			originSid: row.origin_sid,
			sourceHash: createHash("sha256").update(row.payload).digest("hex"),
		};
	}

	async complete(
		id: number,
		ledger: { written: number[]; skipped: string[] },
		domain: string | null,
		by: string | null,
	): Promise<void> {
		this.db
			.query(
				"UPDATE knowledge_queue SET state = 'done', result_key = ?, payload = '' WHERE id = ?",
			)
			.run(JSON.stringify(ledger), id);
		await this.emitLanded(domain, ledger.written, id, by);
	}

	async fail(id: number, err: string, poison: boolean): Promise<void> {
		if (poison)
			this.db
				.query(
					"UPDATE knowledge_queue SET state = 'failed', result_key = ?, payload = '' WHERE id = ?",
				)
				.run(`failed after max attempts: ${err.slice(0, 250)}`, id);
		else
			this.db
				.query("UPDATE knowledge_queue SET state = 'queued' WHERE id = ?")
				.run(id);
	}

	async promote(id: number): Promise<boolean> {
		return (
			this.db
				.query(
					"UPDATE knowledge SET state = 'active' WHERE id = ? AND state = 'candidate'",
				)
				.run(id).changes > 0
		);
	}

	async retire(id: number, supersededBy: number | null): Promise<boolean> {
		return (
			this.db
				.query(
					"UPDATE knowledge SET state = 'retired', superseded_by = COALESCE(?, superseded_by) WHERE id = ? AND state != 'retired'",
				)
				.run(supersededBy, id).changes > 0
		);
	}

	async note(id: number, sid: string, what: string): Promise<number> {
		const row = this.db
			.query("SELECT contributors FROM knowledge WHERE id = ?")
			.get(id) as { contributors: string | null } | undefined;
		if (!row) return -1;
		let contributors: unknown[] = [];
		try {
			contributors = row.contributors ? JSON.parse(row.contributors) : [];
		} catch {}
		contributors.push({ sid, ts: Date.now(), what });
		this.db
			.query(
				"UPDATE knowledge SET contributors = ?, updated_at = ? WHERE id = ?",
			)
			.run(JSON.stringify(contributors), Date.now(), id);
		return contributors.length;
	}

	async verifyRows(id: number | null) {
		return this.db
			.query(
				"SELECT id, topic, source_ref AS sourceRef, source_hash AS sourceHash FROM knowledge WHERE source_ref IS NOT NULL AND source_hash IS NOT NULL AND (? IS NULL OR id = ?)",
			)
			.all(id, id) as {
			id: number;
			topic: string;
			sourceRef: string;
			sourceHash: string;
		}[];
	}

	async upsert(row: KnowledgeUpsert): Promise<number> {
		const now = Date.now();
		const ins = this.db
			.query(
				"INSERT INTO knowledge (ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'knowledge-worker', 'candidate', ?, ?)",
			)
			.run(
				now,
				row.topic,
				row.fact,
				row.confidence,
				row.domain,
				row.area,
				row.originKind,
				row.originSystem,
				row.sourceRef,
				row.originSid,
				JSON.stringify(
					row.originSid
						? [{ sid: row.originSid, ts: now, what: "origin" }]
						: [],
				),
				// supersedes links must point at REAL rows — never dangle
				row.supersedesId &&
					this.db
						.query("SELECT 1 FROM knowledge WHERE id = ?")
						.get(row.supersedesId)
					? row.supersedesId
					: null,
				row.sourceRef,
				row.sourceHash,
				now,
				now,
			);
		return Number(ins.lastInsertRowid);
	}

	async dedupeCheck(cand: {
		topic: string;
		fact: string;
	}): Promise<{ id: number; topic: string; fact: string } | null> {
		return findNearDuplicate(this.db, cand);
	}

	async search(filters: KnowledgeSearchFilters): Promise<KnowledgeHit[]> {
		return knowledgeSearch(this.db, filters.query, filters);
	}

	async emitLanded(
		domain: string | null,
		written: number[],
		queueId: number,
		by: string | null,
	): Promise<void> {
		this.db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.landed', ?, ?, NULL)",
			)
			.run(
				Date.now(),
				"knowledge-worker",
				domain,
				JSON.stringify({ knowledge: written, queue: queueId, by }),
			);
	}

	async recoverOrphans(olderThanMs: number): Promise<void> {
		this.db
			.query(
				"UPDATE knowledge_queue SET state = 'queued' WHERE state IN ('started','running') AND started_at < ?",
			)
			.run(Date.now() - olderThanMs);
	}

	async queuedCount(): Promise<number> {
		return (
			this.db
				.query(
					"SELECT COUNT(*) AS n FROM knowledge_queue WHERE state = 'queued'",
				)
				.get() as { n: number }
		).n;
	}
}

// ─── distill support: strict JSON parse + canon clamps (#7) ───
export interface DistillItem {
	topic: string;
	fact: string;
	confidence: number;
	domain: string | null;
	area: string | null;
	originKind: string | null;
	originSystem: string | null;
	supersedesId: number | null;
}

// tolerate fences/prose around the JSON array; validate + clamp each item
export function parseDistill(raw: string): DistillItem[] {
	let t = raw.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
	if (fence) t = fence[1];
	const l = t.indexOf("[");
	const r = t.lastIndexOf("]");
	if (l === -1 || r <= l)
		throw new Error(`no JSON array in distill output: ${t.slice(0, 80)}`);
	const arr = JSON.parse(t.slice(l, r + 1)) as unknown[];
	return arr
		.map(asItem)
		.filter((x): x is DistillItem => x !== null)
		.slice(0, 12);
}

// W91 #9/#7: canon clamps — the distill contract caps topic/fact; raw source
// text never enters the table (source_ref + source_hash point back instead)
function asItem(x: unknown): DistillItem | null {
	if (!x || typeof x !== "object") return null;
	const o = x as Record<string, unknown>;
	const t = typeof o.topic === "string" ? o.topic.trim() : "";
	const f = typeof o.fact === "string" ? o.fact.trim() : "";
	if (!t || !f) return null;
	const s = (v: unknown): string | null =>
		typeof v === "string" && v.trim() ? v.trim() : null;
	const conf =
		typeof o.confidence === "number" && Number.isFinite(o.confidence)
			? Math.min(1, Math.max(0, o.confidence))
			: 0.5;
	return {
		topic: t.slice(0, 80),
		fact: f.slice(0, 400),
		confidence: conf,
		domain: s(o.domain),
		area: s(o.area),
		originKind: s(o.origin_kind)?.toLowerCase() ?? null,
		originSystem: s(o.origin_system),
		// extraction only: the source must DECLARE the correction; the model
		// never judges. Clamped to a real row at insert (store.upsert).
		supersedesId:
			typeof o.supersedes_id === "number" && Number.isInteger(o.supersedes_id)
				? o.supersedes_id
				: null,
	};
}

const PROMPT_FILE = join(import.meta.dir, "..", "knowledgeworker.md");

// knowledgeworker.md: config-over-code — re-read at REQUEST time so prompt
// edits apply to the next queued job without a restart (#6)
export function systemPrompt(): string {
	try {
		return readFileSync(PROMPT_FILE, "utf8");
	} catch {
		return "";
	}
}

// missing prompt file → minimal inline fallback, never a dead worker
const FALLBACK_PROMPT =
	"You are an impartial indexer for a fleet knowledge store. You do not evaluate truth, quality, or usefulness — you describe, condense, link, and timestamp. Return ONLY a JSON array. Each element: {topic, fact, confidence 0..1, domain, area, origin_kind (lesson|incident|decision|study|fact), origin_system, supersedes_id (only when the source text EXPLICITLY declares it replaces/corrects a row, else null)}. Never copy credentials into facts — redact as [REDACTED] or reject. Corrections create a new row via supersedes_id; history is append-only.";

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

// W91 #9: local distill adapter — any OpenAI-compatible endpoint. Belt users
// omit INGEST_LLM_URL and fall through to BeltDistillClient instead.
export class LocalLlmDistillClient implements DistillClient {
	constructor(
		private url: string,
		private key?: string,
	) {}

	async distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<DistillItem[]> {
		const model =
			process.env.INGEST_LLM_MODEL ?? (await defaultModel(this.url, this.key));
		const hintsLine = [
			hints.domain ? `domain=${hints.domain}` : "domain=null",
			hints.area ? `area=${hints.area}` : "area=null",
			hints.codeOrigin ? `code_origin=${hints.codeOrigin}` : "code_origin=null",
		].join(", ");
		return this.chat(payload, hintsLine, model, hints.originSid);
	}

	private async chat(
		payload: string,
		hintsLine: string,
		model: string,
		originSid: string | null,
	): Promise<DistillItem[]> {
		const sys = systemPrompt() || FALLBACK_PROMPT;
		const user = `payload:\n${payload}\n\nenqueue hints (authoritative over your guesses when set): ${hintsLine}${originSid ? `\norigin_sid: ${originSid}` : ""}`;
		const r = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: user },
				],
				temperature: 0.2,
				max_tokens: 1600,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		if (!r.ok)
			throw new Error(
				`LLM ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
			);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return parseDistill(j.choices?.[0]?.message?.content ?? "");
	}
}

export class BeltDistillClient implements DistillClient {
	// belt /api/route: W96 hint routing ('prefer local distill reasoning' —
	// belt decides, local-first) — belt may live on another machine or be a
	// wholly different system; resolveBelt() finds it (#9a chain)
	async distill(
		payload: string,
		hints: {
			domain: string | null;
			area: string | null;
			codeOrigin: string | null;
			originSid: string | null;
		},
	): Promise<DistillItem[]> {
		const loc = await resolveBelt();
		if (!loc)
			throw new Error("belt unreachable — jobs stay queued, retry later");
		const sys = systemPrompt() || FALLBACK_PROMPT;
		const user = `payload:\n${payload}\n\nenqueue hints: domain=${hints.domain ?? "null"}, area=${hints.area ?? "null"}, code_origin=${hints.codeOrigin ?? "null"}`;
		return this.route(user, sys, loc);
	}

	private async route(
		user: string,
		sys: string,
		loc: { url: string; token?: string },
	): Promise<DistillItem[]> {
		const r = await fetch(`${loc.url}/api/route`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(loc.token ? { authorization: `Bearer ${loc.token}` } : {}),
			},
			body: JSON.stringify({
				// W96: belt decides, local-first — the hint REPLACES the interim
				// INGEST_LLM_URL pin (an ingest pass is a distill/reasoning task)
				hint: "prefer local distill reasoning",
				execute: true,
				max_tokens: 1600,
				temperature: 0.2,
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: user },
				],
			}),
			signal: AbortSignal.timeout(300_000),
		});
		if (!r.ok)
			throw new Error(
				`belt ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
			);
		const j = (await r.json()) as { reply?: string };
		return parseDistill(j.reply ?? "");
	}
}

// ─── config seam: a plain switch at daemon startup, no plugin framework ───
export function makeStore(): KnowledgeStore {
	const url = process.env.KNOWLEDGE_STORE_URL;
	if (url)
		throw new Error(
			`no remote knowledge-store adapter in this build (KNOWLEDGE_STORE_URL=${url}) — the local SQLite store is the only implementation; the port is the seam`,
		);
	return new SqliteKnowledgeStore(openGovernorDb());
}

export function makeDistillClient(): DistillClient {
	if (process.env.INGEST_LLM_URL)
		return new LocalLlmDistillClient(
			process.env.INGEST_LLM_URL,
			process.env.INGEST_LLM_KEY || undefined,
		);
	return new BeltDistillClient(); // resolveBelt() chain per attempt (#9a)
}

// producer seam (#9b): enqueue through the port, never INSERT directly — a
// producer in another repo/machine keeps working when the store moves
export async function enqueueKnowledge(job: {
	source: string;
	payload: string;
	domain?: string | null;
	area?: string | null;
	codeOrigin?: string | null;
	originSid?: string | null;
}): Promise<number> {
	const db = openGovernorDb();
	try {
		const r = db
			.query(
				"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, domain, area, code_origin, origin_sid) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)",
			)
			.run(
				Date.now(),
				job.source,
				job.payload,
				job.domain ?? null,
				job.area ?? null,
				job.codeOrigin ?? null,
				job.originSid ?? null,
			);
		return Number(r.lastInsertRowid);
	} finally {
		db.close();
	}
}
