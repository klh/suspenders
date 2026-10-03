// hooks/pre-compact.ts — PreCompact hook: the last-moment roll (W253).
// Compaction is about to discard the session's working context; bank the
// plane-derived header (branch/head, owned items, capsule) to the rolling
// checkpoint while the plane is still authoritative. Agent-owned done/next
// bullets survive the roll. Degrade-honest: a failure logs to stderr and
// NEVER blocks compaction. Register as:
//   PreCompact → bun ~/.claude/hooks/suspenders/pre-compact.ts
import { openGovernorDb, projectIdentity } from "./lib/govdb.ts";
import { rollCheckpoint } from "./lib/checkpoint.ts";

type In = { session_id?: string; transcript_path?: string; trigger?: string };

const raw = await new Response(Bun.stdin.stream()).text();
let input: In = {};
try {
	input = JSON.parse(raw) as In;
} catch {
	process.exit(0);
}
if (!input.session_id) process.exit(0);

// same lane discriminator as session-start.ts: Claude Code gives subagent
// lanes the PARENT's session_id; their transcript path carries the lane name
const laneMatch = (input.transcript_path ?? "").match(
	/\/subagents\/([^/]+?)(?:\.jsonl)?\/?$/,
);
const lane = laneMatch
	? `${input.session_id}#${laneMatch[1]}`
	: input.session_id;

try {
	const r = rollCheckpoint(openGovernorDb(), projectIdentity(), lane, {
		cwd: process.cwd(),
		auto: input.trigger ?? "auto",
	});
	process.stderr.write(
		`[checkpoint] rolled gen ${r.gen} → ${r.path} (pre-compact)\n`,
	);
} catch (e) {
	process.stderr.write(
		`[checkpoint] degraded (compaction proceeds): ${String(e)}\n`,
	);
}
process.exit(0);
