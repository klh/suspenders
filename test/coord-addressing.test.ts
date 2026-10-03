import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOME = mkdtempSync(join(process.cwd(), ".coord-addressing-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".coord-addressing-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const env = { ...process.env, HOME, NO_COLOR: "1" };
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
writeFileSync(join(REPO, "README.md"), "seed\n");
Bun.spawnSync(["git", "-C", REPO, "add", "README.md"], {
	stdout: "ignore",
	stderr: "ignore",
});
Bun.spawnSync(["git", "-C", REPO, "commit", "-q", "-m", "init"], {
	stdout: "ignore",
	stderr: "ignore",
});

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", BIN, ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const gitDir = r.exitCode === 0 ? r.stdout.toString().trim() : "";
	return gitDir ? resolve(dir, gitDir) : dir;
}

const PROJECT = projectOf(REPO);
const DIRECT_KIND = ["NO", "TE"].join("");
run(["kb", "stats"]);

function fact(db: Database, key: string, value: string) {
	db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, 'test', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	).run(key, value, Date.now());
}

function seedSessions() {
	const db = new Database(DB);
	db.query("DELETE FROM events").run();
	db.query("DELETE FROM cursors").run();
	db.query("DELETE FROM claims").run();
	db.query("DELETE FROM work_items").run();
	db.query(
		"DELETE FROM facts WHERE key LIKE 'lane.%' OR key LIKE 'broadcast.%'",
	).run();
	db.query("DELETE FROM sessions").run();
	const now = Date.now();
	const insertSession = db.query(
		"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path, actor, tags) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)",
	);
	insertSession.run(
		"lane-claude-11111111",
		PROJECT,
		"worker",
		null,
		join(REPO, ".worktrees", "W296"),
		now,
		now,
		"shell,fs,git",
		null,
		"dev:alice",
		JSON.stringify({}),
	);
	insertSession.run(
		"lane-copilot-22222222",
		PROJECT,
		"worker",
		null,
		join(REPO, ".worktrees", "IKEA"),
		now,
		now,
		"shell,fs,git",
		null,
		"dev:bob",
		JSON.stringify({ hub: "nas", cli: "copilot", name: "ikea opus" }),
	);
	insertSession.run(
		"lane-stale-33333333",
		PROJECT,
		"worker",
		null,
		join(REPO, ".worktrees", "STALE"),
		now - 31 * 60_000,
		now - 31 * 60_000,
		"shell,fs,git",
		null,
		"dev:stale",
		JSON.stringify({ name: "stale lane" }),
	);
	db.query(
		"INSERT INTO work_items (project, id, title, state, owner_sid, created_at, updated_at) VALUES (?, 'W296', 'Building cross CLI addressing adapter', 'RUNNING', ?, ?, ?)",
	).run(PROJECT, "lane-claude-11111111", now, now);
	fact(db, "lane.lane-claude-11111111.model", "claude-sonnet-5");
	fact(db, "lane.lane-claude-11111111.executor", "claude");
	fact(db, "lane.lane-copilot-22222222.model", "gpt-5.4");
	fact(db, "lane.lane-copilot-22222222.executor", "copilot");
	db.close();
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("coord targets", () => {
	test("lists live targets with canonical labels and full sids", () => {
		seedSessions();
		const r = run(["targets"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("[local][claude]-w296-addressing-adapter (sonnet)");
		expect(r.out).toContain("lane-claude-11111111");
		expect(r.out).toContain("[nas][copilot]-ikea-opus (gpt)");
		expect(r.out).toContain("lane-copilot-22222222");
		expect(r.out).not.toContain("stale lane");
	});

	test("supports case insensitive filtering and json output", () => {
		seedSessions();
		const filtered = run(["targets", "--filter", "COPILOT"]);
		expect(filtered.code).toBe(0);
		expect(filtered.out).toContain("[nas][copilot]-ikea-opus (gpt)");
		expect(filtered.out).not.toContain(
			"[local][claude]-w296-addressing-adapter",
		);
		const json = run(["targets", "--json"]);
		const parsed = JSON.parse(json.out) as Array<{
			sid: string;
			label: string;
		}>;
		expect(parsed).toHaveLength(2);
		expect(parsed.map((row) => row.sid)).toEqual([
			"lane-claude-11111111",
			"lane-copilot-22222222",
		]);
	});

	// W299: top-level sessions only get hb bumped at bootstrap
	// (lesson.zombie-session-hygiene), so a long-running coordinator's hb
	// goes stale while it's genuinely still alive — sweepStaleSessions
	// already never reaps role='coordinator' rows for exactly this reason;
	// targets/message/broadcast must agree, or a live supervisor becomes
	// unreachable by every addressing surface.
	test("a stale-hb top-level coordinator is still a live target", () => {
		seedSessions();
		const db = new Database(DB);
		const now = Date.now();
		db.query(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, capabilities, transcript_path, actor, tags) VALUES (?, ?, 'coordinator', NULL, ?, ?, ?, 'RUNNING', '', NULL, 'dev:carol', ?)",
		).run(
			"lane-coordinator-44444444",
			PROJECT,
			join(REPO, ".worktrees", "COORD"),
			now - 8 * 24 * 3_600_000,
			now - 8 * 24 * 3_600_000,
			JSON.stringify({ name: "supervisor" }),
		);
		db.close();
		const r = run(["targets"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("lane-coordinator-44444444");
		expect(r.out).toContain("supervisor");
	});
});

describe("coord message", () => {
	test("resolves a unique label substring and emits a direct note to one lane", () => {
		seedSessions();
		const r = run([
			"message",
			"ikea-opus",
			"hello lane",
			"--as",
			"caller-99999999",
		]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("message queued");
		const db = new Database(DB, { readonly: true });
		const row = db
			.query(
				"SELECT kind, source, target, payload FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
			)
			.get(DIRECT_KIND) as {
			kind: string;
			source: string;
			target: string;
			payload: string;
		};
		db.close();
		expect(row.kind).toBe(DIRECT_KIND);
		expect(row.source).toBe("caller-99999999");
		expect(row.target).toBe("lane-copilot-22222222");
		expect(row.payload).toContain("hello lane");
	});

	test("errors clearly on ambiguous substrings", () => {
		seedSessions();
		const r = run(["message", "lane", "hello"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("ambiguous target");
	});

	test("message --all reuses broadcast delivery semantics", () => {
		seedSessions();
		const r = run(["message", "--all", "fleet hello", "--as", "caller-all"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("message broadcast");
		const db = new Database(DB, { readonly: true });
		const targets = (
			db
				.query("SELECT target FROM events WHERE kind = 'BROADCAST' ORDER BY id")
				.all() as { target: string }[]
		).map((row) => row.target);
		db.close();
		expect(targets).toEqual(["lane-claude-11111111", "lane-copilot-22222222"]);
	});
});
