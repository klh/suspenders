// hooks/board/context.ts — process config: db, port/bind, registry paths, gate/session CLIs, board-owned decisions schema (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { openStore, type GovernorStore } from "../lib/govdb.ts";

export const CLI = (f: string) =>
	new URL(`../bin/${f}`, import.meta.url).pathname;

// row shapes the board SELECTs out of governor.db — SQLite rows are untyped,
// so every query asserts its shape once (schema: hooks/lib/govdb.ts). A
// subset query still asserts to the full row; the extra columns are absent.
export interface EventRow {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
	target: string | null;
}

export interface WorkItemRow {
	project: string;
	id: string;
	parent_id: string | null;
	title: string;
	description: string | null;
	state: string;
	priority: number;
	owner_sid: string | null;
	created_by: string | null;
	scope: string | null;
	why_parallel: string | null;
	result_sha: string | null;
	required: number;
	created_at: number;
	updated_at: number;
	requires: string | null;
	origin: string | null;
}

// W92.2: the board binds the control-plane store port — colocation-free
// like the CLIs (W92.1): GOVERNOR_STORE_URL / ${REG}/store.url rides the
// HTTP transport, default stays the in-process file (byte-identical local).
export const db: GovernorStore = openStore();
export const PORT =
	Number(process.argv[process.argv.indexOf("--port") + 1] ?? 7799) || 7799;
export const BIND = process.env.SUSPENDERS_BIND ?? "127.0.0.1";
export const DEMO = process.argv.includes("--demo");
export const REG_DIR = `${process.env.HOME}/.cache/claude-governor`;
// the setup LLM probe hits the endpoint ORIGIN (advise.ts spells the env var
// as a full chat-completions URL; the origin serves GET /v1/models for both)
export const LLM_ORIGIN = (() => {
	try {
		return new URL(process.env.SUSPENDERS_LLM_URL ?? "http://127.0.0.1:8901")
			.origin;
	} catch {
		return "http://127.0.0.1:8901";
	}
})();
// board dispatch executors (the READY-card dropdown): the two local coding
// agents plus live LLM targets from belt's remote registry. `remotes.ts
// check --json` runs server-side, cached 60s — the probes are multi-second
// and the board polls every second.
export const BELT_REPO =
	process.env.BELT_REPO ?? "/Volumes/Sensitive/github/klh/belt";
export const WORK_CLI = CLI("work.ts");
export const COORD_CLI = CLI("coord.ts");

export const gatePath = new URL("../gate.ts", import.meta.url).pathname;
export const sessionStartPath = new URL("../session-start.ts", import.meta.url)
	.pathname;

// GET /llms.txt — plain-text orientation for LLM agents (the llms.txt
// convention): what the control plane is and which endpoints this board
// serves. Static; kept factual with the routes below.

// decision lifecycle (schema v2, board-owned `decisions` table), contract:
// docs/decisions-api.md. NEED% events must not vanish when the recipient acks
// their inbox — cursors track delivery, this table tracks the human decision.
// State machine: OPEN → ANSWERED → ACKNOWLEDGED; OPEN → CANCELLED (asking
// lane supersede/cancel of the linked work, or board dismiss with UI
// confirmation). answer_token rotates on every state change — clients echo
// it in POST /api/answer for idempotency + multi-tab/stale-view protection.
db.run(`CREATE TABLE IF NOT EXISTS decisions (
	event_id INTEGER PRIMARY KEY,
	target TEXT NOT NULL,
	asked_by TEXT,
	project TEXT,
	task_id TEXT,
	question TEXT,
	options TEXT,
	state TEXT NOT NULL DEFAULT 'OPEN',
	delivery TEXT NOT NULL DEFAULT 'DELIVERED',
	answer_note TEXT,
	answer_to TEXT,
	ack_ts INTEGER,
	answer_token TEXT,
	answered_at INTEGER,
	closed_at INTEGER,
	created_at INTEGER NOT NULL
)`);

// guarded ALTERs — board-owned table: add columns if missing, never drop.
// A fresh table already has everything; a v1 table gets the v2 columns.
export const decCols = new Set(
	(db.query("PRAGMA table_info(decisions)").all() as { name: string }[]).map(
		(c) => c.name,
	),
);
for (const [col, ddl] of Object.entries({
	asked_by: "TEXT",
	project: "TEXT",
	task_id: "TEXT",
	question: "TEXT",
	options: "TEXT",
	delivery: "TEXT",
	ack_ts: "INTEGER",
	answer_token: "TEXT",
})) {
	if (!decCols.has(col))
		db.run(`ALTER TABLE decisions ADD COLUMN ${col} ${ddl}`);
}

// "dead" hb = the monitor's zombie threshold (same fact, same default)
