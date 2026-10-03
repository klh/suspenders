// hooks/lib/checkpoint.ts — W253: the rolling compaction checkpoint.
// One file per session (/tmp/suspenders-checkpoints/<project>/<sid>.md),
// overwritten on every roll: a plane-derived header (branch/head, owned
// work, capsule) plus two agent-owned sections (done/next) whose bullets
// SURVIVE rolls. hooks/pre-compact.ts rolls it at the last moment before
// compaction discards the session's context; session-start.ts then points
// the post-compact session at it as its first action.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

// SUSPENDERS_CKPT_ROOT overrides the root (tests; multi-user machines)
export const CKPT_ROOT =
	process.env.SUSPENDERS_CKPT_ROOT ?? "/tmp/suspenders-checkpoints";

// project slug — projectIdentity() is the git common dir (`.git` tail),
// worktrees share it; same shape as the session-start display name
export function slug(project: string): string {
	const parts = project.split("/").filter(Boolean);
	const last = (parts[parts.length - 1] ?? "").replace(/\.git$/, "");
	return last || parts[parts.length - 2] || "proj";
}

export function checkpointPath(project: string, sid: string): string {
	const safe = sid.replace(/[^A-Za-z0-9._@-]/g, "_");
	return `${CKPT_ROOT}/${slug(project)}/${safe}.md`;
}

// ---- pure section merge (unit-tested without fs) ------------------------

const MAX_BULLETS = 10;

// pull the agent-owned bullets back out of an existing checkpoint body —
// the `- ` lines under `## done` / `## next`, newest first
export function extractSections(md: string): {
	done: string[];
	next: string[];
} {
	const grab = (header: string): string[] => {
		const at = md.indexOf(`${header}\n`);
		if (at < 0) return [];
		const rest = md.slice(at + header.length + 1);
		const m = /^## /m.exec(rest);
		const body = m ? rest.slice(0, m.index) : rest;
		return body
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("- "))
			.map((l) => l.slice(2).trim())
			.filter(Boolean);
	};
	return { done: grab("## done"), next: grab("## next") };
}

export type RollOpts = {
	cwd: string;
	note?: string | null; // fresh "done" bullet, prepended
	next?: string | null; // fresh "next" bullet, prepended
	auto?: string | null; // trigger label when the pre-compact hook rolls
};

export function renderCheckpoint(parts: {
	project: string;
	sid: string;
	rolledIso: string;
	gen: number;
	head: string;
	owned: string;
	capsule: string;
	done: string[];
	next: string[];
	auto?: string | null;
}): string {
	const L = [
		`# CHECKPOINT — ${slug(parts.project)} · ${parts.sid}`,
		`rolled: ${parts.rolledIso} (gen ${parts.gen}${parts.auto ? `, ${parts.auto}` : ""})`,
	];
	if (parts.head) L.push(`branch: ${parts.head}`);
	if (parts.owned) L.push(`owned: ${parts.owned}`);
	if (parts.capsule) L.push(`capsule: ${parts.capsule}`);
	L.push("");
	L.push("## done");
	for (const d of parts.done) L.push(`- ${d}`);
	L.push("");
	L.push("## next");
	for (const n of parts.next) L.push(`- ${n}`);
	L.push("");
	return L.join("\n");
}

// ---- plane-derived state ------------------------------------------------

function gitHead(cwd: string): string {
	const probe = (args: string[]): string => {
		try {
			const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
		} catch {
			return "";
		}
	};
	const ref = probe(["rev-parse", "--abbrev-ref", "HEAD"]);
	const sha = probe(["rev-parse", "--short", "HEAD"]);
	return [ref, sha].filter(Boolean).join(" @ ");
}

const OWNED_SQL =
	"SELECT id, state, title FROM work_items " +
	"WHERE owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED') ORDER BY id";

function capsuleLine(db: Database, sid: string): string {
	const v = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${sid}.capsule`) as { value: string } | null;
	if (!v) return "";
	try {
		const c = JSON.parse(v.value) as Record<string, unknown>;
		return Object.entries(c)
			.filter(([k]) => k !== "ts")
			.map(([k, x]) => `${k}=${String(x).slice(0, 60)}`)
			.join(" · ")
			.slice(0, 200);
	} catch {
		return v.value.slice(0, 200);
	}
}

// roll the checkpoint: refresh the plane-derived header, keep the agent's
// accumulated done/next bullets (new note/next prepended), bump the gen
export function rollCheckpoint(
	db: Database,
	project: string,
	sid: string,
	opts: RollOpts,
): { path: string; gen: number } {
	const path = checkpointPath(project, sid);
	const old = existsSync(path) ? readFileSync(path, "utf8") : "";
	const sections = extractSections(old);
	const one = (s: string | null | undefined): string =>
		s ? s.replace(/\s*\n\s*/g, " ").trim() : "";
	if (one(opts.note)) sections.done.unshift(one(opts.note));
	if (one(opts.next)) sections.next.unshift(one(opts.next));
	for (const k of ["done", "next"] as const)
		sections[k] = sections[k].slice(0, MAX_BULLETS);
	const owned = (
		db.query(OWNED_SQL).all(sid) as {
			id: string;
			state: string;
			title: string;
		}[]
	)
		.map((w) => `${w.id}[${w.state}] ${w.title.slice(0, 60)}`)
		.join("; ");
	const gen = Number(/gen (\d+)/.exec(old)?.[1] ?? 0) + 1;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		renderCheckpoint({
			project,
			sid,
			rolledIso: new Date().toISOString(),
			gen,
			head: gitHead(opts.cwd),
			owned,
			capsule: capsuleLine(db, sid),
			done: sections.done,
			next: sections.next,
			auto: opts.auto ?? null,
		}),
	);
	return { path, gen };
}
