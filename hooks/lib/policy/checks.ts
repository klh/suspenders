// hooks/lib/policy/checks.ts — W161 policy advisor: the executable half of
// the catalog (catalog.ts holds the descriptors). Runs the machine-checkable
// subset of fleet law against a repo root — the worked-on service. Every
// violation becomes a SUGGESTION (where + policy citation + opt-in
// implement-and-PR offer); never a mutation, never a gate. Honest omission
// doctrine: content that cannot be confidently parsed (spreads, variable
// headers, oversized files) is skipped + noted in result.notes, never guessed.
//
// ids = the law.* namespace, matching files.ts + CLAUDE.md law ids:
//   law.qlty-required · law.ts-1500-decompose · law.servicemon-health
//   law.http-citizenship · law.auth-key-material

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { POLICY_CATALOG_VERSION, policyCatalog } from "./catalog.ts";
import type {
	PolicyFinding,
	PolicyRule,
	PolicyRunResult,
	PolicySourceFile,
} from "./types.ts";

const LINE_LIMIT = 1500;
const FULL_SCAN_CAP = 1_000_000;

/** Same naive count as hooks/gates/files.ts: split("\n").length. */
function countLines(buf: Buffer): number {
	let n = 0;
	for (const b of buf) if (b === 0x0a) n++;
	return n + 1;
}

/** Test files hold generated fixtures (fake keys, unheadered responses), so
 *  content-law scans exclude them; the 1500-line law does not. */
function isTestPath(rel: string): boolean {
	return (
		rel.startsWith("test/") ||
		rel.includes("/test/") ||
		/\.test\.ts$/.test(rel) ||
		/\.spec\.ts$/.test(rel)
	);
}

/** Blank comments without shifting line structure, so scans see code, not
 *  doc-comment examples (a comment's own example code must not fire rules). */
export function blankComments(text: string): string {
	let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
	out = out
		.split("\n")
		.map((l) => (l.trimStart().startsWith("//") ? "" : l))
		.join("\n");
	return out;
}

/** Dirs never scanned (static list; worktrees/vendor/dist excluded). */
export const POLICY_IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"vendor",
	"coverage",
	".worktrees",
	".cache",
	".qlty",
]);

/** Collect every .ts under root: exact line counts always, content only
 *  under FULL_SCAN_CAP (oversized files skip content scans — noted). */
export function collectSource(root: string): {
	files: PolicySourceFile[];
	notes: string[];
} {
	const files: PolicySourceFile[] = [];
	const notes: string[] = [];
	if (!existsSync(root)) {
		notes.push(`root does not exist: ${root}`);
		return { files, notes };
	}
	const walk = (rel: string): void => {
		const abs = join(root, rel);
		for (const e of readdirSync(abs, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (!POLICY_IGNORED_DIRS.has(e.name)) walk(join(rel, e.name));
				continue;
			}
			if (!e.isFile() || !e.name.endsWith(".ts")) continue;
			const frel = rel === "" ? e.name : join(rel, e.name);
			const buf = readFileSync(join(root, frel));
			const oversized = buf.length > FULL_SCAN_CAP;
			files.push({
				rel: frel,
				lines: countLines(buf),
				text: oversized ? null : buf.toString("utf8"),
				test: isTestPath(frel),
				oversized,
			});
		}
	};
	walk("");
	files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
	return { files, notes };
}

function finding(
	rule: PolicyRule,
	where: string,
	detail: string,
): PolicyFinding {
	return {
		rule: rule.id,
		title: rule.title,
		where,
		detail,
		citation: rule.citation,
		offer: rule.offer,
		fix: rule.fix,
		severity: rule.severity,
	};
}

/** law.qlty-required — repo scope. */
export function checkQltyPresence(root: string): PolicyFinding[] {
	const rule = policyCatalog.find((r) => r.id === "law.qlty-required");
	if (rule === undefined) return [];
	if (existsSync(join(root, ".qlty", "qlty.toml"))) return [];
	return [finding(rule, ".", ".qlty/qlty.toml missing at the repo root")];
}

/** law.ts-1500-decompose — every .ts, tests included. */
export function checkLineLimit(files: PolicySourceFile[]): PolicyFinding[] {
	const rule = policyCatalog.find((r) => r.id === "law.ts-1500-decompose");
	if (rule === undefined) return [];
	const out: PolicyFinding[] = [];
	for (const f of files) {
		if (f.lines <= LINE_LIMIT) continue;
		out.push(
			finding(
				rule,
				f.rel,
				`${String(f.lines)} lines (limit ${String(LINE_LIMIT)}) — decompose by responsibility`,
			),
		);
	}
	return out;
}

/** law.servicemon-health — non-test .ts with Bun.serve( must reference
 *  servicemon (import, sm.fetch( or sm.wrapped(). */
export function checkServicemon(files: PolicySourceFile[]): PolicyFinding[] {
	const rule = policyCatalog.find((r) => r.id === "law.servicemon-health");
	if (rule === undefined) return [];
	const out: PolicyFinding[] = [];
	for (const f of files) {
		if (f.text === null || f.test) continue;
		const src = blankComments(f.text);
		if (!src.includes("Bun.serve(")) continue;
		if (/servicemon/i.test(src)) continue;
		out.push(
			finding(
				rule,
				f.rel,
				"Bun.serve( without servicemon wiring — no /status, no /metrics",
			),
		);
	}
	return out;
}

const RESPONSE_REQUIRED_HEADERS: Record<number, string> = {
	401: "www-authenticate",
	405: "allow",
	429: "retry-after",
};

/** Inner text of the balanced bracket span opening at idx (open = "(" or
 *  "{"), or null when unbalanced — skip, never guess. */
function balancedFrom(
	src: string,
	idx: number,
	open: string,
	close: string,
): string | null {
	let depth = 0;
	for (let i = idx; i < src.length; i++) {
		const ch = src[i];
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return src.slice(idx + 1, i);
		}
	}
	return null;
}

function lineAt(text: string, idx: number): number {
	let line = 1;
	for (let i = 0; i < idx; i++) if (text[i] === "\n") line++;
	return line;
}

/** law.http-citizenship — the confidently-parsable subset of the status/
 *  header table: literal statuses 401/405/429 in a plain object literal;
 *  spreads and variable headers are skipped (honest omission). */
export function checkHttpCitizenship(
	files: PolicySourceFile[],
): PolicyFinding[] {
	const rule = policyCatalog.find((r) => r.id === "law.http-citizenship");
	if (rule === undefined) return [];
	const out: PolicyFinding[] = [];
	for (const f of files) {
		if (f.text === null || f.test) continue;
		const src = blankComments(f.text);
		for (const m of src.matchAll(/new Response\(/g)) {
			const span = balancedFrom(src, m.index + m[0].length - 1, "(", ")");
			if (span === null || span.includes("...")) continue;
			const sm = /(?:^|[{,\s(])status:\s*(\d{3})\b/.exec(span);
			if (sm === null) continue;
			const status = Number(sm[1]);
			const need = RESPONSE_REQUIRED_HEADERS[status];
			if (need === undefined) continue;
			const hObj = /\bheaders\s*:\s*\{/.exec(span);
			const at = `${f.rel}:${String(lineAt(src, m.index))}`;
			if (hObj === null) {
				if (/\bheaders\s*:/.exec(span) === null)
					out.push(
						finding(
							rule,
							at,
							`status ${String(status)} response with no headers literal — required: ${need}`,
						),
					);
				continue;
			}
			const hSpan = balancedFrom(
				span,
				hObj.index + hObj[0].length - 1,
				"{",
				"}",
			);
			if (hSpan === null) continue;
			if (hSpan.toLowerCase().includes(need)) continue;
			out.push(
				finding(
					rule,
					at,
					`status ${String(status)} response missing required header: ${need}`,
				),
			);
		}
	}
	return out;
}

const PEM_RE = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/;
const SECRET_LIT_RE =
	/\b(?:password|passwd|secret|api_?key|token|bearer)\b\s*[:=]\s*["'`]([^"`\n]{20,})["'`]/gi;
const PLACEHOLDER_RE =
	/(?:changeme|change-me|placeholder|example|\$\{|<[^>]+>)/i;

/** law.auth-key-material — non-test source only (tests hold generated
 *  fixtures). PEM blocks + long literal secret assignments; matched values
 *  are NEVER rendered into findings (findings are safe to surface). */
export function checkAuthKeyMaterial(
	files: PolicySourceFile[],
): PolicyFinding[] {
	const rule = policyCatalog.find((r) => r.id === "law.auth-key-material");
	if (rule === undefined) return [];
	const out: PolicyFinding[] = [];
	for (const f of files) {
		if (f.text === null || f.test) continue;
		const src = blankComments(f.text);
		if (PEM_RE.test(src)) {
			out.push(
				finding(
					rule,
					f.rel,
					"PEM key/certificate block embedded in source — move to the secrets home, reference by env name only",
				),
			);
			continue;
		}
		for (const m of src.matchAll(SECRET_LIT_RE)) {
			const value = m[1] ?? "";
			if (value === "" || PLACEHOLDER_RE.test(value)) continue;
			const key = m[0].split(/[:=]/)[0]?.trim() ?? "secret";
			out.push(
				finding(
					rule,
					`${f.rel}:${String(lineAt(src, m.index))}`,
					`literal ${key} assignment (${String(value.length)} chars) — move to env/secrets home`,
				),
			);
		}
	}
	return out;
}

/** rule id → executor. Repo-scope rules take root; source-scope take files. */
const EXECUTORS: Record<
	string,
	(root: string, files: PolicySourceFile[]) => PolicyFinding[]
> = {
	"law.qlty-required": (root) => checkQltyPresence(root),
	"law.ts-1500-decompose": (_root, files) => checkLineLimit(files),
	"law.servicemon-health": (_root, files) => checkServicemon(files),
	"law.http-citizenship": (_root, files) => checkHttpCitizenship(files),
	"law.auth-key-material": (_root, files) => checkAuthKeyMaterial(files),
};

/** Rule ids whose executor needs the file walk. */
const SOURCE_RULES = new Set([
	"law.ts-1500-decompose",
	"law.servicemon-health",
	"law.http-citizenship",
	"law.auth-key-material",
]);

/** Run the catalog (or a --rule subset) against a repo root. Requested-but-
 *  unknown ids land in skipped[] (honest); findings come in catalog order. */
export function runPolicyChecks(
	root: string,
	opts: { rules?: string[] } = {},
): PolicyRunResult {
	const requested =
		opts.rules !== undefined && opts.rules.length > 0
			? new Set(opts.rules)
			: null;
	const checked: string[] = [];
	const skipped: string[] = [];
	const findings: PolicyFinding[] = [];
	const needsSource =
		requested === null || [...requested].some((id) => SOURCE_RULES.has(id));
	const { files, notes } = needsSource
		? collectSource(root)
		: { files: [], notes: [] };
	for (const rule of policyCatalog) {
		if (requested !== null && !requested.has(rule.id)) continue;
		const ex = EXECUTORS[rule.id];
		if (ex === undefined) continue;
		checked.push(rule.id);
		findings.push(...ex(root, files));
	}
	for (const id of opts.rules ?? []) {
		if (!checked.includes(id) && !skipped.includes(id)) skipped.push(id);
	}
	return {
		root,
		version: POLICY_CATALOG_VERSION,
		checked,
		skipped,
		notes,
		findings,
	};
}
