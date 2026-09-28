// hooks/lib/morph.ts — AST-grade structural edits via ts-morph (W79).
// Doctrine (lesson.ts-morph-edits + ts-morph.com/manipulation): load the whole
// project ONCE, collect matches as a snapshot BEFORE mutating, batch every
// change in memory, gate on NEW pre-emit diagnostics, and write disk exactly
// once via project.saveSync() — so an abort leaves the tree untouched and an
// apply never lands in a halfway state.
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	type Diagnostic,
	type DiagnosticMessageChain,
	type Node,
	Project,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";

export type Session = {
	project: Project;
	roots: string[];
	/** path -> full text at load time (the abort baseline) */
	before: Map<string, string>;
	/** formatted diagnostics at load time — only NEW ones abort */
	diagKeys: Set<string>;
};

export type Outcome = {
	ok: boolean;
	note: string;
	error?: string;
	diags?: string[];
	changed: string[];
	diff: string;
};

const IGNORED_DIRS = [
	"node_modules",
	".git",
	".worktrees",
	".fleet",
	".qlty",
	".claude",
	".tmp-",
];

/** Load every .ts under roots into one in-memory project (plus tsconfig when present). */
export async function loadSession(roots: string[]): Promise<Session> {
	const tsconfig = roots
		.map((r) => join(r, "tsconfig.json"))
		.find((p) => existsSync(p));
	const opts: {
		tsConfigFilePath?: string;
		skipAddingFilesFromTsConfig: boolean;
	} = { skipAddingFilesFromTsConfig: true };
	if (tsconfig) opts.tsConfigFilePath = tsconfig;
	const project = new Project(opts);
	const glob = new Bun.Glob("**/*.ts");
	for (const root of roots) {
		const files = await Array.fromAsync(
			glob.scan({ cwd: root, onlyFiles: true }),
		);
		for (const relPath of files.sort()) {
			if (IGNORED_DIRS.some((d) => relPath.includes(d))) continue;
			project.addSourceFileAtPath(resolve(root, relPath));
		}
	}
	return {
		project,
		roots,
		before: new Map(
			project.getSourceFiles().map((f) => [f.getFilePath(), f.getFullText()]),
		),
		diagKeys: diagKeySet(project),
	};
}

function flattenMsg(m: DiagnosticMessageChain): string {
	return `${m.getMessageText()} [${(m.getNext() ?? []).map((n) => flattenMsg(n)).join("; ")}]`;
}

function diagKey(d: Diagnostic): string {
	const msg = d.getMessageText();
	return `${d.getSourceFile()?.getFilePath() ?? "?"}:${d.getLineNumber() ?? -1}:${d.getCode()}:${flat(msg)}`;
}

function flat(m: string | DiagnosticMessageChain): string {
	return typeof m === "string"
		? m
		: `${m.getMessageText()} [${(m.getNext() ?? []).map((n) => flattenMsg(n)).join("; ")}]`;
}

function diagKeySet(project: Project): Set<string> {
	const keys = new Set<string>();
	for (const d of project.getPreEmitDiagnostics()) keys.add(diagKey(d));
	return keys;
}

/**
 * The one file-resolving helper for recipes: finds the named declaration
 * whose getNameNode() IS the identifier — a snapshot match, not a live walk.
 */
function findNamedDecl(
	file: SourceFile,
	name: string,
): { node: Node; nameNode: Node } | undefined {
	for (const id of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
		if (id.getText() !== name) continue;
		const parent = id.getParent();
		const named = parent as {
			getName?: () => string;
			getNameNode?: () => Node;
		};
		if (
			typeof named.getName === "function" &&
			named.getName?.() === name &&
			named.getNameNode?.() === id
		) {
			return { node: parent, nameNode: id };
		}
	}
	return undefined;
}

/** Sites = the declaration itself + every reference the language service finds (deduped). */
function renameSites(nameNode: Node, from: string): Set<string> {
	const seen = new Set<string>();
	const add = (n: Node): void => {
		if (n.getText() !== from) return;
		seen.add(`${n.getSourceFile().getFilePath()}:${n.getStart()}`);
	};
	add(nameNode);
	for (const r of nameNode.findReferencesAsNodes()) add(r);
	return seen;
}

export function renameSymbol(
	s: Session,
	o: {
		file: string;
		from: string;
		to: string;
		count?: number;
		apply?: boolean;
	},
): Outcome {
	const file = resolveFile(s, o.file);
	if (!file) return noFile(o.file);
	const decl = findNamedDecl(file, o.from);
	if (!decl) {
		return {
			ok: false,
			note: "",
			error: `no declaration named "${o.from}" in ${o.file}`,
			changed: [],
			diff: "",
		};
	}
	const sites = renameSites(decl.nameNode, o.from);
	if (o.count !== undefined && sites.size !== o.count) {
		return {
			ok: false,
			note: "",
			error: `found ${sites.size} rename site(s) for "${o.from}", --count ${o.count} — aborted untouched`,
			changed: [],
			diff: "",
		};
	}
	try {
		decl.nameNode.rename(o.to);
	} catch (e) {
		return {
			ok: false,
			note: "",
			error: `rename failed: ${(e as Error).message}`,
			changed: [],
			diff: "",
		};
	}
	return finish(s, `renamed ${sites.size} site(s): ${o.from} -> ${o.to}`, o);
}

export function moveSymbol(
	s: Session,
	o: { file: string; name: string; target: string; apply?: boolean },
): Outcome {
	const file = resolveFile(s, o.file);
	if (!file) return noFile(o.file);
	const decl = findNamedDecl(file, o.name);
	if (!decl) {
		return {
			ok: false,
			note: "",
			error: `no declaration named "${o.name}" in ${o.file}`,
			changed: [],
			diff: "",
		};
	}
	if (!decl.node.getParent()?.isKind(SyntaxKind.SourceFile)) {
		return {
			ok: false,
			note: "",
			error: `"${o.name}" is not a top-level declaration — move only handles top level`,
			changed: [],
			diff: "",
		};
	}
	const target = resolveTarget(s, o.target);
	const text = decl.node.getFullText().trimEnd();
	const refFiles = new Set(
		decl.nameNode
			.findReferencesAsNodes()
			.map((r) => r.getSourceFile())
			.filter((f) => f.getFilePath() !== target.getFilePath()),
	);
	const importers = refFiles.size;
	// remove from source (whole statement when it only declares this symbol).
	// kind-guard first: getVariableStatement() THROWS on non-variable nodes
	// (v28 throws Array.find-callback from its ancestor walk)
	if (decl.node.getKind() === SyntaxKind.VariableDeclaration) {
		const vs = (
			decl.node as unknown as {
				getVariableStatement: () => {
					getDeclarations: () => unknown[];
					remove: () => void;
				};
			}
		).getVariableStatement();
		if (vs.getDeclarations().length === 1) vs.remove();
		else decl.node.remove();
	} else {
		decl.node.remove();
	}
	target.addStatements(`\n${text}\n`);
	for (const rf of refFiles) {
		if (rf.getFilePath() === file.getFilePath()) continue;
		removeOldBinding(rf, o.name, file);
		ensureImport(rf, o.name, target);
	}
	// the source itself may still reference the symbol after losing it
	if (refFiles.has(file)) ensureImport(file, o.name, target);
	return finish(
		s,
		`moved ${o.name}: ${rel(s, file.getFilePath())} -> ${rel(s, target.getFilePath())} (${importers} importer(s))`,
		o,
	);
}

export function organizeImports(
	s: Session,
	o: { only: string[]; apply: boolean },
): Outcome {
	const wanted = o.only.map((n) => resolve(n));
	const files = s.project
		.getSourceFiles()
		.filter(
			(f) => wanted.length === 0 || wanted.some((w) => f.getFilePath() === w),
		);
	if (o.only.length > 0 && files.length === 0) return noFile(o.only.join(", "));
	for (const f of files) f.organizeImports();
	return finish(s, `organized imports in ${files.length} file(s)`, o);
}

/** Diagnostics gate + diff + the ONLY disk write: one saveSync, after all checks. */
function finish(s: Session, note: string, o: { apply: boolean }): Outcome {
	const changed = s.project
		.getSourceFiles()
		.filter((f) => f.getFullText() !== s.before.get(f.getFilePath()));
	const fresh = s.project
		.getPreEmitDiagnostics()
		.filter((d) => !s.diagKeys.has(diagKey(d)));
	const diff = changed
		.map((f) =>
			unifiedDiff(
				s.before.get(f.getFilePath()) ?? "",
				f.getFullText(),
				rel(s, f.getFilePath()),
			),
		)
		.join("\n");
	if (fresh.length > 0) {
		return {
			ok: false,
			note,
			error: `${fresh.length} new diagnostic(s) after mutation — aborted, nothing written`,
			diags: fresh.slice(0, 10).map((d) => flat(d.getMessageText())),
			changed: [],
			diff,
		};
	}
	if (!o.apply) {
		return {
			ok: true,
			note: `${note} [dry-run — re-run with --apply to write]`,
			changed: changed.map((f) => rel(s, f.getFilePath())),
			diff,
		};
	}
	s.project.saveSync();
	return {
		ok: true,
		note,
		changed: changed.map((f) => rel(s, f.getFilePath())),
		diff,
	};
}

function resolveFile(s: Session, p: string): SourceFile | undefined {
	const abs = resolve(p);
	return s.project.getSourceFiles().find((f) => f.getFilePath() === abs);
}

function resolveTarget(s: Session, p: string): SourceFile {
	const abs = resolve(p);
	const existing = s.project
		.getSourceFiles()
		.find((f) => f.getFilePath() === abs);
	if (existing) return existing;
	if (existsSync(abs)) return s.project.addSourceFileAtPath(abs);
	return s.project.createSourceFile(abs);
}

function ensureImport(sf: SourceFile, name: string, target: SourceFile): void {
	const spec = relativeSpecifier(sf, target);
	const existing = sf
		.getImportDeclarations()
		.find((d) => d.getModuleSpecifierValue() === spec);
	if (existing) {
		if (!existing.getNamedImports().some((n) => n.getName() === name)) {
			existing.addNamedImport(name);
		}
		return;
	}
	sf.addImportDeclaration({ namedImports: [name], moduleSpecifier: spec });
}

/** Drop `name` from importer's imports of the source module (sole member: whole import goes). */
function removeOldBinding(
	sf: SourceFile,
	name: string,
	from: SourceFile,
): void {
	const spec = relativeSpecifier(sf, from);
	for (const d of sf.getImportDeclarations()) {
		if (d.getModuleSpecifierValue() !== spec) continue;
		const named = d.getNamedImports();
		const hit = named.find((n) => n.getName() === name);
		if (hit) {
			if (named.length === 1) d.remove();
			else hit.remove();
		}
		return;
	}
}

function relativeSpecifier(from: SourceFile, to: SourceFile): string {
	let r = relative(dirname(from.getFilePath()), to.getFilePath());
	r = r.replace(/\.ts$/, "");
	if (!r.startsWith(".")) r = `./${r}`;
	return r;
}

function noFile(p: string): Outcome {
	return {
		ok: false,
		note: "",
		error: `file not in loaded project: ${p} (is it under a --root?)`,
		changed: [],
		diff: "",
	};
}

function rel(s: Session, abs: string): string {
	for (const root of s.roots) {
		const r = relative(root, abs);
		if (!r.startsWith("..") && !r.startsWith("/")) return r;
	}
	return abs;
}

/** Minimal unified diff (LCS on lines) — enough for review + tests, no deps. */
export function unifiedDiff(a: string, b: string, label: string): string {
	const al = a.split("\n");
	const bl = b.split("\n");
	const dp: number[][] = Array.from({ length: al.length + 1 }, () =>
		new Array<number>(bl.length + 1).fill(0),
	);
	for (let i = al.length - 1; i >= 0; i--) {
		for (let j = bl.length - 1; j >= 0; j--) {
			dp[i][j] =
				al[i] === bl[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	type Op = { t: " " | "-" | "+"; line: string };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < al.length && j < bl.length) {
		if (al[i] === bl[j]) {
			ops.push({ t: " ", line: al[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ t: "-", line: al[i] });
			i++;
		} else {
			ops.push({ t: "+", line: bl[j] });
			j++;
		}
	}
	while (i < al.length) ops.push({ t: "-", line: al[i++] });
	while (j < bl.length) ops.push({ t: "+", line: bl[j++] });
	if (!ops.some((o) => o.t !== " ")) return "";

	// hunks: extend to context edges; a gap of >ctx equal lines starts a new hunk
	const ctx = 3;
	const hunks: string[] = [];
	let start = 0;
	while (start < ops.length) {
		if (ops[start].t === " ") {
			start++;
			continue;
		}
		const from = Math.max(0, start - ctx);
		let end = start;
		let run = 0;
		while (end < ops.length) {
			if (ops[end].t === " ") {
				run++;
				if (run > ctx) break;
			} else {
				run = 0;
			}
			end++;
		}
		const slice = ops.slice(from, end);
		let a0 = 0;
		let b0 = 0;
		for (let k = 0; k < from; k++) {
			if (ops[k].t !== "+") a0++;
			if (ops[k].t !== "-") b0++;
		}
		const aCount = slice.filter((o) => o.t !== "+").length;
		const bCount = slice.filter((o) => o.t !== "-").length;
		hunks.push(`@@ -${a0 + 1},${aCount} +${b0 + 1},${bCount} @@`);
		hunks.push(...slice.map((o) => `${o.t}${o.line}`));
		start = end;
	}
	return `--- a/${label}\n+++ b/${label}\n${hunks.join("\n")}`;
}
