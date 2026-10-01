// test/gates-read.test.ts — W110 read gate (fat-read deny + re-read nudge).
//   1. pure: readCapBytes parsing + fatReadDeny decision core
//   2. gate-level: real `bun hooks/gate.ts pre-read` spawns — deny carries the
//      size and the bounded retry; 3rd same-path read emits additionalContext
// Fixtures: mkdtemp under cwd, unique path per test, TMPDIR isolated per run
// so the re-read counters never leak between runs.
import { describe, test, expect, afterAll } from "bun:test";
import {
	fatReadDeny,
	readCapBytes,
	DEFAULT_MAX_READ,
} from "../hooks/gates/read.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmp = mkdtempSync(join(process.cwd(), ".read-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sizedFixture(name: string, bytes: number): string {
	const f = join(tmp, name);
	writeFileSync(f, "x".repeat(bytes));
	return f;
}

const SID = "read-test-lane";
const hook = (input: Record<string, unknown>) => ({
	tool_name: "Read",
	tool_input: input,
	cwd: process.cwd(),
	session_id: SID,
});

function spawnGate(payload: unknown, env: Record<string, string> = {}) {
	const pf = join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), "pre-read"],
		{
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
			cwd: import.meta.dir,
			env: { ...process.env, TMPDIR: tmp, ...env },
		},
	);
	rmSync(pf);
	let json: {
		hookSpecificOutput?: {
			permissionDecision?: string;
			permissionDecisionReason?: string;
			additionalContext?: string;
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
const nudgeText = (r: ReturnType<typeof spawnGate>) =>
	r.json?.hookSpecificOutput?.additionalContext ?? "";

// ============================== pure ==============================

describe("readCapBytes (SUSPENDERS_MAX_READ)", () => {
	test("unset → default 40KB", () =>
		expect(readCapBytes(undefined)).toBe(DEFAULT_MAX_READ));
	test("blank → default", () =>
		expect(readCapBytes("  ")).toBe(DEFAULT_MAX_READ));
	test("positive integer honored", () =>
		expect(readCapBytes("2048")).toBe(2048));
	test("0 disables", () => expect(readCapBytes("0")).toBe(0));
	test("negatives and garbage disable", () => {
		expect(readCapBytes("-3")).toBe(0);
		expect(readCapBytes("abc")).toBe(0);
		expect(readCapBytes("4.5")).toBe(0);
	});
});

describe("fatReadDeny (pure core)", () => {
	const P = "/repo/big.ts";
	test("small file → null", () =>
		expect(fatReadDeny(1024, false, 40_960, P)).toBeNull());
	test("big file with limit → null", () =>
		expect(fatReadDeny(50_000, true, 40_960, P)).toBeNull());
	test("big file no limit → reason with size + bounded retry", () => {
		const m = fatReadDeny(122_880, false, 40_960, P) ?? "";
		expect(m).toContain("120KB");
		expect(m).toContain("limit");
		expect(m).toContain("SUSPENDERS_MAX_READ");
	});
	test("cap 0 disables", () =>
		expect(fatReadDeny(999_999, false, 0, P)).toBeNull());
	test("media extensions exempt", () => {
		expect(fatReadDeny(500_000, false, 40_960, "/repo/scan.png")).toBeNull();
		expect(fatReadDeny(500_000, false, 40_960, "/repo/deck.pdf")).toBeNull();
	});
});

// ============================== gate: pre-read spawns ==============================

describe("readGate — live pre-read spawns", () => {
	test("pre-read: >40KB file without limit → deny with size + guidance", () => {
		const f = sizedFixture(
			`big-${Math.random().toString(36).slice(2)}.txt`,
			50 * 1024,
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("read-gate:");
		expect(reason(r)).toContain("50KB");
	});

	test("pre-read: same file with limit → allow", () => {
		const f = sizedFixture(
			`big-${Math.random().toString(36).slice(2)}.txt`,
			50 * 1024,
		);
		const r = spawnGate(hook({ file_path: f, limit: 400 }));
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: small file → allow", () => {
		const f = sizedFixture(
			`small-${Math.random().toString(36).slice(2)}.txt`,
			1024,
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: media extension exempt from the fat-read deny", () => {
		const f = sizedFixture(
			`scan-${Math.random().toString(36).slice(2)}.png`,
			60 * 1024,
		);
		const r = spawnGate(hook({ file_path: f }));
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: SUSPENDERS_MAX_READ=0 disables the deny", () => {
		const f = sizedFixture(
			`big-${Math.random().toString(36).slice(2)}.txt`,
			50 * 1024,
		);
		const r = spawnGate(hook({ file_path: f }), { SUSPENDERS_MAX_READ: "0" });
		expect(decision(r)).toBe("allow");
	});

	test("pre-read: 3rd same-path read → additionalContext nudge, read proceeds", () => {
		const f = sizedFixture(
			`rereread-${Math.random().toString(36).slice(2)}.txt`,
			1024,
		);
		const first = spawnGate(hook({ file_path: f }));
		const second = spawnGate(hook({ file_path: f }));
		const third = spawnGate(hook({ file_path: f }));
		expect(decision(first)).toBe("allow");
		expect(nudgeText(first)).toBe("");
		expect(decision(second)).toBe("allow");
		expect(decision(third)).toBe("allow"); // nudge is non-blocking
		expect(nudgeText(third)).toContain("read-gate: read #3");
		expect(nudgeText(third)).toContain(f.slice(f.lastIndexOf("/") + 1)); // basename — nudges stay compact
	});

	test("pre-read: SUSPENDERS_REREAD_NUDGE=0 silences the nudge", () => {
		const f = sizedFixture(
			`quiet-${Math.random().toString(36).slice(2)}.txt`,
			1024,
		);
		for (let i = 0; i < 3; i++) {
			const r = spawnGate(hook({ file_path: f }), {
				SUSPENDERS_REREAD_NUDGE: "0",
			});
			expect(nudgeText(r)).toBe("");
		}
	});
});
