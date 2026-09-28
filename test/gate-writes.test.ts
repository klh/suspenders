// test/gate-writes.test.ts — W58: the gate-write journal exported by
// hooks/gates/files.ts. The journal is relocated into a fixture dir via the
// SUSPENDERS_GATE_WRITES seam — tests never touch the real ~/.cache journal.
import { describe, test, expect, afterAll } from "bun:test";
import {
	GATE_WRITES_JOURNAL,
	gateWroteSince,
	recordGateWrite,
} from "../hooks/gates/files.ts";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tmp = mkdtempSync(join(process.cwd(), ".gate-writes-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

process.env.SUSPENDERS_GATE_WRITES = join(tmp, "gate-writes.jsonl");

let n = 0;
function fixture(content: string): string {
	const f = join(tmp, `gw-${++n}-${Math.random().toString(36).slice(2, 8)}.ts`);
	writeFileSync(f, content);
	return f;
}

type Entry = { path: string; sha256: string; ts: string };
function entries(): Entry[] {
	return readFileSync(process.env.SUSPENDERS_GATE_WRITES ?? "", "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Entry);
}

describe("gate-write journal (W58)", () => {
	test("GATE_WRITES_JOURNAL is the ~/.cache paper trail", () => {
		expect(GATE_WRITES_JOURNAL).toBe(
			`${process.env.HOME}/.cache/claude-governor/gate-writes.jsonl`,
		);
	});

	test("recordGateWrite appends {path, sha256, ts}; gateWroteSince blesses by ts", () => {
		const f = fixture("const x = 1;\n");
		recordGateWrite(f);
		const mine = entries().filter((e) => e.path === f);
		expect(mine).toHaveLength(1);
		expect(mine[0].sha256).toMatch(/^[0-9a-f]{16}$/);
		expect(mine[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(gateWroteSince(f, mine[0].ts)).toBe(true);
		expect(
			gateWroteSince(f, new Date(Date.parse(mine[0].ts) + 1).toISOString()),
		).toBe(false);
	});

	test("never-written path → no entry, gateWroteSince false", () => {
		const ghost = join(tmp, "ghost.ts");
		recordGateWrite(ghost);
		expect(entries().some((e) => e.path === ghost)).toBe(false);
		expect(gateWroteSince(ghost, "1970-01-01T00:00:00.000Z")).toBe(false);
	});

	test("journal caps at the last 500 lines", () => {
		const f = fixture("const cap = 1;\n");
		for (let i = 0; i < 505; i++) recordGateWrite(f);
		expect(entries().length).toBe(500);
	});

	test("unreadable journal → false, no throw (fail-open: deny as today)", () => {
		process.env.SUSPENDERS_GATE_WRITES = join(tmp, "no-such-dir", "gw.jsonl");
		expect(gateWroteSince(join(tmp, "x.ts"), "1970-01-01T00:00:00.000Z")).toBe(
			false,
		);
		process.env.SUSPENDERS_GATE_WRITES = join(tmp, "gate-writes.jsonl");
	});

	test("absent journal file with existing target → false, no throw", () => {
		process.env.SUSPENDERS_GATE_WRITES = join(tmp, "absent.jsonl");
		const f = fixture("const y = 2;\n");
		expect(gateWroteSince(f, "1970-01-01T00:00:00.000Z")).toBe(false);
		process.env.SUSPENDERS_GATE_WRITES = join(tmp, "gate-writes.jsonl");
	});
});
