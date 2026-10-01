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
	loadDocs,
	loadRootDocs,
	docForRef,
	substitutionCheck,
} from "./knowledge.ts";
import { openGovernorDb, openKnowledgeDb } from "./govdb.ts";
import { resolveBelt } from "./belt-locate.ts";

export type { KnowledgeHit };

export interface KnowledgeJob {
	id: number;
	source: string;
	payload: string;
	attempts: number;
	domain: string | null;
	area: string | null;
	// W100: the producer-declared provenance (normalized at enqueue) — claim()
	// surfaces it INSTEAD of the raw code_origin hint so the substitution
	// gate's fallback writes a resolvable ref, not "path — explanation" prose.
	codeOrigin: string | null;
	originSid: string | null;
	sourceRef: string | null;
	// W100: enqueue-time sha256 of the source_ref FILE (producer had repo
	// access; the distiller only sees the payload) — never the payload hash.
	// "" when the producer stored NULL (ref unresolvable there); upsert()
	// lands "" as NULL so the trust marker stays honest.
	sourceHash: string;
	/** W159: the queue row's settled hub_eligible (NULL = unsettled) —
	 *  inherited by distilled rows so feed timing cannot orphan the sort. */
	hubEligible: 0 | 1 | null;
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
	// W100: the enqueue-time FILE hash from the queue (claim() maps NULL to
	// ""). upsert() lands ""/NULL as a NULL row hash — never a doomed value.
	sourceHash: string | null;
	originSid: string | null;
	/** W159 provenance sort: stamp distilled rows from the queue row's
	 *  settled flag (inheritance at distill; the settle backfills the rest). */
	hubEligible?: 0 | 1 | null;
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
	// W103 curation: flag rows failing the substitution test for HUMAN review.
	// Rows stay in place, state untouched — a contributors note records the
	// verdict (append-only, NO updated_at bump: flagging is not freshness).
	curate(opts: { repoRoot: string; by?: string }): Promise<{
		checked: number;
		flagged: {
			id: number;
			topic: string;
			doc: string;
			coverage: number;
		}[];
	}>;
	// W166: the W159 settle's provenance sort rides the PORT — the settle's
	// knowledge writes must go through knowledge.db, never openGovernorDb.
	settleHubEligible(
		sid: string,
		flag: 0 | 1,
	): Promise<{ queueMarked: number; rowsBackfilled: number }>;
	// W166 (design §4): FTS5 segment merge after every job that wrote rows —
	// measured 70 ms per run, ~5% read-latency recovery after churn.
	optimize(): Promise<void>;
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

// ─── local adapter: knowledge.db (SQLite/WAL) + FTS5 + knowledge_queue ───
// the ONLY place in the knowledge layer allowed to open governor.db (#9b)
export class SqliteKnowledgeStore implements KnowledgeStore {
	// governor handle for the control-plane bus INSERTs only (emitLanded,
	// curateRecord) — knowledge rows and the queue ride `db` (knowledge.db).
	private gov: Database | null;

	constructor(
		private db: Database,
		governor?: Database | null,
	) {
		this.gov = governor ?? null;
	}

	// lazy, cached: the events bus lives in governor.db, opened on first use
	// so tests can inject both handles (or none, defaulting to the files).
	private bus(): Database {
		if (!this.gov) this.gov = openGovernorDb();
		return this.gov;
	}

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
				"SELECT source, payload, attempts, domain, area, code_origin, origin_sid, source_ref, source_hash, hub_eligible FROM knowledge_queue WHERE id = ? AND state = 'queued'",
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
					source_ref: string | null;
					source_hash: string | null;
					hub_eligible: 0 | 1 | null;
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
			// W100: the enqueue-normalized ref IS the fallback provenance — the
			// substitution gate writes it verbatim when nothing better resolves,
			// so rows carry "path" not "path — explanation".
			codeOrigin: row.source_ref ?? row.code_origin,
			originSid: row.origin_sid,
			sourceRef: row.source_ref,
			// W100: the enqueue-time FILE hash passes through verbatim; "" means
			// the producer stored NULL (unresolvable at enqueue) — upsert() turns
			// that into a NULL row hash so /verify never chases a doomed value.
			sourceHash: row.source_hash ?? "",
			hubEligible: row.hub_eligible,
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

	// W103: substitution curation — flag single-file-derivable rows for HUMAN
	// review. Rows stay in place; the flag is a contributors note appended
	// WITHOUT bumping updated_at (a flag is not a freshness signal).
	async curate(opts: { repoRoot: string; by?: string }): Promise<{
		checked: number;
		flagged: { id: number; topic: string; doc: string; coverage: number }[];
	}> {
		const docs = [...loadDocs(opts.repoRoot), ...loadRootDocs(opts.repoRoot)];
		const rows = this.db
			.query(
				"SELECT id, topic, fact, source_ref FROM knowledge WHERE state != 'retired'",
			)
			.all() as {
			id: number;
			topic: string;
			fact: string;
			source_ref: string | null;
		}[];
		const flagged: {
			id: number;
			topic: string;
			doc: string;
			coverage: number;
		}[] = [];
		return this.curateScan(opts, docs, rows, flagged);
	}

	private curateScan(
		opts: { repoRoot: string; by?: string },
		docs: SubstitutionDoc[],
		rows: {
			id: number;
			topic: string;
			fact: string;
			source_ref: string | null;
		}[],
		flagged: { id: number; topic: string; doc: string; coverage: number }[],
	): {
		checked: number;
		flagged: { id: number; topic: string; doc: string; coverage: number }[];
	} {
		for (const r of rows) {
			const own = docForRef(opts.repoRoot, r.source_ref);
			const corpus = own ? [...docs, own] : docs;
			const v = substitutionCheck(r.fact, corpus);
			if (!v.covered) continue;
			flagged.push({
				id: r.id,
				topic: r.topic,
				doc: v.doc ?? "?",
				coverage: Math.round(v.coverage * 100),
			});
		}
		this.curateRecord(opts, rows, flagged);
		return { checked: rows.length, flagged };
	}

	// contributors append WITHOUT updated_at bump (unlike note())
	private appendNote(id: number, sid: string, what: string): void {
		const row = this.db
			.query("SELECT contributors FROM knowledge WHERE id = ?")
			.get(id) as { contributors: string | null } | undefined;
		if (!row) return;
		let list: unknown[] = [];
		try {
			list = row.contributors ? JSON.parse(row.contributors) : [];
		} catch {}
		list.push({ sid, ts: Date.now(), what });
		this.db
			.query("UPDATE knowledge SET contributors = ? WHERE id = ?")
			.run(JSON.stringify(list), id);
	}

	// flag notes + one plane event (curateScan part 2; `by` names the curator)
	private curateRecord(
		opts: { repoRoot: string; by?: string },
		rows: unknown[],
		flagged: { id: number; topic: string; doc: string; coverage: number }[],
	): void {
		const by = opts.by ?? "curate";
		for (const f of flagged) {
			this.appendNote(
				f.id,
				by,
				`curate-flag: single-file-derivable from ${f.doc} (${f.coverage}% term coverage) — pointer-ize or retire (W103)`,
			);
		}
		this.bus()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.curate', 'knowledge', ?, NULL)",
			)
			.run(
				Date.now(),
				"knowledge-worker",
				JSON.stringify({
					repo: opts.repoRoot,
					by,
					checked: rows.length,
					flagged: flagged.map((f) => f.id),
				}),
			);
	}

	async upsert(row: KnowledgeUpsert): Promise<number> {
		const now = Date.now();
		const ins = this.db
			.query(
				"INSERT INTO knowledge (ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, created_at, updated_at, hub_eligible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'knowledge-worker', 'candidate', ?, ?, ?)",
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
				// W100: "" (unhashable at enqueue) lands as NULL — /verify only ever
				// compares against a hash the producer actually took of the file.
				row.sourceHash || null,
				now,
				now,
				row.hubEligible ?? null,
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
		this.bus()
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

	// W166: hub_eligible stamp on BOTH the queue row and the distilled rows —
	// idempotent (hub_eligible IS NULL guard), matching the W159 settle SQL.
	// Counts ride pre-SELECTs: bun's stmt.changes on an UPDATE that fires the
	// FTS sync trigger reports trigger/FTS ops too — never the honest delta.
	async settleHubEligible(
		sid: string,
		flag: 0 | 1,
	): Promise<{ queueMarked: number; rowsBackfilled: number }> {
		const pending = (t: string): number =>
			Number(
				(
					this.db
						.query(
							`SELECT COUNT(*) AS n FROM ${t} WHERE origin_sid = ? AND hub_eligible IS NULL`,
						)
						.get(sid) as { n: number }
				).n,
			);
		const queueMarked = pending("knowledge_queue");
		const rowsBackfilled = pending("knowledge");
		this.db
			.query(
				"UPDATE knowledge_queue SET hub_eligible = ? WHERE origin_sid = ? AND hub_eligible IS NULL",
			)
			.run(flag, sid);
		this.db
			.query(
				"UPDATE knowledge SET hub_eligible = ? WHERE origin_sid = ? AND hub_eligible IS NULL",
			)
			.run(flag, sid);
		return { queueMarked, rowsBackfilled };
	}

	// W166: merge FTS5 segments — keeps the index bounded from row one.
	async optimize(): Promise<void> {
		this.db
			.query("INSERT INTO knowledge_fts (knowledge_fts) VALUES ('optimize')")
			.run();
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
	sourceRef: string | null;
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
		// W103 substitution contract: the model may emit a POINTER ref for
		// doc-covered facts; the worker only honors it when the file resolves
		sourceRef: s(o.source_ref),
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
	"You are an impartial indexer for a fleet knowledge store. You do not evaluate truth, quality, or usefulness — you describe, condense, link, and timestamp. Return ONLY a JSON array. Each element: {topic, fact, confidence 0..1, domain, area, origin_kind (lesson|incident|decision|study|fact), origin_system, supersedes_id (only when the source text EXPLICITLY declares it replaces/corrects a row, else null), source_ref (REQUIRED when the payload names a doc path: the repo-relative path of that exact doc, else null)}. Never copy credentials into facts — redact as [REDACTED] or reject. Substitution contract: never restate what one file/doc already teaches — pointer-ize (source_ref + non-obvious residue) or reject. Corrections create a new row via supersedes_id; history is append-only.";

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
	// belt /api/route: role-based routing — belt may live on another machine
	// or be a wholly different system; resolveBelt() finds it (#9a chain)
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
				role: "reasoning", // an ingest pass is a reasoning task
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
	return new SqliteKnowledgeStore(openKnowledgeDb());
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
	// W100: declared provenance ref — explanatory suffixes are normalized out
	// and the named FILE is hashed at ENQUEUE time (the producer has repo
	// access; the distiller only sees the payload). Defaults to codeOrigin.
	sourceRef?: string | null;
	// repo root the ref resolves against — default KNOWLEDGE_DOCS_ROOT (W103),
	// then KNOWLEDGE_REPO_ROOT, then the producer's cwd
	docsRoot?: string;
}): Promise<number> {
	// W100: hash the declared source FILE here — the producer has repo access;
	// the distiller never sees the filesystem.
	const ref = normalizeSourceRef(job.sourceRef || job.codeOrigin || "");
	const root =
		job.docsRoot ??
		process.env.KNOWLEDGE_DOCS_ROOT ??
		process.env.KNOWLEDGE_REPO_ROOT ??
		process.cwd();
	const db = openKnowledgeDb();
	try {
		const r = db
			.query(
				"INSERT INTO knowledge_queue (ts, source, payload, state, attempts, domain, area, code_origin, origin_sid, source_ref, source_hash) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				Date.now(),
				job.source,
				job.payload,
				job.domain ?? null,
				job.area ?? null,
				job.codeOrigin ?? null,
				job.originSid ?? null,
				ref || null,
				ref ? fileHash(root, ref) : null,
			);
		return Number(r.lastInsertRowid);
	} finally {
		db.close();
	}
}

// W100: normalize the explanatory suffixes off a declared ref — the trust
// layer (trustOf, coord knowledge-verify) resolves only the leading path, so
// the queue stores that path itself: "hooks/bin/work.ts take (W60)" →
// "hooks/bin/work.ts", "docs/x.md — why it matters" → "docs/x.md".
export function normalizeSourceRef(ref: string): string {
	return (ref.trim().split(/\s+/)[0] ?? "").replace(/[—–].*$/, "");
}

// sha256 of the file a ref names under root — same utf8 bytes trustOf and
// coord knowledge-verify hash. Unresolvable → null (honest unverified).
function fileHash(root: string, ref: string): string | null {
	try {
		return createHash("sha256")
			.update(readFileSync(join(root, ref), "utf8"))
			.digest("hex");
	} catch {
		return null;
	}
}
