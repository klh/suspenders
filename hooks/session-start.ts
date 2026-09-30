// hooks/session-start.ts — SessionStart control-plane bootstrap.
// Registers the live session, rebinds a closed predecessor when the lineage
// is unambiguous (exactly one closed session in this project still owning
// active work) and source is `resume`, then injects the restart packet
// (SESSION / REBIND / OWNED / READY / INBOX / HEAD). Stdout is injected as
// session context. CLAUDE_FLEET_BOOTSTRAP=0 opts out entirely.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity, CAPABILITIES } from "./lib/govdb.ts";
import { makeStore } from "./lib/store-ports.ts";

type In = { session_id?: string; source?: string; transcript_path?: string };

if (process.env.CLAUDE_FLEET_BOOTSTRAP === "0") process.exit(0);

const raw = await new Response(Bun.stdin.stream()).text();
const input = JSON.parse(raw) as In;
if (!input.session_id) process.exit(0);

const sid = input.session_id;
const src = input.source ?? "startup";
const project = projectIdentity();

// Subagent lanes: Claude Code gives a subagent the PARENT's session_id, so
// anything it claims under the raw sid lands on the parent's account (W24 /
// W30, 2026-09-26: the owner's id showed on lanes they never ran). Same
// discriminator as the governor's laneId — register the subagent as its own
// session row and hand it a lane id for claims, checkpoints, and emits.
const laneMatch = (input.transcript_path ?? "").match(
	/\/subagents\/([^/]+?)(?:\.jsonl)?\/?$/,
);
const isSubagent = !!laneMatch;
const lane = laneMatch ? `${sid}#${laneMatch[1]}` : sid;

function pname(p: string): string {
	const parts = p.split("/");
	const last = parts[parts.length - 1].replace(/\.git$/, "");
	return last || parts[parts.length - 2] || p;
}
// CLIs ship in bin/ next to this hook (repo checkout and installed prefix
// share the layout) — resolve there first; fall back to the pre-namespacing
// ~/.claude/bin location for old installs.
const cli = (name: string): string => {
	for (const p of [
		join(import.meta.dir, "bin", name),
		`${process.env.HOME}/.claude/bin/${name}`,
	])
		if (existsSync(p)) return p;
	return `${process.env.HOME}/.claude/bin/${name}`;
};
const WORK = cli("work.ts");
const COORD = cli("coord.ts");

// W92: the control plane is reached through the store port — HTTP when a
// store server runs (resolveStore chain), embedded SQLite otherwise. This
// hook never opens governor.db directly.
const store = await makeStore();

const RULES =
	`RULES: Work Graph (bun ${WORK}) is authoritative — ` +
	"continue OWNED before taking new; own an item (work take) before code " +
	"work; never reconstruct mutable state from Markdown; parallelizable " +
	"work gets work split. Stuck or need a colleague's context: " +
	"coord consult/who-knows (questions, never ownership). Who-is-working: " +
	"query the plane (sessions + claims, coord fleet) — never /tmp files. " +
	"Fleet lessons live in facts — coord fact list (lesson.*) before " +
	"re-deriving painful knowledge; set lesson.<topic> when you learn " +
	"something another lane will need. " +
	"Between items: " +
	"poll coord inbox --as <sid>; if READY work matches your capabilities, " +
	"take it yourself — don't wait for dispatch; checkpoint each landed " +
	"milestone (work done --sha / capsule) so preemption stays possible. " +
	"Decisions: a decision held only in your context is invisible to the " +
	"fleet and the owner — emit it (coord emit NEED_DECISION --to " +
	'<coordinator-or-own-sid> --note "question + options" --as <sid>) ' +
	"the moment you hold one; the fleet board surfaces it for the human.";

// top-level sessions are full agent runtimes — advertise the complete
// capability set so capability-gated work stays takeable by them (lanes
// inherit their caps from the parent via coord bootstrap --parent)
const CAPS = CAPABILITIES.join(",");

await store.sessionUpsert({
	sid: lane,
	project,
	parentSid: isSubagent ? sid : null,
	caps: CAPS,
	transcriptPath: input.transcript_path ?? null,
});
const out = [
	isSubagent
		? `SUBAGENT LANE ${lane.slice(0, 24)}  project=${pname(project)}`
		: `SESSION ${sid.slice(0, 8)}  project=${pname(project)}`,
];

// automagic hygiene: every bootstrap sweeps stale sessions fleet-wide
const sweptN = await store.sweepSessions();
if (sweptN)
	out.push(
		`SWEPT ${sweptN} stale session(s) — hb-stale + transcript-dead (coordinator/waiting kept)`,
	);
if (isSubagent) {
	out.push(
		`You share the parent's session id — claim and checkpoint as the lane id instead: ` +
			`work take/done --as ${lane}, coord emit --as ${lane}. Raw-sid claims land on the parent's account.`,
	);
}

// lineage: only `resume` may rebind — startup/clear/compact never touch
// ownership. 0 closed owners → fresh start; 1 → deterministic rebind;
// >1 → escalate, never guess. Subagent lanes never rebind: they are not
// continuations of anything.
const dead =
	src === "resume" && !isSubagent ? await store.workClosedOwners(project) : [];
if (dead.length === 1 && dead[0] !== sid) {
	const p = Bun.spawnSync(
		["bun", COORD, "resume-session", "--as", sid, "--from", dead[0]],
		{
			stdout: "pipe",
		},
	);
	out.push(`REBIND ${new TextDecoder().decode(p.stdout).trim()}`);
} else if (dead.length > 1) {
	const ids = dead.map((d) => d.slice(0, 8)).join(", ");
	out.push(`LINEAGE AMBIGUOUS: ${ids} — resolve with coord resume-session`);
}

const mine = await store.workOwned(project, lane);
const readyN = await store.workReadyCount(project);
const inbox = await store.inboxCount(lane);
const head = await store.fact("integration.head");

if (mine.length || inbox > 0 || readyN > 0 || head) {
	const owned = mine
		.map((w) => `${w.id}[${w.state}] ${w.title.slice(0, 40)}`)
		.join(", ");
	out.push(
		`OWNED ${mine.length}${owned ? `: ${owned}` : ""}  READY ${readyN}  INBOX ${inbox}${head ? `  head=${head.slice(0, 7)}` : ""}`,
	);
	out.push(RULES);
}

// fleet notices: inject unseen `coord broadcast` notes — each session sees
// each notice exactly once (per-session watermark in facts)
{
	const bl = await store.fact("broadcast.latest");
	if (bl) {
		try {
			const b = JSON.parse(bl) as {
				id: string;
				ts: number;
				note: string;
			};
			const seen = await store.fact(`broadcast.seen.${sid}`);
			if (b.ts > Number(seen ?? 0)) {
				out.push(
					`FLEET NOTICE (${new Date(b.ts).toISOString().slice(0, 16).replace("T", " ")} UTC): ${b.note}`,
				);
				await store.factSet(
					`broadcast.seen.${sid}`,
					String(b.ts),
					"session-start",
				);
			}
		} catch {}
	}
}

// fleet lessons: facts under the lesson.* namespace are the curriculum —
// pushed at bootstrap (once per session, watermark like broadcasts) because
// pull-only knowledge never gets pulled. Values are truncated; the full note
// is one coord fact get away.
{
	const wm = await store.fact(`lesson.seen.${sid}`);
	const rows = (await store.factList("lesson.", Number(wm ?? 0)))
		.filter((r) => !r.key.startsWith("lesson.seen."))
		.slice(0, 5);
	if (rows.length) {
		for (const r of rows) {
			const v =
				r.value !== null && r.value.length > 200
					? `${r.value.slice(0, 200)}… (coord fact get ${r.key})`
					: (r.value ?? "");
			out.push(`LESSON ${r.key.slice("lesson.".length)}: ${v}`);
		}
		await store.factSet(
			`lesson.seen.${sid}`,
			String(Math.max(...rows.map((r) => r.ts))),
			"session-start",
		);
	}
}

// legacy-ledger notice: known operational-ledger names, unmarked = old habit
// may still treat them as live. One terse line, first match only. Deterministic
// filename check only — no content classification, no auto-migration.
const LEDGERS = [
	"MASTER-TASK-LEDGER.md",
	"TODO.md",
	"TASKS.md",
	"BACKLOG.md",
	"PROGRESS.md",
	"STATUS.md",
	"ROADMAP.md",
];
outer: for (const dir of [".", "docs", "docs/design"]) {
	for (const name of LEDGERS) {
		const p = `${process.cwd()}/${dir === "." ? "" : `${dir}/`}${name}`;
		try {
			if (
				!existsSync(p) ||
				readFileSync(p, "utf8").includes("HISTORICAL / DESIGN RECORD")
			)
				continue;
			out.push(
				`LEGACY LEDGER ${dir === "." ? "" : `${dir}/`}${name} — operational state belongs in the Work Graph (register items, add the HISTORICAL banner); never append progress there`,
			);
			break outer;
		} catch {}
	}
}
console.log(out.join("\n"));
