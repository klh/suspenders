#!/usr/bin/env bun
// morph.ts — AST-grade structural edits with transactional guardrails (W79).
// Recipes mutate an in-memory ts-morph project of every .ts under --root,
// then either print the unified diff (dry-run, default) or land everything in
// ONE saveSync (lib/morph.ts finish()). Abort conditions: zero matches, a
// --count mismatch (splice.ts discipline), or any NEW pre-emit diagnostic —
// in every abort case nothing reaches disk.
//
//   bun morph.ts rename <file> --symbol OLD --to NEW [--count N] [--apply]
//   bun morph.ts move   <file> --symbol NAME --to TARGET.ts [--apply]
//   bun morph.ts organize [file...]               [--apply]
//
// Common flags: --root DIR (repeatable, default cwd), --apply.
import { loadSession } from "../lib/morph";
import type { Outcome } from "../lib/morph";
import { moveSymbol, organizeImports, renameSymbol } from "../lib/morph";

const argv = process.argv.slice(2);
const get = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--count", "--symbol", "--to", "--root"]);
const positionals = argv.filter(
	(a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])),
);
const collect = (flag: string): string[] => {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === flag) out.push(argv[i + 1] ?? "");
	}
	return out;
};

const USAGE = `usage: morph.ts <recipe> [file...] [--apply] [--count N] [--symbol NAME] [--to NEW|TARGET.ts] [--root DIR]...

recipes:
  rename <file> --symbol OLD --to NEW [--count N]
      AST rename across every loaded file (language-service backed).
  move <file> --symbol NAME --to TARGET.ts
      Move one top-level declaration to TARGET and add imports where used.
      Moves only the declaration — its own dependencies stay put; the
      diagnostics gate aborts if that leaves NEW type errors.
  organize [file...]
      organizeImports on the named files (default: all loaded files).

guardrails: dry-run by default. Zero matches, a --count mismatch, or any NEW
pre-emit diagnostic after mutation aborts with exit 2 and writes nothing.
On success everything lands through exactly one project.saveSync().`;

const countRaw = get("--count");
const count = countRaw === undefined ? undefined : Number(countRaw);
if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
	console.error(`morph: --count must be a positive integer, got ${countRaw}`);
	process.exit(1);
}

const cmdArg = positionals[0] ?? "";
if (
	cmdArg === "" ||
	cmdArg === "-h" ||
	cmdArg === "--help" ||
	positionals.length === 0
) {
	console.error(USAGE);
	process.exit(1);
}
const symbol = get("--symbol");
const to = get("--to");
const apply = argv.includes("--apply");
const roots = collect("--root");
if (roots.length === 0) roots.push(process.cwd());

const s = await loadSession(roots);
let out: Outcome;
if (cmdArg === "rename") {
	if (!positionals[1] || !symbol || !to) {
		console.error(USAGE);
		process.exit(1);
	}
	out = renameSymbol(s, {
		file: positionals[1],
		from: symbol,
		to,
		count,
		apply,
	});
} else if (cmdArg === "move") {
	if (!positionals[1] || !symbol || !to) {
		console.error(USAGE);
		process.exit(1);
	}
	out = moveSymbol(s, {
		file: positionals[1],
		name: symbol,
		target: to,
		apply,
	});
} else if (cmdArg === "organize") {
	out = organizeImports(s, { only: positionals.slice(1), apply });
} else {
	console.error(`morph: unknown recipe "${cmdArg}"`);
	console.error(USAGE);
	process.exit(1);
}

if (!out.ok) {
	console.error(`morph: ${out.error}`);
	for (const d of out.diags ?? []) console.error(`  TS: ${d}`);
	process.exit(2);
}
if (out.diff) console.log(out.diff);
console.log(`morph: ${out.note}`);
process.exit(0);
