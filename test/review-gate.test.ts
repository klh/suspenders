// test/review-gate.test.ts — W247: fresh-context reviewer gate before merge.
// Unit tests for the pure helpers + end-to-end runs of the gate script
// against a temp repo (work graph in a temp HOME, branches as REAL worktrees
// so scoped tests run branch-side) and a fake belt on 127.0.0.1 (SUSPENDERS_BELT_URL
// is the first resolver step, so the fake needs no discovery).
// The temp repo lives under process.cwd() (never /tmp — see work-cli.test.ts)
// and matches the `.gates-test-*` gitignore pattern.
import { describe, test, expect, afterAll, spyOn } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// temp HOME BEFORE the gate import: govdb resolves its registry path at
// module load, so fixture llm.call events must land in the temp registry,
// never the live one
const HOME = mkdtempSync(join(tmpdir(), "claude-review-gate-home-"));
process.env.HOME = HOME;
const REPO = mkdtempSync(join(process.cwd(), ".gates-test-review-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const { runGate, itemIdFromBranch, parseVerdict, collectDiff } = await import(
	"../hooks/bin/review-gate.ts"
);

const git = (repo: string, ...args: string[]): string => {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	return p.stdout.toString().trim();
};

git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "gate-test@local");
git(REPO, "config", "user.name", "gate test");
writeFileSync(join(REPO, "src.ts"), "export const base = 1;\n");
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "base");

// a second branch in a REGISTERED worktree — the gate runs scoped tests in
// the branch's own worktree, so bare checkouts are not enough
const wtFor = (branch: string): string => {
	const wt = join(REPO, `wt-${branch.replace(/\//g, "-")}`);
	git(REPO, "worktree", "add", "-q", "-b", branch, wt);
	return wt;
};

const work = (...args: string[]): string => {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], {
		cwd: REPO,
		env: { ...process.env, HOME },
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.stdout.toString();
};

const idOf = (out: string): string =>
	(out.match(/W\d+(?:\.\d+)*/) ?? [""])[0] ?? "";

const gate = async (
	branch: string,
	env: Record<string, string> = {},
): Promise<{ out: string; code: number }> => {
	const captured: string[] = [];
	const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		captured.push(a.join(" "));
	});
	const errSpy = spyOn(console, "error").mockImplementation(
		(...a: unknown[]) => {
			captured.push(a.join(" "));
		},
	);
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	try {
		const code = await runGate([
			"--repo",
			REPO,
			"--branch",
			branch,
			"--main",
			"main",
		]);
		return { out: captured.join("\n"), code };
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
		for (const k of Object.keys(env)) delete process.env[k];
	}
};

// fake belt: the review verdict is a scenario switch, requests are recorded
// so tests can assert exactly what the reviewer was shown
type Mode = "approve" | "changes" | "garbage";
let mode: Mode = "approve";
const hits: { system: string; user: string }[] = [];
const server = Bun.serve({
	port: 0,
	fetch: async (req) => {
		const body = (await req.json()) as {
			messages: { role: string; content: string }[];
		};
		hits.push({
			system: body.messages.find((m) => m.role === "system")?.content ?? "",
			user: body.messages.find((m) => m.role === "user")?.content ?? "",
		});
		let reply = "";
		if (mode === "approve")
			reply = "Looks correct and scoped.\n\nVERDICT: APPROVE";
		else if (mode === "changes")
			reply =
				"The diff misses the objective.\n\nVERDICT: REQUEST_CHANGES — does not implement the objective";
		else reply = "I have opinions but no verdict line.";
		return Response.json({
			reply,
			target: { model: "fake-gate", machine: "test" },
			ms: 3,
		});
	},
});
const BELT_URL = `http://127.0.0.1:${server.port}`;

const reviewsDir = join(REPO, ".fleet", "reviews");
const reviewFiles = (): string[] =>
	existsSync(reviewsDir) ? readdirSync(reviewsDir) : [];

afterAll(() => {
	server.stop(true);
	rmSync(REPO, { recursive: true, force: true });
	rmSync(HOME, { recursive: true, force: true });
});

describe("review-gate unit helpers", () => {
	test("itemIdFromBranch derives the work id from lane branches", async () => {
		expect(itemIdFromBranch("suspenders/W247")).toBe("W247");
		expect(itemIdFromBranch("parked/W9.1")).toBe("W9.1");
		expect(itemIdFromBranch("main")).toBe(null);
		expect(itemIdFromBranch("lane/tooling")).toBe(null);
	});

	test("parseVerdict takes the LAST verdict line, fail-closed on none", async () => {
		expect(
			parseVerdict("a\nVERDICT: REQUEST_CHANGES — x\nVERDICT: APPROVE"),
		).toBe("APPROVE");
		expect(parseVerdict("VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES — y")).toBe(
			"REQUEST_CHANGES",
		);
		expect(parseVerdict("no verdict here")).toBe(null);
	});
});

describe("review-gate end-to-end", () => {
	test("APPROVE merges through the gate and banks evidence", async () => {
		const id = idOf(work("add", "gates: approve path fixture"));
		const wt = wtFor(`suspenders/${id}`);
		writeFileSync(join(wt, "src.ts"), "export const base = 2;\n");
		git(wt, "commit", "-aqm", "objective achieved");
		mode = "approve";
		const r = await gate(`suspenders/${id}`, { SUSPENDERS_BELT_URL: BELT_URL });
		expect(r.code).toBe(0);
		expect(r.out).toContain("REVIEW APPROVE");
		expect(git(REPO, "log", "--oneline", "-1", "main")).toContain(
			`Merge suspenders/${id}`,
		);
		expect(reviewFiles().some((f) => f.startsWith(id))).toBe(true);
	});

	test("reviewer sees exactly objective + diff + tests, no worker framing", async () => {
		const hit = hits.at(-1);
		expect(hit).toBeDefined();
		expect(hit?.user).toContain("OBJECTIVE");
		expect(hit?.user).toContain("approve path fixture");
		expect(hit?.user).toContain("DIFF");
		expect(hit?.user).toContain("TEST EVIDENCE");
		// sycophancy-proofing: none of the lane-brief vocabulary rides along
		expect(hit?.user).not.toContain("You are lane");
		expect(hit?.system).toContain("fresh-context");
	});
});

describe("review-gate end-to-end", () => {
	test("REQUEST_CHANGES fails the ladder — no merge, verdict in output", async () => {
		const id = idOf(work("add", "gates: changes path fixture"));
		const wt = wtFor(`suspenders/${id}`);
		writeFileSync(join(wt, "src.ts"), "export const base = 3;\n");
		git(wt, "commit", "-aqm", "objective missed");
		mode = "changes";
		const before = git(REPO, "rev-parse", "main");
		const r = await gate(`suspenders/${id}`, { SUSPENDERS_BELT_URL: BELT_URL });
		expect(r.code).toBe(1);
		expect(r.out).toContain("REVIEW REQUEST_CHANGES");
		expect(r.out).toContain("does not implement the objective");
		expect(git(REPO, "rev-parse", "main")).toBe(before);
		expect(reviewFiles().some((f) => f.startsWith(id))).toBe(true);
	});

	test("gate runs scoped tests in the branch worktree and shows the reviewer", async () => {
		const id = idOf(work("add", "gates: scoped test evidence fixture"));
		const wt = wtFor(`suspenders/${id}`);
		writeFileSync(
			join(wt, "ok.test.ts"),
			`import { test, expect } from "bun:test";\ntest("trivial", () => expect(1).toBe(1));\n`,
		);
		git(wt, "add", "-A");
		git(wt, "commit", "-qm", "adds a test");
		mode = "approve";
		const r = await gate(`suspenders/${id}`, { SUSPENDERS_BELT_URL: BELT_URL });
		expect(r.code).toBe(0);
		const hit = hits.at(-1);
		expect(hit?.user).toContain("bun test 1 file(s), exit 0");
	});
});

describe("review-gate end-to-end", () => {
	test("belt unreachable → REVIEW-SKIPPED passthrough merge", async () => {
		const id = idOf(work("add", "gates: belt-down passthrough fixture"));
		const wt = wtFor(`suspenders/${id}`);
		writeFileSync(join(wt, "src.ts"), "export const base = 4;\n");
		git(wt, "commit", "-aqm", "obj");
		const before = git(REPO, "rev-parse", "main");
		const r = await gate(`suspenders/${id}`, {
			SUSPENDERS_BELT_URL: "http://127.0.0.1:9", // discard port — refused fast
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("REVIEW-SKIPPED");
		expect(git(REPO, "rev-parse", "main")).not.toBe(before);
	});

	test("review-paused kill switch → plain merge, belt never called", async () => {
		writeFileSync(join(REPO, ".fleet", "review-paused"), "");
		const id = idOf(work("add", "gates: kill switch fixture"));
		const wt = wtFor(`suspenders/${id}`);
		writeFileSync(join(wt, "src.ts"), "export const base = 5;\n");
		git(wt, "commit", "-aqm", "obj");
		const beforeHits = hits.length;
		const r = await gate(`suspenders/${id}`, { SUSPENDERS_BELT_URL: BELT_URL });
		rmSync(join(REPO, ".fleet", "review-paused"));
		expect(r.code).toBe(0);
		expect(hits.length).toBe(beforeHits);
	});
});

describe("review-gate end-to-end", () => {
	test("unparsable reply → one retry, then fail closed", async () => {
		const id = idOf(work("add", "gates: unparsable reply fixture"));
		const wt = wtFor(`suspenders/${id}`);
		writeFileSync(join(wt, "src.ts"), "export const base = 6;\n");
		git(wt, "commit", "-aqm", "obj");
		mode = "garbage";
		const beforeHits = hits.length;
		const before = git(REPO, "rev-parse", "main");
		const r = await gate(`suspenders/${id}`, { SUSPENDERS_BELT_URL: BELT_URL });
		expect(hits.length - beforeHits).toBe(2); // exactly one retry
		expect(r.code).toBe(1);
		expect(git(REPO, "rev-parse", "main")).toBe(before);
		const stored = readFileSync(
			join(reviewsDir, reviewFiles().find((f) => f.startsWith(id)) ?? ""),
			"utf8",
		);
		expect(stored).toContain("UNPARSABLE");
	});
});

describe("collectDiff cap", () => {
	test("oversized diffs truncate with an honest marker", async () => {
		git(
			REPO,
			"worktree",
			"add",
			"-q",
			"-b",
			"feature/big",
			join(REPO, "wt-big"),
		);
		const wt = join(REPO, "wt-big");
		writeFileSync(join(wt, "big.txt"), `${"x".repeat(70_000)}\n`);
		git(wt, "add", "-A");
		git(wt, "commit", "-qm", "big");
		const d = collectDiff(REPO, "main", "feature/big");
		expect(d.length).toBeLessThan(70_000);
		expect(d).toContain("[diff truncated");
	});
});
