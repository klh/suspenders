// hooks/gates/bash.ts — PreToolUse(Bash): secrets + edit-enforce +
// skill-install + tool-enforce, over the shell-quote AST.
// Review pass 2026-09-03: hoisted constants, deferred EVERY computation,
// extracted shared redirect-target logic, single denyInstall helper,
// approvals moved to lib/approvals.ts (fixes the trivial-token bind bug).
import { parse } from "shell-quote";
import { allow, deny, nudge, type HookInput } from "../lib/hookio.ts";
import { have, run } from "../lib/run.ts";
import { verifyAndConsume, extractSourceRef } from "../lib/approvals.ts";
import { basename, dirname, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { openGovernorDb } from "../lib/govdb.ts";
import type { Database } from "bun:sqlite";
import { laneId, leaseExpired } from "./governor.ts";
import { resolveFleetLane } from "../lib/fleetlane.ts";

// governor-bypass section: shell writes must respect governor leases
const GOV = `${process.env.HOME}/.cache/claude-governor`;
const canonPath = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		try {
			return `${realpathSync(dirname(p))}/${basename(p)}`;
		} catch {
			return resolve(p);
		}
	}
};

// ---- module-scope constants (allocated once, not per call) ----
const WRAPPERS = new Set(["sudo", "nice", "env", "command", "nohup", "time"]);
const SKILLS_PATH = /\.claude\/skills|\.agents\/skills/;
const TOOL_MAP: Record<string, string> = {
	ls: "eza -la (or eza --tree)",
	find: "fd",
	grep: "rg",
	cat: "bat",
	sed: "sd",
	du: "dust",
	diff: "difft",
	ps: "procs",
	curl: "xh",
};

type Op = { op: string };
type Cmd = { cmd: string };
type Tok = string | Op | Cmd;

const isOp = (t: Tok, ...ops: string[]) =>
	typeof t === "object" && "op" in t && ops.includes((t as Op).op);

function segments(toks: Tok[]): Tok[][] {
	const segs: Tok[][] = [[]];
	for (const t of toks) {
		if (isOp(t, ";", "&", "|", "&&", "||", "(", ")")) segs.push([]);
		else segs[segs.length - 1].push(t);
	}
	return segs.filter((s) => s.length > 0);
}
const words = (seg: Tok[]): string[] =>
	seg.map((t) =>
		typeof t === "string" ? t : "op" in t ? `<op:${t.op}>` : "<sub>",
	);

function verb(w: string[]): string {
	let i = 0;
	while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
	while (i < w.length && WRAPPERS.has(w[i])) i++;
	return w[i] ?? "";
}

// the git SUBCOMMAND is the first non-flag token after "git" (global option
// values skipped — see GIT_GLOBAL_VALUE_OPTS). "push"/"commit" as any OTHER
// token must not trigger the scans: `git stash push` is a local op — the
// any-token check denied it in any repo with history secrets (it is not a
// remote write; W40 incident 2026-09-26).
const GIT_GLOBAL_VALUE_OPTS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
]);

function gitSubIndex(w: string[]): { sub: string; idx: number } {
	const gi = w.indexOf("git");
	if (gi === -1) return { sub: "", idx: -1 };
	for (let i = gi + 1; i < w.length; i++) {
		const t = w[i];
		if (GIT_GLOBAL_VALUE_OPTS.has(t)) {
			i++; // space-form global option: its value is never the subcommand
			continue;
		}
		if (t.startsWith("-")) continue;
		return { sub: t, idx: i };
	}
	return { sub: "", idx: -1 };
}

function gitSub(w: string[]): string {
	return gitSubIndex(w).sub;
}

const throwaway = (p: string) =>
	p.startsWith("/tmp/") ||
	p.startsWith("/private/tmp/") ||
	p.startsWith("/dev/") ||
	p.includes("$TMPDIR");

/** Shared: find the redirect-target word after any '>' op, if the target is
 *  a real path (not throwaway). Returns "" when no actionable redirect. */
function redirectTarget(w: string[]): string {
	const idx = w.findIndex((a) => a.startsWith("<op:>"));
	if (idx === -1 || !w[idx + 1]) return "";
	return throwaway(w[idx + 1]) ? "" : w[idx + 1];
}

/** Shared: single-point deny for the skill-install gate. */
const denyInstall = (how: string): never =>
	deny(
		`skill-install-gate: ${how} blocked. Run the skill-security-review skill on the exact source; on PASS run: approve-skill <source> — then retry this command.`,
	);

// ---- no-lane-push-to-main (W70) — refspec analysis over gate words ----
// `git push` args (everything after the subcommand token); callers only
// invoke these on segments whose gitSub is "push".
function pushArgs(w: string[]): string[] {
	const { idx } = gitSubIndex(w);
	return idx === -1 ? [] : w.slice(idx + 1);
}

// push flags that swallow the next token, so a value is never misread as a
// refspec; every other flag-shaped token is inert.
const PUSH_VALUE_FLAGS = new Set([
	"--repo",
	"-o",
	"--push-option",
	"--receive-pack",
	"--exec",
]);

/** Shared: the repo dir a git segment operates on — -C <path> / --git-dir=
 *  <path> override the segment cwd (cd-tracking already folded into segCwd). */
function gitRepoDir(w: string[], segCwd: string): string {
	let dir = segCwd;
	const c = w.indexOf("-C");
	if (c !== -1 && w[c + 1])
		dir = w[c + 1].startsWith("/")
			? String(w[c + 1])
			: resolve(segCwd, String(w[c + 1]));
	const gd = w.find((a) => a.startsWith("--git-dir="));
	if (gd) dir = gd.slice("--git-dir=".length);
	return dir;
}

const currentBranch = (dir: string): string => {
	const r = run("git", ["branch", "--show-current"], { cwd: dir });
	return r.ok ? r.out.trim() : "";
};

/** The offending ARG when this `git push` segment would move main on the
 *  remote, "" otherwise. currentBranch resolves HEAD-dst refspecs and the
 *  bare-push fallback (push.default sends the CURRENT branch). */
export function pushMainTarget(w: string[], currentBranch: string): string {
	const args = pushArgs(w);
	if (args.includes("--all") || args.includes("--mirror"))
		return "--all/--mirror carries main";
	const refspecs: string[] = [];
	let remoteSeen = false; // --repo <r> supplies the remote outside the
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("-")) {
			if (PUSH_VALUE_FLAGS.has(a)) {
				i++; // swallow the flag's value token
				if (a === "--repo") remoteSeen = true; // positional slots shift
			}
			continue;
		}
		// first positional (when --repo did not already name the remote) is
		// the REMOTE; the rest are refspecs
		if (!remoteSeen && refspecs.length === 0) {
			remoteSeen = true;
			continue;
		}
		refspecs.push(a);
	}
	const movesMain = (spec: string): boolean => {
		const [src = "", dst = ""] = spec.replace(/^\+/, "").split(":");
		let target = dst || src; // empty dst falls back to same-name expansion
		if (target === "HEAD" || target === "@") target = currentBranch;
		if (target.startsWith("refs/heads/"))
			target = target.slice("refs/heads/".length);
		return target === "main";
	};
	if (refspecs.some(movesMain)) return String(refspecs.find(movesMain));
	// no refspecs (bare `git push` / `git push <remote>`): push.default sends
	// the current branch — a lane sitting on main must not push at all
	return refspecs.length === 0 && currentBranch === "main"
		? "HEAD (current branch is main)"
		: "";
}

export function bashGate(hook: HookInput): never {
	const CMD = hook.tool_input?.command ?? "";
	const CWD = hook.cwd ?? process.env.HOME ?? "/";
	if (hook.tool_name !== "Bash" || !CMD) allow();

	const toks = parse(CMD) as Tok[];
	const SEGS = segments(toks).map((s) => words(s));

	// ---- secrets (git commit / push) — per git SEGMENT ----
	// Each git verb is scanned in ITS OWN repo with the flags of THAT verb:
	// `push repoA && commit repoB` used to carry isPush across segments and run
	// the full-history scan against repoB (owner 2026-09-26: the deny was real
	// output from the wrong repo — repoB holds secrets and must never push).
	if (have("gitleaks")) {
		let segCwd = CWD;
		for (const w of SEGS) {
			const v = verb(w);
			// track cd segments: `cd X && git push` must scan X, not hook.cwd
			// (the session-cwd repo may hold secrets the pushed repo does not)
			if (v === "cd") {
				const target = w[w.length - 1];
				if (target && !target.startsWith("<op"))
					segCwd = target.startsWith("/") ? target : resolve(segCwd, target);
				continue;
			}
			if (v !== "git") continue;
			if (w.includes("--no-verify"))
				deny(
					"secrets-gate: --no-verify in an agent command is denied by policy. If you are the USER, run the git command in your own terminal.",
				);
			const repoDir = gitRepoDir(w, segCwd);
			const inRepo = run("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd: repoDir,
			}).ok;
			if (
				gitSub(w) === "commit" &&
				inRepo &&
				!run("gitleaks", ["protect", "--staged", "--redact", "--no-banner"], {
					cwd: repoDir,
				}).ok
			)
				deny(
					"gitleaks found secrets in STAGED content. Remove the secret (rotate if real). --no-verify is not available to agents.",
				);
			if (
				gitSub(w) === "push" &&
				inRepo &&
				!run("gitleaks", ["git", ".", "--redact", "--no-banner"], {
					cwd: repoDir,
				}).ok
			)
				deny(
					"gitleaks found secrets in commit history headed for the remote. Rotate the credential and rewrite/purge history. --no-verify is not available to agents.",
				);
		}
	}

	// ---- no-lane-push-to-main (W70): the merge ladder owns main — lanes push
	// their branch only; the ladder (board ship trigger / fleet-loop ship)
	// merges it. Lane identity is mechanical (ppid-walk → .fleet/lanes.json,
	// lib/fleetlane.ts) — interactive sessions resolve to null and are never
	// blocked. Parsed per git segment like the secrets gate (cd-aware).
	{
		const pushSegs = SEGS.filter(
			(w) => verb(w) === "git" && gitSub(w) === "push",
		);
		if (pushSegs.length > 0) {
			const lane = resolveFleetLane(CWD);
			if (lane) {
				let segCwd = CWD;
				for (const w of SEGS) {
					const v = verb(w);
					if (v === "cd") {
						const target = w[w.length - 1];
						if (target && !target.startsWith("<op"))
							segCwd = target.startsWith("/")
								? target
								: resolve(segCwd, target);
					}
					if (v !== "git" || gitSub(w) !== "push") continue;
					const hit = pushMainTarget(w, currentBranch(gitRepoDir(w, segCwd)));
					if (hit)
						deny(
							`push-guard: lane ${lane.sid} cannot push ${hit} — main moves only through the fleet merge ladder (board ship trigger / fleet-loop ship). Push your branch; the ladder merges it.`,
						);
				}
			}
		}
	}

	// ---- no-commit-into-live-merge (gaps 18517f51, 2026-09-28): a bare
	// commit while MERGE_HEAD exists concludes a FOREIGN merge — that state
	// belongs to the ladder. Fires only when the ladder's liveness marker is
	// live, so an owner's own non-fleet merge is never blocked. The ladder
	// bypasses this gate (spawnSync); lanes commit in worktrees whose .git
	// is a FILE — this check cannot match there.
	{
		const commitSegs = SEGS.filter(
			(w) => verb(w) === "git" && gitSub(w) === "commit",
		);
		if (commitSegs.length > 0) {
			let segCwd = CWD;
			for (const w of SEGS) {
				const v = verb(w);
				if (v === "cd") {
					const target = w[w.length - 1];
					if (target && !target.startsWith("<op"))
						segCwd = target.startsWith("/") ? target : resolve(segCwd, target);
					continue;
				}
				if (v !== "git" || gitSub(w) !== "commit") continue;
				const dir = gitRepoDir(w, segCwd);
				if (!existsSync(`${dir}/.git/MERGE_HEAD`)) continue;
				let live = false;
				try {
					const j = JSON.parse(
						readFileSync(`${dir}/.fleet/merge-active`, "utf8"),
					) as { pid: number; cmd?: string; ts: number };
					if (
						Date.now() - j.ts < 30 * 60_000 &&
						typeof j.cmd === "string" &&
						j.cmd.length > 0 &&
						Bun.spawnSync(["ps", "-o", "command=", "-p", String(j.pid)])
							.stdout.toString()
							.trim() === j.cmd
					)
						live = true;
				} catch {}
				if (live)
					deny(
						`merge-guard: a fleet merge is LIVE in ${dir} (MERGE_HEAD + live runner) — a commit now concludes the foreign merge. Wait for the ladder to finish, or SendMessage the coordinator.`,
					);
			}
		}
	}

	// ---- governor leases: shell writes must respect the same per-file leases
	// the Write/Edit gate enforces (BEFORE edit-enforce: nudge() exits the
	// process, so deny checks must run before any nudge). Leases live in
	// governor.db (SQLite) — the legacy locks.json read is gone. Lane identity,
	// canonical paths, TTL/liveness, and exemptions match gates/governor.ts.
	{
		let db: Database | null = null;
		if (existsSync(`${GOV}/governor.db`)) {
			try {
				db = openGovernorDb();
			} catch {
				db = null; // fail open: a dead registry never blocks a shell command
			}
		}
		if (db) {
			const now = Date.now();
			const rows = db.query("SELECT path, sid, ts, tp FROM locks").all() as {
				path: string;
				sid: string;
				ts: number;
				tp: string | null;
			}[];
			const live = rows.filter((r) => !leaseExpired(r, now));
			if (live.length > 0) {
				const lane = laneId(hook);
				const sid = hook.session_id ?? "unknown";
				const isSubagent = (hook.transcript_path ?? "").includes("/subagents/");
				const exPath = `${GOV}/exempt.json`;
				const exempt =
					!isSubagent &&
					existsSync(exPath) &&
					(JSON.parse(readFileSync(exPath, "utf8")) as string[]).includes(sid);
				const targets: string[] = [];
				let segCwd = CWD;
				for (const w of SEGS) {
					const v = verb(w);
					const vi = w.indexOf(v);
					const rest = vi >= 0 ? w.slice(vi + 1) : w;
					// collect against the segment's working directory; `cd X` takes
					// effect for LATER segments (a redirect on the cd line itself
					// resolves in the pre-cd cwd, as the shell sets it up before cd runs)
					for (let i = 0; i < w.length; i++) {
						if (
							(w[i] === "<op:>" || w[i] === "<op:>>") &&
							w[i + 1] &&
							!String(w[i + 1]).startsWith("<op")
						) {
							targets.push(resolve(segCwd, String(w[i + 1])));
						}
					}
					if (["tee", "touch", "truncate", "sd", "ambr"].includes(v)) {
						for (const t of rest)
							if (!t.startsWith("-")) targets.push(resolve(segCwd, t));
					}
					if (["cp", "mv", "rsync", "ditto"].includes(v)) {
						const last = rest[rest.length - 1];
						if (last && !last.startsWith("-"))
							targets.push(resolve(segCwd, last));
					}
					if (v === "rm")
						for (const t of rest)
							if (!t.startsWith("-")) targets.push(resolve(segCwd, t));
					if (v === "dd")
						for (const kv of rest)
							if (kv.startsWith("of="))
								targets.push(resolve(segCwd, kv.slice(3)));
					if (v === "cd") {
						const target = w[w.length - 1];
						if (target && !target.startsWith("<op"))
							segCwd = target.startsWith("/")
								? target
								: resolve(segCwd, target);
					}
				}
				for (const t of targets) {
					if (!t || throwaway(t)) continue; // temp/dev targets are not arbitrated
					const P = canonPath(t);
					const hit = live.find((r) => r.path === P);
					if (hit && hit.sid !== lane && !exempt) {
						deny(
							`GOVERNOR: shell write to ${P} blocked — leased to another agent (session ${hit.sid.slice(0, 8)}). ` +
								`Use Edit/Write (governed), or SendMessage to "main" for arbitration.`,
						);
					}
					// own lease or no lease → allowed; governor.ts renews/claims on Edit/Write
				}
			}
		}
	}
	// ---- edit-enforce ----
	for (const w of SEGS) {
		const v = verb(w);
		if (v === "cat") {
			const t = redirectTarget(w);
			if (t)
				deny(
					`edit-enforce: shell file-write via cat → ${t}. Use Write (new/whole file) or Edit (unique anchor) — prompt-free, diffed, syntax-checked.`,
				);
		}
		if (v === "sed" || v === "perl") {
			const args = w.slice(w.indexOf(v) + 1);
			if (
				args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")
			)
				deny(
					"edit-enforce: sed -i / perl -i in-place edit. Use Edit (surgical) or sd (bulk replace).",
				);
		}
		if (
			["python3", "python", "node", "bun", "deno"].includes(v) &&
			w.some((a) => a === "<op:<" || a === "<op:<<")
		)
			nudge(
				"edit-enforce: inline interpreter heredoc — if it mutates files, switch to Edit/Write (context-anchored + syntax-checked). Pure compute: ignore.",
			);
		if (v === "echo" || v === "printf") {
			const t = redirectTarget(w);
			if (t)
				nudge(
					`edit-enforce: generating file content via ${v} redirect → ${t} — prefer the Write tool. Command-output capture is fine.`,
				);
		}
	}

	// ---- skill-install (signed approvals; format in lib/approvals.ts) ----
	{
		const installs: string[] = []; // how-descriptions for detected installs
		for (const w of SEGS) {
			const v = verb(w);
			const rest = w.slice(w.indexOf(v) + 1);
			if (["npx", "bunx", "pnpm", "yarn"].includes(v)) {
				const s = rest.indexOf("skills");
				if (s !== -1 && rest[s + 1] === "add")
					installs.push("third-party skill install");
			}
			if (
				v === "git" &&
				rest[0] === "clone" &&
				SKILLS_PATH.test(rest[rest.length - 1] ?? "")
			)
				installs.push("clone into a skills dir");
			if (
				["cp", "mv", "rsync", "ditto", "tar"].includes(v) &&
				w.some((a) => SKILLS_PATH.test(a))
			)
				installs.push("install into skills dir");
			if (
				v === "claude" &&
				rest.some((a) => ["plugin", "mcp"].includes(a)) &&
				rest.some((a) => ["install", "add"].includes(a))
			)
				installs.push("third-party plugin/MCP install");
		}
		if (installs.length > 0) {
			const src = extractSourceRef(SEGS.flat());
			if (!verifyAndConsume(src)) denyInstall(installs.join(", "));
		}
	}

	// ---- tool-enforce (advisory) ----
	const v0 = verb(SEGS[0] ?? []);
	if (v0 in TOOL_MAP)
		nudge(
			`speedy nudge: prefer the fast tool — ${v0} → ${TOOL_MAP[v0]} (see CLAUDE.md / klh-cli-speed-tools skill)`,
		);

	// ---- structural-edit nudge (2026-09-28): text rewrites on .ts files are
	// where the day's corruptions lived — regex escapes, fmt-reflowed anchors,
	// blanket replaces hitting a second binding. ast-grep matches syntax
	// nodes, so none of those can happen. Advisory: the tools still work.
	const joined = SEGS.map((s) =>
		s.map((t) => (typeof t === "string" ? t : (t as Cmd).cmd)).join(" "),
	).join(" ; ");
	if (/\b(sd|sed)\b/.test(joined) || /bun\s+-e\b/.test(joined)) {
		const tsTarget = /[\w./-]+\.(ts|tsx)\b/.test(joined);
		if (tsTarget)
			nudge(
				"structural nudge: rewriting a .ts file with a text tool — prefer ast-grep (ast-grep rewrite -p '<pattern>' -r '<replacement>' <file>); matches syntax nodes, immune to fmt/whitespace drift and silent second-site hits",
			);
	}

	allow();
}
