// hooks/lib/policy/types.ts — W161 policy advisor shared types. Data-only
// module so catalog.ts, checks.ts and bin/policy-advisor.ts (and any future
// board/console route) share one shape without import cycles.

export type PolicySeverity = "warn" | "info";

/** One distributable rule descriptor — the manifest carries descriptors,
 *  never functions (hub defines, spoke executes). */
export interface PolicyRule {
	/** law.* id — the stable key used by executors and the manifest */
	id: string;
	title: string;
	/** policy citation rendered for the user */
	citation: string;
	/** repo = checked once against the repo root; source = per-file scan */
	scope: "repo" | "source";
	severity: PolicySeverity;
	/** machine-checkable description of what the local executor verifies */
	check: string;
	/** what an opt-in implement-and-PR would change */
	fix: string;
	/** the opt-in implement-and-PR offer sentence */
	offer: string;
}

/** A violation surfaced as a SUGGESTION — never a mutation. */
export interface PolicyFinding {
	/** law.* rule id from the catalog */
	rule: string;
	title: string;
	/** where the violation lives (repo-relative path, path:line, or repo) */
	where: string;
	detail: string;
	/** policy citation rendered for the user */
	citation: string;
	/** the opt-in implement-and-PR offer text (PRs to branches only) */
	offer: string;
	/** what an opt-in implement-and-PR would change */
	fix: string;
	severity: PolicySeverity;
}

/** Aggregated advisor run. */
export interface PolicyRunResult {
	root: string;
	version: string;
	/** rule ids that executed */
	checked: string[];
	/** rule ids skipped (--rule subset or shapeless manifest entries) */
	skipped: string[];
	/** honest omissions (missing root, oversized files) — never silent */
	notes: string[];
	findings: PolicyFinding[];
}

/** A source file collected by the advisor walk. */
export interface PolicySourceFile {
	/** repo-relative path */
	rel: string;
	lines: number;
	/** null when oversized (>1MB) — content scans skip honestly */
	text: string | null;
	test: boolean;
	oversized: boolean;
}
