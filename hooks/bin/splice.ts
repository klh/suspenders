#!/usr/bin/env bun
// splice.ts — mechanical file edit with an EXPECTED occurrence count.
// Exists because a global let→const replace once broke a second binding
// (coord.ts metrics `project`) — blanket .split().join() rewrites never
// notice they hit more sites than intended. This tool refuses unless the
// count matches:
//
//   bun splice.ts <file> --find '<exact>' --replace '<new>' [--count N]
//
// --count omittable for single-occurrence edits (the common case); an
// explicit count that mismatches, or zero matches, aborts untouched.
const file = process.argv[2];
const get = (flag: string): string | undefined => {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const find = get("--find");
const rep = get("--replace");
const want = get("--count");

if (!file || find === undefined || rep === undefined) {
	console.error(
		"usage: splice.ts <file> --find '<exact text>' --replace '<new>' [--count N]",
	);
	process.exit(1);
}
const text = await Bun.file(file).text();
const n = text.split(find).length - 1;
if (n === 0) {
	console.error(`splice: --find not found in ${file} — untouched`);
	process.exit(1);
}
const expected = want === undefined ? 1 : Number(want);
if (!Number.isInteger(expected) || expected < 1) {
	console.error(`splice: --count must be a positive integer, got ${want}`);
	process.exit(1);
}
if (n !== expected) {
	console.error(
		`splice: found ${n} occurrence(s), expected ${expected} — ABORTED, ${file} untouched. Pass --count ${n} if ${n} is intended.`,
	);
	process.exit(1);
}
await Bun.write(file, text.split(find).join(rep));
console.log(`splice: ${n} occurrence(s) replaced in ${file}`);
