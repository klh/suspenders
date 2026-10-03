// test/hook-adapter-grok.test.ts - W296: the grok-cli hook adapter.
// Covers the two translations (payload in / decision out), the identity
// invariant (fleet sid on every governor row), the emitter's merge-not-
// clobber contract, and real entrypoint integration through a gate.ts fixture
// with the grok case injected but the tracked gate.ts file left untouched.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	buildDecision,
	resolveGrokSid,
	normalizeGrok,
} from "../hooks/dialects/grok/lib.ts";

const ROOT = join(process.cwd(), `.tmp-w296-grok-${process.pid}`);
const HOME = join(ROOT, "home");
const REPO = join(ROOT, "repo");
const GATE = join(
	import.meta.dir,
	"..",
	"hooks",
	`gate-grok-fixture-${process.pid}.ts`,
);
const WIRE = join(
	import.meta.dir,
	"..",
	"hooks",
	"dialects",
	"grok",
	"wire.ts",
);
const GROK_CASE = `	// biome-ignore lint/suspicious/noFallthroughSwitchClause: grokGate never resolves - await parks the case
	case "grok": {
		// W296 grok-cli adapter - dialect bound by argv (\`gate.ts grok <mode>\`):
		// payload normalization + decision translation + fleet sid resolution
		// live in gates/grok.ts + lib/grok.ts; gates keep zero grok knowledge.
		const { grokGate } = await import("./gates/grok.ts");
		await grokGate(process.argv[3] ?? "", hook as Record<string, unknown>);
	}
`;

mkdirSync(join(REPO, ".fleet"), { recursive: true });
mkdirSync(HOME, { recursive: true });
const gateSource = readFileSync(
	join(import.meta.dir, "..", "hooks", "gate.ts"),
	"utf8",
);
writeFileSync(
	GATE,
	gateSource.replace('	case "session": {', `${GROK_CASE}	case "session": {`),
);

const env = (): Record<string, string> => ({
	...(process.env as Record<string, string>),
	HOME,
});

afterAll(() => {
	rmSync(GATE, { force: true });
	rmSync(ROOT, { recursive: true, force: true });
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

const driftFile = () =>
	join(HOME, ".cache", "claude-governor", "grok-drift.jsonl");

describe("normalizeGrok", () => {
	const norm = (
		raw: Record<string, unknown>,
		tool: string,
		event = "PreToolUse",
	) => normalizeGrok(raw, tool, event);

	test("bash rides command-level as Bash", () => {
		const n = norm(
			{ tool_input: { command: "rg -n foo ." }, cwd: REPO },
			"bash",
		);
		expect(n.gate).toBe("pre-bash");
		expect(n.hook.tool_name).toBe("Bash");
		expect((n.hook.tool_input as Record<string, unknown>).command).toBe(
			"rg -n foo .",
		);
	});

	test("edit_file renames path to file_path and preserves diff strings", () => {
		const n = norm(
			{
				tool_input: {
					path: "src/a.ts",
					old_string: "old",
					new_string: "new",
				},
				cwd: REPO,
				hook_event_name: "PreToolUse",
			},
			"edit_file",
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

	test("write_file post-tool routes to post-files and preserves content", () => {
		const n = norm(
			{
				tool_input: { path: "src/b.ts", content: "export const x = 1;\n" },
				cwd: REPO,
				hook_event_name: "PostToolUse",
			},
			"write_file",
			"PostToolUse",
		);
		expect(n.gate).toBe("post-files");
		expect(n.hook.tool_name).toBe("Write");
		expect((n.hook.tool_input as Record<string, unknown>).file_path).toBe(
			"src/b.ts",
		);
		expect((n.hook.tool_input as Record<string, unknown>).content).toBe(
			"export const x = 1;\n",
		);
	});

	test("read_file renames path and marks bounded line reads as limited", () => {
		const n = norm(
			{
				tool_input: { path: "README.md", startLine: 10, endLine: 25 },
				cwd: REPO,
			},
			"read_file",
		);
		expect(n.gate).toBe("pre-read");
		expect(n.hook.tool_name).toBe("Read");
		expect((n.hook.tool_input as Record<string, unknown>).file_path).toBe(
			"README.md",
		);
		expect((n.hook.tool_input as Record<string, unknown>).limit).toBe(16);
	});

	test("unknown tools fail open with an allow route", () => {
		const n = norm({ tool_input: { query: "foo" }, cwd: REPO }, "search_web");
		expect(n.gate).toBe("allow");
		expect(n.provenance).toBe("search_web");
	});
});

describe("buildDecision translation table", () => {
	test("allow is empty control JSON", () => {
		expect(buildDecision("allow", "PreToolUse", "")).toEqual({
			stdout: "{}",
			exit: 0,
		});
	});

	test("deny blocks with flat JSON and exit 2", () => {
		const d = buildDecision("deny", "PreToolUse", "lease held by autow5");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			decision: string;
			reason: string;
			stopReason: string;
		};
		expect(parsed.decision).toBe("block");
		expect(parsed.reason).toContain("autow5");
		expect(parsed.stopReason).toContain("autow5");
		expect(d.exit).toBe(2);
	});

	test("ask degrades to block and journals the downgrade", () => {
		const prevHome = process.env.HOME;
		process.env.HOME = HOME;
		try {
			const d = buildDecision("ask", "PreToolUse", "request access via coord");
			const parsed = JSON.parse(d.stdout ?? "{}") as {
				decision: string;
				reason: string;
			};
			expect(parsed.decision).toBe("block");
			expect(parsed.reason).toContain("request access");
			expect(d.exit).toBe(2);
			expect(existsSync(driftFile())).toBe(true);
			expect(readFileSync(driftFile(), "utf8")).toContain(
				"ask decision unsupported by grok-cli",
			);
		} finally {
			process.env.HOME = prevHome;
		}
	});

	test("context and nudge emit additionalContext", () => {
		const d = buildDecision("context", "SessionStart", "SESSION x OWNED 1");
		const parsed = JSON.parse(d.stdout ?? "{}") as {
			additionalContext: string;
		};
		expect(parsed.additionalContext).toContain("OWNED 1");
		expect(d.exit).toBe(0);
	});

	test("feedback blocks Stop and nudges PostToolUse", () => {
		const stop = buildDecision("feedback", "Stop", "STOP-GATE: fix errors");
		const stopParsed = JSON.parse(stop.stdout ?? "{}") as {
			decision: string;
			stopReason: string;
		};
		expect(stopParsed.decision).toBe("block");
		expect(stopParsed.stopReason).toContain("STOP-GATE");
		expect(stop.exit).toBe(2);

		const post = buildDecision("feedback", "PostToolUse", "qlty-fmt: re-read");
		const postParsed = JSON.parse(post.stdout ?? "{}") as {
			additionalContext: string;
		};
		expect(postParsed.additionalContext).toContain("re-read");
		expect(post.exit).toBe(0);
	});
});

describe("resolveGrokSid", () => {
	test("env wins", () => {
		process.env.SUSPENDERS_SID = "autowenv";
		try {
			expect(resolveGrokSid(REPO)).toEqual({ sid: "autowenv", source: "env" });
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
					item: "W296",
					pid: process.pid,
					branch: "b",
					worktree: REPO,
				},
			]),
		);
		try {
			const r = resolveGrokSid(REPO);
			expect(r.source).toBe("lanes");
			expect(r.sid).toBe("autowpid");
		} finally {
			rmSync(join(REPO, ".fleet", "lanes.json"), { force: true });
		}
	});

	test("unresolved stays unresolved (caller fail-opens + journals)", () => {
		const r = resolveGrokSid(
			`/Volumes/Sensitive/github/klh/nonfleet-w296-${process.pid}`,
		);
		expect(r.source).toBe("unresolved");
		expect(r.sid).toBe("");
	});
});

describe("gate-wire-grok emitter", () => {
	const SETTINGS = join(HOME, "user-settings.json");

	test("merges seven entries, preserves user hooks, idempotent", () => {
		writeFileSync(
			SETTINGS,
			JSON.stringify({
				model: "grok-code",
				hooks: {
					PreToolUse: [
						{
							matcher: "user-tool",
							hooks: [{ type: "command", command: "user-own-tool" }],
						},
					],
				},
			}),
		);
		const r1 = run([WIRE], "", { SUSPENDERS_GROK_SETTINGS: SETTINGS });
		expect(r1.code).toBe(0);
		const doc1 = JSON.parse(readFileSync(SETTINGS, "utf8")) as {
			model?: string;
			hooks: Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;
		};
		expect(doc1.model).toBe("grok-code");
		expect(doc1.hooks.PreToolUse).toHaveLength(4);
		expect(doc1.hooks.PreToolUse[0].hooks[0].command).toBe("user-own-tool");
		expect(
			doc1.hooks.PreToolUse.some(
				(entry) => entry.matcher === "edit_file|write_file",
			),
		).toBe(true);
		expect(Object.keys(doc1.hooks)).toContain("SessionEnd");

		const r2 = run([WIRE], "", { SUSPENDERS_GROK_SETTINGS: SETTINGS });
		expect(r2.out).toContain("already wired");
		const doc2 = JSON.parse(readFileSync(SETTINGS, "utf8")) as typeof doc1;
		expect(doc2.hooks.PreToolUse).toHaveLength(4);
	});

	test("--check exits 0 when wired, 1 when not", () => {
		const clean = join(HOME, "clean-settings.json");
		const wired = run([WIRE, "--check"], "", {
			SUSPENDERS_GROK_SETTINGS: SETTINGS,
		});
		expect(wired.code).toBe(0);
		const unwired = run([WIRE, "--check"], "", {
			SUSPENDERS_GROK_SETTINGS: clean,
		});
		expect(unwired.code).toBe(1);
	});
});

describe("gate.ts grok integration", () => {
	test("pre-bash allow rides through", () => {
		const r = gate(["grok", "pre-bash"], {
			hook_event_name: "PreToolUse",
			tool_name: "bash",
			tool_input: { command: "ls" },
			cwd: REPO,
		});
		const parsed = JSON.parse(r.out) as { decision?: string };
		expect(parsed.decision ?? "approve").toBe("approve");
		expect(r.code).toBe(0);
	});

	test("fat read deny surfaces as a grok block", () => {
		const target = join(REPO, "big.txt");
		writeFileSync(target, "x".repeat(41 * 1024));
		const r = gate(["grok", "pre-read"], {
			hook_event_name: "PreToolUse",
			tool_name: "read_file",
			tool_input: { path: target },
			cwd: REPO,
		});
		const parsed = JSON.parse(r.out) as { decision: string; reason: string };
		expect(parsed.decision).toBe("block");
		expect(parsed.reason).toContain("read-gate");
		expect(r.code).toBe(2);
	});

	test("governor lease deny surfaces as grok block JSON", () => {
		gate(["grok", "session"], { cwd: REPO }, { SUSPENDERS_SID: "autow-seed" });
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.query(
			"INSERT OR REPLACE INTO locks (path, sid, tool, ts, hash) VALUES (?, ?, ?, ?, ?)",
		).run(join(REPO, "leased.ts"), "autow-other", "Write", Date.now(), "x");
		db.close();
		const r = gate(
			["grok", "pre-files"],
			{
				hook_event_name: "PreToolUse",
				tool_name: "write_file",
				tool_input: { path: join(REPO, "leased.ts"), content: "b" },
				cwd: REPO,
			},
			{ SUSPENDERS_SID: "autow-mine" },
		);
		const parsed = JSON.parse(r.out) as { decision: string; reason: string };
		expect(parsed.decision).toBe("block");
		expect(parsed.reason).toContain("leased to another agent");
		expect(r.code).toBe(2);
	});

	test("session registers the fleet sid in governor.db", () => {
		gate(["grok", "session"], { cwd: REPO }, { SUSPENDERS_SID: "autow-sess" });
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		const row = db
			.query("SELECT sid, state FROM sessions WHERE sid = 'autow-sess'")
			.get() as { sid: string; state: string } | null;
		db.close();
		expect(row?.sid).toBe("autow-sess");
	});
});
