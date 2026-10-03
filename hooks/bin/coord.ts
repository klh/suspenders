// coord.ts — the coordination event bus over governor.db: agents share state
// BY REFERENCE (short structured events + canonical facts), never by retelling
// it in prose. Direct SendMessage stays reserved for interrupts.
//
// usage:
//   bun ~/.claude/bin/coord.ts emit <kind> [--scope s] [--sha x] [--note "..."] [--as sid]
//   bun ~/.claude/bin/coord.ts poll [--as sid] [--scope s] [--kinds a,b] [--limit n]
//   bun ~/.claude/bin/coord.ts wait --as sid [--scope s] [--kinds a,b] [--max-seconds 30]
//        (adaptive long-poll: 250ms fast path, backs off to 2s when idle)
//   bun ~/.claude/bin/coord.ts metrics [project] [--days N]
//   bun ~/.claude/bin/coord.ts fact set <key> <value> [--source s]
//   bun ~/.claude/bin/coord.ts fact get <key> / fact list
//   bun ~/.claude/bin/coord.ts diff [--since <seq|event-id>] [--last N] [--table t] [--json]
//        (row-image delta log: what changed in sessions/claims/locks/facts/
//         work_items between two points — events/cursors are the bus's own trail)
//   bun ~/.claude/bin/coord.ts targets [--filter text] [--json]
//   bun ~/.claude/bin/coord.ts message <target-label-or-sid-or-substring> "text" [--as sid]
//   bun ~/.claude/bin/coord.ts message --all "text" [--as sid]
//
// event kinds (doctrine): checkpoint | landed | interface_changed | test_red |

import { die, setRest } from "../coord/shared.ts";
import {
	cmdEmit,
	cmdBroadcast,
	cmdPoll,
	cmdWait,
	cmdState,
	cmdInbox,
	cmdPause,
	cmdPaused,
	cmdResume,
	cmdResumed,
	cmdResumeSession,
} from "../coord/bus.ts";
import { cmdTargets, cmdMessage } from "../coord/addressing.ts";
import {
	cmdFact,
	cmdCapsule,
	cmdLeaseRelease,
	cmdKb,
	cmdGc,
} from "../coord/facts.ts";
import {
	cmdConsult,
	cmdConsultReply,
	cmdConsults,
	cmdWhoKnows,
} from "../coord/consult.ts";
import {
	cmdKnowledge,
	cmdKnowledgeEnqueue,
	cmdKnowledgePromote,
	cmdKnowledgeRetire,
	cmdKnowledgeNote,
	cmdKnowledgeVerify,
	cmdKnowledgeCurate,
} from "../coord/knowledge.ts";
import {
	cmdBootstrap,
	cmdFleet,
	cmdMetrics,
	cmdDoctorSession,
	cmdDiff,
} from "../coord/fleet.ts";

const [cmd, ...rest] = process.argv.slice(2);
// --help anywhere wins before any parsing that could create state
if (
	cmd === "--help" ||
	cmd === "-h" ||
	rest.includes("--help") ||
	rest.includes("-h")
) {
	console.log(
		"coord — control plane. emit | broadcast | poll | wait | fact | bootstrap | state | inbox | capsule | pause | paused | resume | resumed | resume-session | doctor-session | who-knows | consult | consult-reply | consults | kb | knowledge | knowledge-enqueue | knowledge-promote | knowledge-retire | knowledge-note | knowledge-verify | knowledge-curate | lease-release | gc | fleet | metrics | diff | targets | message",
	);
	process.exit(0);
}

// W157: the 32-command if/else chain lives in hooks/coord/*.ts as
// verbatim handler bodies; this entry parses argv, pins `rest` for
// `arg()`'s closure, and dispatches. CLI surface byte-compatible.
setRest(rest);

const cmds: Record<string, (rest: string[]) => Promise<void>> = {
	emit: cmdEmit,
	broadcast: cmdBroadcast,
	poll: cmdPoll,
	wait: cmdWait,
	state: cmdState,
	inbox: cmdInbox,
	pause: cmdPause,
	paused: cmdPaused,
	resume: cmdResume,
	resumed: cmdResumed,
	"resume-session": cmdResumeSession,
	fact: cmdFact,
	capsule: cmdCapsule,
	"lease-release": cmdLeaseRelease,
	kb: cmdKb,
	gc: cmdGc,
	consult: cmdConsult,
	"consult-reply": cmdConsultReply,
	consults: cmdConsults,
	"who-knows": cmdWhoKnows,
	knowledge: cmdKnowledge,
	"knowledge-enqueue": cmdKnowledgeEnqueue,
	"knowledge-promote": cmdKnowledgePromote,
	"knowledge-retire": cmdKnowledgeRetire,
	"knowledge-note": cmdKnowledgeNote,
	"knowledge-verify": cmdKnowledgeVerify,
	"knowledge-curate": cmdKnowledgeCurate,
	bootstrap: cmdBootstrap,
	fleet: cmdFleet,
	metrics: cmdMetrics,
	"doctor-session": cmdDoctorSession,
	diff: cmdDiff,
	targets: cmdTargets,
	message: cmdMessage,
};

const fn = cmds[cmd ?? ""];
if (fn) await fn(rest);
else
	die(
		"unknown command — try emit | broadcast | poll | wait | fact | bootstrap | state | inbox | capsule | pause | paused | resume | resumed | resume-session | doctor-session | who-knows | consult | consult-reply | consults | kb | knowledge | knowledge-enqueue | knowledge-promote | knowledge-retire | knowledge-note | knowledge-verify | knowledge-curate | lease-release | gc | fleet | metrics | diff | targets | message",
	);
