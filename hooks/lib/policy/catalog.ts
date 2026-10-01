// hooks/lib/policy/catalog.ts — W161 policy advisor: the machine-checkable
// rule catalog (owner law: federation-2026-10-01.md "Policy advisor —
// suggested enforcement"). Data only — the executable checks live in
// checks.ts, keyed by rule id (hub defines, spoke executes: the hub cannot
// push code, so the manifest carries descriptors, never functions).
//
// Hub-distributable: catalogManifest(version) emits the W154 policy-pull
// payload shape ({version, rules, cr_queue}) — see hooks/lib/federation.ts
// HubManifestShape. Spokes reconcile pulled rules through
// reconcileManifestRules(): known ids map to local executors, unknown ids
// are skipped HONESTLY (never silently trusted).
//
// Never silent mutation law: a finding is a SUGGESTION with citation + a
// rendered opt-in implement-and-PR offer. The advisor never edits, never
// commits, never opens a PR. PRs land on branches, never straight to main.
import type { PolicyRule } from "./types.ts";

export const POLICY_CATALOG_VERSION = "w161.1";

export const policyCatalog: PolicyRule[] = [
	{
		id: "law.qlty-required",
		title: "qlty quality tooling present (.qlty/qlty.toml)",
		citation:
			'CLAUDE.md "qlty Quality Doctrine" — .qlty/ must exist or the governor\'s on-write gate silently no-ops',
		scope: "repo",
		severity: "warn",
		check: "repo root has .qlty/qlty.toml",
		fix: "run `qlty init` and commit .qlty/ (biome owns code formatting; prettier stays markdown-only)",
		offer:
			"opt-in: I can run `qlty init`, wire the biome plugin, and push that as a branch PR (never main).",
	},
	{
		id: "law.ts-1500-decompose",
		title: "1500-line hard limit on .ts files",
		citation:
			'CLAUDE.md "1500-Line Hard Limit"; enforced as an on-write gate in hooks/gates/files.ts:126 (W157)',
		scope: "source",
		severity: "warn",
		check: "no .ts file in the repo exceeds 1500 lines",
		fix: "split by responsibility, one source of truth per pattern (pattern: hooks/board/, hooks/coord/, hooks/board-html/)",
		offer:
			"opt-in: I can decompose the file into single-purpose modules and push that as a branch PR (never main).",
	},
	{
		id: "law.servicemon-health",
		title: "every Bun.serve service wires servicemon (/status + /metrics)",
		citation:
			'W125 servicemon law — hooks/lib/servicemon.ts:1; docs/design/buckle/federation-2026-10-01.md "Policy advisor"',
		scope: "source",
		severity: "warn",
		check:
			"every non-test .ts containing Bun.serve( also references servicemon (import, sm.fetch( or sm.wrapped()",
		fix: "wire the shared observability wrap: const sm = servicemon({ service, port }); Bun.serve({ ...base, ...sm.wrapped(base) })",
		offer:
			"opt-in: I can wire servicemon into the service and push that as a branch PR (never main).",
	},
	{
		id: "law.http-citizenship",
		title: "HTTP citizenship — required headers on error statuses",
		citation: "docs/design/http-citizenship.md (the status/header table)",
		scope: "source",
		severity: "warn",
		check:
			"confidently-parsed new Response( literals with status 401/405/429 carry WWW-Authenticate / Allow / Retry-After respectively",
		fix: "add the required headers to the response literal (401→WWW-Authenticate, 405→Allow, 429→Retry-After)",
		offer:
			"opt-in: I can add the required headers and push that as a branch PR (never main).",
	},
	{
		id: "law.auth-key-material",
		title: "no embedded key material or literal secrets in source",
		citation:
			"hooks/lib/auth.ts:1 KEY MATERIAL LAW — no key value is ever embedded, logged, or committed; fingerprints only",
		scope: "source",
		severity: "warn",
		check:
			"no PEM key blocks or long literal secret assignments in non-test source (tests may hold generated fixtures)",
		fix: "move the secret to the runtime secrets home and reference it by env name only (BUCKLE_SECRETS_HOME pattern)",
		offer:
			"opt-in: I can move the secret to the env/config path and push that as a branch PR (never main).",
	},
];

/** Rule lookup by id. */
export function ruleById(id: string): PolicyRule | undefined {
	return policyCatalog.find((r) => r.id === id);
}

/** The W154 policy-pull payload for this catalog: {version, rules,
 *  cr_queue} — JSON-serializable, HubManifestShape-compatible. */
export function catalogManifest(version: string = POLICY_CATALOG_VERSION): {
	version: string;
	rules: unknown[];
	cr_queue: Array<Record<string, unknown>>;
} {
	return { version, rules: policyCatalog, cr_queue: [] };
}

/** Spoke-side reconciliation of a pulled manifest's rules[]: known ids map
 *  to their local descriptor; anything unknown or shape-broken is reported,
 *  never trusted. Degradation law: returns what it could map, never throws. */
export function reconcileManifestRules(rules: unknown[]): {
	known: PolicyRule[];
	unknown: string[];
} {
	const known: PolicyRule[] = [];
	const unknown: string[] = [];
	for (const raw of rules) {
		const id =
			typeof raw === "string"
				? raw
				: typeof raw === "object" && raw !== null && "id" in raw
					? String((raw as Record<string, unknown>).id)
					: "";
		const local = id !== "" ? ruleById(id) : undefined;
		if (local !== undefined) known.push(local);
		else unknown.push(id === "" ? "<shapeless>" : id);
	}
	return { known, unknown };
}
