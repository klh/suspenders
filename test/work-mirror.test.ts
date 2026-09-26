// test/work-mirror.test.ts — W32: the .workgraph.jsonl workgraph mirror.
// WRITER: every successful mutating command atomically re-exports the project
// graph (items + deps + meta line) beside the common git dir. READER: read
// verbs fall back to a committed mirror when governor.db cannot serve the
// project — unreachable (open throws), or a fresh HOME whose empty partition
// has never seen this graph. Recipes follow test/work-cli.test.ts: spawned
// CLI, temp HOME via env, real `git init`, temp repos under process.cwd()
// (NEVER /tmp — the bash gate exempts /tmp by design, so a /tmp checkout
// would silently test nothing).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const gitInit = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	const r = Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
	if (r.exitCode !== 0) throw new Error(`git init failed in ${dir}`);
};
const pid = (repo: string): string => {
	const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
	return realpathSync(resolve(repo, r.stdout.toString().trim()));
};
function run(cwd: string, home: string, ...args: string[]): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), ...args], { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}
const idOf = (out: string): string => (out.match(/W\d+(?:\.\d+)*/) ?? [])[0] ?? "";
const mirrorLines = (repo: string): string[] => readFileSync(join(repo, ".workgraph.jsonl"), "utf8").split("\n").filter((l) => l.trim());
const seedMirror = (repo: string, items: Record<string, unknown>[], meta: Record<string, unknown> = {}): void =>
	writeFileSync(
		join(repo, ".workgraph.jsonl"),
		[...items.map((i) => JSON.stringify(i)), JSON.stringify({ type: "meta", project: pid(repo), exported_at: Date.now(), count: items.length, ...meta })].join("\n") + "\n",
	);

// home A: working DB (the mirror-writing path); repos live under the checkout
const HOME = mkdtempSync(join(tmpdir(), "claude-work-mirror-home-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-work-mirror-repo-"));
gitInit(REPO);
const work = (...args: string[]) => run(REPO, HOME, ...args);

// home B: fresh machine — no governor.db at all (the beads use case)
const HOME_FRESH = mkdtempSync(join(tmpdir(), "claude-work-mirror-fresh-"));
// home C: broken registry — $HOME/.cache is a file, so openGovernorDb throws
const HOME_BROKEN = mkdtempSync(join(tmpdir(), "claude-work-mirror-broken-"));
writeFileSync(join(HOME_BROKEN, ".cache"), "not a directory");

// repo 2 carries only a hand-seeded mirror — never a single work command
const REPO2 = mkdtempSync(join(process.cwd(), ".tmp-work-mirror-repo2-"));
gitInit(REPO2);
const MIRROR_ITEM = { id: "W1", parent_id: null, title: "served from the mirror", state: "READY", priority: 0, owner_sid: null, required: 1, requires: null, created_at: 1, updated_at: 1, deps: [] };

afterAll(() => {
	for (const d of [HOME, HOME_FRESH, HOME_BROKEN, REPO, REPO2]) rmSync(d, { recursive: true, force: true });
});

describe("mirror writer — mutating commands export the graph", () => {
	test("add writes a valid jsonl mirror with a matching meta count", () => {
		const r = work("add", "mirror seed item");
		expect(r.code).toBe(0);
		const lines = mirrorLines(REPO);
		expect(lines.length).toBe(2); // one item + meta
		const items = lines.slice(0, -1).map((l) => JSON.parse(l));
		const meta = JSON.parse(lines[lines.length - 1]);
		expect(meta.type).toBe("meta");
		expect(meta.project).toBe(pid(REPO));
		expect(meta.count).toBe(items.length);
		expect(meta.exported_at).toBeGreaterThan(0);
		expect(meta.max_updated_at).toBeGreaterThan(0);
		expect(items[0].id).toBe(idOf(r.out));
		expect(items[0].title).toBe("mirror seed item");
		expect(items[0].state).toBe("READY");
		expect(items[0].deps).toEqual([]);
	});

	test("state changes flow through: take claims, block adds a dep edge", () => {
		const a = idOf(work("add", "edge target").out);
		const b = idOf(work("add", "edge waiter").out);
		expect(work("take", a, "--as", "mirror-lane").code).toBe(0);
		expect(work("block", b, "--on", a).code).toBe(0);
		const items = mirrorLines(REPO).slice(0, -1).map((l) => JSON.parse(l));
		const ta = items.find((i) => i.id === a);
		const tb = items.find((i) => i.id === b);
		expect(ta.state).toBe("CLAIMED");
		expect(ta.owner_sid).toBe("mirror-lane");
		expect(tb.deps).toEqual([a]);
	});

	test("reads with rows in the DB never touch the mirror", () => {
		const r = work("list");
		expect(r.code).toBe(0);
		expect(r.err).not.toContain("serving from");
	});
});

describe("mirror reader — fallback when governor.db cannot serve the project", () => {
	test("fresh HOME (no governor.db): list and show serve the committed mirror", () => {
		seedMirror(REPO2, [MIRROR_ITEM]);
		const r = run(REPO2, HOME_FRESH, "list");
		expect(r.code).toBe(0);
		expect(r.err).toContain("serving from .workgraph.jsonl mirror (governor.db unreachable) — read-only");
		expect(r.out).toContain("served from the mirror");
		const s = run(REPO2, HOME_FRESH, "show", "W1");
		expect(s.out).toContain("W1");
		expect(s.out).toContain("served from the mirror");
	});

	test("unreachable DB (open throws): reads still serve the mirror", () => {
		const r = run(REPO2, HOME_BROKEN, "list");
		expect(r.code).toBe(0);
		expect(r.err).toContain("serving from .workgraph.jsonl mirror");
		expect(r.out).toContain("served from the mirror");
	});

	test("DB wins when it holds the project's rows — mirror ignored", () => {
		const a = idOf(work("add", "db truth").out);
		seedMirror(REPO, [{ ...MIRROR_ITEM, id: a, title: "STALE MIRROR LIE" }]); // diverges from the DB
		const r = work("list");
		expect(r.code).toBe(0);
		expect(r.err).not.toContain("serving from");
		expect(r.out).not.toContain("STALE MIRROR LIE");
	});

	test("fresh clone with an empty partition and no mirror stays quiet", () => {
		const repo3 = mkdtempSync(join(process.cwd(), ".tmp-work-mirror-repo3-"));
		gitInit(repo3);
		try {
			const r = run(repo3, HOME_FRESH, "list");
			expect(r.code).toBe(0);
			expect(r.err).not.toContain("serving from");
			expect(r.out).toContain("(none)");
		} finally {
			rmSync(repo3, { recursive: true, force: true });
		}
	});
});

describe("freshness guard", () => {
	test("a mirror older than 15 min warns with its age", () => {
		seedMirror(REPO2, [MIRROR_ITEM], { exported_at: Date.now() - 20 * 60_000 });
		const r = run(REPO2, HOME_FRESH, "list");
		expect(r.code).toBe(0);
		expect(r.err).toContain("mirror may be stale, exported 20m ago");
	});

	test("a fresh mirror does not warn", () => {
		seedMirror(REPO2, [MIRROR_ITEM]);
		const r = run(REPO2, HOME_FRESH, "list");
		expect(r.err).not.toContain("may be stale");
	});
});

describe("mutations without the DB", () => {
	test("mutating verb refuses with the unreachable hint", () => {
		const r = run(REPO2, HOME_BROKEN, "add", "should not exist");
		expect(r.code).toBe(2);
		expect(r.err).toContain("governor.db unreachable");
		expect(r.err).toContain("mirror");
	});

	test("failed mutations never touch the mirror", () => {
		const before = readFileSync(join(REPO, ".workgraph.jsonl"), "utf8");
		expect(work("take", "W404", "--as", "nobody").code).not.toBe(0);
		expect(readFileSync(join(REPO, ".workgraph.jsonl"), "utf8")).toBe(before);
	});
});

describe("meta bookkeeping", () => {
	test("count tracks every item, max_updated_at is the freshest row", () => {
		work("add", "meta probe one");
		work("add", "meta probe two");
		const lines = mirrorLines(REPO);
		const items = lines.slice(0, -1).map((l) => JSON.parse(l));
		const meta = JSON.parse(lines[lines.length - 1]);
		expect(meta.count).toBe(items.length);
		expect(meta.count).toBeGreaterThanOrEqual(5);
		const maxDb = Math.max(...items.map((i) => i.updated_at));
		expect(meta.max_updated_at).toBe(maxDb);
	});
});
