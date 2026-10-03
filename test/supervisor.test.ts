// test/supervisor.test.ts — W266.1: the supervision plane. Template render
// refuses landmines (unrendered __VAR__), ensure converges template →
// LaunchAgents → launchctl → governor.db row with all IO stubbed, status
// classifies UP/DOWN/NOT-LOADED/UNKNOWN from one parsed launchctl table,
// repo matching follows the projectIdentity realpath derivation, and the
// SessionStart fact line carries the fix command only when something is
// actually down. No test touches the live launchd or the live governor.db.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalRepo,
	ensureSupervisor,
	hasUnrenderedVar,
	labelOf,
	listServices,
	liveStates,
	launchctlTable,
	parseLaunchctlList,
	plistVars,
	renderPlist,
	serviceOf,
	supervisorFactLine,
	supervisorRows,
	upsertSupervisor,
	type SupervisorLive,
	type SupervisorRow,
	type Sh,
} from "../hooks/lib/supervisor.ts";

// temp-HOME isolation for the real-migration shape test (govdb-router
// recipe): the ?query import busts bun's module cache so THIS file's govdb
// instance binds the temp HOME, never the real governor.db.
const MHOME = mkdtempSync(join(tmpdir(), "suspenders-w266-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = MHOME; // REG binds at govdb module load — set before import
const govdb = await import(
	`../hooks/lib/govdb.ts?w266=${encodeURIComponent(MHOME)}`
);
process.env.HOME = REAL_HOME;

const DDL =
	"CREATE TABLE supervisors (label TEXT PRIMARY KEY, repo TEXT NOT NULL, plist TEXT NOT NULL, service TEXT NOT NULL, ts INTEGER NOT NULL)";

const memDb = (): Database => {
	const db = new Database(":memory:");
	db.run(DDL);
	return db;
};

const row = (over: Partial<SupervisorRow> = {}): SupervisorRow => ({
	label: "com.suspenders.board",
	repo: "/repo/.git",
	plist: "/LaunchAgents/com.suspenders.board.plist",
	service: "board",
	ts: 1700000000000,
	...over,
});

const shLog = (
	plan: Record<string, { code: number; out: string }> = {},
): {
	sh: Sh;
	calls: string[][];
} => {
	const calls: string[][] = [];
	return {
		calls,
		sh: (cmd) => {
			calls.push(cmd);
			for (const [k, v] of Object.entries(plan))
				if (cmd.join(" ").includes(k)) return v;
			return { code: 0, out: "" };
		},
	};
};

const TPL = `<?xml version="1.0"?><plist><dict>
	<string>__BUN__</string><string>__HOME__</string><string>__PREFIX__</string>
	<string>__REPO__</string><string>__BELT_URL__</string><string>__BELT_TOKEN__</string>
</dict></plist>`;

// ─── template rendering ──────────────────────────────────────────────────────

describe("renderPlist", () => {
	test("substitutes every var and leaves no placeholder", () => {
		const vars = plistVars({
			bun: "/opt/bun",
			home: "/home/u",
			prefix: "/prefix",
			repo: "/repo",
			beltUrl: "http://127.0.0.1:4100",
			beltToken: "",
		});
		const out = renderPlist(TPL, vars);
		expect(out).not.toMatch(/__[A-Z_]+__/);
		expect(out).toContain("/opt/bun");
		expect(out).toContain("/home/u");
		expect(out).toContain("/prefix");
		expect(out).toContain("/repo");
	});

	test("hasUnrenderedVar flags a landmine template", () => {
		expect(hasUnrenderedVar(TPL)).toBe(true);
		expect(
			hasUnrenderedVar(
				renderPlist(
					TPL,
					plistVars({
						bun: "b",
						home: "h",
						prefix: "p",
						repo: "r",
						beltUrl: "u",
						beltToken: "t",
					}),
				),
			),
		).toBe(false);
	});
});

// ─── service discovery ───────────────────────────────────────────────────────

describe("listServices", () => {
	test("discovers com.suspenders.* templates, sorted, nothing else", () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-lib-"));
		try {
			for (const f of [
				"com.suspenders.board.plist",
				"com.suspenders.fleet-loop.plist",
				"com.other.thing.plist",
				"README.md",
			])
				writeFileSync(join(dir, f), "x");
			expect(listServices(dir)).toEqual(["board", "fleet-loop"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing dir → honest empty", () => {
		expect(listServices("/no/such/dir-xyz")).toEqual([]);
	});
});

// ─── identity ────────────────────────────────────────────────────────────────

describe("canonicalRepo", () => {
	test("git common dir wins (projectIdentity derivation)", () => {
		const root = mkdtempSync(join(tmpdir(), "sup-repo-"));
		mkdirSync(join(root, ".git"), { recursive: true });
		try {
			const { sh } = shLog({
				"rev-parse --git-common-dir": { code: 0, out: ".git" },
			});
			expect(canonicalRepo(root, sh)).toBe(realpathSync(join(root, ".git")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("non-git dir falls back to its realpath", () => {
		const { sh } = shLog({
			"rev-parse --git-common-dir": { code: 128, out: "" },
		});
		expect(canonicalRepo("/wt", sh)).toBe("/wt");
	});
});

// ─── rows ────────────────────────────────────────────────────────────────────

describe("supervisor rows", () => {
	test("upsert converges label → latest row", () => {
		const db = memDb();
		upsertSupervisor(db, row());
		upsertSupervisor(
			db,
			row({ repo: "/repo2/.git", ts: 1700000000001, plist: "/p2" }),
		);
		const rows = supervisorRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].repo).toBe("/repo2/.git");
		expect(rows[0].plist).toBe("/p2");
	});
});

// ─── live status ─────────────────────────────────────────────────────────────

describe("liveStates", () => {
	const table = parseLaunchctlList(
		"4123\t0\tcom.suspenders.board\n-\t1\tcom.suspenders.harvest\n",
	);

	test("UP / DOWN from pid presence", () => {
		const live = liveStates(
			[row(), row({ label: "com.suspenders.harvest", service: "harvest" })],
			table,
			"/repo/.git",
		);
		expect(live[0].state).toBe("UP");
		expect(live[0].pid).toBe(4123);
		expect(live[1].state).toBe("DOWN");
	});

	test("NOT-LOADED when launchctl lacks the label", () => {
		const live = liveStates(
			[row({ label: "com.suspenders.ghost", service: "ghost" })],
			table,
			"/repo/.git",
		);
		expect(live[0].state).toBe("NOT-LOADED");
	});

	test("UNKNOWN everywhere when the probe failed (launchd unreachable)", () => {
		const live = liveStates([row()], table, "/repo/.git", false);
		expect(live[0].state).toBe("UNKNOWN");
	});

	test("foreign-repo rows carry repoMatch false, same-repo true", () => {
		const live = liveStates(
			[
				row(),
				row({ label: "com.suspenders.x", service: "x", repo: "/other/.git" }),
			],
			table,
			"/repo/.git",
		);
		expect(live[0].repoMatch).toBe(true);
		expect(live[1].repoMatch).toBe(false);
	});
});

// ─── ensure ──────────────────────────────────────────────────────────────────

describe("ensureSupervisor", () => {
	const setup = (): { tplDir: string; laDir: string } => {
		const tplDir = mkdtempSync(join(tmpdir(), "sup-tpl-"));
		writeFileSync(join(tplDir, "com.suspenders.board.plist"), TPL);
		return { tplDir, laDir: join(tplDir, "LaunchAgents") };
	};

	test("converges template → plist → launchctl → row", () => {
		const { tplDir, laDir } = setup();
		const db = memDb();
		const { sh, calls } = shLog();
		const r = ensureSupervisor({
			db,
			service: "board",
			repo: "/repo/.git",
			launchdDir: tplDir,
			launchAgentsDir: laDir,
			vars: plistVars({
				bun: "/opt/bun",
				home: "/h",
				prefix: "/pfx",
				repo: "/repo",
				beltUrl: "http://127.0.0.1:4100",
				beltToken: "",
			}),
			sh,
			now: 1700000000000,
		});
		expect(r.ok).toBe(true);
		expect(r.row?.label).toBe("com.suspenders.board");
		const written = readFileSync(
			join(laDir, "com.suspenders.board.plist"),
			"utf8",
		);
		expect(hasUnrenderedVar(written)).toBe(false);
		expect(written).toContain("/opt/bun");
		// bootout (ignore) then bootstrap, in order
		expect(calls[0].join(" ")).toContain("bootout");
		expect(calls[1].join(" ")).toContain("bootstrap");
		const rows = supervisorRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].service).toBe("board");
		rmSync(tplDir, { recursive: true, force: true });
	});

	test("missing template refuses without touching launchctl", () => {
		const db = memDb();
		const { sh, calls } = shLog();
		const r = ensureSupervisor({
			db,
			service: "ghost",
			repo: "/repo/.git",
			launchdDir: "/no/such/dir",
			launchAgentsDir: "/no/la",
			vars: {},
			sh,
		});
		expect(r.ok).toBe(false);
		expect(calls).toHaveLength(0);
		expect(supervisorRows(db)).toHaveLength(0);
	});

	test("unrendered placeholder refuses to install", () => {
		const { tplDir, laDir } = setup();
		// overwrite with a template whose var is NOT in the vars map
		writeFileSync(
			join(tplDir, "com.suspenders.board.plist"),
			"<plist>__NOT_A_VAR__</plist>",
		);
		const db = memDb();
		const { sh } = shLog();
		const r = ensureSupervisor({
			db,
			service: "board",
			repo: "/repo/.git",
			launchdDir: tplDir,
			launchAgentsDir: laDir,
			vars: plistVars({
				bun: "b",
				home: "h",
				prefix: "p",
				repo: "r",
				beltUrl: "u",
				beltToken: "t",
			}),
			sh,
		});
		expect(r.ok).toBe(false);
		rmSync(tplDir, { recursive: true, force: true });
	});

	test("bootstrap failure: honest ok:false, row still claims the service", () => {
		const { tplDir, laDir } = setup();
		const db = memDb();
		const { sh } = shLog({
			bootstrap: { code: 1, out: "Bootstrap failed: 5: Input/output error" },
		});
		const r = ensureSupervisor({
			db,
			service: "board",
			repo: "/repo/.git",
			launchdDir: tplDir,
			launchAgentsDir: laDir,
			vars: plistVars({
				bun: "b",
				home: "h",
				prefix: "p",
				repo: "r",
				beltUrl: "u",
				beltToken: "t",
			}),
			sh,
		});
		expect(r.ok).toBe(false);
		expect(r.line).toContain("bootstrap exit 1");
		expect(supervisorRows(db)).toHaveLength(1); // status will show it DOWN
		rmSync(tplDir, { recursive: true, force: true });
	});
});

// ─── SessionStart fact line ──────────────────────────────────────────────────

describe("supervisorFactLine", () => {
	const live = (over: Partial<SupervisorLive> = {}): SupervisorLive => ({
		label: "com.suspenders.board",
		service: "board",
		repo: "/repo/.git",
		pid: 42,
		state: "UP",
		repoMatch: true,
		...over,
	});

	test("all UP → terse fact, no fix command", () => {
		const line = supervisorFactLine([live()], "/coord.ts");
		expect(line).toBe("SUPERVISOR 1 UP (board)");
	});

	test("down services carry the fix command", () => {
		const line = supervisorFactLine(
			[live({ state: "NOT-LOADED", pid: null })],
			"/coord.ts",
		);
		expect(line).toContain("board NOT-LOADED");
		expect(line).toContain("supervisor ensure");
	});

	test("foreign-repo rows never alarm", () => {
		const line = supervisorFactLine(
			[live({ repoMatch: false, state: "DOWN", pid: null })],
			"/coord.ts",
		);
		expect(line).toBeNull();
	});

	test("no rows → null (silent bootstrap)", () => {
		expect(supervisorFactLine([], "/coord.ts")).toBeNull();
	});

	test("UNKNOWN probe → null (never cries wolf)", () => {
		expect(
			supervisorFactLine([live({ state: "UNKNOWN" })], "/coord.ts"),
		).toBeNull();
	});
});

// ─── misc ────────────────────────────────────────────────────────────────────

describe("labels", () => {
	test("labelOf / serviceOf round-trip, foreign labels rejected", () => {
		expect(labelOf("board")).toBe("com.suspenders.board");
		expect(serviceOf("com.suspenders.board")).toBe("board");
		expect(serviceOf("com.belt.gateway")).toBeNull();
	});
});

describe("launchctlTable", () => {
	test("probe failure → ok:false (UNKNOWN downstream)", () => {
		const { sh } = shLog({
			"launchctl list": { code: 127, out: "" },
		});
		const t = launchctlTable(sh);
		expect(t.ok).toBe(false);
	});

	test("successful probe parses the table", () => {
		const { sh } = shLog({
			"launchctl list": {
				code: 0,
				out: "99\t0\tcom.suspenders.board\n",
			},
		});
		const t = launchctlTable(sh);
		expect(t.ok).toBe(true);
		expect(t.table.get("com.suspenders.board")).toBe(99);
	});
});

// ─── real migration shape (temp-HOME isolation) ──────────────────────────────

describe("v11 migration", () => {
	test("openGovernorDb creates the supervisors table with the designed columns", () => {
		mkdirSync(join(MHOME, ".cache", "claude-governor"), { recursive: true });
		govdb.openGovernorDb();
		const d = new Database(
			join(MHOME, ".cache", "claude-governor", "governor.db"),
		);
		const uv = (
			d.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBe(11);
		const cols = (
			d.query("PRAGMA table_info(supervisors)").all() as { name: string }[]
		).map((c) => c.name);
		expect(cols).toEqual(["label", "repo", "plist", "service", "ts"]);
		d.close();
	});
});
