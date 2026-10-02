import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { openStore, type GovernorStore } from "../lib/govdb.ts";
import type { KnowledgeHit } from "../lib/knowledge-ports.ts";
import { trustOf } from "../lib/knowledge.ts";

export {
	projectIdentity,
	CAPABILITIES,
	workTiming,
	pruneDeltas,
	tokenUsage,
	sweepStaleSessions,
} from "../lib/govdb.ts";
export { makeStore, enqueueKnowledge } from "../lib/knowledge-ports.ts";
export { readFileSync, realpathSync };
export { createHash };
export { resolve };

export interface Ev {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
}

// one row-image change from the deltas trigger log (govdb.ts v5 migration)
export interface DeltaRow {
	seq: number;
	ts: number;
	tbl: string;
	op: string;
	pk: string;
	before: string | null;
	after: string | null;
}

export const die = (m: string): never => {
	console.error(`coord: ${m}`);
	process.exit(2);
};

export const db: GovernorStore = openStore();

// dispatcher-owned: the entry parses argv and pins it here so `arg()`
// keeps closing over one `rest` exactly as the monolith did
export let rest: string[] = [];
export function setRest(r: string[]): void {
	rest = r;
}
export const arg = (name: string): string | null => {
	const i = rest.indexOf(name);
	return i >= 0 ? (rest[i + 1] ?? null) : null;
};

// output polish — quiet ANSI, disabled when piped or NO_COLOR
export const tty = process.stdout.isTTY && !process.env.NO_COLOR;
export const paint =
	(code: string) =>
	(s: string): string =>
		tty ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = paint("2");
export const cyan = paint("36");
export const green = paint("32");
export const amber = paint("33");
export const red = paint("31");

export function kbLookup(question: string): {
	id: number;
	problem: string;
	solution: string;
	answered_by: string;
	hits: number;
} | null {
	const terms = [
		...new Set(
			question
				.toLowerCase()
				.split(/[^a-z0-9_.-]+/)
				.filter((t) => t.length > 2),
		),
	];
	if (!terms.length) return null;
	try {
		const cands = db
			.query(
				`SELECT k.id, k.problem, k.solution, k.answered_by, k.hits FROM consult_kb_fts f
				 JOIN consult_kb k ON k.id = f.rowid WHERE consult_kb_fts MATCH ? ORDER BY rank LIMIT 5`,
			)
			.all(terms.map((t) => `"${t}"`).join(" OR ")) as {
			id: number;
			problem: string;
			solution: string;
			answered_by: string;
			hits: number;
		}[];
		let best: ((typeof cands)[number] & { overlap: number }) | null = null;
		for (const c of cands) {
			const pt = new Set(c.problem.toLowerCase().split(/[^a-z0-9_.-]+/));
			const shared = terms.filter((t) => pt.has(t));
			const overlap = shared.length / terms.length;
			if (
				shared.length >= 2 &&
				overlap >= 0.6 &&
				(!best || overlap > best.overlap)
			)
				best = { ...c, overlap };
		}
		return best;
	} catch {
		return null;
	}
}

// lessonLookup — doctrine answers: lesson.* facts are the plane's curriculum
// (session-start pushes them; coord fact set lesson.<topic> writes them). A
// consult whose question overlaps a lesson is answered BY THE PLANE — no
// expert round-trip. Score = question tokens found in key+value; wins at ≥2.
// Deterministic on purpose — no LLM in the routing path.
export function lessonLookup(
	question: string,
): { key: string; value: string; score: number } | null {
	const terms = [
		...new Set(
			question
				.toLowerCase()
				.split(/[^a-z0-9_.-]+/)
				.filter((t) => t.length > 2),
		),
	];
	if (!terms.length) return null;
	const rows = db
		.query(
			"SELECT key, value FROM facts WHERE key LIKE 'lesson.%' AND key NOT LIKE 'lesson.seen.%'",
		)
		.all() as {
		key: string;
		value: string;
	}[];
	let best: { key: string; value: string; score: number } | null = null;
	for (const r of rows) {
		const hay = `${r.key} ${r.value}`.toLowerCase().split(/[^a-z0-9_.-]+/);
		const keyTokens = r.key
			.slice("lesson.".length)
			.toLowerCase()
			.split(/[^a-z0-9_.-]+/);
		const score =
			terms.filter((t) => hay.includes(t)).length +
			(terms.some((t) => keyTokens.includes(t)) ? 1 : 0);
		if (score >= 2 && (!best || score > best.score))
			best = { key: r.key, value: r.value, score };
	}
	return best;
}

export function renderKnowledgeHit(
	h: KnowledgeHit,
	dim: (s: string) => string,
	cyan: (s: string) => string,
): void {
	if (h.kind === "knowledge") {
		const trust = trustOf(h.source_ref, h.source_hash);
		const hop = h.hop === 1 ? ` · 1-hop ${h.via}` : "";
		console.log(
			`${cyan(`k#${h.id}`)} ${dim(`${h.state ?? "?"} · age ${h.ageDays ?? "?"}d · ${trust}${hop}`)} ${h.topic ?? ""} ${dim([h.domain, h.area, h.origin_kind, h.origin_system].filter(Boolean).join("/"))}\n  ${h.snippet}`,
		);
	} else if (h.kind === "fact")
		console.log(`${cyan(String(h.key))}\n  ${h.snippet}`);
	else console.log(`${cyan(`kb#${h.id}`)} ${h.problem ?? ""}\n  ${h.snippet}`);
}

export function scopeCovers(a: string, b: string): boolean {
	if (a === b) return true;
	const pa = a.replace(/\/\*\*?$/, "");
	return pa !== a && (b.startsWith(`${pa}/`) || b === pa);
}

// liveness sweep: RUNNING + heartbeat stale + NO live transcript = a process
// that died without SessionEnd. hb alone is not evidence — it only updates on
// bootstrap — but an active session writes its transcript continuously, so
// transcript-dead is the real signal for TOP-LEVEL sessions. LANES (parented
// rows) have no transcript of their own, so they close only after 24h stale —
// their real liveness design is backlog W9. Swept sessions keep owned work.
// contextual expertise ranking for who-knows / consult --best. Score =
// claims 40% / recent DONE work 25% / recent scope touches 20% / role 10% /
// heartbeat recency 5%. Only live sessions in the project.
export function rankExperts(
	project: string,
	q: string,
	scope: string | null,
	excludeSid?: string,
): { sid: string; score: number; hint: string }[] {
	const toks = [
		...new Set(
			[
				...(scope ?? "").split(/[^a-z0-9_.]+/),
				...q.toLowerCase().split(/[^a-z0-9_.]+/),
			].filter((t) => t.length > 2),
		),
	];
	const now = Date.now();
	const live = db
		.query(
			"SELECT sid, role, hb FROM sessions WHERE project = ? AND state = 'RUNNING'",
		)
		.all(project) as { sid: string; role: string; hb: number }[];
	const hits = (hay: string): number =>
		toks.reduce((n, t) => n + (hay.toLowerCase().includes(t) ? 1 : 0), 0);
	const rows: { sid: string; score: number; hint: string }[] = [];
	for (const s of live) {
		if (excludeSid && s.sid === excludeSid) continue;
		const claims = db
			.query("SELECT scope, intent FROM claims WHERE sid = ?")
			.all(s.sid) as { scope: string; intent: string | null }[];
		let claimN = 0;
		let hint = "";
		for (const c of claims) {
			let m = hits(`${c.scope} ${c.intent ?? ""}`);
			if (scope && scopeCovers(c.scope, scope)) m = Math.max(m, 3);
			if (m > claimN) {
				claimN = m;
				hint = c.intent ?? c.scope;
			}
		}
		const done = db
			.query(
				"SELECT title FROM work_items WHERE project = ? AND owner_sid = ? AND state = 'DONE' AND updated_at > ?",
			)
			.all(project, s.sid, now - 6 * 3_600_000) as { title: string }[];
		let workN = 0;
		for (const d of done) {
			const m = hits(d.title);
			if (m > workN) {
				workN = m;
				hint = hint || d.title;
			}
		}
		const touches = db
			.query(
				"SELECT scope FROM events WHERE source = ? AND ts > ? AND scope IS NOT NULL",
			)
			.all(s.sid, now - 6 * 3_600_000) as { scope: string | null }[];
		const touchN = touches.reduce(
			(n, t) => Math.max(n, hits(t.scope ?? "")),
			0,
		);
		const roleN = s.role === "coordinator" ? 1 : 0;
		const rec = Math.max(0, 1 - (now - s.hb) / (30 * 60_000));
		const score =
			0.4 * Math.min(1, claimN / 3) +
			0.25 * Math.min(1, workN / 2) +
			0.2 * Math.min(1, touchN / 2) +
			0.1 * roleN +
			0.05 * rec;
		if (score > 0.02) rows.push({ sid: s.sid, score, hint: hint.slice(0, 50) });
	}
	return rows.sort((a, b) => b.score - a.score);
}
