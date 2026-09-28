// test/morph.test.ts — end-to-end suite for the morph CLI (hooks/bin/morph.ts
// + hooks/lib/morph.ts, W79). Every test builds a real fixture project under
// the repo cwd (never /tmp — the bash gate exempts /tmp by design), spawns
// the CLI with an argument array, and asserts on exit codes + file bytes.
// The diagnostics-gate test is the load-bearing one: a move that orphans a
// private helper must abort with exit 2, zero bytes written.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "hooks", "bin", "morph.ts");
const roots: string[] = [];

function fixture(name: string, files: Record<string, string>): string {
	const dir = mkdtempSync(join(process.cwd(), `.tmp-morph-${name}-`));
	roots.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		writeFileSync(abs, content.replace(/^\t/gm, ""));
	}
	return dir;
}

const TSCONFIG = `{
	"compilerOptions": {
		"strict": true,
		"target": "es2022",
		"module": "esnext",
		"moduleResolution": "bundler",
		"noEmit": true
	}
}`;

function morph(...args: string[]): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", BIN, ...args], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

const withRoot = (dir: string, ...args: string[]): string[] => [
	`--root`,
	dir,
	...args,
];

describe("morph CLI", () => {
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});

	test("usage exits 1", () => {
		expect(morph().code).toBe(1);
		expect(morph("bogus").code).toBe(1);
	});

	test("rename dry-run: prints diff, writes nothing", () => {
		const dir = fixture("rename-dry", {
			"tsconfig.json": TSCONFIG,
			"a.ts": `export const oldAnswer = 41;
export function oldAnswerPlus(): number {
	return oldAnswer + 1;
}
`,
			"b.ts": `import { oldAnswer } from "./a";
export const doubled = oldAnswer * 2;
`,
		});
		const a0 = readFileSync(join(dir, "a.ts"), "utf8");
		const b0 = readFileSync(join(dir, "b.ts"), "utf8");
		const r = morph(
			...withRoot(dir),
			"rename",
			join(dir, "a.ts"),
			"--symbol",
			"oldAnswer",
			"--to",
			"newAnswer",
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("+export const newAnswer");
		expect(r.out).toContain("-export const oldAnswer");
		expect(r.out).toContain("renamed 4 site(s)");
		expect(r.out).toContain("dry-run");
		// untouched on disk
		expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe(a0);
		expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe(b0);
	});

	test("rename --apply: rewrites declaration + cross-file references", () => {
		const dir = fixture("rename-apply", {
			"tsconfig.json": TSCONFIG,
			"a.ts": `export const oldAnswer = 41;
export function answerPlus(): number {
	return oldAnswer + 1;
}
`,
			"b.ts": `import { oldAnswer } from "./a";
export const doubled = oldAnswer * 2;
`,
		});
		const r = morph(
			...withRoot(dir),
			"rename",
			join(dir, "a.ts"),
			"--symbol",
			"oldAnswer",
			"--to",
			"newAnswer",
			"--apply",
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("renamed 4 site(s)");
		const a = readFileSync(join(dir, "a.ts"), "utf8");
		const b = readFileSync(join(dir, "b.ts"), "utf8");
		expect(a).toContain("newAnswer");
		expect(a).not.toContain("oldAnswer");
		expect(b).toContain('import { newAnswer } from "./a"');
		expect(b).toContain("newAnswer * 2");
		// --count assertion: 4 sites found, so 99 aborts untouched
		const bad = morph(
			...withRoot(dir),
			"rename",
			join(dir, "a.ts"),
			"--symbol",
			"newAnswer",
			"--to",
			"zz",
			"--count",
			"99",
		);
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("--count 99");
		expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe(b);
	});

	test("move --apply: rewires importers (incl. back-import into source)", () => {
		const dir = fixture("move-apply", {
			"tsconfig.json": TSCONFIG,
			"lib.ts": `export function helper(x: number): number {
	return x + 1;
}
export const base = helper(2);
`,
			"app.ts": `import { helper } from "./lib";
export const out = helper(10);
`,
		});
		const r = morph(
			...withRoot(dir),
			"move",
			join(dir, "lib.ts"),
			"--symbol",
			"helper",
			"--to",
			join(dir, "util.ts"),
			"--apply",
		);
		expect(r.code).toBe(0);
		const util = readFileSync(join(dir, "util.ts"), "utf8");
		const lib = readFileSync(join(dir, "lib.ts"), "utf8");
		const app = readFileSync(join(dir, "app.ts"), "utf8");
		expect(util).toContain("export function helper");
		expect(lib).not.toContain("function helper");
		// lib.ts still USES helper (base = helper(2)) — must import it back
		expect(lib).toContain('from "./util"');
		// app.ts rewired away from ./lib to ./util
		expect(app).toContain('from "./util"');
		expect(app).not.toContain('from "./lib"');
		// real proof: the moved project builds
		const build = Bun.spawnSync(["bun", "build", join(dir, "app.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(build.exitCode).toBe(0);
	});

	test("diagnostics gate: move that orphans a private helper aborts, nothing written", () => {
		const dir = fixture("move-abort", {
			"tsconfig.json": TSCONFIG,
			"inner.ts": `export function inner(x: number): number {
	return x * 2;
}
`,
			"priv.ts": `import { inner } from "./inner";
export function outer(x: number): number {
	return inner(x) + 1;
}
`,
		});
		const before = readFileSync(join(dir, "priv.ts"), "utf8");
		const target = join(dir, "gone.ts");
		const r = morph(
			...withRoot(dir),
			"move",
			join(dir, "priv.ts"),
			"--symbol",
			"outer",
			"--to",
			target,
			"--apply",
		);
		expect(r.code).toBe(2);
		expect(r.err).toContain("new diagnostic");
		expect(r.err).toContain("inner");
		expect(existsSync(target)).toBe(false);
		expect(readFileSync(join(dir, "priv.ts"), "utf8")).toBe(before);
	});

	test("rename no-match aborts with exit 2", () => {
		const dir = fixture("no-match", {
			"tsconfig.json": TSCONFIG,
			"a.ts": `export const real = 1;
`,
		});
		const r = morph(
			...withRoot(dir),
			"rename",
			join(dir, "a.ts"),
			"--symbol",
			"missing",
			"--to",
			"x",
		);
		expect(r.code).toBe(2);
		expect(r.err).toContain('no declaration named "missing"');
	});

	test("organize: sorts import declarations, --apply writes", () => {
		const dir = fixture("organize", {
			"tsconfig.json": TSCONFIG,
			"a.ts": `export const alpha = 1;
`,
			"z.ts": `export const zebra = 2;
`,
			"messy.ts": `import { zebra } from "./z";
import { alpha } from "./a";
export const both = alpha + zebra;
`,
		});
		const messy0 = readFileSync(join(dir, "messy.ts"), "utf8");
		const dry = morph(...withRoot(dir), "organize", join(dir, "messy.ts"));
		expect(dry.code).toBe(0);
		expect(readFileSync(join(dir, "messy.ts"), "utf8")).toBe(messy0);
		const r = morph(
			...withRoot(dir),
			"organize",
			join(dir, "messy.ts"),
			"--apply",
		);
		expect(r.code).toBe(0);
		const messy = readFileSync(join(dir, "messy.ts"), "utf8");
		expect(messy.indexOf('"./a"')).toBeLessThan(messy.indexOf('"./z"'));
	});
});
