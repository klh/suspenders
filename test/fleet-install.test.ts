// test/fleet-install.test.ts — W298: the fleet-install CLI's non-interactive
// paths (flag parsing, explicit --agent selection, gating errors, --dry-run).
// Interactive multiselect branches aren't exercised here — they need a real
// TTY; manual verification is recorded in docs/fleet-install.md.
import { describe, test, expect } from "bun:test";

const BIN = `${import.meta.dir}/../hooks/bin/fleet-install.ts`;

async function run(args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["bun", BIN, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, out: out + err };
}

describe("fleet-install CLI (W298)", () => {
	test("--agent '*' --dry-run wires only supported+detected targets, touches nothing", async () => {
		const { code, out } = await run(["--agent", "*", "--dry-run"]);
		expect(code).toBe(0);
		// On a machine/CI runner with zero supported targets detected (a bare
		// $HOME), "*" legitimately resolves to nothing to wire — only assert
		// the "something would be wired" message when something was selected.
		if (!out.includes("Nothing selected — no wiring performed")) {
			expect(out).toContain("would be wired, nothing touched");
		}
		expect(out).not.toContain("wired 7 copilot hook entries"); // wire.ts never ran
	});

	test("--agent codex,cline --dry-run selects exactly those two", async () => {
		const { code, out } = await run(["--agent", "codex,cline", "--dry-run"]);
		expect(code).toBe(0);
		expect(out).toContain("dialects/codex/wire.ts");
		expect(out).toContain("dialects/cline/wire.ts");
		expect(out).not.toContain("dialects/copilot/wire.ts");
	});

	test("--agent <unknown> exits non-zero with a clear error", async () => {
		const { code, out } = await run([
			"--agent",
			"not-a-real-target",
			"--dry-run",
		]);
		expect(code).toBe(1);
		expect(out).toContain("Unknown target: not-a-real-target");
	});

	test("--agent <gated vendored target> exits non-zero (no hook adapter yet)", async () => {
		const { code, out } = await run(["--agent", "zed", "--dry-run"]);
		expect(code).toBe(1);
		expect(out).toContain("has no hook adapter yet");
	});

	test("lists gated-but-detected targets with a pointer to the dialect-pattern doc", async () => {
		const { out } = await run(["--agent", "codex", "--dry-run"]);
		if (out.includes("not yet wireable")) {
			expect(out).toContain("docs/cli-dialect-pattern.md");
		}
	});
});
