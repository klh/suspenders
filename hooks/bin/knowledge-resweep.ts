// knowledge-resweep.ts — W117: mechanical pointer re-sweep of EXISTING hub
// rows (no LLM). W112's pointer fallback (extractDocPaths/pointerFromText in
// ../lib/knowledge.ts) only runs at ingest under ONE global KNOWLEDGE_DOCS_ROOT
// — rows distilled for other projects were left without source_ref, and
// existence is per-project root-relative. This sweep backfills: for every
// non-retired row with an EMPTY source_ref it resolves a per-row docs root,
// re-runs the same mechanical extractor, and pointer-izes the row when a
// named path EXISTS under that root (hash = file content, W103 pointer shape).
// READ-ONLY by default (--dry-run); --write updates ONLY source_ref,
// source_hash, updated_at via a re-checked guarded UPDATE.
//
// row → project docs-root mapping (W117, evidence in the live store):
//   1. knowledge.domain holds the project NAME (live: suspenders 157, gaps 33,
//      tredebanken-v2 20, hojtaler 18, coordination 1) — the basename of the
//      repo root.
//   2. sessions.project = projectIdentity() = realpath of the repo's common
//      git dir ("<root>/.git" for a main worktree) — per-row provenance via
//      knowledge.origin_sid and contributors[].sid.
//   3. Sessions persist after close (live: 603 CLOSED / 6 RUNNING) but most
//      knowledge origin_sids predate the kept sessions — the domain-basename
//      match over ALL distinct sessions.project values is the load-bearing arm.
//   4. code_origin is empty on every ref-less row (verified live) — not a hint.
// Resolution order per row (first root where a path RESOLVES wins):
//   --root-map override → origin_sid's session → contributors' sessions →
//   domain-basename match.
import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { extractDocPaths, pointerFromText } from "../lib/knowledge.ts";

export interface ResweepRow {
	id: number;
	topic: string;
	fact: string;
	domain: string | null;
	origin_sid: string | null;
	contributors: string | null;
	state: string;
	source_ref: string | null;
	source_hash: string | null;
}

// candidate roots per lookup key, ordered most-specific first
export interface RootIndex {
	bySid: Map<string, string[]>;
	byDomain: Map<string, string[]>;
	// operator --root-map overrides (domain → roots), tried FIRST
	rootMap: Map<string, string[]>;
}

// "<root>/.git" (projectIdentity, main worktree) → repo root; other shapes
// pass through. Nonexistent paths are dropped (stale cross-machine rows).
function sessionRoot(project: string): string | null {
	const root = project.replace(/\/\.git$/, "");
	if (root === project && !project.endsWith(".git")) return norm(project);
	return norm(root);
}

function norm(path: string): string | null {
	if (!path.startsWith("/")) return null;
	try {
		return realpathSync(path);
	} catch {
		return null; // stale session — skip
	}
}

// index sessions.project values: by sid and by repo basename (= domain name)
export function buildRootIndex(
	sessions: { sid: string; project: string }[],
	rootMap: Map<string, string[]>,
): RootIndex {
	const bySid = new Map<string, string[]>();
	const byDomain = new Map<string, string[]>();
	for (const s of sessions) {
		const root = sessionRoot(s.project);
		if (!root) continue;
		push(bySid, s.sid, root);
		push(byDomain, basename(root), root);
	}
	return { bySid, byDomain, rootMap };
}

function push(m: Map<string, string[]>, k: string, v: string): void {
	const cur = m.get(k);
	if (cur?.includes(v)) return;
	if (cur) cur.push(v);
	else m.set(k, [v]);
}

// ordered, deduped candidate roots for one row
export function candidateRoots(row: ResweepRow, idx: RootIndex): string[] {
	const out: string[] = [];
	const add = (r: string): void => {
		if (!out.includes(r)) out.push(r);
	};
	for (const r of idx.rootMap.get(row.domain ?? "") ?? []) add(r);
	for (const r of idx.bySid.get(row.origin_sid ?? "") ?? []) add(r);
	for (const sid of contributorSids(row.contributors))
		for (const r of idx.bySid.get(sid) ?? []) add(r);
	for (const r of idx.byDomain.get(row.domain ?? "") ?? []) add(r);
	return out;
}

// contributors is a JSON array of {sid, ts, what} — parse defensively
export function contributorSids(contributors: string | null): string[] {
	if (!contributors) return [];
	try {
		const arr: unknown = JSON.parse(contributors);
		if (!Array.isArray(arr)) return [];
		return arr
			.map((c) =>
				typeof c === "object" && c !== null && "sid" in c
					? String((c as { sid: unknown }).sid)
					: "",
			)
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

export type PlanKind = "planned" | "no-paths" | "unresolved";

export interface Planned {
	kind: "planned";
	id: number;
	domain: string | null;
	ref: string;
	hash: string;
	root: string;
	via: string;
}

export interface Unplanned {
	kind: "no-paths" | "unresolved";
	id: number;
	domain: string | null;
	paths: string[];
	rootsTried: number;
}

export type PlanEntry = Planned | Unplanned;

// one row: extract paths from the fact, try candidate roots in order
export function planRow(row: ResweepRow, idx: RootIndex): PlanEntry {
	const paths = extractDocPaths(row.fact);
	const domain = row.domain;
	if (!paths.length)
		return { kind: "no-paths", id: row.id, domain, paths, rootsTried: 0 };
	const roots = candidateRoots(row, idx);
	for (const root of roots) {
		const p = pointerFromText(row.fact, root);
		if (p)
			return {
				kind: "planned",
				id: row.id,
				domain,
				ref: p.ref,
				hash: p.hash,
				root,
				via: viaLabel(row, root, idx),
			};
	}
	return {
		kind: "unresolved",
		id: row.id,
		domain,
		paths,
		rootsTried: roots.length,
	};
}

// which arm supplied the winning root (report transparency)
function viaLabel(row: ResweepRow, root: string, idx: RootIndex): string {
	if ((idx.rootMap.get(row.domain ?? "") ?? []).includes(root))
		return "root-map";
	if ((idx.bySid.get(row.origin_sid ?? "") ?? []).includes(root))
		return "origin_sid";
	for (const sid of contributorSids(row.contributors))
		if ((idx.bySid.get(sid) ?? []).includes(root)) return "contributors";
	if ((idx.byDomain.get(row.domain ?? "") ?? []).includes(root))
		return "domain";
	return "?";
}

export interface SweepReport {
	total: number;
	retired: number;
	alreadyReferenced: number;
	scanned: number;
	noPaths: number;
	planned: PlanEntry[];
	unresolved: Unplanned[];
	changes: number;
}

// read the hub, plan every eligible row, optionally apply. Eligible = NOT
// retired AND source_ref empty — retired rows and already-referenced rows are
// never scanned, and --write re-checks both invariants inside the UPDATE so a
// concurrent writer cannot be clobbered.
export function sweep(
	db: Database,
	opts: { write?: boolean; rootMap?: Map<string, string[]> } = {},
): SweepReport {
	const rows = db
		.query(
			"SELECT id, topic, fact, domain, origin_sid, contributors, state, source_ref, source_hash FROM knowledge",
		)
		.all() as ResweepRow[];
	const sessions = db
		.query("SELECT sid, project FROM sessions WHERE project IS NOT NULL")
		.all() as { sid: string; project: string }[];
	const idx = buildRootIndex(sessions, opts.rootMap ?? new Map());
	const retired = rows.filter((r) => r.state === "retired");
	const already = rows.filter(
		(r) => r.state !== "retired" && !!(r.source_ref && r.source_ref.length > 0),
	);
	const scanned = rows.filter(
		(r) => r.state !== "retired" && !(r.source_ref && r.source_ref.length > 0),
	);
	const planned: Planned[] = [];
	const unresolved: Unplanned[] = [];
	let noPaths = 0;
	for (const row of scanned) {
		const e = planRow(row, idx);
		if (e.kind === "planned") planned.push(e);
		else {
			if (e.kind === "no-paths") noPaths++;
			else unresolved.push(e);
		}
	}
	let changes = 0;
	if (opts.write) {
		const upd = db.query(
			"UPDATE knowledge SET source_ref = ?, source_hash = ?, updated_at = ? WHERE id = ? AND (source_ref IS NULL OR source_ref = '') AND state != 'retired'",
		);
		for (const p of planned) {
			changes += upd.run(p.ref, p.hash, Date.now(), p.id).changes;
		}
	}
	return {
		total: rows.length,
		retired: retired.length,
		alreadyReferenced: already.length,
		scanned: scanned.length,
		noPaths,
		planned,
		unresolved,
		changes,
	};
}

const DEFAULT_DB = `${process.env.HOME}/.cache/claude-governor/governor.db`;

function parseRootMap(spec: string | undefined): Map<string, string[]> {
	const m = new Map<string, string[]>();
	if (!spec) return m;
	for (const pair of spec.split(",")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const dom = pair.slice(0, eq).trim();
		const root = norm(pair.slice(eq + 1).trim());
		if (!dom || !root) continue;
		const cur = m.get(dom) ?? [];
		if (!cur.includes(root)) cur.push(root);
		m.set(dom, cur);
	}
	return m;
}

function main(): void {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const verbose = args.includes("--verbose");
	const dbFlag = args.indexOf("--db");
	const dbPath = dbFlag >= 0 ? (args[dbFlag + 1] ?? DEFAULT_DB) : DEFAULT_DB;
	const rmFlag = args.indexOf("--root-map");
	const rootMap = parseRootMap(rmFlag >= 0 ? args[rmFlag + 1] : undefined);
	// bun:sqlite: readonly must be true or OMITTED — { readonly: false } is
	// SQLITE_MISUSE ("flags must include SQLITE_OPEN_READONLY or READWRITE")
	const db = write
		? new Database(dbPath)
		: new Database(dbPath, { readonly: true });
	const rep = sweep(db, { write, rootMap });
	const mode = write ? "WRITE" : "dry-run";
	console.log(`knowledge-resweep (${mode}) — db: ${dbPath}`);
	console.log(
		`total ${rep.total} · retired ${rep.retired} · already referenced ${rep.alreadyReferenced} · scanned ${rep.scanned}`,
	);
	console.log(
		`  no path-like tokens: ${rep.noPaths} (skipped) · planned pointer rows: ${rep.planned.length} · unresolved: ${rep.unresolved.length}${write ? ` · applied: ${rep.changes}` : ""}`,
	);
	const byDomain = new Map<string, { planned: number; unresolved: number }>();
	for (const e of [...rep.planned, ...rep.unresolved]) {
		const k = e.domain ?? "(none)";
		const cur = byDomain.get(k) ?? { planned: 0, unresolved: 0 };
		if (e.kind === "planned") cur.planned++;
		else cur.unresolved++;
		byDomain.set(k, cur);
	}
	for (const [dom, c] of byDomain)
		console.log(`  ${dom}: ${c.planned} planned, ${c.unresolved} unresolved`);
	for (const p of rep.planned)
		console.log(`  k#${p.id} [${p.domain ?? "none"}] via ${p.via} → ${p.ref}`);
	if (verbose)
		for (const u of rep.unresolved)
			console.log(
				`  k#${u.id} [${u.domain ?? "none"}] unresolved (${u.rootsTried} root${u.rootsTried === 1 ? "" : "s"}): ${u.paths.join(", ")}`,
			);
	if (!write)
		console.log(
			"dry-run only — pass --write to apply (coordinator approval required for the live hub)",
		);
	db.close();
}

if (import.meta.main) main();
