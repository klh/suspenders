// test/hook-adapter-copilot.test.ts — W296: the Copilot CLI hook adapter
// (the fix for the original bug: a manually-started Copilot CLI session was
// invisible to the fleet's coordination bus). Covers schema validation, the
// two translations (payload in / decision out), the identity invariant
// (ALWAYS register — never skip, unlike codex's unresolved-skip policy),
// the emitter's merge-not-clobber + matcher-scoped contract, and
// integration teeth through the real gate.ts copilot entrypoint.
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
	buildCopilotDecision,
	resolveCopilotSid,
	normalizeCopilotTool,
	normalizeCopilotSession,
	normalizeCopilotSessionEnd,
} from "../hooks/dialects/copilot/lib.ts";
import {
	CopilotSessionStartSchema,
	CopilotPreToolUseSchema,
} from "../hooks/dialects/copilot/schemas.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w296-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w296-repo-"));
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
	"copilot",
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

// ---- schema validation (degrade-honest, never throw) ----

describe("copilot schemas", () => {
	test("SessionStart accepts VS-Code-compatible snake_case payload", () => {
		const r = CopilotSessionStartSchema.safeParse({
			hook_event_name: "SessionStart",
			session_id: "abc123",
			cwd: "/tmp/x",
			source: "resume",
		});
		expect(r.success).toBe(true);
	});

	test("SessionStart rejects a missing session_id (degrade, never throw)", () => {
		const r = CopilotSessionStartSchema.safeParse({ cwd: "/tmp/x" });
		expect(r.success).toBe(false);
	});

	test("PreToolUse accepts unknown tool_input shapes (narrowed per-tool later)", () => {
		const r = CopilotPreToolUseSchema.safeParse({
			session_id: "abc",
			tool_name: "Bash",
			tool_input: { command: "ls", anythingElse: 1 },
		});
		expect(r.success).toBe(true);
	});
});

// ---- payload normalization (copilot → HookInput) ----

describe("normalizeCopilotTool", () => {
	test("Bash tool rides command through", () => {
		const h = normalizeCopilotTool(
			{ tool_name: "Bash", tool_input: { command: "rg -n foo ." }, cwd: REPO },
			"pre-bash",
		);
		expect(h.tool_name).toBe("Bash");
		expect((h.tool_input as Record<string, unknown>).command).toBe(
			"rg -n foo .",
		);
	});

	test("Edit tool maps inferred copilot field names to Claude's", () => {
		const h = normalizeCopilotTool(
			{
				tool_name: "Edit",
				tool_input: { path: "src/a.ts", old_str: "old", new_str: "new" },
				cwd: REPO,
			},
			"pre-files",
		);
		expect(h.tool_name).toBe("Edit");
		expect((h.tool_input as Record<string, unknown>).file_path).toBe(
			"src/a.ts",
		);
		expect((h.tool_input as Record<string, unknown>).old_string).toBe("old");
		expect((h.tool_input as Record<string, unknown>).new_string).toBe("new");
	});

	test("Edit tool also accepts Claude-shaped field names defensively", () => {
		const h = normalizeCopilotTool(
			{
				tool_name: "Edit",
				tool_input: {
					file_path: "src/b.ts",
					old_string: "o",
					new_string: "n",
				},
				cwd: REPO,
			},
			"pre-files",
		);
		expect((h.tool_input as Record<string, unknown>).file_path).toBe(
			"src/b.ts",
		);
	});

	test("Write tool maps file_text to content", () => {
		const h = normalizeCopilotTool(
			{
				tool_name: "Write",
				tool_input: { path: "new.ts", file_text: "hello" },
				cwd: REPO,
			},
			"pre-files",
		);
		expect(h.tool_name).toBe("Write");
		expect((h.tool_input as Record<string, unknown>).file_path).toBe("new.ts");
		expect((h.tool_input as Record<string, unknown>).content).toBe("hello");
	});

	test("Read tool maps path to file_path", () => {
		const h = normalizeCopilotTool(
			{ tool_name: "Read", tool_input: { path: "x.ts" }, cwd: REPO },
			"pre-read",
		);
		expect(h.tool_name).toBe("Read");
		expect((h.tool_input as Record<string, unknown>).file_path).toBe("x.ts");
	});

	test("unknown/native lowercase tool name still maps via the table", () => {
		const h = normalizeCopilotTool(
			{ tool_name: "bash", tool_input: { command: "echo hi" }, cwd: REPO },
			"pre-bash",
		);
		expect(h.tool_name).toBe("Bash");
	});
});

describe("session normalization", () => {
	test("resume source rides through as resume", () => {
		const n = normalizeCopilotSession({
			session_id: "s1",
			cwd: REPO,
			source: "resume",
		});
		expect(n.source).toBe("resume");
		expect(n.sessionId).toBe("s1");
	});

	test("new source rides through as startup (claude has no 'new')", () => {
		const n = normalizeCopilotSession({
			session_id: "s2",
			cwd: REPO,
			source: "new",
		});
		expect(n.source).toBe("startup");
	});

	test("malformed payload degrades to empty sessionId, never throws", () => {
		const n = normalizeCopilotSession({ garbage: true });
		expect(n.sessionId).toBe("");
	});

	test("session end extracts session_id", () => {
		expect(normalizeCopilotSessionEnd({ session_id: "s3" })).toBe("s3");
		expect(normalizeCopilotSessionEnd({})).toBe("");
	});
});

// ---- output translation (the teeth — flat JSON, no hookSpecificOutput) ----

describe("buildCopilotDecision translation table", () => {
	test("allow is empty control JSON", () => {
		expect(buildCopilotDecision("allow", "PreToolUse", "")).toEqual({
			stdout: "{}",
			exit: 0,
		});
	});

	test("deny: flat permissionDecision, no hookSpecificOutput wrapper", () => {
		const d = buildCopilotDecision("deny", "PreToolUse", "lease held");
		const parsed = JSON.parse(d.stdout ?? "{}") as Record<string, string>;
		expect(parsed.permissionDecision).toBe("deny");
		expect(parsed.permissionDecisionReason).toContain("lease held");
		expect(parsed.hookSpecificOutput).toBeUndefined();
		expect(d.exit).toBe(0);
	});

	test("ask is natively supported (never degrades to deny, unlike codex)", () => {
		const d = buildCopilotDecision("ask", "PreToolUse", "confirm this");
		const parsed = JSON.parse(d.stdout ?? "{}") as Record<string, string>;
		expect(parsed.permissionDecision).toBe("ask");
		expect(parsed.permissionDecisionReason).toContain("confirm this");
	});

	test("context emits flat additionalContext on SessionStart", () => {
		const d = buildCopilotDecision("context", "SessionStart", "SESSION x");
		const parsed = JSON.parse(d.stdout ?? "{}") as Record<string, string>;
		expect(parsed.additionalContext).toBe("SESSION x");
	});

	test("feedback emits additionalContext, never a hard block", () => {
		const d = buildCopilotDecision("feedback", "Stop", "errors remain");
		const parsed = JSON.parse(d.stdout ?? "{}") as Record<string, string>;
		expect(parsed.additionalContext).toContain("errors remain");
		expect(d.exit).toBe(0);
	});
});

// ---- identity resolution (always register — the policy divergence from codex) ----

describe("resolveCopilotSid", () => {
	test("env wins", () => {
		process.env.SUSPENDERS_SID = "autowenv";
		try {
			expect(resolveCopilotSid(REPO, "own-id")).toEqual({
				sid: "autowenv",
				source: "env",
			});
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
			const r = resolveCopilotSid(REPO, "own-id");
			expect(r.source).toBe("lanes");
			expect(r.sid).toBe("autowpid");
		} finally {
			rmSync(join(REPO, ".fleet", "lanes.json"));
		}
	});

	test("unresolved falls back to the session's OWN id — never empty (the copilot divergence)", () => {
		const r = resolveCopilotSid(
			"/tmp/definitely-not-a-fleet-root-8f3k2",
			"copilot-session-xyz",
		);
		expect(r.source).toBe("own");
		expect(r.sid).toBe("copilot-session-xyz");
	});
});

// ---- wiring emitter (merge-not-clobber, matcher-scoped) ----

describe("gate-wire-copilot emitter", () => {
	const WIREPATH = join(HOME, "settings.json");

	test("merges matcher-scoped events, preserves user entries, idempotent", () => {
		writeFileSync(
			WIREPATH,
			JSON.stringify({
				allowedUrls: ["https://example.com"],
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [{ type: "command", command: "user-own-tool" }],
						},
					],
				},
			}),
		);
		const r1 = run([WIRE], "", { SUSPENDERS_COPILOT_SETTINGS: WIREPATH });
		expect(r1.code).toBe(0);
		const doc1 = JSON.parse(readFileSync(WIREPATH, "utf8")) as {
			allowedUrls?: string[];
			hooks: Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;
		};
		expect(doc1.allowedUrls).toEqual(["https://example.com"]);
		// PreToolUse gets 3 managed matcher entries (Bash/Edit|Write/Read) +
		// the one preserved user Bash entry = 4
		expect(doc1.hooks.PreToolUse).toHaveLength(4);
		const userBash = doc1.hooks.PreToolUse.find(
			(e) => e.hooks[0].command === "user-own-tool",
		);
		expect(userBash?.matcher).toBe("Bash");
		expect(Object.keys(doc1.hooks)).toContain("SessionEnd");
		expect(Object.keys(doc1.hooks)).toContain("Stop");
		const postEdit = doc1.hooks.PostToolUse.find(
			(e) => e.matcher === "Edit|Write",
		);
		expect(postEdit?.hooks[0].command).toContain("copilot post-files");

		const r2 = run([WIRE], "", { SUSPENDERS_COPILOT_SETTINGS: WIREPATH });
		expect(r2.out).toContain("already wired");
		const doc2 = JSON.parse(readFileSync(WIREPATH, "utf8")) as typeof doc1;
		expect(doc2.hooks.PreToolUse).toHaveLength(4); // no duplicate
	});

	test("--check exits 0 when wired, 1 when not", () => {
		const clean = join(HOME, "clean-settings.json");
		const wired = run([WIRE, "--check"], "", {
			SUSPENDERS_COPILOT_SETTINGS: WIREPATH,
		});
		expect(wired.code).toBe(0);
		const unwired = run([WIRE, "--check"], "", {
			SUSPENDERS_COPILOT_SETTINGS: clean,
		});
		expect(unwired.code).toBe(1);
	});
});

// ---- integration: the teeth through the real entrypoint ----

describe("gate.ts copilot integration", () => {
	test("pre-bash allow rides through as flat JSON (no hookSpecificOutput)", () => {
		const r = gate(["copilot", "pre-bash"], {
			tool_name: "Bash",
			tool_input: { command: "true" },
			cwd: REPO,
		});
		expect(r.out.trim()).toBe("{}");
		expect(r.code).toBe(0);
	});

	test("governor lease deny surfaces as flat copilot deny JSON", () => {
		gate(
			["copilot", "session"],
			{ session_id: "own-seed", cwd: REPO },
			{ SUSPENDERS_SID: "autow-seed" },
		);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.query(
			"INSERT OR REPLACE INTO locks (path, sid, tool, ts, hash) VALUES (?, ?, ?, ?, ?)",
		).run(join(REPO, "leased.ts"), "autow-other", "Write", Date.now(), "x");
		db.close();
		const r = gate(
			["copilot", "pre-files"],
			{
				tool_name: "Edit",
				tool_input: { path: "leased.ts", old_str: "a", new_str: "b" },
				cwd: REPO,
			},
			{ SUSPENDERS_SID: "autow-mine" },
		);
		const parsed = JSON.parse(r.out) as {
			permissionDecision: string;
			permissionDecisionReason: string;
		};
		expect(parsed.permissionDecision).toBe("deny");
		expect(parsed.permissionDecisionReason).toContain(
			"leased to another agent",
		);
	});

	test("copilot session registers the fleet sid in governor.db", () => {
		gate(
			["copilot", "session"],
			{ session_id: "own-xyz", cwd: REPO },
			{ SUSPENDERS_SID: "autow-sess" },
		);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		const row = db
			.query("SELECT sid, state FROM sessions WHERE sid = 'autow-sess'")
			.get() as { sid: string; state: string } | null;
		db.close();
		expect(row?.sid).toBe("autow-sess");
	});

	test("copilot session with NO fleet lane registers under its OWN session_id (the policy divergence from codex)", () => {
		gate(["copilot", "session"], {
			session_id: "manual-copilot-abc",
			cwd: REPO,
		});
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		const row = db
			.query("SELECT sid FROM sessions WHERE sid = 'manual-copilot-abc'")
			.get() as { sid: string } | null;
		db.close();
		expect(row?.sid).toBe("manual-copilot-abc");
	});
});
