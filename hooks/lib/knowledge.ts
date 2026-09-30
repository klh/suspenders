// hooks/lib/knowledge.ts — shared knowledge-layer helpers (W91): the ranked
// FTS5 search behind `coord knowledge` and the read_knowledge MCP tool, plus
// the ingest worker's near-duplicate gate. One search implementation, three
// consumers (coord.ts, knowledge-worker.ts, knowledge-mcp.ts).
import type { Database } from "bun:sqlite";

export interface KnowledgeFilters {
	domain?: string | null;
	area?: string | null;
	originKind?: string | null;
	originSystem?: string | null;
	limit?: number;
}

export interface KnowledgeHit {
	kind: "knowledge" | "fact" | "consult_kb";
	id: number;
	ts: number; // ms epoch
	snippet: string;
	// knowledge rows
	topic?: string;
	fact?: string;
	confidence?: number;
	state?: string;
	codeOrigin?: string | null;
	// facts rows
	key?: string;
	// consult_kb rows
	problem?: string;
	solution?: string;
	domain?: string | null;
	area?: string | null;
	originKind?: string | null;
	originSystem?: string | null;
	source?: string;
	// schema-delta fields (W91 owner directives): staleness + provenance +
	// the mechanical link chain (duplicate_of / supersedes_id)
	ageDays?: number;
	origin_sid?: string | null;
	contributors?: string | null;
	duplicate_of?: number | null;
	superseded_by?: number | null;
	supersedes_id?: number | null;
}

// FTS5 MATCH term list: quoted, OR-joined — bm25 ranks the union, so a
// rephrasing still surfaces (ranked honestly low); strict AND would hide it.
// Embedded quotes are doubled. No terms → empty string → caller returns an
// honest empty result.
export function ftsTerms(q: string): string {
	const terms = [
		...new Set(
			q
				.toLowerCase()
				.split(/[^a-z0-9_.-]+/)
				.filter((t) => t.length > 1),
		),
	];
	if (!terms.length) return "";
	return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

// ranked search across the knowledge layer's three stores. Each store returns
// up to `limit` hits ranked by its own bm25 (ranks are NOT comparable across
// stores, so the merged array keeps the stores grouped: knowledge, then
// facts, then consult_kb — consumers render the kind field).
export function knowledgeSearch(
	db: Database,
	query: string,
	filters: KnowledgeFilters = {},
): KnowledgeHit[] {
	const match = ftsTerms(query);
	if (!match) return [];
	const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? 10)), 50);
	const out: KnowledgeHit[] = [];
	const dom = filters.domain ?? null;
	const area = filters.area ?? null;
	const kind = filters.originKind ?? null;
	const sys = filters.originSystem ?? null;
	// 1. knowledge rows — the primary store; retired rows exit search
	try {
		out.push(
			...(
				db
					.query(
						`SELECT k.*, snippet(knowledge_fts, 1, '[', ']', '…', 12) AS snip
	FROM knowledge_fts
	JOIN knowledge k ON k.id = knowledge_fts.rowid
	WHERE knowledge_fts MATCH ?
		AND knowledge_fts.state != 'retired'
		AND (? IS NULL OR knowledge_fts.domain = ?)
		AND (? IS NULL OR knowledge_fts.area = ?)
		AND (? IS NULL OR knowledge_fts.origin_kind = ?)
		AND (? IS NULL OR knowledge_fts.origin_system = ?)
	ORDER BY rank + (${Date.now()} - COALESCE(k.updated_at, k.ts)) / 86400000.0 * 0.05 LIMIT ?`,
					)
					.all(
						match,
						dom,
						dom,
						area,
						area,
						kind,
						kind,
						sys,
						sys,
						limit,
					) as (KnowledgeHit & { snip?: string })[]
			).map((r) => ({
				...r,
				kind: "knowledge" as const,
				snippet: r.snip ?? "",
				ageDays: Math.max(
					0,
					Math.round((Date.now() - (r.updated_at ?? r.ts)) / 86_400_000),
				),
			})),
		);
	} catch {} // pre-v6 db opened raw — skip honestly
	// 2. facts (key+value) — first search index for facts; ranked, no gate
	try {
		out.push(
			...db
				.query(
					`SELECT f.key, f.ts,
	snippet(facts_fts, 0, '[', ']', '…', 12) AS snip
	FROM facts_fts
	JOIN facts f ON f.rowid = facts_fts.rowid
	WHERE facts_fts MATCH ?
	ORDER BY rank LIMIT ?`,
				)
				.all(match, limit)
				.map((r: unknown): KnowledgeHit => {
					const o = r as {
						key: string;
						ts: number;
						snip?: string;
					};
					return {
						kind: "fact" as const,
						id: 0,
						ts: o.ts,
						snippet: o.snip ?? "",
						key: o.key,
					};
				}),
		);
	} catch {} // facts_fts absent — skip honestly
	// 3. consult_kb — answered consults (problem → solution) joined in
	try {
		out.push(
			...db
				.query(
					`SELECT k.id, k.problem, k.solution, k.created_at AS ts,
	snippet(consult_kb_fts, 0, '[', ']', '…', 12) AS snip
	FROM consult_kb_fts
	JOIN consult_kb k ON k.id = consult_kb_fts.rowid
	WHERE consult_kb_fts MATCH ?
	ORDER BY rank LIMIT ?`,
				)
				.all(match, limit)
				.map((r: unknown): KnowledgeHit => {
					const o = r as {
						id: number;
						problem: string;
						solution: string;
						ts: number;
						snip?: string;
					};
					return {
						kind: "consult_kb" as const,
						id: o.id,
						ts: o.ts,
						snippet: o.snip ?? "",
						problem: o.problem,
						fact: o.problem,
						solution: o.solution,
					};
				}),
		);
	} catch {} // consult_kb absent (pre-v4 db) — skip honestly
	return out;
}

// near-duplicate gate for the ingest worker: FTS5 fetches candidates, then a
// deterministic term-overlap score (same doctrine as kbLookup in coord.ts).
export function findNearDuplicate(
	db: Database,
	cand: { topic: string; fact: string },
): { id: number; topic: string; fact: string } | null {
	const text = `${cand.topic} ${cand.fact}`;
	const terms = [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9_.-]+/)
				.filter((t) => t.length > 2),
		),
	];
	if (!terms.length) return null;
	const cands = db
		.query(
			`SELECT k.id, k.topic, k.fact
	FROM knowledge_fts
	JOIN knowledge k ON k.id = knowledge_fts.rowid
	WHERE knowledge_fts MATCH ? AND knowledge_fts.state != 'retired'
	ORDER BY rank LIMIT 5`,
		)
		.all(ftsTerms(text)) as { id: number; topic: string; fact: string }[];
	for (const h of cands) {
		const hay = new Set(
			`${h.topic} ${h.fact}`.toLowerCase().split(/[^a-z0-9_.-]+/),
		);
		const shared = terms.filter((t) => hay.has(t));
		if (shared.length >= 2 && shared.length / terms.length >= 0.6) return h;
	}
	return null;
}

// mechanical secrets pass (layer 2 of 2 — the LLM's no-secrets prompt rule is
// layer 1): credential-shaped patterns (gitleaks-inspired, original code). A
// private-key block is unrecoverable context → the candidate is rejected.
const SECRET_PATTERNS: { re: RegExp; kind: string }[] = [
	{
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		kind: "private key block",
	},
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, kind: "aws access key" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, kind: "github token" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, kind: "slack token" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, kind: "google api key" },
	{ re: /\bsk_(live|test)_[0-9A-Za-z]{16,}\b/g, kind: "stripe key" },
	{ re: /\bnpm_[A-Za-z0-9]{36}\b/g, kind: "npm token" },
	{ re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, kind: "bearer token" },
	{
		re: /\b(api[_-]?key|secret|token|password|passwd|pwd|authorization)\b\s*[:=]\s*\S+/gi,
		kind: "credential assignment",
	},
];

// redact in place; a private-key block rejects the whole candidate
export function redactSecrets(text: string): {
	text: string;
	rejected: boolean;
	hits: string[];
} {
	let rejected = false;
	const hits: string[] = [];
	let out = text;
	for (const p of SECRET_PATTERNS) {
		p.re.lastIndex = 0;
		if (!p.re.test(out)) continue;
		p.re.lastIndex = 0;
		out = out.replace(p.re, () => {
			hits.push(p.kind);
			return p.kind === "private key block" ? "[REJECTED-KEY]" : "[REDACTED]";
		});
		if (p.kind === "private key block") rejected = true;
	}
	return { text: out, rejected, hits };
}
