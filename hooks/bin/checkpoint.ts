#!/usr/bin/env bun
// hooks/bin/checkpoint.ts — W253 agent CLI (`checkpoint`) for the rolling
// compaction checkpoint (hooks/lib/checkpoint.ts). `set` rolls the file
// with fresh done/next bullets (plane header auto-derived: branch/head,
// owned work, capsule); `show` cats it; `path` prints where it lives.
// Bun swallows `--` (W250 lesson) so flags are scanned from argv directly,
// `--name=value` form.
import { existsSync, readFileSync } from "node:fs";
import { openGovernorDb, projectIdentity } from "../lib/govdb.ts";
import { checkpointPath, rollCheckpoint } from "../lib/checkpoint.ts";

const arg = (name: string): string | null => {
	const t = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
	return t ? t.slice(name.length + 3) : null;
};

const usage = (): void => {
	process.stderr.write(
		"usage: checkpoint set --as <sid> [--note s] [--next s] | checkpoint show --as <sid> | checkpoint path --as <sid>\n",
	);
	process.exit(1);
};

const cmd = process.argv[2] ?? "";
const as = arg("as") ?? "";

if (cmd === "set") {
	if (!as) usage();
	const r = rollCheckpoint(openGovernorDb(), projectIdentity(), as, {
		cwd: process.cwd(),
		note: arg("note"),
		next: arg("next"),
	});
	console.log(`checkpoint rolled (gen ${r.gen}): ${r.path}`);
} else if (cmd === "show") {
	if (!as) usage();
	const p = checkpointPath(projectIdentity(), as);
	console.log(
		existsSync(p) ? readFileSync(p, "utf8").trimEnd() : "(no checkpoint)",
	);
} else if (cmd === "path") {
	if (!as) usage();
	console.log(checkpointPath(projectIdentity(), as));
} else {
	usage();
}
