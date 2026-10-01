// test/policy-advisor.test.ts — W161 policy advisor: the machine-checkable
// rule catalog (catalog.ts), the check engine (checks.ts) and the CLI
// (bin/policy-advisor.ts). Fixtures build temp repos exercising each law;
// violations surface as findings with citation + offer — never mutations.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	catalogManifest,
	policyCatalog,
	reconcileManifestRules,
} from "../hooks/lib/policy/catalog.ts";
import { runPolicyChecks } from "../hooks/lib/policy/checks.ts";
import { parseArgs, renderHuman } from "../hooks/bin/policy-advisor.ts";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "w161-policy-"));
}

/** Write fixture files into a temp repo (paths repo-relative). */
function mkRepo(root: string, files: Record<string, string>): string {
	for (const [rel, body] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, body);
	}
	return root;
}

const CLEAN_SERVICE = [
	`import { servicemon } from "../../hooks/lib/servicemon.ts";`,
	`const sm = servicemon({ service: "x", port: 8080 });`,
	`Bun.serve({ port: 8080, fetch: sm.fetch(() => new Response("ok")) });`,
	`export const lim = new Response(null, {`,
	`	status: 429,`,
	`	headers: { "retry-after": "30" },`,
	`});`,
].join("\n");

/** A fixture that fires THREE rules at once: no servicemon around its
 *  Bun.serve(, a bare 429, and a long literal secret. */
const BAD_SERVICE = [
	`const srv = Bun.serve({`,
	`	port: 8080,`,
	`	fetch() {`,
	`		return new Response("rate limited", { status: 429 });`,
	`	},`,
	`});`,
	`const cfg = { token: "super-secret-value-1234567890abcdef" };`,
	`export default srv;`,
].join("\n");

function bigFile(lines: number): string {
	const out: string[] = ["export const pad: number[] = [];"];
	for (let i = 0; i < lines; i++) out.push(`pad.push(${String(i)});`);
	return `${out.join("\n")}\n`;
}

describe("policy catalog (hub-distributable)", () => {
	test("five law.* rules, JSON-serializable", () => {
		expect(policyCatalog.length).toBe(5);
		for (const r of policyCatalog) {
			expect(r.id.startsWith("law.")).toBe(true);
			expect(r.citation.length).toBeGreaterThan(0);
			expect(r.fix.length).toBeGreaterThan(0);
			expect(r.offer.length).toBeGreaterThan(0);
			expect(r.check.length).toBeGreaterThan(0);
		}
		JSON.parse(JSON.stringify(policyCatalog));
	});

	test("manifest: W154 shape + JSON round-trip reconciles", () => {
		const m = catalogManifest("t");
		expect(m.version).toBe("t");
		expect(m.rules.length).toBe(5);
		expect(m.cr_queue).toEqual([]);
		const back = JSON.parse(JSON.stringify(m)) as { rules: unknown[] };
		const rec = reconcileManifestRules(back.rules);
		expect(rec.known.length).toBe(5);
		expect(rec.unknown).toEqual([]);
	});

	test("reconcile: unknown/shapeless ids reported honestly", () => {
		const rec = reconcileManifestRules([
			{ id: "law.qlty-required" },
			{ id: "gateway.knobs" },
			"garbage",
			{},
		]);
		expect(rec.known.map((r) => r.id)).toEqual(["law.qlty-required"]);
		expect(rec.unknown).toEqual(["gateway.knobs", "garbage", "<shapeless>"]);
	});
});

describe("repo + line-law checks", () => {
	test("qlty missing → finding; present → clean", () => {
		const root = mkRepo(tmpRoot(), { "src/a.ts": CLEAN_SERVICE });
		const bad = runPolicyChecks(root);
		expect(bad.findings.some((f) => f.rule === "law.qlty-required")).toBe(true);
		mkdirSync(join(root, ".qlty"), { recursive: true });
		writeFileSync(
			join(root, ".qlty", "qlty.toml"),
			'[[plugin]]\nname = "biome"\n',
		);
		const good = runPolicyChecks(root);
		expect(good.findings.some((f) => f.rule === "law.qlty-required")).toBe(
			false,
		);
	});

	test("1500-line law fires over the limit only", () => {
		const root = mkRepo(tmpRoot(), {
			"src/big.ts": bigFile(1600),
			"src/ok.ts": "export const one = 1;\n",
		});
		const out = runPolicyChecks(root, {
			rules: ["law.ts-1500-decompose"],
		});
		expect(out.checked).toEqual(["law.ts-1500-decompose"]);
		expect(out.findings.length).toBe(1);
		expect(out.findings[0]?.where).toBe(join("src", "big.ts"));
		expect(out.findings[0]?.detail).toContain("1602 lines");
	});
});

describe("service-surface checks", () => {
	test("Bun.serve without servicemon fires; wiring clears it", () => {
		const root = mkRepo(tmpRoot(), {
			"src/one.ts": `export const r = Bun.serve({ port: 1 });`,
			"src/two.ts": `import { servicemon } from "sm";\nconst sm2 = servicemon({ service: "t", port: 2 });\nexport const r = Bun.serve({ port: 2, fetch: sm2.fetch() });`,
		});
		const out = runPolicyChecks(root, {
			rules: ["law.servicemon-health"],
		});
		expect(out.findings.map((f) => f.where)).toEqual([join("src", "one.ts")]);
	});

	test("401/405/429: missing required headers fire; present pass", () => {
		const root = mkRepo(tmpRoot(), {
			"src/http.ts": [
				`export const a = new Response("x", { status: 401 });`,
				`export const b = new Response("y", { status: 405, headers: { allow: "GET" } });`,
				`export const c = new Response("z", { status: 429 });`,
			].join("\n"),
		});
		const out = runPolicyChecks(root, { rules: ["law.http-citizenship"] });
		expect(out.findings.length).toBe(2);
		const d = out.findings.map((f) => f.detail);
		expect(d.some((x) => x.includes("401"))).toBe(true);
		expect(d.some((x) => x.includes("429"))).toBe(true);
	});
});

describe("http-citizenship honest omission", () => {
	test("spreads and variable headers are skipped, not guessed", () => {
		const root = mkRepo(tmpRoot(), {
			"src/skip.ts": [
				`export const a = new Response("x", { ...opts, status: 429 });`,
				`export const b = new Response("y", { status: 401, headers: h });`,
				`export const c = new Response(body(), { status: err.code });`,
			].join("\n"),
		});
		const out = runPolicyChecks(root, { rules: ["law.http-citizenship"] });
		expect(out.findings).toEqual([]);
	});

	test("doc-comment examples do not fire (comments blanked)", () => {
		const root = mkRepo(tmpRoot(), {
			"src/commented.ts": [
				`/** example: new Response("x", { status: 429 }) */`,
				`// new Response("y", { status: 405 })`,
				`export const ok = 1;`,
			].join("\n"),
		});
		const out = runPolicyChecks(root, { rules: ["law.http-citizenship"] });
		expect(out.findings).toEqual([]);
	});
});

describe("auth key material", () => {
	test("PEM in src fires; fixtures under test/ are exempt", () => {
		const pem = [
			"-----BEGIN PRIVATE KEY-----",
			"abc",
			"-----END PRIVATE KEY-----",
		].join("\n");
		const root = mkRepo(tmpRoot(), {
			"src/key.ts": pem,
			"test/key.test.ts": pem,
		});
		const out = runPolicyChecks(root, {
			rules: ["law.auth-key-material"],
		});
		expect(out.findings.length).toBe(1);
		expect(out.findings[0]?.where).toBe(join("src", "key.ts"));
	});

	test("long literal secrets fire; placeholders + env reads pass", () => {
		const root = mkRepo(tmpRoot(), {
			"src/a.ts": `export const cfg = { token: "super-secret-value-1234567890" };`,
			"src/b.ts": `export const cfg = { token: "changeme-placeholder-value" };`,
			"src/c.ts": `const k = process.env.BUCKLE_SPOKE_TOKEN;`,
		});
		const out = runPolicyChecks(root, {
			rules: ["law.auth-key-material"],
		});
		expect(out.findings.length).toBe(1);
		expect(out.findings[0]?.where).toBe(`${join("src", "a.ts")}:1`);
	});
});

describe("run semantics + CLI", () => {
	test("unknown requested ids land in skipped[] honestly", () => {
		const out = runPolicyChecks(tmpRoot(), {
			rules: ["law.qlty-required", "nope.rule"],
		});
		expect(out.checked).toEqual(["law.qlty-required"]);
		expect(out.skipped).toEqual(["nope.rule"]);
	});

	test("missing root → honest note; qlty finding still fires", () => {
		const out = runPolicyChecks(join(tmpRoot(), "missing"));
		expect(out.notes.length).toBeGreaterThan(0);
		expect(out.findings.some((f) => f.rule === "law.qlty-required")).toBe(true);
	});

	test("parseArgs: flags, repeatable --rule, positional root", () => {
		const a = parseArgs([
			"/some/root",
			"--rule",
			"law.a",
			"--rule",
			"law.b",
			"--json",
			"--strict",
		]);
		expect(a.root).toBe("/some/root");
		expect(a.rules).toEqual(["law.a", "law.b"]);
		expect(a.json).toBe(true);
		expect(a.strict).toBe(true);
	});

	test("renderHuman: citation + offer surface per finding", () => {
		const root = mkRepo(tmpRoot(), { "src/x.ts": "export const q = 1;\n" });
		const out = runPolicyChecks(root, {
			rules: ["law.qlty-required"],
		});
		const text = renderHuman(out);
		expect(text).toContain("law.qlty-required");
		expect(text).toContain("policy:");
		expect(text).toContain("offer:");
		expect(text).toContain("never main");
	});
});

describe("integration: one file, three rules", () => {
	test("BAD_SERVICE fires servicemon + http-citizenship + auth at once", () => {
		const root = mkRepo(tmpRoot(), { "src/bad.ts": BAD_SERVICE });
		const out = runPolicyChecks(root);
		const rules = new Set(out.findings.map((f) => f.rule));
		expect(rules.has("law.servicemon-health")).toBe(true);
		expect(rules.has("law.http-citizenship")).toBe(true);
		expect(rules.has("law.auth-key-material")).toBe(true);
		const cit = out.findings.filter((f) => f.rule === "law.servicemon-health");
		expect(cit[0]?.citation).toContain("servicemon.ts");
	});
});
