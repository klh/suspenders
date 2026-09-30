// hooks/lib/knowledge.ts — shared knowledge-layer helpers (W91): the ranked
// FTS5 search behind `coord knowledge` and the read_knowledge MCP tool, plus
// the ingest worker's near-duplicate gate. One search implementation, three
// consumers (coord.ts, knowledge-worker.ts, knowledge-mcp.ts). W103 adds the
// dosu-mechanics layer: substitution contract (single-file test + residue),
// trust-as-permission-to-act (mechanical hash check), and prose-card output.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
	// W103: raw k.* columns flow through search verbatim (snake_case) — the
	// mechanical trust check hashes source_ref against source_hash
	source_ref?: string | null;
	source_hash?: string | null;
	trust?: TrustState;
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

// ═══ W103 — dosu mechanics: substitution, trust, prose cards ═══

// trust-as-permission-to-act: hits with verified provenance may be acted on
// directly; DRIFT or unverified hits must be re-checked. Mechanical: hash the
// source_ref file now and compare with source_hash taken at index time.
// Resolution: ref as-is (repo-relative), then its first whitespace token.
// Unreadable → "unverified" (honest: nothing to check from this root).
export type TrustState = "verified" | "drift" | "unverified";

export function trustOf(
	ref: string | null | undefined,
	hash: string | null | undefined,
	root: string = process.cwd(),
): TrustState {
	if (!ref || !hash) return "unverified";
	for (const cand of [ref, ref.split(/\s+/)[0]]) {
		try {
			const cur = createHash("sha256")
				.update(readFileSync(join(root, cand), "utf8"))
				.digest("hex");
			return cur === hash ? "verified" : "drift";
		} catch {} // next candidate / fall through to unverified
	}
	return "unverified";
}

// add a `trust` field to every knowledge-kind hit (JSON face)
export function withTrust<T extends KnowledgeHit>(
	hits: T[],
	root?: string,
): T[] {
	return hits.map((h) =>
		h.kind === "knowledge"
			? { ...h, trust: trustOf(h.source_ref, h.source_hash, root) }
			: h,
	);
}

// the precedence clause (W103 owner addendum): knowledge is context, never a
// constraint on the objective — injected facts must not cause premature task
// refusal. Rendered in EVERY prose-card output (MCP + API), quoted verbatim
// in the standing rule file.
export const KNOWLEDGE_PRECEDENCE =
	"Precedence: the brief's objective always wins. Knowledge describes the world as it was — when a knowledge fact conflicts with the brief, the brief prevails: note the conflict in one line and adapt (if the brief asks for a thing that doesn't exist, building it IS the task). Knowledge is context, never a constraint on the objective.";

const ageOf = (ts: number): number =>
	Math.max(0, Math.round((Date.now() - ts) / 86_400_000));

// fact / consult_kb cards (aux kinds of the merged search)
function renderAuxCard(lines: string[], h: KnowledgeHit): void {
	if (h.kind === "fact")
		lines.push(
			`fact ${h.key ?? "?"} [age ${ageOf(h.ts)}d · hash unverified]`,
			`  ${h.snippet}`,
		);
	else
		lines.push(
			`kb#${h.id} · ${(h.problem ?? "").slice(0, 120)} [age ${ageOf(h.ts)}d · hash unverified]`,
			`  ${h.solution ?? h.snippet}`,
		);
}

// prose cards — one card per hit: topic + fact + provenance + trust markers.
// The MCP face and the API's `cards` field render through here; raw hits
// JSON stays on the API's `hits` field for programmatic consumers.
export function proseCards(
	query: string,
	hits: KnowledgeHit[],
	root: string = process.cwd(),
): string {
	if (!hits.length) return `no fleet knowledge for: ${query}`;
	const lines: string[] = [
		`fleet knowledge — ${hits.length} hit${hits.length === 1 ? "" : "s"} for: ${query}`,
		KNOWLEDGE_PRECEDENCE,
	];
	for (const h of hits) {
		if (h.kind === "knowledge") {
			const trust = trustOf(h.source_ref, h.source_hash, root);
			lines.push(
				`k#${h.id} · ${h.topic ?? "(untitled)"} [${h.state ?? "?"} · age ${h.ageDays ?? "?"}d · hash ${trust}]`,
				`  ${h.fact ?? h.snippet}`,
				`  source: ${h.source_ref ?? h.code_origin ?? "none"}${h.domain ? ` · domain ${h.domain}` : ""}${h.area ? ` · area ${h.area}` : ""}`,
			);
		} else {
			renderAuxCard(lines, h);
		}
		lines.push(""); // blank line between cards
	}
	return lines.join("\n").trimEnd();
}

// ─── substitution contract: the mechanical single-file test ───
// dosu rule 2 parallel: never store what the repo already teaches. A fact is
// "covered" when ONE file/doc contains ≥ COVERED_MIN of its distinctive
// terms; the residue = the fact's sentences whose OWN coverage vs that file
// is low. Mechanical approximation — flags are for human review; ingest-time
// conversion keeps the residue as a pointer row.
export interface SubstitutionDoc {
	path: string;
	text: string;
}

// closed-class words any fact and any doc share — excluded so coverage
// measures content overlap only
const STOP = new Set(
	"the and for with that this from are was were not but all any can has had its one two per via when then than into only also may will must should would could have been each which their what how why get use used using same even never every always note see like just more less most over under after before does done keep keeps kept row rows".split(
		" ",
	),
);

export function distinctTerms(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_.-]+/)
			// sentence punctuation would glue to tokens ("teaches." ≠ "teaches")
			.map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
			.filter((t) => t.length > 2 && !STOP.has(t)),
	);
}

function coverageOf(terms: Set<string>, hay: Set<string>): number {
	if (!terms.size) return 0;
	let hit = 0;
	for (const t of terms) if (hay.has(t)) hit++;
	return hit / terms.size;
}

export const COVERED_MIN = 0.75; // ≥ share of fact terms in one file → covered
const SENTENCE_KEEP_MAX = 0.55; // sentence survives when its own coverage < this

export interface SubstitutionVerdict {
	covered: boolean;
	doc: string | null; // repo-relative path of the covering file
	docText: string | null; // its content (pointer rows hash this)
	coverage: number; // 0..1 share of the fact's terms the doc contains
	residue: string; // non-covered sentences ("" = fully derivable)
}

export function substitutionCheck(
	fact: string,
	docs: SubstitutionDoc[],
	coveredMin = COVERED_MIN,
): SubstitutionVerdict {
	const verdict: SubstitutionVerdict = {
		covered: false,
		doc: null,
		docText: null,
		coverage: 0,
		residue: "",
	};
	const terms = distinctTerms(fact);
	if (docs.length < 1 || terms.size < 4) return verdict; // thin fact, no signal
	return scanDocs(verdict, terms, fact, docs, coveredMin);
}

// doc scan + sentence-level residue extraction (substitutionCheck part 2)
function scanDocs(
	v: SubstitutionVerdict,
	terms: Set<string>,
	fact: string,
	docs: SubstitutionDoc[],
	coveredMin: number,
): SubstitutionVerdict {
	let bestDoc: { doc: string; text: string; cov: number } | null = null;
	for (const d of docs) {
		const hay = distinctTerms(d.text);
		if (!hay.size) continue;
		const cov = coverageOf(terms, hay);
		if (!bestDoc || cov > bestDoc.cov)
			bestDoc = { doc: d.path, text: d.text, cov };
	}
	if (!bestDoc || bestDoc.cov < coveredMin) return v;
	const docTerms = distinctTerms(bestDoc.text);
	const residue = fact
		.split(/(?<=[.;!?])\s+/)
		.map((s) => s.trim())
		.filter(
			(s) => s && coverageOf(distinctTerms(s), docTerms) < SENTENCE_KEEP_MAX,
		)
		.join(" ");
	return {
		covered: true,
		doc: bestDoc.doc,
		docText: bestDoc.text,
		coverage: bestDoc.cov,
		residue,
	};
}

export const MAX_DOCS = 300; // corpus cap — a huge repo cannot stall ingest
export const MAX_DOC_BYTES = 262_144;

// docs corpus for the substitution test: docs/ (recursive .md/.markdown) plus
// root-level README/AGENTS/CLAUDE. Paths relative to root, posix separators.
export function loadDocs(root: string): SubstitutionDoc[] {
	const out: SubstitutionDoc[] = [];
	const walk = (dir: string): void => {
		if (out.length >= MAX_DOCS) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable/absent dir — skip honestly
		}
		for (const e of entries) {
			if (out.length >= MAX_DOCS) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(md|markdown)$/.test(e.name)) continue;
			try {
				if (statSync(full).size > MAX_DOC_BYTES) continue;
				out.push({
					path: relative(root, full).split(sep).join("/"),
					text: readFileSync(full, "utf8"),
				});
			} catch {} // unreadable file — skip honestly
		}
	};
	walk(join(root, "docs"));
	return out;
}

// root-level README/AGENTS/CLAUDE also teach the repo — joined after docs/
export function loadRootDocs(root: string): SubstitutionDoc[] {
	const out: SubstitutionDoc[] = [];
	for (const name of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
		try {
			out.push({ path: name, text: readFileSync(join(root, name), "utf8") });
		} catch {} // absent root doc — fine
	}
	return out;
}

// the row's own source file joins the corpus (a fact can derive from its
// source_ref file, not only from docs/) — ref may carry a symbol suffix
export function docForRef(
	root: string,
	ref: string | null | undefined,
): SubstitutionDoc | null {
	if (!ref) return null;
	for (const cand of [ref, ref.split(/\s+/)[0]]) {
		try {
			return { path: ref, text: readFileSync(join(root, cand), "utf8") };
		} catch {} // next candidate
	}
	return null;
}
