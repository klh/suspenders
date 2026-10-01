// test/repo-laws.test.ts — W164: the .llm dotfile grammar, discovery, the
// 4-state reconciliation, and the BYO user plane. Pure unit tests on TEMP
// files only (BUCKLE_SECRETS_HOME pinned to a temp home) — never the live
// secrets home, never committed config.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findLlmDotfile,
	parseLlmDotfile,
	parseLawExpr,
	readUserKey,
	readUserPlane,
	reconcileRepoLaws,
	serializeLaws,
	userKeyPath,
	validateUserPlaneEntry,
	writeUserPlane,
} from "../hooks/lib/repo-laws.ts";

const TMP = mkdtempSync(join(tmpdir(), "w164-laws-"));
const ENV = { ...process.env, BUCKLE_SECRETS_HOME: join(TMP, "secrets") };

describe("parseLlmDotfile", () => {
	test("valid dotfile: laws + comments + blank lines", () => {
		const p = parseLlmDotfile(
			"# repo laws\nprefer=model:qwen*\nmust=cloud\n\ntier=complex\nfallback=local-swarm, gpt-5.2\n",
		);
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(p.doc.laws).toEqual([
			{ line: 2, verb: "prefer", expr: "model:qwen*" },
			{ line: 3, verb: "must", expr: "cloud" },
		]);
		expect(p.doc.tier).toBe("complex");
		expect(p.doc.fallback).toEqual(["local-swarm", "gpt-5.2"]);
	});

	test("three invalid lines → three loud errors, each with its line number", () => {
		const p = parseLlmDotfile("prefer=\nwrongo=foo\ntier=bogus");
		expect(p.ok).toBe(false);
		if (p.ok) return;
		expect(p.errors).toEqual([
			{
				line: 1,
				why: "prefer=: law expression: 1–12 whitespace-separated tokens, e.g. 'local distill reasoning'",
			},
			{
				line: 2,
				why: "unknown law key 'wrongo' — expected prefer=, must=, tier=, fallback=",
			},
			{
				line: 3,
				why: "tier=: must be one of simple|medium|complex|very_complex, got 'bogus'",
			},
		]);
	});

	test("round-trip: parse → serialize → parse is law-identical", () => {
		const text = "prefer=local\nmust=model:glm*\ntier=medium\nfallback=a, b\n";
		const p = parseLlmDotfile(text);
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		const back = parseLlmDotfile(serializeLaws(p.doc));
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.doc.laws).toEqual(
			p.doc.laws.map((l) => ({ ...l, line: expect.any(Number) })),
		);
		expect(back.doc.tier).toBe(p.doc.tier);
		expect(back.doc.fallback).toEqual(p.doc.fallback);
	});
});

describe("parseLawExpr", () => {
	test("duplicate location refused", () => {
		expect(parseLawExpr("local cloud").ok).toBe(false);
		expect(parseLawExpr("local host:box").ok).toBe(false);
	});

	test("empty host:/model: values refused", () => {
		expect(parseLawExpr("host:").ok).toBe(false);
		expect(parseLawExpr("model:").ok).toBe(false);
	});
});

describe("findLlmDotfile", () => {
	test("nearest dotfile wins; repo root bounds the walk; none → null", () => {
		const repo = mkdtempSync(join(tmpdir(), "w164-repo-"));
		mkdirSync(join(repo, ".git"));
		mkdirSync(join(repo, "pkg", "deep"), { recursive: true });
		writeFileSync(join(repo, "pkg", ".llm"), "prefer=local\n");
		// nested pkg has its own dotfile — wins over the repo root
		const nested = findLlmDotfile(join(repo, "pkg", "deep"));
		expect(nested).toBe(join(repo, "pkg", ".llm"));
		// repo root itself has no dotfile — walk stops there, returns null
		expect(findLlmDotfile(repo)).toBeNull();
	});
});

describe("reconcileRepoLaws", () => {
	test("(a) dotfile + no config → adopt, config materialized FROM dotfile", () => {
		const r = reconcileRepoLaws({ dotfile: "prefer=local\n", config: null });
		expect(r.state).toBe("adopt");
		if (r.state !== "adopt") return;
		expect(r.configEntry).toBe("prefer=local\n");
		expect(r.effective).toBe("prefer=local\n");
	});

	test("(b) dotfile + config → dotfile wins, config mirrors", () => {
		const r = reconcileRepoLaws({
			dotfile: "prefer=local\n",
			config: "prefer=cloud\n",
		});
		expect(r.state).toBe("dotfile-wins");
		if (r.state !== "dotfile-wins") return;
		expect(r.effective).toBe("prefer=local\n");
		expect(r.configEntry).toBe("prefer=local\n");
	});

	test("(c) no dotfile + config → config governs", () => {
		const r = reconcileRepoLaws({ dotfile: null, config: "prefer=cloud\n" });
		expect(r.state).toBe("config-governs");
		if (r.state !== "config-governs") return;
		expect(r.effective).toBe("prefer=cloud\n");
		expect(r.configEntry).toBeNull();
	});

	test("(d) neither → defaults", () => {
		const r = reconcileRepoLaws({ dotfile: null, config: null });
		expect(r.state).toBe("defaults");
		expect(r.effective).toBeNull();
	});
});

describe("user plane (BYO-LLM)", () => {
	test("valid entries validate; key-material fields hard-refused", () => {
		expect(
			validateUserPlaneEntry({
				name: "my-zai",
				base: "https://api.example.net/v1",
				model: "glm-5.3",
				key_name: "zai-personal",
				roles: ["reasoning"],
			}),
		).toBeNull();
		for (const field of ["api_key", "key", "token"]) {
			const e: Record<string, unknown> = {
				name: "leak",
				base: "https://api.example.net/v1",
				model: "m",
			};
			e[field] = "sk-never-in-config";
			expect(validateUserPlaneEntry(e)).toContain("key MATERIAL");
		}
	});

	test("readUserPlane stamps plane:user and drops invalid entries loudly", () => {
		const home = join(TMP, "byo");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "local-models.json"),
			JSON.stringify([
				{
					name: "eleven",
					base: "https://api.example.net/v1",
					model: "eleven-tts",
					key_name: "eleven-key",
				},
				{ name: "bad", base: "not-a-url" },
			]),
		);
		const r = readUserPlane({ ...ENV, BUCKLE_SECRETS_HOME: home });
		expect(r.errors).toEqual(["entry[1]: base: not a URL: 'not-a-url'"]);
		expect(r.entries).toEqual([
			{
				name: "eleven",
				base: "https://api.example.net/v1",
				model: "eleven-tts",
				key_name: "eleven-key",
				plane: "user",
			},
		]);
	});

	test("writeUserPlane: validates all-then-writes; key value refused", () => {
		const home = join(TMP, "byo-write");
		const env = { ...ENV, BUCKLE_SECRETS_HOME: home };
		const good = {
			name: "zai",
			base: "https://api.example.net/v1",
			model: "glm-5.3",
		};
		const w = writeUserPlane([good], env);
		expect(w).toEqual({ ok: true, wrote: 1 });
		expect(readUserPlane(env).entries).toHaveLength(1);
		const bad = writeUserPlane(
			[
				{
					name: "leak",
					base: "https://x.example.net/v1",
					model: "m",
					api_key: "sk-no",
				},
			],
			env,
		);
		expect(bad).toEqual({
			ok: false,
			why: "entry[0]: entry 'leak': field 'api_key' carries key MATERIAL — keys live in the secrets home by NAME (key_name), never in config",
		});
		// the good write survived — atomic validate-all-then-write
		expect(readUserPlane(env).entries).toHaveLength(1);
	});
});

describe("user key law (mode 600, by NAME)", () => {
	test("missing key file → honest refusal", () => {
		const r = readUserKey("no-such-key", ENV);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.why).toContain("no key file");
		expect(r.why).toContain("mode 600");
	});

	test("wrong mode → refused with the actual mode named", () => {
		const home = join(TMP, "keylaw");
		const env = { ...ENV, BUCKLE_SECRETS_HOME: home };
		mkdirSync(join(home, "keys"), { recursive: true });
		const p = userKeyPath("loose", env);
		writeFileSync(p, "sk-loose", { mode: 0o644 });
		const r = readUserKey("loose", env);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.why).toContain("must be mode 600");
		expect(r.why).toContain("644");
	});

	test("mode 600 key reads fine", () => {
		const home = join(TMP, "keylaw-ok");
		const env = { ...ENV, BUCKLE_SECRETS_HOME: home };
		mkdirSync(join(home, "keys"), { recursive: true });
		writeFileSync(userKeyPath("tight", env), "sk-tight\n", { mode: 0o600 });
		expect(readUserKey("tight", env)).toEqual({ ok: true, key: "sk-tight" });
	});
});
