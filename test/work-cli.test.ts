// test/work-cli.test.ts — end-to-end suite for the Work Graph CLI (bin/work.ts).
// Every test spawns `bun bin/work.ts <cmd>` against an isolated temp HOME
// (fresh governor.db) and a temp git repo created under process.cwd() for
// project identity. The repo must NEVER live under /tmp: the bash gate
// exempts /tmp paths by design, so a /tmp checkout would silently test
// nothing (on Linux os.tmpdir() IS /tmp). Each temp repo gets a real
// `git init`: an empty mkdir'd .git is NOT a valid gitdir, and discovery
// would walk up into the checkout's own .git, colliding project identity.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "claude-work-cli-home-"));
const gitInit = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	const r = Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
	if (r.exitCode !== 0) throw new Error(`git init failed in ${dir}`);
};
const REPO = mkdtempSync(join(process.cwd(), ".tmp-work-cli-repo-"));
gitInit(REPO);
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

function workIn(cwd: string, ...args: string[]): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}
const work = (...args: string[]) => workIn(REPO, ...args);
const idOf = (out: string): string => (out.match(/W\d+(?:\.\d+)*/) ?? [])[0] ?? "";
const rootNum = (id: string): number => Number(id.slice(1).split(".")[0]);
const firstLine = (s: string): string => (s.split("\n")[0] ?? "").trim();

function withDb(fn: (db: Database) => void): void {
	const db = new Database(DB, { create: true });
	fn(db);
	db.close();
}

/** take → done: the disciplined completion path. */
function finish(id: string, sid: string): { code: number; out: string; err: string } {
	const t = work("take", id, "--as", sid);
	if (t.code !== 0) return t;
	return work("done", id, "--sha", `sha-${sid}`);
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("add — id allocation", () => {
	test("root ids allocate sequentially per project", () => {
		const a = idOf(work("add", "alpha item").out);
		const b = idOf(work("add", "beta item").out);
		expect(a).toMatch(/^W\d+$/);
		expect(rootNum(b)).toBe(rootNum(a) + 1);
	});

	test("child ids nest under --parent", () => {
		const p = idOf(work("add", "parent item").out);
		expect(idOf(work("add", "kid one", "--parent", p).out)).toBe(`${p}.1`);
		expect(idOf(work("add", "kid two", "--parent", p).out)).toBe(`${p}.2`);
	});

	test("missing title and unknown options are refused", () => {
		expect(work("add").err).toContain("usage: add <title>");
		expect(work("add", "x", "--bogus", "y").err).toContain("unknown option: --bogus");
	});
});

describe("take — CAS claim", () => {
	test("take claims; a second take is refused", () => {
		const a = idOf(work("add", "contested").out);
		expect(work("take", a, "--as", "lane-one").code).toBe(0);
		const again = work("take", a, "--as", "lane-two");
		expect(again.code).toBe(2);
		expect(again.err).toContain("was taken");
	});

	test("take refuses nonexistent ids and unmet dependencies", () => {
		expect(work("take", "W404", "--as", "any").err).toContain("no such work item");
		const g = idOf(work("add", "gate target").out);
		const d = idOf(work("add", "dependent").out);
		work("block", d, "--on", g);
		expect(work("take", d, "--as", "any").err).toContain("unmet dependencies");
	});

	test("concurrent takes race: exactly one CAS wins", async () => {
		const id = idOf(work("add", "race item").out);
		const procs = ["racer-1", "racer-2"].map((sid) =>
			Bun.spawn(["bun", join(BIN, "work.ts"), "take", id, "--as", sid], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" }),
		);
		const codes = await Promise.all(procs.map((p) => p.exited));
		expect(codes.filter((c) => c === 0).length).toBe(1);
	});
});

describe("split — shatter, child ids, roll-up", () => {
	test("split creates dotted child ids and shatters the parent", () => {
		const p = idOf(work("add", "shatter me").out);
		const s = work("split", p, "child a", "child b", "--reason", "independent-scopes");
		expect(s.code).toBe(0);
		expect(s.out).toContain(`${p}.1`);
		expect(s.out).toContain(`${p}.2`);
		expect(firstLine(work("show", p).out)).toContain("SHATTERED");
	});

	test("split without --reason is refused", () => {
		const p = idOf(work("add", "no reason").out);
		expect(work("split", p, "a", "b").err).toContain("usage: split");
	});

	test("--keep leaves the claimed child with the owner", () => {
		const p = idOf(work("add", "keep root").out);
		expect(work("take", p, "--as", "lane-keep").code).toBe(0);
		const s = work("split", p, "kept", "handed", "--reason", "independent-scopes", "--keep", "1");
		expect(s.code).toBe(0);
		expect(firstLine(work("show", `${p}.1`).out)).toContain("CLAIMED");
		expect(firstLine(work("show", `${p}.2`).out)).toContain("READY");
	});
});

describe("done — roll-up for shattered parents", () => {
	test("parent stays SHATTERED until every required child is DONE, then rolls up", () => {
		const p = idOf(work("add", "rollup root").out);
		expect(work("split", p, "c1", "c2", "--reason", "independent-scopes").code).toBe(0);
		expect(work("done", `${p}.1`, "--sha", "s1").code).not.toBe(0); // this repo: READY work cannot be marked done...
		expect(work("take", `${p}.1`, "--as", "lane-r1").code).toBe(0); // ...claim it first
		expect(work("done", `${p}.1`, "--sha", "s1").code).toBe(0);
		expect(firstLine(work("show", p).out)).toContain("SHATTERED");
		expect(work("take", `${p}.2`, "--as", "lane-r2").code).toBe(0);
		expect(work("done", `${p}.2`, "--sha", "s2").code).toBe(0);
		expect(firstLine(work("show", p).out)).toContain("DONE");
	});

	test("nested shatters roll up recursively", () => {
		const q = idOf(work("add", "nested root").out);
		expect(work("split", q, "x", "y", "--reason", "independent-scopes").code).toBe(0);
		expect(work("split", `${q}.1`, "x1", "x2", "--reason", "independent-scopes").code).toBe(0);
		expect(work("take", `${q}.2`, "--as", "lane-n2").code).toBe(0);
		expect(work("done", `${q}.2`, "--sha", "s").code).toBe(0);
		expect(firstLine(work("show", q).out)).toContain("SHATTERED");
		expect(work("take", `${q}.1.1`, "--as", "lane-n11").code).toBe(0);
		expect(work("done", `${q}.1.1`, "--sha", "s").code).toBe(0);
		expect(firstLine(work("show", q).out)).toContain("SHATTERED");
		expect(work("take", `${q}.1.2`, "--as", "lane-n12").code).toBe(0);
		expect(work("done", `${q}.1.2`, "--sha", "s").code).toBe(0);
		expect(firstLine(work("show", `${q}.1`).out)).toContain("DONE");
		expect(firstLine(work("show", q).out)).toContain("DONE");
	});

	test("FAILED required child blocks the parent; supersession closes", () => {
		const p = idOf(work("add", "failure root").out);
		expect(work("split", p, "a", "b", "--reason", "independent-scopes").code).toBe(0);
		expect(work("fail", `${p}.1`, "--note", "blew up").code).toBe(0);
		expect(finish(`${p}.2`, "lane-fb").code).toBe(0);
		expect(firstLine(work("show", p).out)).toContain("SHATTERED"); // FAILED blocks
		expect(work("supersede", `${p}.1`, "--by", `${p}.9`).code).toBe(0);
		expect(firstLine(work("show", p).out)).toContain("DONE");
	});

	test("done without an id prints usage", () => {
		expect(work("done").err).toContain("usage: done <id> [--as sid] --sha <sha>");
	});
});

describe("ready — dependency gating", () => {
	test("blocked items leave ready until their dependency is DONE", () => {
		const a = idOf(work("add", "gate a").out);
		const b = idOf(work("add", "gate b").out);
		expect(work("block", b, "--on", a).code).toBe(0);
		let ready = work("ready").out;
		expect(ready).toContain(a);
		expect(ready).not.toContain(b);
		expect(work("show", b).out).toContain(`depends on: ${a}(READY)`);
		expect(work("take", a, "--as", "lane-gate").code).toBe(0); // claim before done (transition guard)
		expect(work("done", a, "--sha", "s").code).toBe(0);
		ready = work("ready").out;
		expect(ready).toContain(b);
	});

	test("claimed items are not ready; list still shows them", () => {
		const c = idOf(work("add", "claimed item").out);
		expect(work("take", c, "--as", "lane-c").code).toBe(0);
		expect(work("ready").out).not.toContain(c);
		expect(work("list").out).toContain(c);
	});
});

describe("capability filter on take", () => {
	test("requires ⊆ session capabilities or take refuses", () => {
		withDb((db) => {
			const ins = db.query(
				"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path) VALUES (?, ?, 'worker', NULL, NULL, ?, ?, 'RUNNING', ?, NULL)",
			);
			ins.run("cap-fs", REPO, Date.now(), Date.now(), "shell,fs");
			ins.run("cap-build", REPO, Date.now(), Date.now(), "shell,build");
		});
		const c = idOf(work("add", "needs a compiler", "--requires", "build").out);
		const no = work("take", c, "--as", "cap-fs");
		expect(no.code).toBe(2);
		expect(no.err).toContain("requires [build]");
		expect(work("take", c, "--as", "cap-build").code).toBe(0);
		// no requires = no constraint, even for an unregistered sid
		const u = idOf(work("add", "no capability gate").out);
		expect(work("take", u, "--as", "never-bootstrapped").code).toBe(0);
	});
});

describe("mine / owned / orphaned", () => {
	test("mine filters by owner, owned lists all, orphaned finds dead claims", () => {
		const m = idOf(work("add", "owned item").out);
		expect(work("take", m, "--as", "lane-mine").code).toBe(0);
		expect(work("mine", "--as", "lane-mine").out).toContain(m);
		expect(work("mine", "--as", "lane-nobody").out).toContain("(nothing owned)");
		expect(work("owned").out).toContain(m);
		// temp HOME has no transcripts ⇒ every claim is dead ⇒ orphaned
		expect(work("orphaned").out).toContain(m);
	});

	test("mine without --as prints usage", () => {
		expect(work("mine").err).toContain("usage: mine --as <sid>");
	});
});

describe("release / reclaim", () => {
	test("release returns the item to READY and drops ownership", () => {
		const d = idOf(work("add", "release me").out);
		expect(work("take", d, "--as", "lane-rel").code).toBe(0);
		expect(work("release", d, "--as", "lane-rel").code).toBe(0);
		expect(work("mine", "--as", "lane-rel").out).toContain("(nothing owned)");
		expect(work("ready").out).toContain(d);
	});

	test("reclaim rescues CLAIMED and ORPHANED, refuses READY", () => {
		const r = idOf(work("add", "reclaim me").out);
		expect(work("take", r, "--as", "lane-gone").code).toBe(0);
		expect(work("reclaim", r).code).toBe(0);
		expect(firstLine(work("show", r).out)).toContain("READY");
		withDb((db) =>
			db.query("UPDATE work_items SET state = 'ORPHANED' WHERE project = (SELECT project FROM work_items WHERE id = ?) AND id = ?").run(r, r),
		);
		expect(work("reclaim", r).code).toBe(0);
		const stale = work("reclaim", r); // now READY — nothing to reclaim
		expect(stale.code).toBe(2);
		expect(stale.err).toContain("only CLAIMED/RUNNING/ORPHANED");
	});
});

describe("block — dependencies and cycles", () => {
	test("block on a missing item is refused", () => {
		const e = idOf(work("add", "edge case").out);
		expect(work("block", e, "--on", "W404").err).toContain("no such work item");
	});

	test("cycle-forming blocks are refused", () => {
		const a = idOf(work("add", "cycle a").out);
		const b = idOf(work("add", "cycle b").out);
		expect(work("block", b, "--on", a).code).toBe(0);
		const cyc = work("block", a, "--on", b);
		expect(cyc.code).toBe(2);
		expect(cyc.err).toContain("dependency cycle");
	});

	test("unblock clears the edge and frees the item for ready", () => {
		const u = idOf(work("add", "unblock target").out);
		const w = idOf(work("add", "unblock waiter").out);
		work("block", w, "--on", u);
		expect(work("ready").out).not.toContain(w);
		expect(work("unblock", w, "--on", u).code).toBe(0);
		expect(work("ready").out).toContain(w);
	});
});

describe("project partitioning", () => {
	test("another repo sees none of this project's work", () => {
		const repo2 = mkdtempSync(join(process.cwd(), ".tmp-work-cli-repo2-"));
		gitInit(repo2);
		try {
			expect(workIn(repo2, "list").out).toContain("(none)");
			const any = idOf(work("add", "visibility probe").out);
			expect(workIn(repo2, "show", any).err).toContain("no such work item in this project");
		} finally {
			rmSync(repo2, { recursive: true, force: true });
		}
	});
});

describe("usage surface", () => {
	test("arg-less commands print their usage and exit 2", () => {
		expect(work("take").err).toContain("usage: take <id> --as <sid>");
		expect(work("supersede", "W1").err).toContain("usage: supersede <id> --by <new-id>");
		expect(work("block", "W1").err).toContain("usage: block <id> --on <other-id>");
	});

	test("unknown command dies, --help wins everywhere", () => {
		expect(work("bogus-cmd").err).toContain("unknown command");
		expect(work("--help").code).toBe(0);
		expect(work("add", "x", "--help").code).toBe(0);
	});
});

describe("finish helper sanity", () => {
	test("take → done marks DONE with the sha", () => {
		const f = idOf(work("add", "finish probe").out);
		const r = finish(f, "lane-finish");
		expect(r.code).toBe(0);
		expect(firstLine(work("show", f).out)).toContain("DONE");
	});
});

describe("split gate — more than 2 children requires --plan", () => {
	test("1-2 child splits stay free", () => {
		const p = idOf(work("add", "free split").out);
		expect(work("split", p, "a", "b", "--reason", "independent-scopes").code).toBe(0);
	});

	test("3+ children without --plan is refused, no partial state", () => {
		const p = idOf(work("add", "drive-by fan-out").out);
		const r = work("split", p, "a", "b", "c", "--reason", "independent-scopes");
		expect(r.code).toBe(2);
		expect(r.err).toContain("--plan");
		expect(firstLine(work("show", p).out)).toContain("READY"); // parent untouched
		expect(work("list").out).not.toContain(`${p}.1`); // no children created
	});

	test("--plan must reference an existing graph item", () => {
		const p = idOf(work("add", "phantom plan").out);
		const r = work("split", p, "a", "b", "c", "--reason", "independent-scopes", "--plan", "W404");
		expect(r.code).toBe(2);
		expect(r.err).toContain("--plan");
		expect(r.err).toContain("W404");
	});

	test("3 children with a registered plan shatter atomically", () => {
		const plan = idOf(work("add", "the registered plan").out);
		const p = idOf(work("add", "gated fan-out").out);
		const r = work("split", p, "a", "b", "c", "--reason", "independent-scopes", "--plan", plan);
		expect(r.code).toBe(0);
		expect(r.out).toContain(`${p}.3`);
		expect(firstLine(work("show", p).out)).toContain("SHATTERED");
	});
});

describe("migrate-ledger", () => {
	test("imports unresolved lines", () => {
		const led = join(REPO, "OPS-LEDGER.md");
		writeFileSync(
			led,
			[
				"# Ops ledger",
				"",
				"- IN-FLIGHT: fix the flange",
				"- [ ] write the parser battery",
				"- [x] closed long ago",
				"2. BLOCKED: wait on vendor",
				"3. PAUSED — revisit quoting",
				"- OWNER-GATED: publish the board",
				"",
				"## Architecture",
				"The system uses a queue.",
				"",
				"```",
				"- TODO: example in a fence, must be skipped",
				"```",
				"",
			].join("\n"),
		);
		const r = work("migrate-ledger", led);
		expect(r.code).toBe(0);
		// five unresolved lines imported; markers and numbering stripped
		for (const t of ["fix the flange", "write the parser battery", "wait on vendor", "revisit quoting", "publish the board"]) {
			expect(r.out).toContain(t);
			expect(work("list").out).toContain(t);
		}
		// checked task, prose, heading, fenced example: none imported
		expect(r.out).not.toContain("closed long ago");
		expect(work("list").out).not.toContain("closed long ago");
		expect(r.out).not.toContain("example in a fence");
	});

	test("tombstone appended, points at the graph, single on re-run", () => {
		const led = join(REPO, "OPS-LEDGER.md");
		const r = work("migrate-ledger", led);
		expect(r.code).toBe(0);
		const text = readFileSync(led, "utf8");
		expect(text).toContain("Migrated to the Work Graph");
		expect(text).toContain("work done <id> --sha <sha>");
		expect(text.split("<!-- work-migrate-tombstone -->").length - 1).toBe(1);
	});

	test("idempotent on re-run: no new items", () => {
		const led = join(REPO, "OPS-LEDGER.md");
		const count = (s: string): number => (s.match(/·|◐|▶|⚠|⏸|⊞|◌|✗/g) ?? []).length;
		const before = count(work("list").out);
		const r = work("migrate-ledger", led);
		expect(r.code).toBe(0);
		expect(count(work("list").out)).toBe(before);
		expect(r.out).toContain("already in the graph");
	});

	test("dedupes against items already in the graph", () => {
		work("add", "sync the cache");
		const led2 = join(REPO, "LEDGER2.md");
		writeFileSync(led2, "- TODO sync the cache\n- [ ] brand new thing\n");
		const r = work("migrate-ledger", led2);
		expect(r.code).toBe(0);
		expect(r.out).toContain("already in the graph");
		const list = work("list").out;
		expect(list.split("sync the cache").length - 1).toBe(1);
	});

	test("imported items stay READY — a human closes them", () => {
		const led3 = join(REPO, "LEDGER3.md");
		writeFileSync(led3, "- TODO unique threshold work\n");
		const r = work("migrate-ledger", led3);
		expect(r.code).toBe(0);
		expect(firstLine(work("show", idOf(r.out)).out)).toContain("READY");
	});

	test("missing path or missing file is refused", () => {
		expect(work("migrate-ledger").err).toContain("usage: migrate-ledger <path>");
		expect(work("migrate-ledger", join(REPO, "NOPE.md")).code).toBe(2);
	});
});
