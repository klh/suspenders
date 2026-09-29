// test/deny-audit.test.ts — the denied-call audit (W80): every gate denial
// appends one JSONL line to $HOME/.cache/claude-governor/denied-calls.jsonl.
// Gate-level probe: a >40-line Write to an existing file trips mutation-size
// through the REAL pre-files chain spawn (temp $HOME isolates the audit
// file); the allow path must produce nothing. Unit leg pins auditDeny()'s
// truncation caps directly.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditDeny, auditPath } from "../hooks/lib/hookio.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-denyaudit-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-denyaudit-repo-"));
const env = { ...process.env, HOME };
const HOOKS = join(import.meta.dir, "..", "hooks");
const AUDIT = join(HOME, ".cache/claude-governor/denied-calls.jsonl");

let n = 0;
function gate(payload: object): { out: string; code: number | null } {
	const pf = join(HOME, `hook-${n++}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), "pre-files"], {
		cwd: REPO,
		env,
		stdin: Bun.file(pf),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString(), code: p.exitCode };
}

function lines(): string[] {
	if (!existsSync(AUDIT)) return [];
	return readFileSync(AUDIT, "utf8")
		.split("\n")
		.filter((l) => l !== "");
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("denied-call audit", () => {
	test("allow path leaves no audit line", () => {
		const f = join(REPO, "new-allow.md");
		const r = gate({
			tool_name: "Write",
			tool_input: { file_path: f, content: "seed\n" },
			cwd: REPO,
			session_id: "s",
			transcript_path: join(HOME, "t.jsonl"),
		});
		expect(r.out).toBe("{}"); // new files exempt — clean allow
		expect(lines()).toEqual([]); // no denials, no audit file
	});

	test("gate denial appends exactly one parseable JSONL line", () => {
		const f = join(REPO, "exists.md");
		writeFileSync(f, "seed\n"); // existing → mutation-size applies
		const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
		const r = gate({
			tool_name: "Write",
			tool_input: { file_path: f, content: big },
			cwd: REPO,
			session_id: "s",
			transcript_path: join(HOME, "t.jsonl"),
		});
		expect(r.out).toContain('"permissionDecision":"deny"');
		expect(r.out).toContain("mutation-size");
		const all = lines();
		expect(all.length).toBe(1);
		const parsed = JSON.parse(all[0]) as Record<string, string>;
		expect(parsed.event).toBe("pre-files");
		expect(parsed.tool).toBe("Write");
		expect(parsed.path).toBe(f);
		expect(parsed.cmd).toBe("");
		expect(parsed.cwd).toBe(REPO);
		expect(parsed.reason).toContain("mutation-size");
		expect(typeof parsed.at).toBe("string");
	});

	test("auditDeny truncates reason at the 300-char cap", () => {
		const prev = process.env.HOME;
		process.env.HOME = HOME;
		try {
			expect(auditPath()).toBe(AUDIT); // path follows $HOME at call time
			const before = lines().length;
			auditDeny("x".repeat(400));
			const all = lines();
			expect(all.length).toBe(before + 1);
			const parsed = JSON.parse(all[all.length - 1]) as Record<string, string>;
			expect(parsed.reason.length).toBe(300);
		} finally {
			if (prev === undefined) delete process.env.HOME;
			else process.env.HOME = prev;
		}
	});
});
