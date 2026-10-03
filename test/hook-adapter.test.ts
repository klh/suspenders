// test/hook-adapter.test.ts — W73: the codex hook adapter. Covers the two
// translations (payload in / decision out), the identity invariant (fleet
// sid on every governor row), the emitter's merge-not-clobber contract, and
// one integration tooth: a governor lease deny surfacing as codex decision
// JSON through the real gate.ts codex entrypoint.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	buildDecision,
	resolveCodexSid,
	normalizeCodex,
} from "../hooks/dialects/codex/lib.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w73-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w73-repo-"));
mkdirSync(join(REPO, ".fleet"), { recursive: true });
const env = (): Record<string, string> => ({
	...(process.env as Record<string, string>),
	HOME,
});
const GATE = join(import.meta.dir, "..", "hooks", "gate.ts");
const WIRE = join(
	import.meta.dir,
	"..",
	"hooks",
	"dialects",
	"codex",
	"wire.ts",
);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const run = (
	args: string[],
	input: unknown,
	extra: Record<string, string> = {},
) => {
	const pf = join(
		REPO,
		`payload-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(pf, typeof input === "string" ? input : JSON.stringify(input));
	const p = Bun.spawnSync(["bun", ...args], {
		cwd: REPO,
		env: { ...env(), ...extra },
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
	});
	rmSync(pf, { force: true });
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
};

const gate = (
	args: string[],
	input: unknown,
	extra: Record<string, string> = {},
) => run([GATE, ...args], input, extra);

// ---- payload normalization (codex → HookInput) ----

describe("normalizeCodex", () => {
	const norm = (raw: Record<string, unknown>, tool: string) =>
		normalizeCodex(raw, tool, "PreToolUse");

	test("shell tool rides command-level as Bash", () => {
		const n = norm(
			{ tool_input: { command: "rg -n foo ." }, cwd: REPO },
			"shell",
		);
		expect(n.gate).toBe("pre-bash");
		expect(n.hook.tool_name).toBe("Bash");
		expect((n.hook.tool_input as Record<string, unknown>).command).toBe(
			"rg -n foo .",
		);
	});

	test("apply_patch lifts the first file with old/new strings", () => {
		const n = norm(
			{
				tool_input: {
					command:
						"apply_patch <<EOF\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
				},
				cwd: REPO,
			},
			"apply_patch",
		);
		expect(n.gate).toBe("pre-files");
		expect(n.hook.tool_name).toBe("Edit");
		expect((n.hook.tool_input as Record<string, unknown>).file_path).toBe(
			"src/a.ts",
		);
		expect((n.hook.tool_input as Record<string, unknown>).old_string).toBe(
			"old",
		);
		expect((n.hook.tool_input as Record<string, unknown>).new_string).toBe(
			"new",
		);
	});

	test("unknown tool with no patch body falls back to command-style", () => {
		const n = norm(
			{ tool_input: { command: "echo hi" }, cwd: REPO },
			"mystery_tool",
		);
		expect(n.gate).toBe("pre-bash");
	});

	test("patch body under unknown tool name still routes pre-files", () => {
		const n = norm(
			{
				tool_input: { command: "*** Begin Patch\n*** Add File: b.txt\n+hi\n" },
				cwd: REPO,
			},
			"mystery_tool",
		);
		expect(n.gate).toBe("pre-files");
	});
});

// ---- output translation (the teeth) ----

describe("buildDecision translation table", () => {
	test("allow is empty control JSON", () => {
		expect(buildDecision("allow", "PreToolUse", "")).toEqual({
			stdout: "{}",
			exit: 0,
		});
	});

	test("deny requires reason, targets the codex event", () => {
		const d = buildDecision("deny", "PostToolUse", "lease held by autow5");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
			"autow5",
		);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
		expect(d.exit).toBe(0);
	});

	test("ask degrades to deny (never silently allow)", () => {
		const d = buildDecision(
			"ask",
			"PreToolUse",
			"governor: request access via coord",
		);
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
			"request access",
		);
	});

	test("ask without reason still yields non-empty reason", () => {
		const d = buildDecision("ask", "PreToolUse", "");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(
			parsed.hookSpecificOutput.permissionDecisionReason.length,
		).toBeGreaterThan(0);
	});

	test("context/nudge emit additionalContext", () => {
		const d = buildDecision("context", "SessionStart", "SESSION x  OWNED 1");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			hookSpecificOutput: Record<string, string>;
		};
		expect(parsed.hookSpecificOutput.additionalContext).toContain("OWNED 1");
		expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
	});

	test("feedback exits 2 with stderr (harness-cloned semantics)", () => {
		const d = buildDecision(
			"feedback",
			"Stop",
			"STOP-GATE: post-files errors remain",
		);
		expect(d.exit).toBe(2);
		expect(d.stderr).toContain("STOP-GATE");
	});
});

// ---- identity resolution (the correctness invariant) ----

describe("resolveCodexSid", () => {
	test("env wins", () => {
		process.env.SUSPENDERS_SID = "autowenv";
		try {
			expect(resolveCodexSid(REPO)).toEqual({ sid: "autowenv", source: "env" });
		} finally {
			delete process.env.SUSPENDERS_SID;
		}
	});

	test("lanes.json ppid-walk resolves the fleet sid", () => {
		writeFileSync(
			join(REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{
					sid: "autowpid",
					item: "W999",
					pid: process.pid,
					branch: "b",
					worktree: REPO,
				},
			]),
		);
		try {
			const r = resolveCodexSid(REPO);
			expect(r.source).toBe("lanes");
			expect(r.sid).toBe("autowpid");
		} finally {
			rmSync(join(REPO, ".fleet", "lanes.json"));
		}
	});

	test("unresolved stays unresolved (caller fail-opens + journals)", () => {
		const r = resolveCodexSid("/tmp/definitely-not-a-fleet-root-8f3k2");
		expect(r.source).toBe("unresolved");
		expect(r.sid).toBe("");
	});
});

// ---- wiring emitter (merge-not-clobber) ----

describe("gate-wire-codex emitter", () => {
	const WIREPATH = join(HOME, "hooks.json");

	test("merges five events, preserves user entries, idempotent", () => {
		writeFileSync(
			WIREPATH,
			JSON.stringify({
				model: "gpt-5",
				hooks: {
					PreToolUse: [
						{ hooks: [{ type: "command", command: "user-own-tool" }] },
					],
				},
			}),
		);
		const r1 = run([WIRE], "", { SUSPENDERS_CODEX_HOOKS: WIREPATH });
		expect(r1.code).toBe(0);
		const doc1 = JSON.parse(readFileSync(WIREPATH, "utf8")) as {
			model?: string;
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		expect(doc1.model).toBe("gpt-5");
		expect(doc1.hooks.PreToolUse).toHaveLength(2);
		expect(doc1.hooks.PreToolUse[0].hooks[0].command).toBe("user-own-tool");
		expect(Object.keys(doc1.hooks)).toContain("SessionEnd");

		const r2 = run([WIRE], "", { SUSPENDERS_CODEX_HOOKS: WIREPATH });
		expect(r2.out).toContain("already wired");
		const doc2 = JSON.parse(readFileSync(WIREPATH, "utf8")) as typeof doc1;
		expect(doc2.hooks.PreToolUse).toHaveLength(2); // no duplicate
	});

	test("--check exits 0 when wired, 1 when not", () => {
		const clean = join(HOME, "clean.json");
		const wired = run([WIRE, "--check"], "", {
			SUSPENDERS_CODEX_HOOKS: WIREPATH,
		});
		expect(wired.code).toBe(0);
		const unwired = run([WIRE, "--check"], "", {
			SUSPENDERS_CODEX_HOOKS: clean,
		});
		expect(unwired.code).toBe(1);
	});
});

// ---- integration: the teeth through the real entrypoint ----

describe("gate.ts codex integration", () => {
	test("pre-tool shell allow rides through", () => {
		const r = gate(["codex", "pre-tool"], {
			tool_name: "shell",
			tool_input: { command: "ls" },
			cwd: REPO,
		});
		const parsed = JSON.parse(r.out) as {
			hookSpecificOutput?: { permissionDecision?: string };
		};
		expect(parsed.hookSpecificOutput?.permissionDecision ?? "allow").toBe(
			"allow",
		); // nudges ride additionalContext
		expect(r.code).toBe(0);
	});

	test("governor lease deny surfaces as codex deny JSON", () => {
		// materialize the registry first: a session gate creates dir + DB via
		// the real govdb migration, so the direct Database open below succeeds
		gate(["codex", "session"], { cwd: REPO }, { SUSPENDERS_SID: "autow-seed" });
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.query(
			"INSERT OR REPLACE INTO locks (path, sid, tool, ts, hash) VALUES (?, ?, ?, ?, ?)",
		).run(join(REPO, "leased.ts"), "autow-other", "Write", Date.now(), "x");
		db.close();
		const r = gate(
			["codex", "pre-tool"],
			{
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: leased.ts\n@@\n-a\n+b\n",
				},
				cwd: REPO,
			},
			{ SUSPENDERS_SID: "autow-mine" },
		);
		const parsed = JSON.parse(r.out) as {
			hookSpecificOutput: {
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
			"leased to another agent",
		);
	});

	test("codex session registers the fleet sid in governor.db", () => {
		gate(["codex", "session"], { cwd: REPO }, { SUSPENDERS_SID: "autow-sess" });
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		const row = db
			.query("SELECT sid, state FROM sessions WHERE sid = 'autow-sess'")
			.get() as {
			sid: string;
			state: string;
		} | null;
		db.close();
		expect(row?.sid).toBe("autow-sess");
	});
});
