import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildDecision,
	normalizeCline,
	resolveClineSid,
} from "../hooks/dialects/cline/lib.ts";

const HOME = join(process.cwd(), ".tmp-w296-cline-home");
const REPO = join(process.cwd(), ".tmp-w296-cline-repo");
mkdirSync(join(REPO, ".fleet"), { recursive: true });
mkdirSync(HOME, { recursive: true });

const WIRE = join(
	import.meta.dir,
	"..",
	"hooks",
	"dialects",
	"cline",
	"wire.ts",
);
const GATE_MOD = join(
	import.meta.dir,
	"..",
	"hooks",
	"dialects",
	"cline",
	"gate.ts",
);

function runBun(
	args: string[],
	input: unknown,
	extra: Record<string, string> = {},
) {
	const payloadFile = join(
		REPO,
		`cline-payload-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
	);
	writeFileSync(
		payloadFile,
		typeof input === "string" ? input : JSON.stringify(input),
	);
	const proc = Bun.spawnSync(["bun", ...args], {
		cwd: REPO,
		env: {
			...(process.env as Record<string, string>),
			HOME,
			...extra,
		},
		stdin: Bun.file(payloadFile),
		stdout: "pipe",
		stderr: "pipe",
	});
	rmSync(payloadFile, { force: true });
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function runGate(
	mode: string,
	input: unknown,
	extra: Record<string, string> = {},
) {
	const script = `const { clineGate } = await import(${JSON.stringify(GATE_MOD)}); const input = JSON.parse(await new Response(Bun.stdin).text()); await clineGate(${JSON.stringify(mode)}, input);`;
	return runBun(["-e", script], input, extra);
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("normalizeCline", () => {
	test("maps run_commands to bash", () => {
		const n = normalizeCline(
			{
				workspaceRoots: [REPO],
				tool_call: { name: "run_commands", input: { command: "rg -n foo ." } },
			},
			"pre-tool",
		);
		expect(n.gate).toBe("pre-bash");
		expect(n.hook.tool_name).toBe("Bash");
		expect((n.hook.tool_input as Record<string, unknown>).command).toBe(
			"rg -n foo .",
		);
	});

	test("maps read_files to read with limit signal", () => {
		const n = normalizeCline(
			{
				workspaceRoots: [REPO],
				tool_call: {
					name: "read_files",
					input: { file_paths: [{ path: "src/a.ts" }], end_line: 20 },
				},
			},
			"pre-tool",
		);
		expect(n.gate).toBe("pre-read");
		expect(n.hook.tool_name).toBe("Read");
		expect((n.hook.tool_input as Record<string, unknown>).file_path).toBe(
			"src/a.ts",
		);
		expect((n.hook.tool_input as Record<string, unknown>).limit).toBe(20);
	});

	test("maps editor old/new payloads to pre-files", () => {
		const n = normalizeCline(
			{
				workspaceRoots: [REPO],
				tool_call: {
					name: "editor",
					input: { path: "src/a.ts", old_text: "old", new_text: "new" },
				},
			},
			"pre-tool",
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

	test("maps apply_patch payloads by parsing patch headers", () => {
		const n = normalizeCline(
			{
				workspaceRoots: [REPO],
				tool_call: {
					name: "apply_patch",
					input:
						"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
				},
			},
			"pre-tool",
		);
		expect(n.gate).toBe("pre-files");
		expect((n.hook.tool_input as Record<string, unknown>).file_path).toBe(
			"src/a.ts",
		);
	});
});

describe("buildDecision", () => {
	test("ask becomes review", () => {
		const d = buildDecision("ask", "pre-tool", "review this edit");
		expect(JSON.parse(d.stdout ?? "{}")).toEqual({
			review: true,
			contextModification: "review this edit",
		});
	});

	test("feedback cancels with error message", () => {
		const d = buildDecision("feedback", "post-tool", "fix formatting");
		expect(JSON.parse(d.stdout ?? "{}")).toEqual({
			cancel: true,
			errorMessage: "fix formatting",
		});
	});
});

describe("resolveClineSid", () => {
	test("falls back to the session's own task id", () => {
		const r = resolveClineSid(REPO, {
			taskId: "conv-1",
			parent_agent_id: null,
		});
		expect(r).toEqual({ sid: "conv-1", source: "own" });
	});
});

describe("gate-wire-cline", () => {
	const CLI = join(HOME, "cline-hooks");
	const VSCODE = join(HOME, "documents-hooks");

	test("preserves user hook and writes managed wrappers", () => {
		mkdirSync(CLI, { recursive: true });
		writeFileSync(
			join(CLI, "PreToolUse.sh"),
			"#!/usr/bin/env bash\necho '{}'\n",
			{
				mode: 0o755,
			},
		);
		const r1 = runBun([WIRE], "", {
			SUSPENDERS_CLINE_HOOKS_DIR: CLI,
			SUSPENDERS_CLINE_VSCODE_HOOKS_DIR: VSCODE,
			SUSPENDERS_CLINE_SCOPE: "both",
		});
		expect(r1.code).toBe(0);
		expect(readFileSync(join(CLI, "PreToolUse"), "utf8")).toContain(
			"gate.ts cline pre-tool",
		);
		expect(
			readFileSync(
				join(CLI, ".suspenders-preserved", "PreToolUse", "PreToolUse.sh"),
				"utf8",
			),
		).toContain("echo '{}'");
		const r2 = runBun([WIRE, "--check", "--scope=both"], "", {
			SUSPENDERS_CLINE_HOOKS_DIR: CLI,
			SUSPENDERS_CLINE_VSCODE_HOOKS_DIR: VSCODE,
		});
		expect(r2.code).toBe(0);
	});
});

describe("cline gate integration", () => {
	test("session start registers the resolved sid in governor.db", () => {
		const r = runGate(
			"task-start",
			{ taskId: "conv-start", workspaceRoots: [REPO], parent_agent_id: null },
			{ SUSPENDERS_SID: "autow-cline" },
		);
		expect(r.code).toBe(0);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		const row = db
			.query("SELECT sid, state FROM sessions WHERE sid = 'autow-cline'")
			.get() as { sid: string; state: string } | null;
		db.close();
		expect(row?.sid).toBe("autow-cline");
	});

	test("pre-tool editor payload surfaces governor lease deny", () => {
		runGate(
			"task-start",
			{ taskId: "conv-lease", workspaceRoots: [REPO], parent_agent_id: null },
			{ SUSPENDERS_SID: "autow-seed" },
		);
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.query(
			"INSERT OR REPLACE INTO locks (path, sid, tool, ts, hash) VALUES (?, ?, ?, ?, ?)",
		).run(join(REPO, "leased.ts"), "autow-other", "Write", Date.now(), "x");
		db.close();
		const r = runGate(
			"pre-tool",
			{
				taskId: "conv-lease",
				workspaceRoots: [REPO],
				parent_agent_id: null,
				tool_call: {
					name: "editor",
					input: { path: "leased.ts", old_text: "a", new_text: "b" },
				},
			},
			{ SUSPENDERS_SID: "autow-mine" },
		);
		expect(JSON.parse(r.out)).toMatchObject({
			cancel: true,
			errorMessage: expect.stringContaining("leased to another agent"),
		});
	});
});
