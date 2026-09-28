// test/gates.test.ts — the gate suite (bun:test). Two layers:
//   1. pure functions: payload line-counting, the SUSPENDERS_MAX_MUTATION
//      threshold, marker detection, ledger classification
//   2. gate-level: real `bun hooks/gate.ts <event>` spawns with JSON payloads
//      via temp-file stdin (Bun spawnSync drops the `input` option)
// Fixtures live in a mkdtemp under process.cwd() — NOT /tmp: the Bash gate
// exempts /tmp paths by design, so /tmp fixtures would dodge the governor.
// Spawned gates take real governor leases, so every fixture path is unique
// per test and written BEFORE its spawn (raw fs writes take no lease).
import { describe, test, expect, afterAll } from "bun:test";
import {
	countLines,
	changedLines,
	mutationCap,
	DEFAULT_CAP,
} from "../hooks/gates/mutation-size.ts";
import {
	markerLines,
	newMarkerLines,
	isLedgerFile,
	MARKER,
} from "../hooks/gates/ledger.ts";
import { filesCheck } from "../hooks/gates/files.ts";
import { pushMainTarget } from "../hooks/gates/bash.ts";
import type { HookInput } from "../hooks/lib/hookio.ts";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---- shared fixture dir (fresh per run, under the repo cwd) ----
const tmp = mkdtempSync(join(process.cwd(), ".gates-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let fixtureN = 0;
function fixture(content: string, ext = ".md", name?: string): string {
	const base = name
		? `${name}-${++fixtureN}`
		: `fx-${++fixtureN}-${Math.random().toString(36).slice(2, 8)}`;
	const f = join(tmp, `${base}${ext}`);
	writeFileSync(f, content);
	return f;
}
const phantom = (name: string) => join(tmp, `ghost-${name}`); // never created on disk

const SID = "gates-test-lane";

/** Spawn the real gate entrypoint; payload goes through a temp file because
 * Bun's spawnSync drops `input`. Returns exit code + parsed stdout JSON. */
function spawnGate(
	event: string,
	payload: unknown,
	env: Record<string, string> = {},
) {
	const pf = join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, JSON.stringify(payload));
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), event],
		{
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		},
	);
	rmSync(pf);
	let json: {
		hookSpecificOutput?: {
			permissionDecision?: string;
			permissionDecisionReason?: string;
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
const hook = (tool: string, input: Record<string, unknown>, cwd?: string) => ({
	tool_name: tool,
	tool_input: input,
	cwd: cwd ?? process.cwd(),
	session_id: SID,
	transcript_path: "/nonexistent.jsonl",
});

// ============================== W5: mutation-size ==============================

describe("countLines", () => {
	test('"" is 0 lines', () => expect(countLines("")).toBe(0));
	test("single line", () => expect(countLines("x")).toBe(1));
	test("multi line", () => expect(countLines("a\nb\nc")).toBe(3));
	test("trailing newline does not open a line", () =>
		expect(countLines("a\nb\n")).toBe(2));
});

describe("changedLines (max of both sides — both are fresh emissions)", () => {
	test("1-line swap", () => expect(changedLines("old", "new")).toBe(1));
	test("big replacement of a small block", () =>
		expect(changedLines("old", "1\n2\n3\n4\n5")).toBe(5));
	test("45-line new_string over 1-line old_string", () => {
		const big = Array.from({ length: 45 }, (_, i) => `line-${i}`).join("\n");
		expect(changedLines("old", big)).toBe(45);
	});
});

describe("mutationCap (SUSPENDERS_MAX_MUTATION)", () => {
	test("unset → default 40", () =>
		expect(mutationCap(undefined)).toBe(DEFAULT_CAP));
	test("empty/blank → default 40", () => {
		expect(mutationCap("")).toBe(DEFAULT_CAP);
		expect(mutationCap("  ")).toBe(DEFAULT_CAP);
	});
	test("positive integer is honored", () => {
		expect(mutationCap("25")).toBe(25);
		expect(mutationCap("40")).toBe(40);
	});
	test("0 disables", () => expect(mutationCap("0")).toBe(0));
	test("negatives and garbage disable", () => {
		expect(mutationCap("-3")).toBe(0);
		expect(mutationCap("abc")).toBe(0);
		expect(mutationCap("12.5")).toBe(0);
	});
});

// ============================== W8: ledger markers ==============================

describe("markerLines", () => {
	test("detects the shouted family", () => {
		const lines = markerLines(
			"TODO: a\nfine\nFIXME b\nIN-FLIGHT: c\nBLOCKED on x\nNEXT: d",
		);
		expect(lines).toHaveLength(5);
	});
	test("lowercase prose never trips", () => {
		expect(
			markerLines("todo: a\nnextdoor\nblockade runner\nnext up"),
		).toHaveLength(0);
	});
	test("HISTORICAL tombstone lines are exempt", () => {
		expect(markerLines("HISTORICAL — TODO: retired")).toHaveLength(0);
	});
	test("MARKER is word-bounded", () => {
		expect(MARKER.test("TODOX")).toBe(false);
		expect(MARKER.test("a TODO")).toBe(true);
	});
});

describe("newMarkerLines (only INTRODUCED markers count)", () => {
	test("marker present in old content is not new", () => {
		expect(newMarkerLines("TODO: keep\nhead", "TODO: keep\ntail")).toHaveLength(
			0,
		);
	});
	test("genuinely new marker line is flagged", () => {
		const intro = newMarkerLines("# ledger", "# ledger\nBLOCKED: on review");
		expect(intro).toEqual(["BLOCKED: on review"]);
	});
	test("verbatim moves pass, reworded moves trip", () => {
		expect(newMarkerLines("TODO: old\nx", "x\nTODO: old")).toHaveLength(0);
		expect(newMarkerLines("TODO: old\nx", "x\nTODO: old moved")).toHaveLength(
			1,
		);
	});
});

describe("isLedgerFile (the code-defined ledger list)", () => {
	test("*LEDGER*.md matches", () => {
		expect(isLedgerFile("/x/WAVE-LEDGER.md", "")).toBe(true);
		expect(isLedgerFile("/x/ledger.md", "")).toBe(true);
	});
	test("TODO.md matches case-insensitively", () => {
		expect(isLedgerFile("/x/todo.md", "")).toBe(true);
		expect(isLedgerFile("/x/TODO.MD", "")).toBe(true);
	});
	test("retired-ledger header matches", () => {
		expect(
			isLedgerFile("/x/notes.md", "# Notes\n## Retired ledger — wave 1\n"),
		).toBe(true);
	});
	test("plain docs and non-md do not match", () => {
		expect(isLedgerFile("/x/README.md", "# Readme\n")).toBe(false);
		expect(isLedgerFile("/x/ledger.ts", "")).toBe(false);
		expect(
			isLedgerFile(
				"/x/notes.md",
				"just prose mentioning retired ledger users\n",
			),
		).toBe(false); // prose ≠ header
	});
});

// ============================== W14: filesCheck in-process ==============================
// stop.ts re-verifies changed files by calling filesCheck directly — no bun
// spawn. These tests pin that contract without needing a dirty git repo.

describe("filesCheck (the W14 exit-free core stop.ts now calls in-process)", () => {
	test("clean file → ok", () => {
		// export keeps biome's noUnusedVariables from flagging the fixture
		// (qlty's biome plugin drifted; `const x = 1` now blocks — see the
		// identical failure on pristine HEAD 6bced05)
		const f = fixture("export const x = 1;\n", ".ts");
		const v = filesCheck({
			tool_name: "Write",
			tool_input: { file_path: f },
		} as HookInput);
		expect(v.kind).toBe("ok");
	});
	test("broken settings.json → block (the jq guard branch)", () => {
		const f = join(tmp, "settings.json"); // basename match is exact
		writeFileSync(f, "{ broken");
		const v = filesCheck({
			tool_name: "Write",
			tool_input: { file_path: f },
		} as HookInput);
		expect(v.kind).toBe("block");
	});
	test("non-file tools short-circuit → ok", () => {
		const v = filesCheck({
			tool_name: "Bash",
			tool_input: { command: "echo hi" },
		} as HookInput);
		expect(v.kind).toBe("ok");
	});
});

// ============================== gate-level (real spawns) ==============================

describe("gate.ts live spawns", () => {
	test("pre-bash smoke: echo hi → allow", () => {
		const r = spawnGate("pre-bash", hook("Bash", { command: "echo hi" }));
		expect(r.code).toBe(0);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: small edit on existing file → allow (full pipeline)", () => {
		const f = fixture("line1\nline2\n", ".ts");
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "line1",
				new_string: "line1 edited",
			}),
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: 45-line Edit payload on existing file → mutation-size deny", () => {
		const f = fixture("stable\n", ".ts");
		const big = Array.from({ length: 45 }, (_, i) => `mutation ${i}`).join(
			"\n",
		);
		const r = spawnGate(
			"pre-files",
			hook("Edit", { file_path: f, old_string: "stable", new_string: big }),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("mutation-size:");
		expect(reason(r)).toContain("SUSPENDERS_MAX_MUTATION");
		expect(reason(r)).toContain("mechanical transform");
	});

	test("pre-files: SUSPENDERS_MAX_MUTATION=0 disables the deny", () => {
		const f = fixture("stable\n", ".ts");
		const big = Array.from({ length: 45 }, (_, i) => `mutation ${i}`).join(
			"\n",
		);
		const r = spawnGate(
			"pre-files",
			hook("Edit", { file_path: f, old_string: "stable", new_string: big }),
			{
				SUSPENDERS_MAX_MUTATION: "0",
			},
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: raised cap admits the payload", () => {
		const f = fixture("stable\n", ".ts");
		const big = Array.from({ length: 45 }, (_, i) => `mutation ${i}`).join(
			"\n",
		);
		const r = spawnGate(
			"pre-files",
			hook("Edit", { file_path: f, old_string: "stable", new_string: big }),
			{
				SUSPENDERS_MAX_MUTATION: "50",
			},
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: Write to a NEW file is exempt regardless of size", () => {
		const big = Array.from({ length: 100 }, (_, i) => `fresh ${i}`).join("\n");
		const r = spawnGate(
			"pre-files",
			hook("Write", { file_path: phantom("new-file.ts"), content: big }),
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: new TODO into *LEDGER*.md → operational-marker deny", () => {
		const f = fixture("# Wave ledger\n", ".md", "WAVE-LEDGER");
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "# Wave ledger",
				new_string: "# Wave ledger\nTODO: wire the thing",
			}),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("operational-marker gate:");
		expect(reason(r)).toContain("governor.db");
	});

	test("pre-files: same marker into a plain .md → allow", () => {
		const f = fixture("# Plain doc\n");
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "# Plain doc",
				new_string: "# Plain doc\nTODO: fine here",
			}),
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: verbatim marker move inside a ledger → allow", () => {
		const f = fixture("# Wave ledger\nTODO: keep\n", ".md", "MOVE-LEDGER");
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "# Wave ledger\nTODO: keep",
				new_string: "TODO: keep\n# Wave ledger",
			}),
		);
		expect(decision(r)).toBe("allow");
	});

	test("pre-files: new marker into a retired-ledger doc → deny", () => {
		const f = fixture(
			"# Notes\n## Retired ledger — wave 1\n\nnothing lives here.\n",
		);
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "nothing lives here.",
				new_string: "nothing lives here.\nNEXT: revive",
			}),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("operational-marker gate:");
	});

	test("pre-files: HISTORICAL tombstone line into a ledger → allow", () => {
		const f = fixture("# Wave ledger\n", ".md", "TOMBSTONE-LEDGER");
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "# Wave ledger",
				new_string:
					"# Wave ledger\nHISTORICAL — TODO: superseded by the work graph",
			}),
		);
		expect(decision(r)).toBe("allow");
	});

	test("pipeline order: oversized payload INTO a ledger denies mutation-size first", () => {
		const f = fixture("# Wave ledger\n", ".md", "ORDER-LEDGER");
		const big = Array.from(
			{ length: 45 },
			(_, i) => `TODO: mutation ${i}`,
		).join("\n");
		const r = spawnGate(
			"pre-files",
			hook("Edit", {
				file_path: f,
				old_string: "# Wave ledger",
				new_string: big,
			}),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("mutation-size:");
	});
});

// ===================== W70: no-lane-push-to-main =====================
// The push guard resolves lane identity mechanically: the spawned gate's
// ancestor chain must contain a pid from a .fleet/lanes.json found by
// walking UP from the payload cwd. This TEST PROCESS is that ancestor —
// its real pid in the fixture lanes.json makes the spawned gate see a live
// lane with no real agent running. The fixture lives UNDER `tmp` so its
// .fleet/lanes.json is found BEFORE the real repo's (whose real lane pids
// would otherwise answer first).

describe("pushMainTarget (pure refspec analysis)", () => {
	const lane = "suspenders/W70";
	const hit = (argv: string[], cb?: string): string =>
		pushMainTarget(["git", "push", ...argv], cb ?? lane);
	test("explicit dst main", () => expect(hit(["origin", "main"])).toBe("main"));
	test("own branch → no hit", () => expect(hit(["origin", lane])).toBe(""));
	test("HEAD:main", () =>
		expect(hit(["origin", "HEAD:main"])).toBe("HEAD:main"));
	test("force form +main", () =>
		expect(hit(["origin", "+main"])).toBe("+main"));
	test("delete :main", () => expect(hit(["origin", ":main"])).toBe(":main"));
	test("delete full-ref form", () =>
		expect(hit(["origin", ":refs/heads/main"])).toBe(":refs/heads/main"));
	test("full-ref dst", () =>
		expect(hit(["origin", "main:refs/heads/main"])).toBe(
			"main:refs/heads/main",
		));
	test("a tag named main is NOT the branch", () =>
		expect(hit(["origin", "refs/tags/main"])).toBe(""));
	test("--all/--mirror deny", () => {
		expect(hit(["--all"]).length > 0).toBe(true);
		expect(hit(["--mirror"]).length > 0).toBe(true);
	});
	test("--tags alone is not a main push", () =>
		expect(hit(["origin", "--tags"])).toBe(""));
	test("HEAD dst follows the current branch (lane branch → no hit)", () =>
		expect(hit(["origin", "HEAD"])).toBe(""));
	test("HEAD dst follows the current branch (on main → hit)", () =>
		expect(hit(["origin", "HEAD"], "main")).toBe("HEAD"));
	test("bare push on main hits", () =>
		expect(hit([], "main").length > 0).toBe(true));
	test("remote-only push on main hits", () =>
		expect(hit(["origin"], "main").length > 0).toBe(true));
	test("bare push on a lane branch → no hit", () =>
		expect(hit([], lane)).toBe(""));
	test("--repo <r> main — the flag supplies the remote", () =>
		expect(hit(["--repo", "up", "main"])).toBe("main"));
	test("git -c k=v push origin main (global option value skipped)", () =>
		expect(
			pushMainTarget(["git", "-c", "k=v", "push", "origin", "main"], lane),
		).toBe("main"));
	test("git -C /x push origin main", () =>
		expect(
			pushMainTarget(["git", "-C", "/x", "push", "origin", "main"], lane),
		).toBe("main"));
});

describe("push-guard lane resolution (gate-level, real spawn)", () => {
	const fleetDir = join(tmp, ".fleet");
	const writeLanes = (entries: unknown[]) => {
		mkdirSync(fleetDir, { recursive: true });
		writeFileSync(join(fleetDir, "lanes.json"), JSON.stringify(entries));
	};
	const laneEntry = (pid: number) => [
		{
			sid: "autow70t",
			item: "W70T",
			pid,
			branch: "suspenders/W70T",
			worktree: tmp,
		},
	];

	test("lane pushes main → deny (fixture pid = this test process, a real gate ancestor)", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate(
			"pre-bash",
			hook("Bash", { command: "git push origin main" }, tmp),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("push-guard:");
		expect(reason(r)).toContain("autow70t");
	});
	test("lane pushes its own branch → allow", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate(
			"pre-bash",
			hook("Bash", { command: "git push origin suspenders/W70T" }, tmp),
		);
		expect(decision(r)).toBe("allow");
	});
	test("non-lane session (no ancestor pid in the registry) pushes main → allow", () => {
		writeLanes([
			{
				sid: "ghost",
				item: "GHOST",
				pid: 99999999,
				branch: "x",
				worktree: tmp,
			},
		]);
		const r = spawnGate(
			"pre-bash",
			hook("Bash", { command: "git push origin main" }, tmp),
		);
		expect(decision(r)).toBe("allow");
	});
	test("lane push to main via a cd segment → deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate(
			"pre-bash",
			hook("Bash", { command: `cd ${tmp}/sub && git push origin main` }, tmp),
		);
		expect(decision(r)).toBe("deny");
		expect(reason(r)).toContain("push-guard:");
	});
	test("git -c regression through the real gate → deny", () => {
		writeLanes(laneEntry(process.pid));
		const r = spawnGate(
			"pre-bash",
			hook(
				"Bash",
				{ command: "git -c advice.pushFailed=1 push origin main" },
				tmp,
			),
		);
		expect(decision(r)).toBe("deny");
	});
});
