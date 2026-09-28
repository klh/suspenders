// harvest.test.ts — W77: the fleet curriculum harvester. Covers the lib
// (classification, claude/codex row parsing with command enrichment,
// clustering) and an end-to-end run against a temp HOME + scratch repo with
// synthetic lane transcripts: kb rows + HARVEST event + cursors land,
// a second run is idempotent, scan writes nothing, foreign codex rollouts
// (desktop app) are never harvested.
import { describe, expect, test, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classify,
	clusterSignals,
	discoverTranscripts,
	mungePath,
	newClaudeState,
	parseClaudeRow,
	parseCodexRow,
	type Signal,
} from "../hooks/lib/harvest.ts";

const after: string[] = [];
afterAll(() => {
	for (const d of after) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "w77-harvest-"));
	after.push(d);
	return d;
};

describe("classify", () => {
	test("permission denial with path → tool + path shape", () => {
		const r = classify(
			"Claude requested permissions to read from /Volumes/Sensitive/github/klh/suspenders/.fleet/brief-autow77.md, but you haven't granted it yet.",
		);
		expect(r.kind).toBe("permission-denial");
		expect(r.subject).toContain("brief-autow#.md");
	});

	test("sandbox block names the tool + path", () => {
		const r = classify(
			"cat in '/x/.fleet/brief-autow66.md' was blocked. For security, Claude Code may only concatenate files from the allowed working directories.",
		);
		expect(r.kind).toBe("permission-denial");
		expect(r.subject).toContain("cat");
		expect(r.subject).toContain("brief-autow#.md");
	});

	test("gate marker → gate-denial with marker subject", () => {
		const r = classify(
			"STOP-GATE: not done yet — fix these before claiming completion:\nunmerged: f.ts",
		);
		expect(r.kind).toBe("gate-denial");
		expect(r.subject).toContain("STOP-GATE");
	});

	test("command failure classified + normalized", () => {
		const r = classify("Exit code 1\n(evals): nope");
		expect(r.kind).toBe("command-fail");
		expect(r.subject).toBe("Exit code 1");
	});
});

describe("row parsers", () => {
	test("claude: tool_result error joins its Bash command", () => {
		const state = newClaudeState();
		parseClaudeRow(state, {
			type: "assistant",
			timestamp: "2026-09-28T21:00:00.000Z",
			message: {
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Bash",
						input: { command: "bun test test/harvest.test.ts" },
					},
				],
			},
		});
		const sig = parseClaudeRow(state, {
			type: "user",
			timestamp: "2026-09-28T21:00:05.000Z",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						is_error: true,
						content: "Exit code 1\nerror: no tests found",
					},
				],
			},
		});
		expect(sig?.kind).toBe("command-fail");
		expect(sig?.subject).toBe("cmd: bun test test/harvest.test.ts");
		expect(sig?.detail).toContain("Exit code 1");
	});

	test("codex: exit_code in exec output → command-fail", () => {
		parseCodexRow(
			{
				timestamp: "2026-09-28T21:00:00.000Z",
				type: "response_item",
				payload: {
					type: "custom_tool_call",
					call_id: "c1",
					input: 'text(await tools.exec_command({cmd:"qlty check -a"}))',
				},
			},
			"W98",
		);
		const sig = parseCodexRow(
			{
				timestamp: "2026-09-28T21:00:05.000Z",
				type: "response_item",
				payload: {
					type: "custom_tool_call_output",
					call_id: "c1",
					output: [
						{
							type: "input_text",
							text: 'Script completed\nOutput:\n{"exit_code":2,"output":"ISSUES: 3"}',
						},
					],
				},
			},
			"W98",
		);
		expect(sig?.kind).toBe("command-fail");
		expect(sig?.subject).toContain("qlty check");
	});
});

describe("cluster", () => {
	test("same mistake in two lanes → one cluster, two items", () => {
		const s = (item: string, detail: string): Signal => ({
			kind: "permission-denial",
			subject: "Read brief-autow#.md",
			detail,
			backend: "claude",
			item,
			ts: 1,
		});
		const clusters = clusterSignals([
			s("W66", "denied"),
			s("W68", "denied harder"),
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0]?.count).toBe(2);
		expect(clusters[0]?.items.sort()).toEqual(["W66", "W68"]);
		expect(clusters[0]?.detail).toBe("denied harder");
	});
});

describe("discovery", () => {
	test("claude worktree dirs in; foreign codex rollouts out", async () => {
		const home = tmp();
		const repo = tmp();
		mkdirSync(join(repo, ".git"), { recursive: true });
		const laneDir = join(
			home,
			".claude",
			"projects",
			`${mungePath(`${repo}/.worktrees/W91`)}`,
		);
		mkdirSync(laneDir, { recursive: true });
		writeFileSync(join(laneDir, "s1.jsonl"), "{}\n");
		const day = join(home, ".codex", "sessions", "2026", "09", "28");
		mkdirSync(day, { recursive: true });
		const meta = (cwd: string): string =>
			`${JSON.stringify({ timestamp: "2026-09-28T21:00:00.000Z", type: "session_meta", payload: { cwd } })}\n`;
		writeFileSync(
			join(day, "rollout-ours.jsonl"),
			meta(`${repo}/.worktrees/W92`),
		);
		writeFileSync(
			join(day, "rollout-foreign.jsonl"),
			meta("/elsewhere/desktop"),
		);
		const refs = await discoverTranscripts(repo, home, 7);
		expect(refs.some((r) => r.backend === "claude" && r.item === "W91")).toBe(
			true,
		);
		expect(refs.some((r) => r.backend === "codex" && r.item === "W92")).toBe(
			true,
		);
		expect(refs.some((r) => r.path.includes("foreign"))).toBe(false);
	});
});

describe("end-to-end", () => {
	const laneRow = (repo: string, item: string): string =>
		`${JSON.stringify({
			type: "user",
			timestamp: "2026-09-28T21:00:00.000Z",
			cwd: `${repo}/.worktrees/${item}`,
			message: {
				content: [
					{
						type: "tool_result",
						is_error: true,
						content: `Claude requested permissions to read from ${repo}/.fleet/brief-autow${item.slice(1)}.md, but you haven't granted it yet.`,
					},
				],
			},
		})}\n`;

	const spawnHarvest = (
		mode: string,
		home: string,
		repo: string,
	): { out: string; code: number | null } => {
		const p = Bun.spawnSync(
			[
				"bun",
				join(import.meta.dir, "..", "hooks", "bin", "harvest.ts"),
				mode,
				"--repo",
				repo,
			],
			{
				env: { ...process.env, HOME: home },
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return { out: p.stdout.toString(), code: p.exitCode };
	};

	test("run: kb rows + event + cursors; rerun idempotent; scan writes nothing", async () => {
		const home = tmp();
		const repo = tmp();
		mkdirSync(join(repo, ".git"), { recursive: true });
		const laneDir = (item: string): string => {
			const d = join(
				home,
				".claude",
				"projects",
				`${mungePath(repo)}--worktrees-${item}`,
			);
			mkdirSync(d, { recursive: true });
			return d;
		};
		writeFileSync(join(laneDir("W81"), "s1.jsonl"), laneRow(repo, "W81"));
		writeFileSync(join(laneDir("W82"), "s1.jsonl"), laneRow(repo, "W82"));
		const day = join(home, ".codex", "sessions", "2026", "09", "28");
		mkdirSync(day, { recursive: true });
		const fixtureLine = (payload: object): string =>
			`${JSON.stringify(payload)}\n`;
		writeFileSync(
			join(day, "rollout-w83.jsonl"),
			fixtureLine({
				timestamp: "2026-09-28T21:00:00.000Z",
				type: "session_meta",
				payload: { cwd: `${repo}/.worktrees/W83` },
			}) +
				fixtureLine({
					timestamp: "2026-09-28T21:00:01.000Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call",
						call_id: "c1",
						input: "bun test",
					},
				}) +
				fixtureLine({
					timestamp: "2026-09-28T21:00:02.000Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "c1",
						output: [
							{ type: "input_text", text: '{"exit_code":1,"output":"boom"}' },
						],
					},
				}),
		);
		// two lanes share the brief-read denial; the codex lane adds its own
		// command-fail → two clusters, two kb rows
		const first = spawnHarvest("run", home, repo);
		expect(first.code).toBe(0);
		expect(first.out).toContain("2 new kb rows");
		expect(first.out).toContain("lesson candidates");
		expect(first.out).toContain("(lanes W81, W82)");
		const dbPath = `${home}/.cache/claude-governor/governor.db`;
		const kb = new Database(dbPath, { readonly: true });
		const count = (q: string): number => (kb.query(q).get() as { n: number }).n;
		expect(count("SELECT COUNT(*) AS n FROM consult_kb")).toBe(2);
		expect(
			count("SELECT COUNT(*) AS n FROM events WHERE kind = 'HARVEST'"),
		).toBe(1);
		expect(
			count(
				"SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'harvest.cursor.%'",
			),
		).toBe(3); // two claude files + one codex rollout
		// rerun: nothing new, cluster already known
		const second = spawnHarvest("run", home, repo);
		expect(second.out).toContain("0 new kb rows");
		expect(second.out).toContain("2 already known");
		// scan previews without writing anything
		const scan = spawnHarvest("scan", home, repo);
		expect(scan.out).toContain("scan — nothing written");
		expect(count("SELECT COUNT(*) AS n FROM consult_kb")).toBe(2); // unchanged
		expect(
			count("SELECT COUNT(*) AS n FROM events WHERE kind = 'HARVEST'"),
		).toBe(1); // unchanged
	});
});
