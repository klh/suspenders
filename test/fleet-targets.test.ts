// test/fleet-targets.test.ts — W298: fleet-wide install target detection.
// Verifies the thin wiring/gating layer (hooks/lib/targets.ts) on top of the
// vendored vercel-labs/skills registry (hooks/lib/vendor/skills-agents.ts):
// supported targets get a wireScriptPath pointing at a real hooks/dialects
// wire.ts, claude-code is native, everything else in the 70+ list is still
// listed but gated (supported: false). Detection itself is exercised via a
// subprocess with HOME overridden — os.homedir() is read at module load, so
// an in-process mock can't reach it; a real subprocess + fake $HOME can.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), `.tmp-w298-targets-${process.pid}`);
const REPO = process.cwd();

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

async function detectWithHome(homeDir: string): Promise<
	Array<{
		type: string;
		installed: boolean;
		supported: boolean;
		native: boolean;
	}>
> {
	mkdirSync(homeDir, { recursive: true });
	const script = `
		import { detectFleetTargets } from ${JSON.stringify(join(REPO, "hooks/lib/targets.ts"))};
		const targets = await detectFleetTargets(${JSON.stringify(REPO)});
		console.log(JSON.stringify(targets.map((t) => ({
			type: t.type, installed: t.installed, supported: t.supported, native: t.native,
		}))));
	`;
	const proc = Bun.spawn(["bun", "-e", script], {
		env: { ...process.env, HOME: homeDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`subprocess failed: ${err}`);
	return JSON.parse(out.trim().split("\n").pop() ?? "[]");
}

describe("fleet install targets (W298)", () => {
	test("listTargets includes all four wired dialects + native claude-code, and gates the rest", async () => {
		const { listTargets } = await import("../hooks/lib/targets.ts");
		const targets = listTargets(REPO);

		const byType = new Map(targets.map((t) => [t.type, t]));

		for (const dialect of ["codex", "grok", "cline"] as const) {
			const t = byType.get(dialect);
			expect(t?.supported).toBe(true);
			expect(t?.native).toBe(false);
			expect(t?.wireScriptPath).toBe(
				join(REPO, "hooks/dialects", dialect, "wire.ts"),
			);
		}

		const copilot = byType.get("github-copilot");
		expect(copilot?.supported).toBe(true);
		expect(copilot?.wireScriptPath).toBe(
			join(REPO, "hooks/dialects/copilot/wire.ts"),
		);

		const claude = byType.get("claude-code");
		expect(claude?.supported).toBe(true);
		expect(claude?.native).toBe(true);
		expect(claude?.wireScriptPath).toBeUndefined();

		// A representative sample of the 70+ gated (detected-but-unsupported) targets.
		for (const gated of [
			"zed",
			"cursor",
			"windsurf",
			"hermes-agent",
			"opencode",
		] as const) {
			const t = byType.get(gated);
			expect(t?.supported).toBe(false);
			expect(t?.wireScriptPath).toBeUndefined();
		}

		// universal is a skills-package-only concept (not a real CLI target) — excluded.
		expect(byType.has("universal" as never)).toBe(false);

		// The full vendored breadth stays intact: 70+ entries, nothing dropped.
		expect(targets.length).toBeGreaterThan(70);
	});

	test("detectFleetTargets: empty fake HOME detects none of our supported targets", async () => {
		// Scoped to `supported` only: some vendored entries detect via an
		// absolute app-bundle path (e.g. zcode's /Applications/ZCode.app)
		// independent of $HOME, so this machine's real installs can still
		// show up there — that's correct vendored behavior, not a bug.
		const home = join(ROOT, "empty-home");
		const targets = await detectWithHome(home);
		expect(targets.filter((t) => t.supported).every((t) => !t.installed)).toBe(
			true,
		);
	});

	test("detectFleetTargets: a fake ~/.codex marks only codex installed among supported targets", async () => {
		const home = join(ROOT, "codex-home");
		mkdirSync(join(home, ".codex"), { recursive: true });
		const targets = await detectWithHome(home);
		const supported = targets.filter((t) => t.supported);
		const installedSupported = supported
			.filter((t) => t.installed)
			.map((t) => t.type);
		expect(installedSupported).toEqual(["codex"]);
	});

	test("detectFleetTargets: fake ~/.copilot, ~/.grok, ~/.cline all detected independently", async () => {
		const home = join(ROOT, "multi-home");
		mkdirSync(join(home, ".copilot"), { recursive: true });
		mkdirSync(join(home, ".grok"), { recursive: true });
		mkdirSync(join(home, ".cline"), { recursive: true });
		const targets = await detectWithHome(home);
		const installed = new Set(
			targets.filter((t) => t.installed).map((t) => t.type),
		);
		expect(installed.has("github-copilot")).toBe(true);
		expect(installed.has("grok")).toBe(true);
		expect(installed.has("cline")).toBe(true);
		expect(installed.has("codex")).toBe(false);
	});
});
