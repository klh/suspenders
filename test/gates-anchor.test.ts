// test/gates-anchor.test.ts — W110 anchor-existence gate.
//   1. pure: anchorHint classification (exact / ambiguous / whitespace / regex
//      / fuzzy / none) and the deny messages
//   2. gate-level: real `bun hooks/gate.ts pre-files` spawns — the deny fires
//      BEFORE the harness would fail with "string not found"
// Fixtures: mkdtemp under cwd (NOT /tmp — the governor exempts /tmp paths);
// unique path per test, written BEFORE the spawn (raw fs writes take no lease).
import { describe, test, expect, afterAll } from "bun:test";
import { anchorDenyReason, anchorHint } from "../hooks/gates/anchor.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmp = mkdtempSync(join(process.cwd(), ".anchor-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let fixtureN = 0;
function fixture(content: string, ext = ".ts"): string {
	const f = join(
		tmp,
		`ax-${++fixtureN}-${Math.random().toString(36).slice(2, 8)}${ext}`,
	);
	writeFileSync(f, content);
	return f;
}

const SID = "anchor-test-lane";
const hook = (input: Record<string, unknown>) => ({
	tool_name: "Edit",
	tool_input: input,
	cwd: process.cwd(),
	session_id: SID,
});

function spawnGate(payload: unknown) {
	const pf = join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "pre-files"],
		{
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
			cwd: import.meta.dir,
		},
	);
	rmSync(pf);
	let json: {
		hookSpecificOutput?: {
			permissionDecision?: string;
			permissionDecisionReason?: string;
		};
	} | null = null;
	try {
		json = JSON.parse(r.stdout.toString());
	} catch {}
	return { code: r.exitCode, json };
}
const decision = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
const reason = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";

// ============================== pure: anchorHint ==============================

describe("anchorHint (pure classification)", () => {
	const TEXT = [
		"import { x } from './x.ts';",
		"export const alpha = 1;",
		"export const beta = alpha + 1;",
		"",
	].join("\n");

	test("exact single hit → ok", () => {
		const h = anchorHint(TEXT, "export const alpha = 1;", false);
		expect(h.kind).toBe("ok");
	});

	test("two hits without replace_all → ambiguous, first line reported", () => {
		const h = anchorHint(TEXT, "alpha", false);
		expect(h.kind).toBe("ambiguous");
		if (h.kind === "ambiguous") {
			expect(h.count).toBe(2); // the alpha line + 'alpha + 1'
			expect(h.line).toBe(2); // first occurrence
		}
	});

	test("two hits with replace_all → ok", () => {
		expect(anchorHint(TEXT, "alpha", true).kind).toBe("ok");
	});

	test("indentation drift → whitespace hit with the right line", () => {
		const h = anchorHint(
			"function f() {\n\t\treturn 1;\n}\n",
			"    return 1;",
			false,
		);
		expect(h.kind).toBe("whitespace");
		if (h.kind === "whitespace") expect(h.line).toBe(2);
	});

	test("CRLF file vs LF anchor → whitespace hit", () => {
		const h = anchorHint("alpha\r\nbeta\r\n", "alpha\nbeta", false);
		expect(h.kind).toBe("whitespace");
	});

	test("regex-ish anchor (\\d+) that only matches as a pattern → regex", () => {
		const h = anchorHint("const id = 42;\n", "id = \\d+;", false);
		expect(h.kind).toBe("regex");
		if (h.kind === "regex") expect(h.line).toBe(1);
	});

	test("near-miss identifier → fuzzy with the right line", () => {
		const h = anchorHint(
			"const value = computeTotal(input);\n",
			"const val = computeTotal(input);\n",
			false,
		);
		expect(h.kind).toBe("fuzzy");
		if (h.kind === "fuzzy") {
			expect(h.line).toBe(1);
			expect(h.score).toBeGreaterThan(0.7);
		}
	});

	test("unrelated anchor → none", () => {
		expect(anchorHint(TEXT, "zzqqxx wubbo blorp", false).kind).toBe("none");
	});

	test("empty anchor → ok (never our question)", () => {
		expect(anchorHint(TEXT, "", false).kind).toBe("ok");
	});

	test("unicode survives classification", () => {
		const line = "const æblegrød = '🚀 apples';\n";
		expect(anchorHint(line, "æblegrød = '🚀", false).kind).toBe("ok");
		const typo = anchorHint(line, "const æblegrød = '🍎 apples';", false);
		expect(typo.kind === "fuzzy" || typo.kind === "none").toBe(true);
	});
});

describe("anchorDenyReason (message shape)", () => {
	test("ok → null", () => {
		expect(anchorDenyReason({ kind: "ok", count: 1 }, "/f.ts")).toBeNull();
	});

	test("ambiguous → replace_all guidance", () => {
		const m = anchorDenyReason(
			{ kind: "ambiguous", count: 2, line: 4, text: "alpha" },
			"/f.ts",
		);
		expect(m).toContain("replace_all");
		expect(m).toContain("line 4");
	});

	test("fuzzy → percent + line + window", () => {
		const m = anchorDenyReason(
			{ kind: "fuzzy", score: 0.82, line: 7, text: "const valeu = 1;" },
			"/f.ts",
		);
		expect(m).toContain("82% similar");
		expect(m).toContain("line 7");
		expect(m).toContain("const valeu = 1;");
	});

	test("none → generic stale-read advice", () => {
		const m = anchorDenyReason({ kind: "none" }, "/f.ts");
		expect(m).toContain("no close match");
		expect(m).toContain("anchor-gate:");
	});
});

// ============================== gate: pre-files spawns ==============================

describe("anchorGate — live pre-files spawns", () => {
	test("pre-files: Edit with a missing anchor → deny with nearest-match context", () => {
		const f = fixture("line1\nline2\nline3\n");
		const r = spawnGate(
			hook({
				file_path: f,
				old_string: "line2 = fixed;",
				new_string: "line2 = 2;",
			}),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("anchor-gate:");
		expect(reason(r)).toContain("line2");
	});

	test("pre-files: Edit with an exact anchor → allow (full chain)", () => {
		const f = fixture("export const x = 1;\n");
		const r = spawnGate(
			hook({
				file_path: f,
				old_string: "export const x = 1;",
				new_string: "export const x = 2;",
			}),
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: ambiguous anchor → deny mentioning replace_all", () => {
		const f = fixture("const dup = 1;\nconst other = dup;\n");
		const r = spawnGate(
			hook({
				file_path: f,
				old_string: "dup",
				new_string: "dup2",
			}),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("replace_all");
	});

	test("gate fires on Edit only: Write passes the anchor gate untouched", () => {
		const h = {
			tool_name: "Write",
			tool_input: {
				file_path: join(tmp, "w-never-created.ts"),
				content: "export const y = 1;\n",
				old_string: "this anchor is nowhere",
				new_string: "x",
			},
			cwd: process.cwd(),
			session_id: SID,
		};
		// in-process: must not deny (Write is not an Edit); deny() exits, so we
		// assert via the spawn layer instead of calling anchorGate directly.
		const r = spawnGate(h);
		expect(decision(r)).not.toBe("deny"); // phantom Write: governor/mutation exempt
	});

	test("anchorGate unit: missing file fails open (no deny, no throw)", () => {
		// anchorGate calls deny() which exits — run it in a child bun -e
		const script = `import { anchorGate } from ${JSON.stringify(join(import.meta.dir, "..", "hooks", "gates", "anchor.ts"))};
anchorGate({ tool_name: "Edit", tool_input: { file_path: ${JSON.stringify(join(tmp, "ghost-missing.ts"))}, old_string: "x", new_string: "y" } });
process.stdout.write("OPEN");`;
		const r = Bun.spawnSync(["bun", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(r.stdout.toString()).toBe("OPEN");
	});
});
