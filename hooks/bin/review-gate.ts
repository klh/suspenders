#!/usr/bin/env bun
// review-gate.ts — W247: the fresh-context reviewer pass before merge.
// Suspenders' merge LADDER (fleet-loop --ladder / board .fleet/ship.json):
// every branch merges THROUGH this script, so lane work is judged by a
// reviewer that sees exactly three inputs — the Work Graph objective, the
// merge-base diff, and gate-run test evidence — and never the worker's
// framing (no brief, no capsules, no lane chat). Sycophancy-proof by
// construction: the reviewer is a stateless belt call with no filesystem
// access, so there is nothing to leak into its context.
//
// Ladder contract (exit 0 = merged, per fleet-loop):
//   VERDICT: APPROVE          → git merge --no-ff runs here → exit 0
//   VERDICT: REQUEST_CHANGES  → exit 1 → fleet-loop FAIL (strike → 3-strike park)
//   unparsable reply          → one retry, then fail closed (same exit 1)
//   belt/graph unreachable    → REVIEW-SKIPPED passthrough merge: the gate
//                               never wedges the fleet on LLM-infra weather;
//                               lane-side gates (qlty, tests) stay the floor
//   .fleet/review-paused      → owner kill switch: plain passthrough merge
//
// Evidence: every reviewer reply is stored verbatim under .fleet/reviews/
// (gitignored runtime state) with verdict + model + latency metadata.
//
// usage: bun review-gate.ts --repo <dir> --branch <b> [--main main]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBelt } from "../lib/belt-locate.ts";
import { wtPathFromGit } from "../lib/gitwt.ts";
import { openGovernorDb } from "../lib/govdb.ts";
import { run } from "../lib/run.ts";

const MAX_DIFF_CHARS = 60_000;
const TEST_FILES_CAP = 12;
const TEST_TIMEOUT_MS = 4 * 60_000;
const BELT_TIMEOUT_MS = 5 * 60_000;
const MAX_REVIEW_TOKENS = 1500;

export interface ReviewInput {
	objective: string;
	diff: string;
	tests: string;
}

export interface ReviewReply {
	text: string;
	model: string;
	host: string;
	ms: number;
}

/** The work item a lane branch carries — `suspenders/W247` → `W247`. Any
 * branch whose last segment is a work id gets reviewed; anything else
 * (tooling branches) merges plain. */
export function itemIdFromBranch(b: string): string | null {
	const m = b.match(/(?:^|\/)(W\d+(?:\.\d+)?)$/);
	return m?.[1] ?? null;
}

/** merge-base diff: stat overview + full patch, capped with an honest
 * truncation marker (a reviewer must know it saw a partial diff). */
export function collectDiff(
	repo: string,
	main: string,
	branch: string,
): string {
	const stat = run("git", ["diff", "--stat", `${main}...${branch}`], {
		cwd: repo,
	});
	const patch = run("git", ["diff", `${main}...${branch}`], { cwd: repo });
	const body =
		patch.out.length > MAX_DIFF_CHARS
			? `${patch.out.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} of ${patch.out.length} chars]`
			: patch.out;
	return `${stat.out}\n${body}`;
}

const isTestPath = (p: string): boolean =>
	/^test\//.test(p) ||
	/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
	/_test\.[cm]?[jt]sx?$/.test(p);

/** test files the branch touches — lane-scoped tests at the gate (gaps-l
 * postmortem rule), never the full suite. */
export function scopedTestFiles(
	repo: string,
	main: string,
	branch: string,
): string[] {
	const out = run("git", ["diff", "--name-only", `${main}...${branch}`], {
		cwd: repo,
	});
	return out.out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && isTestPath(l))
		.slice(0, TEST_FILES_CAP);
}

/** gate-run test evidence from the branch's own worktree (the branch code,
 * not main). A missing worktree or an empty test set is honest evidence too. */
export function runScopedTests(
	repo: string,
	branch: string,
	files: string[],
): string {
	if (files.length === 0) return "no test files in this diff";
	const wt = wtPathFromGit(repo, branch);
	if (!wt || !existsSync(wt))
		return "tests not run — branch has no active worktree";
	const r = run("bun", ["test", ...files], {
		cwd: wt,
		timeoutMs: TEST_TIMEOUT_MS,
	});
	if (r.status === null) return "tests did not run — spawn failure or timeout";
	const tail = r.out.trim().split("\n").slice(-40).join("\n");
	return `bun test ${files.length} file(s), exit ${r.status}\n${tail}`;
}

/** The reviewer's entire world: three labeled inputs, nothing else. Pure —
 * it reads no files, so worker framing cannot reach the reviewer even by
 * accident. */
export function reviewerPrompt(input: ReviewInput): {
	system: string;
	user: string;
} {
	const system = [
		"You are a fresh-context code reviewer for a software fleet.",
		"You see exactly three things: the work item's objective, the diff under review, and test evidence gathered by the merge gate.",
		"You have no access to the author, their notes, or any prior discussion — judge only what is in front of you.",
		"Be skeptical: does the diff actually achieve the objective? Look for bugs, security issues, missing error handling, missing or weak tests, and scope creep beyond the objective.",
		"Do not rubber-stamp; an honest REQUEST_CHANGES is more valuable than a polite APPROVE.",
		"End your reply with exactly one final line: `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES — <one-line reason>`.",
	].join("\n");
	const user = [
		"OBJECTIVE (Work Graph record):",
		input.objective,
		"",
		"DIFF (merge-base vs branch):",
		input.diff,
		"",
		"TEST EVIDENCE (run by the merge gate):",
		input.tests,
		"",
		"Review the diff against the objective. Cite file:line where possible. End with the VERDICT line.",
	].join("\n");
	return { system, user };
}

export type Verdict = "APPROVE" | "REQUEST_CHANGES";

/** The LAST verdict line wins (a model that reconsiders mid-reply has chosen
 * by the end). No verdict line = unparsable → null → fail closed. */
export function parseVerdict(text: string): Verdict | null {
	const matches = [
		...text.matchAll(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\b.*$/gim),
	];
	const last = matches.at(-1);
	return last?.[1] === "APPROVE"
		? "APPROVE"
		: last?.[1] === "REQUEST_CHANGES"
			? "REQUEST_CHANGES"
			: null;
}

/** belt picks the reviewer fleet-wide (advise.ts pattern): /api/route,
 * bearer via the shared resolver chain, null on any transport trouble —
 * the caller decides passthrough vs fail-closed. */
async function callReviewer(input: ReviewInput): Promise<ReviewReply | null> {
	const loc = await resolveBelt();
	if (!loc) return null;
	const { system, user } = reviewerPrompt(input);
	try {
		const r = await fetch(`${loc.url}/api/route`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(loc.token ? { authorization: `Bearer ${loc.token}` } : {}),
			},
			body: JSON.stringify({
				role: "reasoning", // code review rides the proven reasoning role
				execute: true,
				max_tokens: MAX_REVIEW_TOKENS,
				temperature: 0.2,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
			signal: AbortSignal.timeout(BELT_TIMEOUT_MS),
		});
		if (!r.ok) return null;
		const j = (await r.json()) as {
			reply?: string;
			target?: { model?: string; machine?: string };
			ms?: number;
		};
		if (!j.reply) return null;
		return {
			text: j.reply,
			model: j.target?.model ?? "belt",
			host: `belt(${j.target?.machine ?? "?"})`,
			ms: j.ms ?? 0,
		};
	} catch {
		return null;
	}
}

/** verbatim evidence file — approve or reject, a review happened and is on
 * disk for audit (`.fleet/` is gitignored runtime state). */
function storeReview(
	repo: string,
	item: string,
	branch: string,
	review: ReviewReply,
	verdict: Verdict | null,
): string {
	const dir = `${repo}/.fleet/reviews`;
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${item}-${Date.now()}.md`);
	const head = [
		`# review ${item} — ${branch}`,
		`verdict: ${verdict ?? "UNPARSABLE (fail closed)"} · model: ${review.model} · ${review.host} · ${review.ms}ms`,
		`date: ${new Date().toISOString()}`,
		"",
	].join("\n");
	writeFileSync(file, `${head}${review.text.trim()}\n`);
	return file;
}

/** board LLM telemetry (advise.ts event shape) — best-effort, never fatal. */
function emitLlmEvent(item: string, review: ReviewReply): void {
	try {
		openGovernorDb()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'review-gate', 'llm.call', ?, ?, NULL)",
			)
			.run(
				Date.now(),
				item,
				JSON.stringify({
					for: item,
					model: review.model,
					host: review.host,
					pt: 0,
					ct: 0,
					tt: 0,
					ms: review.ms,
				}),
			);
	} catch {}
}

/** the merge itself — the ladder REPLACES the default merge, so exit 0 of
 * this script must mean "merged" (fleet-loop mergeOne contract). */
function merge(repo: string, branch: string): number {
	const r = run("git", ["merge", "--no-ff", branch, "-m", `Merge ${branch}`], {
		cwd: repo,
	});
	if (r.out.trim()) console.log(r.out.trim());
	return r.status ?? 1;
}

/** REVIEW-SKIPPED / kill-switch path: log why, then plain merge. */
function passthrough(repo: string, branch: string, why: string): number {
	console.error(why);
	return merge(repo, branch);
}

export async function runGate(argv: string[]): Promise<number> {
	const val = (flag: string, dflt?: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : dflt;
	};
	const repo = val("--repo");
	const branch = val("--branch");
	if (!repo || !branch) {
		console.error(
			"usage: review-gate.ts --repo <dir> --branch <b> [--main main]",
		);
		return 1;
	}
	const main_ = val("--main") ?? "main";

	if (existsSync(`${repo}/.fleet/review-paused`))
		return passthrough(
			repo,
			branch,
			`review-paused: ${branch} merges without review (owner kill switch)`,
		);

	const item = itemIdFromBranch(branch);
	if (!item)
		return passthrough(repo, branch, `no work item on ${branch} — plain merge`);

	// the objective comes from the graph CLI, not from the worker
	const show = run("bun", [join(import.meta.dir, "work.ts"), "show", item], {
		cwd: repo,
	});
	if (!show.ok)
		return passthrough(
			repo,
			branch,
			`REVIEW-SKIPPED ${item} — work show failed (${show.out.split("\n")[0] ?? "no output"}), cannot anchor review`,
		);
	const input: ReviewInput = {
		objective: show.out.trim(),
		diff: collectDiff(repo, main_, branch),
		tests: runScopedTests(repo, branch, scopedTestFiles(repo, main_, branch)),
	};

	let review = await callReviewer(input);
	if (!review)
		return passthrough(
			repo,
			branch,
			`REVIEW-SKIPPED ${item} — belt unreachable, merging on lane gates`,
		);

	let verdict = parseVerdict(review.text);
	if (!verdict) {
		// one retry on a malformed reply; the 3-strike machinery is the real
		// retry loop — each cycle re-reviews with a fresh call
		review = (await callReviewer(input)) ?? review;
		verdict = parseVerdict(review.text);
	}
	const file = storeReview(repo, item, branch, review, verdict);
	emitLlmEvent(item, review);

	if (verdict === "APPROVE") {
		console.log(
			`REVIEW APPROVE ${item} (evidence: ${file}) — merging ${branch}`,
		);
		return merge(repo, branch);
	}
	// fail closed: the loop's FAIL line carries the LAST 3 output lines, so
	// the verdict reason must be visible there
	const tail = review.text.trim().split("\n").slice(-3).join(" | ");
	console.log(`REVIEW REQUEST_CHANGES ${item} — full review at ${file}`);
	console.log(tail.slice(-400));
	return 1;
}

if (import.meta.main) process.exit(await runGate(process.argv.slice(2)));
