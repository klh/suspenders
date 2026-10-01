// test/supervise.test.ts — W146: the micro-supervisor loop. Covered against
// a REAL scratch governor db + scratch repo (same rig as dispatch-next's
// tests): dry-run prints the plan with zero side effects; a childless parent
// with no titles escalates NEED_DECISION to its coordinator; supervisor-run
// shatter + dispatch; scope isolation (sibling subtree untouched, parent
// chain check via inScope); idempotent restart (same-sid resume, no
// double-claim, dep-order dispatch); integration (verify-mode escalation for
// an unmerged sha, merge-mode lands the branch and the subtree closes with
// evidence fact + capsule).
import { describe, expect, test, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inScope } from "../scripts/supervise.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w146-sup-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-w146-sup-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const env = {
	...process.env,
	HOME,
	PATH: `${join(HOME, "bin")}:${process.env.PATH}`,
};

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");
// fake claude: supervise spawns this instead of a real lane (tests never
// spawn real lanes — dry-run + scratch db only)
const FAKE = join(HOME, "bin", "claude");
mkdirSync(join(HOME, "bin"), { recursive: true });
writeFileSync(FAKE, '#!/bin/sh\necho "fake lane: $*"\n');
chmodSync(FAKE, 0o755);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

import { spawnSync } from "node:child_process";
const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

const tool = (bin: string, ...args: string[]) => {
	const p = Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(
			`${bin} ${args.join(" ")} failed (${p.exitCode}): ${p.stderr.toString()}`,
		);
	return { out: p.stdout.toString(), code: p.exitCode ?? 1 };
};
const sup = (...args: string[]) => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "supervise.ts"),
			...args,
			"--grace-ms",
			"0",
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

const PROJECT = realpathSync(
	resolve(
		REPO,
		spawnSync("/usr/bin/git", ["-C", REPO, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
		}).stdout.trim(),
	),
);
const db = () =>
	new Database(`${HOME}/.cache/claude-governor/governor.db`, {
		readonly: true,
	});

const addItem = (title: string): string => {
	const r = tool("work.ts", "add", title);
	const id = (r.out.match(/W\d+/) ?? [])[0] ?? "";
	expect(id).toBeTruthy();
	return id;
};
const state = (
	id: string,
): { state: string; owner_sid: string | null; result_sha: string | null } => {
	const d = db();
	const row = d
		.query(
			"SELECT state, owner_sid, result_sha FROM work_items WHERE project = ? AND id = ?",
		)
		.get(PROJECT, id) as
		| { state: string; owner_sid: string | null; result_sha: string | null }
		| undefined;
	d.close();
	if (!row) throw new Error(`no item ${id}`);
	return row;
};
const decisionEvents = (target: string): { note: string }[] => {
	const d = db();
	const rows = d
		.query(
			"SELECT payload FROM events WHERE kind = 'NEED_DECISION' AND target = ?",
		)
		.all(target) as { payload: string }[];
	d.close();
	return rows.map((r) => JSON.parse(r.payload) as { note: string });
};
const factValue = (key: string): string | null => {
	const d = db();
	const row = d.query("SELECT value FROM facts WHERE key = ?").get(key) as
		| { value: string }
		| undefined;
	d.close();
	return row?.value ?? null;
};
const sidOf = (item: string): string =>
	`autow${item.replace(/^W/, "").replace(/\./g, "")}`;
const commitIn = (wt: string, msg: string): string => {
	writeFileSync(join(wt, "feature.txt"), msg);
	g(["-C", wt, "add", "-A"]);
	g(["-C", wt, "commit", "-m", msg]);
	return spawnSync("/usr/bin/git", ["-C", wt, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).stdout.trim();
};
const ancestorOfMain = (sha: string): boolean =>
	spawnSync(
		"/usr/bin/git",
		["-C", REPO, "merge-base", "--is-ancestor", sha, "main"],
		{ encoding: "utf8" },
	).status === 0;

describe("W146 micro-supervisor", () => {
	test("dry-run prints the plan with zero side effects", () => {
		const p = addItem("dry run fixture parent");
		tool("work.ts", "split", p, "kid a", "kid b", "--reason", "fixture");
		const kids = spawnSync(
			"/usr/bin/git",
			["-C", REPO, "rev-parse", "--git-common-dir"],
			{ encoding: "utf8" },
		);
		expect(kids.status).toBe(0);
		const r = sup(p, "--dry-run", "--once");
		expect(r.code).toBe(0);
		expect(r.out).toContain("DRY dispatch");
		// no state change: children still READY, no fleet/worktree writes
		const show = tool("work.ts", "show", p);
		expect(show.out).toContain("SHATTERED");
		expect(existsSync(join(REPO, ".worktrees"))).toBe(false);
		expect(existsSync(join(REPO, ".fleet"))).toBe(false);
	});

	test("childless parent with no titles escalates NEED_DECISION (once)", () => {
		const p = addItem("childless fixture parent");
		const r = sup(p, "--once", "--to", "coord-a");
		expect(r.out).toContain("NEED_DECISION");
		const events = decisionEvents("coord-a");
		expect(events.length).toBe(1);
		expect(events[0].note).toContain(p);
		// second run: journal dedupes — no repeat escalation
		sup(p, "--once", "--to", "coord-a");
		expect(decisionEvents("coord-a").length).toBe(1);
		// parent untouched
		expect(state(p).state).toBe("READY");
	});

	test("supervisor-run shatter dispatches the fresh children", () => {
		const p = addItem("shatter fixture parent");
		const r = sup(p, "kid one", "kid two", "--once");
		expect(r.out).toContain("shattering");
		const show = tool("work.ts", "show", p);
		expect(show.out).toContain(`${p}.1`);
		const s1 = state(`${p}.1`);
		const s2 = state(`${p}.2`);
		expect(s1.state).toBe("CLAIMED");
		expect(s1.owner_sid).toBe(sidOf(`${p}.1`));
		expect(s2.state).toBe("CLAIMED");
		expect(existsSync(join(REPO, ".worktrees", `${p}.1`))).toBe(true);
	});

	test("scope isolation: sibling subtree untouched, inScope walks chains", () => {
		const p = addItem("scope fixture parent");
		tool("work.ts", "split", p, "mine a", "mine b", "--reason", "fixture");
		const other = addItem("foreign parent");
		tool("work.ts", "add", "not mine", "--parent", other);
		const d = db();
		expect(inScope(d, PROJECT, p, `${p}.1`)).toBe(true);
		expect(inScope(d, PROJECT, p, p)).toBe(true);
		expect(inScope(d, PROJECT, p, `${other}.1`)).toBe(false);
		const grand = tool("work.ts", "add", "grandkid", "--parent", `${p}.1`);
		const gid = (grand.out.match(/W[\d.]+/) ?? [])[0] ?? "";
		expect(gid).toContain(".");
		expect(inScope(d, PROJECT, p, gid)).toBe(true);
		d.close();
		const r = sup(p, "--once");
		expect(r.out).toContain(`dispatched ${p}.1`);
		// the foreign child was never touched
		expect(state(`${other}.1`).state).toBe("READY");
		expect(existsSync(join(REPO, ".worktrees", `${other}.1`))).toBe(false);
	});

	test("restart resumes same-sid; dep order; integrate; close with evidence", () => {
		const p = addItem("dep-order fixture parent");
		tool("work.ts", "split", p, "first", "second", "--reason", "fixture");
		const c1 = `${p}.1`;
		const c2 = `${p}.2`;
		tool("work.ts", "block", c2, "--on", c1);
		// run 1: only the dep-free child dispatches
		const r1 = sup(p, "--once");
		expect(r1.out).toContain(`dispatched ${c1}`);
		expect(r1.out).not.toContain(`dispatched ${c2}`);
		expect(state(c1).owner_sid).toBe(sidOf(c1));
		expect(state(c2).state).toBe("READY");
		// run 2 (restart): dead lane resumed under the SAME sid — no re-claim
		const r2 = sup(p, "--once");
		expect(r2.out).toContain(`dispatched ${c1}`);
		expect(state(c1).owner_sid).toBe(sidOf(c1));
		const lanes = JSON.parse(
			readFileSync(join(REPO, ".fleet", "lanes.json"), "utf8"),
		) as { sid: string; item: string }[];
		const entries = lanes.filter((l) => l.item === c1);
		expect(entries.length).toBe(2);
		expect(new Set(entries.map((l) => l.sid))).toEqual(new Set([sidOf(c1)]));
		// the lane finishes: commit on its branch, mark DONE (landing chain)
		const sha1 = commitIn(join(REPO, ".worktrees", c1), "first child work");
		expect(
			tool("work.ts", "done", c1, "--sha", sha1, "--as", sidOf(c1)).code,
		).toBe(0);
		// run 3: verify mode — DONE-but-unmerged sha escalates, never closes
		const r3 = sup(p, "--once", "--integrate", "verify", "--to", "coord-a");
		expect(r3.out).toContain("NEED_DECISION");
		expect(decisionEvents("coord-a").some((e) => e.note.includes(c1))).toBe(
			true,
		);
		// run 4: merge mode — the child branch lands on main
		const r4 = sup(p, "--once", "--integrate", "merge");
		expect(r4.out).toContain("integrating");
		expect(ancestorOfMain(sha1)).toBe(true);
		expect(factValue(`supervise.${p.toLowerCase()}.integrated`)).toContain(c1);
		// run 5: with the dep merged, the blocked child is now dispatchable
		const r5 = sup(p, "--once", "--integrate", "merge");
		expect(r5.out).toContain(`dispatched ${c2}`);
		// the second lane finishes straight on main (already integrated)
		const sha2 = commitIn(REPO, "second child work");
		expect(
			tool("work.ts", "done", c2, "--sha", sha2, "--as", sidOf(c2)).code,
		).toBe(0);
		// run 6: subtree terminal + integrated → close with evidence
		const r6 = sup(p, "--once", "--integrate", "merge");
		if (r6.code !== 0) throw new Error(`run6 failed: ${r6.err}\n${r6.out}`);
		expect(r6.code).toBe(0);
		expect(r6.out).toContain("CLOSED");
		expect(state(p).state).toBe("DONE");
		expect(factValue(`supervise.${p.toLowerCase()}.closed`)).toContain(p);
		const cap = tool("coord.ts", "capsule", "get", "--as", `sup${p.slice(1)}`);
		expect(cap.out).toContain("subtree closed");
		// interfaces down: the child brief carried the aids + supervision stanzas
		const brief = readFileSync(
			join(REPO, ".fleet", `brief-${sidOf(c1)}.md`),
			"utf8",
		);
		expect(brief).toContain("AIDS (knowledge interfaces):");
		expect(brief).toContain("SUPERVISION:");
		expect(brief).toContain("aids: (preseeding placeholder");
	}, 120000);
});
