// hooks/bin/policy-advisor.ts — W161 policy advisor entry. Runs the
// machine-checkable policy catalog (hooks/lib/policy/) against a repo root —
// the worked-on service. Violations surface as SUGGESTIONS with policy
// citation + opt-in implement-and-PR offer; never a silent mutation: this
// tool never edits, never commits, never opens a PR — the implement-and-PR
// step is a human opt-in, and PRs land on branches, never straight to main.
//
// usage:
//   bun hooks/bin/policy-advisor.ts [root] [--rule <id>] [--json]
//       [--manifest] [--strict]
//
//   root        repo to check (default: $PWD) — "the worked-on service"
//   --rule <id> restrict to catalog rule ids (repeatable; unknown ids are
//               reported in skipped[])
//   --json      machine-readable run result (for board/console integrations)
//   --manifest  print the W154 policy-pull payload ({version, rules,
//               cr_queue}) — the hub-distributable catalog form — and exit
//   --strict    exit 1 when findings exist (default: exit 0 — advice never
//               blocks; blocking is the gates' job, not the advisor's)
import { runPolicyChecks } from "../lib/policy/checks.ts";
import { catalogManifest } from "../lib/policy/catalog.ts";
import type { PolicyRunResult } from "../lib/policy/types.ts";

export interface AdvisorArgs {
	root: string;
	rules: string[];
	json: boolean;
	manifest: boolean;
	strict: boolean;
}

export function parseArgs(argv: string[]): AdvisorArgs {
	const out: AdvisorArgs = {
		root: process.cwd(),
		rules: [],
		json: false,
		manifest: false,
		strict: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--json") out.json = true;
		else if (a === "--manifest") out.manifest = true;
		else if (a === "--strict") out.strict = true;
		else if (a === "--rule") {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith("--")) {
				console.error("policy-advisor: --rule needs a value");
				process.exit(2);
			}
			out.rules.push(v);
			i++;
		} else if (a.startsWith("--")) {
			console.error(`policy-advisor: unknown flag ${a}`);
			process.exit(2);
		} else out.root = a;
	}
	return out;
}

/** Human report: finding → where + detail, policy citation, fix, offer. */
export function renderHuman(out: PolicyRunResult): string {
	const L: string[] = [];
	L.push(
		`[policy ${out.version}] root: ${out.root} — ${String(out.checked.length)} rules`,
	);
	for (const f of out.findings) {
		L.push("");
		L.push(`  ✗ ${f.rule} — ${f.title}`);
		L.push(`    where:  ${f.where} — ${f.detail}`);
		L.push(`    policy: ${f.citation}`);
		L.push(`    fix:    ${f.fix}`);
		L.push(`    offer:  ${f.offer}`);
	}
	L.push("");
	const dirty = new Set(out.findings.map((f) => f.rule));
	const clean = out.checked.filter((r) => !dirty.has(r)).length;
	L.push(
		`${String(out.findings.length)} finding(s) · ${String(clean)} rule(s) clean · ${String(out.skipped.length)} skipped`,
	);
	for (const n of out.notes) L.push(`  note: ${n}`);
	if (out.findings.length === 0) L.push("  ✓ no policy violations found");
	return L.join("\n");
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.manifest) {
		console.log(JSON.stringify(catalogManifest(), null, "\t"));
	} else {
		const out = runPolicyChecks(
			args.root,
			args.rules.length > 0 ? { rules: args.rules } : {},
		);
		if (args.json) console.log(JSON.stringify(out, null, "\t"));
		else console.log(renderHuman(out));
		if (args.strict && out.findings.length > 0) process.exit(1);
	}
}
