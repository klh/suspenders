// secrets-gate.test.ts — the secrets gate's git-subcommand resolution: the
// scans key on the ACTUAL git subcommand (first non-flag token after git),
// not any-token matching. Regression: `git stash push` is a local op, but the
// old any-token check ran the remote-history scan for it and denied in any
// repo with history secrets (W40 incident, 2026-09-26 — .claude holds real
// tokens in history by design, so local stash ops were impossible). Control:
// a real `git push` in the same repo still denies. Skipped when gitleaks is
// absent (CI image parity is not guaranteed).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-secrets-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-secrets-repo-"));
const env = {
	...process.env,
	HOME,
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const HOOKS = join(import.meta.dir, "..", "hooks");

let n = 0;
function gate(command: string): { out: string; code: number } {
	const payload = join(HOME, `hook-${n++}.json`);
	writeFileSync(payload, JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: REPO, session_id: "s", transcript_path: join(HOME, "t.jsonl") }));
	const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), "pre-bash"], { cwd: REPO, env, stdin: Bun.file(payload), stdout: "pipe", stderr: "pipe" });
	return { out: p.stdout.toString(), code: p.exitCode };
}
const allowed = (r: { out: string }) => expect(r.out).toBe("{}");
const denied = (r: { out: string }) => expect(r.out).toContain('"permissionDecision":"deny"');

// synthetic key in the gitleaks github-pat shape, assembled at runtime so no
// literal token lives in this file — a committed literal would itself trip
// the history scan on every future push (entropy: all-repeated chars are
// skipped by gitleaks, hence the realistic filler)
const FAKE = ["ghp_", "xK9m", "Q2vL", "8pR4", "tW7z", "B3nC", "6yF0", "jH5s", "D1aG", "9eU2"].join("");
// Bun.spawnSync THROWS on a missing executable (ENOENT) — CI images have no
// gitleaks, so the probe itself must not be the thing that fails the run
let hasGitleaks = false;
try {
	hasGitleaks = Bun.spawnSync(["gitleaks", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
} catch {
	hasGitleaks = false; // not installed — the gate skips via have(), we skip the file
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

(hasGitleaks ? describe : describe.skip)("secrets gate", () => {
	// one commit whose history carries the synthetic key. REAL git init — an
	// empty scaffolded .git makes repo discovery walk UP into the parent
	// checkout (documented projectOf behavior) and this fixture's commits
	// then land in the SUSPENDERS repo (five stray c1 commits, 2026-09-26).
	// The toplevel guard below fails loudly if isolation ever breaks again.
	Bun.spawnSync(["git", "init", REPO], { env });
	writeFileSync(join(REPO, "k.txt"), `${FAKE}\n`);
	Bun.spawnSync(["git", "-C", REPO, "add", "k.txt"], { env });
	Bun.spawnSync(["git", "-C", REPO, "commit", "-m", "c1"], { env: { ...env, cwd: REPO } });
	const top = new TextDecoder().decode(Bun.spawnSync(["git", "-C", REPO, "rev-parse", "--show-toplevel"], { env }).stdout).trim();
	if (top !== REPO) throw new Error(`fixture escaped its repo: commit landed in ${top}`);

	test("git stash push is a LOCAL op — no remote-history scan, allowed", () => {
		allowed(gate('git stash push -m "wip"'));
	});

	test("git stash list is allowed too", () => {
		allowed(gate("git stash list"));
	});

	test("control: git push in the same secret-bearing repo still denies", () => {
		denied(gate("git push origin main"));
	});

	test("control: git commit of staged content still scans (clean stage passes)", () => {
		writeFileSync(join(REPO, "clean.txt"), "nothing here\n");
		Bun.spawnSync(["git", "-C", REPO, "add", "clean.txt"], { env });
		allowed(gate("git commit -m c2"));
	});
});
