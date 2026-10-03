// hooks/lib/govdb.ts — shared governor registry DB (SQLite, WAL).
// One connection shape for every writer (governor gate, files gate; the
// standalone claim CLI keeps its own copy) + one-time JSON→SQL migrations so
// gates never read two sources of truth. busy_timeout is set BEFORE
// journal_mode: under contention the connection waits instead of throwing;
// WAL is persistent once set and verified on open.
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
} from "node:fs";
import { resolve } from "node:path";

const REG = `${process.env.HOME}/.cache/claude-governor`;

// one project identity for the whole control plane: realpath of the repo's
// COMMON git dir — every worktree of one repo shares one Work Graph, and
// work.ts / coord.ts bootstrap / a future consult layer can never disagree
export function projectIdentity(): string {
	try {
		const r = Bun.spawnSync(
			["git", "-C", process.cwd(), "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (r.exitCode === 0) {
			const dir = new TextDecoder().decode(r.stdout).trim();
			if (dir) return realpathSync(resolve(process.cwd(), dir));
		}
	} catch {}
	return realpathSync(process.cwd());
}

// capability vocabulary for capability-aware dispatch (schema v2):
// work_items.requires ⊆ sessions.capabilities or work take refuses
export const CAPABILITIES = [
	"shell",
	"fs",
	"git",
	"build",
	"mcp",
	"vision",
	"browser",
	"network",
];

// W54 — THE decision-kind gate, shared by every consumer of NEED% forks
// (advise.ts, the board's /api/advise + /api/ack). coord emit passes kinds
// through verbatim, and a lane shipped 'need-decision'; syncDecisions'
// backfill uses SQL LIKE 'NEED%', which SQLite matches case-INsensitively —
// so the board listed forks the case-sensitive startsWith("NEED") gates then
// refused to advise on (live 500). Uppercase-only normalization keeps this
// EXACTLY equal to that LIKE accept set (stripping [-_] would widen it).
export function isDecisionKind(kind: string): boolean {
	return kind.toUpperCase().startsWith("NEED");
}

// W15 — lane-level wall-time metric. Per-item claim→done is distorted when a
// lane works items back-to-back (serialized multi-claims), so replay the Work
// Graph bus events instead of trusting item timestamps: wall = first claim →
// terminal event, agent = Σ closed claim segments. Derived from EXISTING
// events (work.claimed / work.released / work.done / work.failed all carry
// work+project+ts) — no schema, no migration.
export interface ItemTiming {
	project: string;
	work: string;
	firstClaim: number; // first work.claimed ts (0 = never claimed, e.g. auto-rollup)
	lastEvent: number; // last observed event ts (nowMs while still open)
	wallMs: number; // lastEvent − firstClaim (0 when never claimed)
	agentMs: number; // Σ claim segments; an open segment counts up to nowMs
	claims: number;
	releases: number;
	done: boolean;
	failed: boolean;
}

// Replay one project's work events chronologically. A work.claimed opens a
// claim segment; the next work.released / work.done / work.failed closes it
// (that duration is agent time). Items never claimed (auto-rollup parents)
// get wallMs 0 — there is no claim→done interval to measure.
export function workTiming(
	db: Database,
	project: string,
	nowMs = Date.now(),
): ItemTiming[] {
	const rows = db
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND json_extract(payload, '$.project') = ? ORDER BY ts, id",
		)
		.all(project) as {
		id: number;
		ts: number;
		kind: string;
		payload: string | null;
	}[];
	const open = new Map<string, number>(); // work id → open claim-segment start ts
	const out = new Map<string, ItemTiming>();
	const item = (work: string): ItemTiming => {
		let t = out.get(work);
		if (!t) {
			t = {
				project,
				work,
				firstClaim: 0,
				lastEvent: 0,
				wallMs: 0,
				agentMs: 0,
				claims: 0,
				releases: 0,
				done: false,
				failed: false,
			};
			out.set(work, t);
		}
		return t;
	};
	for (const r of rows) {
		let work = "";
		try {
			work = (JSON.parse(r.payload ?? "{}") as { work?: string }).work ?? "";
		} catch {}
		if (!work) continue;
		const t = item(work);
		if (r.kind === "work.claimed") {
			t.claims++;
			if (!t.firstClaim) t.firstClaim = r.ts;
			open.set(work, r.ts);
		} else {
			const start = open.get(work);
			if (start != null) {
				t.agentMs += Math.max(0, r.ts - start);
				open.delete(work);
				t.releases++;
			}
			if (r.kind === "work.done") t.done = true;
			if (r.kind === "work.failed") t.failed = true;
			t.lastEvent = r.ts;
		}
	}
	for (const [work, start] of open) {
		const t = item(work);
		t.agentMs += Math.max(0, nowMs - start);
		t.lastEvent = nowMs;
	}
	for (const t of out.values())
		if (t.firstClaim) t.wallMs = t.lastEvent - t.firstClaim;
	return [...out.values()].sort((a, b) => (a.work < b.work ? -1 : 1));
}

// W24 — usage per task. APPROXIMATION: a transcript shared across items (one
// session working several items serially) is attributed by claim-window
// overlap in time, not causality. Windows replay from the same bus events as
// workTiming: each work.claimed (payload `by` = owner sid) opens
// [claim → closing work.released/done/failed], open claims run to nowMs;
// multiple claims = sum of windowed sums. sid → sessions.transcript_path;
// no resolvable transcript ⇒ null (rendered '-', never 0). Fresh parses
// cache per (project, item) in facts (`metrics.tokens.<proj>.<id>`,
// version-incremented, keyed by transcript mtime) — a DONE item skips
// re-parse while its transcript is unchanged. Transcript errors fail soft.
export interface ItemTokens {
	work: string;
	in: number; // Σ input_tokens (prompt, minus cache reads/creation)
	out: number; // Σ output_tokens
	cacheR: number; // Σ cache_read_input_tokens
	cacheC: number; // Σ cache_creation_input_tokens
}

export function tokenUsage(
	db: Database,
	project: string,
	nowMs = Date.now(),
): Map<string, ItemTokens | null> {
	const rows = db
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND json_extract(payload, '$.project') = ? ORDER BY ts, id",
		)
		.all(project) as {
		id: number;
		ts: number;
		kind: string;
		payload: string | null;
	}[];
	const wins = new Map<string, { start: number; end: number }[]>(); // work id → claim windows (end 0 = still open)
	const sids = new Map<string, string[]>();
	const done = new Set<string>();
	for (const r of rows) {
		let p: { work?: string; by?: string } = {};
		try {
			p = JSON.parse(r.payload ?? "{}") as { work?: string; by?: string };
		} catch {}
		if (!p.work) continue;
		if (r.kind === "work.claimed") {
			if (!wins.has(p.work)) wins.set(p.work, []);
			wins.get(p.work)?.push({ start: r.ts, end: 0 });
			if (p.by) {
				const arr = sids.get(p.work) ?? [];
				arr.push(p.by);
				sids.set(p.work, arr);
			}
		} else {
			const w = wins.get(p.work)?.find((x) => x.end === 0); // claims close in order (FIFO)
			if (w) w.end = r.ts;
			if (r.kind === "work.done") done.add(p.work);
		}
	}
	const out = new Map<string, ItemTokens | null>();
	for (const [work, ws] of wins) {
		out.set(work, null); // default: unresolvable → rendered '-', never 0
		try {
			const paths = new Set<string>();
			for (const sid of sids.get(work) ?? []) {
				const tp = (
					db
						.query("SELECT transcript_path FROM sessions WHERE sid = ?")
						.get(sid) as { transcript_path?: string | null } | undefined
				)?.transcript_path;
				if (tp) paths.add(tp);
			}
			if (!paths.size) continue;
			let maxM = 0;
			for (const tp of paths) maxM = Math.max(maxM, statSync(tp).mtimeMs); // missing file throws → fail soft below
			const key = `metrics.tokens.${project.replace(/[^A-Za-z0-9._-]/g, "-")}.${work}`;
			const cached = JSON.parse(
				(
					db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
						value?: string;
					} | null
				)?.value ?? "null",
			) as {
				in: number;
				out: number;
				cacheR: number;
				cacheC: number;
				at: number;
				tpMtime: number;
			} | null;
			if (done.has(work) && cached?.tpMtime === maxM) {
				// cache hit: item terminal and transcript untouched since last parse
				out.set(work, {
					work,
					in: cached.in,
					out: cached.out,
					cacheR: cached.cacheR,
					cacheC: cached.cacheC,
				});
				continue;
			}
			const t: ItemTokens = { work, in: 0, out: 0, cacheR: 0, cacheC: 0 };
			const n = (x: unknown): number =>
				typeof x === "number" && Number.isFinite(x) ? x : 0;
			for (const tp of paths) {
				for (const line of readFileSync(tp, "utf8").split("\n")) {
					if (!line.includes('"type":"assistant"')) continue; // cheap pre-filter — only assistant lines carry usage
					let ts = NaN;
					let u: Record<string, unknown> | undefined;
					try {
						const o = JSON.parse(line) as {
							timestamp?: string;
							message?: { usage?: Record<string, unknown> };
						};
						ts = Date.parse(o.timestamp ?? "");
						u = o.message?.usage;
					} catch {}
					if (!u || !Number.isFinite(ts)) continue;
					if (!ws.some((w) => ts >= w.start && ts <= (w.end || nowMs)))
						continue;
					t.in += n(u.input_tokens);
					t.out += n(u.output_tokens);
					t.cacheR += n(u.cache_read_input_tokens);
					t.cacheC += n(u.cache_creation_input_tokens);
				}
			}
			out.set(work, t);
			db.query(
				"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'coord', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
			).run(
				key,
				JSON.stringify({
					in: t.in,
					out: t.out,
					cacheR: t.cacheR,
					cacheC: t.cacheC,
					at: nowMs,
					tpMtime: maxM,
				}),
				nowMs,
			);
		} catch {
			// fail soft: a bad/missing transcript never blocks metrics
		}
	}
	return out;
}

// v10 statement list (W166): the knowledge split rides ONE transaction, so
// the whole move is a fixed, reviewable statement table — kb side (CREATE +
// copy preserving ids + FTS rebuild from main), then main side (DROP).
// Trigger bodies may NOT schema-qualify (SQLite forbids cross-db references
// inside a trigger) — the kb.name prefix registers the trigger in kb, where
// the unqualified body/ON names resolve.
// kb pre-existing (rolled-back attempt = empty file; RESET governor meeting
// the post-split store = kb final + rows) must not break the move: DDL is
// IF NOT EXISTS and the row copies ride ONLY into an empty kb (kb wins on
// reset); split-brain (both sides hold rows) refuses loudly in the fn below.
const KNOWLEDGE_SPLIT_V10 = (copy: boolean): string[] => [
	"CREATE TABLE IF NOT EXISTS kb.knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER, hub_eligible INTEGER)",
	"CREATE VIRTUAL TABLE IF NOT EXISTS kb.knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')",
	"CREATE TRIGGER IF NOT EXISTS kb.knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
	"CREATE TRIGGER IF NOT EXISTS kb.knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END",
	"CREATE TRIGGER IF NOT EXISTS kb.knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
	"CREATE TABLE IF NOT EXISTS kb.knowledge_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result_key TEXT, domain TEXT, area TEXT, code_origin TEXT, started_at INTEGER, origin_sid TEXT, source_ref TEXT, source_hash TEXT, hub_eligible INTEGER)",
	...(copy
		? [
				"INSERT INTO kb.knowledge (id, ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, superseded_by, created_at, updated_at, hub_eligible) SELECT id, ts, topic, fact, confidence, domain, area, origin_kind, origin_system, code_origin, origin_sid, contributors, duplicate_of, supersedes_id, source_ref, source_hash, source, state, superseded_by, created_at, updated_at, hub_eligible FROM main.knowledge ORDER BY id",
				"INSERT INTO kb.knowledge_queue (id, ts, source, payload, state, attempts, result_key, domain, area, code_origin, started_at, origin_sid, source_ref, source_hash, hub_eligible) SELECT id, ts, source, payload, state, attempts, result_key, domain, area, code_origin, started_at, origin_sid, source_ref, source_hash, hub_eligible FROM main.knowledge_queue ORDER BY id",
				"INSERT INTO kb.knowledge_fts (rowid, topic, fact) SELECT id, topic, fact FROM main.knowledge",
			]
		: []),
	"DROP TRIGGER IF EXISTS main.knowledge_fts_ai",
	"DROP TRIGGER IF EXISTS main.knowledge_fts_ad",
	"DROP TRIGGER IF EXISTS main.knowledge_fts_au",
	"DROP TABLE IF EXISTS main.knowledge_fts",
	"DROP TABLE IF EXISTS main.knowledge",
	"DROP TABLE IF EXISTS main.knowledge_queue",
];

// W166: the v6-era knowledge tables leave governor.db (uv < 10) — one
// transaction across main + attached kb; a crash rolls back, uv stays < 10,
// and the next open retries. The pre-migration VACUUM INTO of governor.db
// (knowledge rows still resident) is the rollback anchor.
export function migrateKnowledgeSplit(db: Database): void {
	db.run("ATTACH DATABASE ? AS kb", [`${REG}/knowledge.db`]);
	const n = (s: string): number =>
		Number((db.query(s).get() as { n: number }).n);
	const mainN = n("SELECT COUNT(*) AS n FROM main.knowledge");
	const kbHas =
		n("SELECT COUNT(*) AS n FROM kb.sqlite_master WHERE name = 'knowledge'") >
		0;
	const kbN = kbHas ? n("SELECT COUNT(*) AS n FROM kb.knowledge") : 0;
	// split-brain refusal: both files holding knowledge rows is not a state a
	// migration may guess its way out of — name the pre-split backups instead.
	if (kbHas && kbN > 0 && mainN > 0)
		throw new Error(
			"knowledge split (v10): governor.db AND knowledge.db both hold knowledge rows — resolve manually (pre-split snapshots: governor-pre-knowledge-split-*)",
		);
	if (mainN > 0) {
		let bak = `${REG}/governor-pre-knowledge-split-${Date.now()}.db`;
		for (let i = 1; existsSync(bak); i++)
			bak = `${REG}/governor-pre-knowledge-split-${Date.now()}-${i}.db`;
		db.run(`VACUUM INTO '${bak.replaceAll("'", "''")}'`);
		console.error(
			`[govdb] v10 pre-migration backup: ${bak} (${mainN} knowledge rows)`,
		);
	}
	// page_size bakes at file creation — set BEFORE the first kb write; a
	// no-op when kb already has pages (retry after a rolled-back attempt).
	db.run("PRAGMA kb.page_size = 8192");
	db.run("BEGIN IMMEDIATE");
	try {
		for (const sql of KNOWLEDGE_SPLIT_V10(kbN === 0)) db.run(sql);
		db.run("PRAGMA user_version = 10");
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error
			? new Error(
					`govdb knowledge split (v10) failed, rolled back: ${e.message}`,
					{
						cause: e,
					},
				)
			: e;
	}
	db.run("VACUUM"); // freed pages returned (design step 5, outside the tx)
	db.run("DETACH DATABASE kb");
}

export function openGovernorDb(): Database {
	mkdirSync(REG, { recursive: true });
	const db = new Database(`${REG}/governor.db`, { create: true });
	db.run("PRAGMA busy_timeout=2000");
	try {
		db.run("PRAGMA journal_mode=WAL");
	} catch {
		const mode = (
			db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
		)?.journal_mode;
		if (mode?.toLowerCase() !== "wal")
			throw new Error(
				`governor.db WAL unavailable (got: ${mode ?? "unknown"})`,
			);
	}
	db.run("PRAGMA synchronous=NORMAL");
	db.run("PRAGMA foreign_keys=ON"); // composite FKs guard work_deps against cross-project/orphan edges
	// schema versioning via PRAGMA user_version: baseline 1 = composite-PK work
	// graph. Future migrations must be explicit steps (v1→v2), never inferred.
	const uv = (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
	if (uv < 1) db.run("PRAGMA user_version = 1");
	db.run(
		"CREATE TABLE IF NOT EXISTS claims (sid TEXT NOT NULL, scope TEXT NOT NULL, intent TEXT, hot INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, tp TEXT, PRIMARY KEY (sid, scope))",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS locks (path TEXT PRIMARY KEY, sid TEXT NOT NULL, tool TEXT, ts INTEGER NOT NULL, tp TEXT, hash TEXT, seen TEXT)",
	);
	// event bus (coord.ts): append-only events, per-agent cursors, canonical facts.
	// target = directed inbox (null = broadcast); added by migration on older DBs.
	db.run(
		"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	const evCols = (
		db.query("PRAGMA table_info(events)").all() as { name: string }[]
	).map((c) => c.name);
	if (!evCols.includes("target"))
		db.run("ALTER TABLE events ADD COLUMN target TEXT");
	db.run(
		"CREATE TABLE IF NOT EXISTS cursors (sid TEXT PRIMARY KEY, event_id INTEGER NOT NULL)",
	);
	// work graph: hierarchical, claimable, shatterable work items (bin/work.ts).
	// project = repo root realpath — partitions the graph per project so
	// sessions in different repos never see (or steal) each other's work.
	// CREATE TABLE IF NOT EXISTS cannot upgrade a live table, so legacy
	// (single-PK, pre-partition) shapes are migrated in one transaction:
	// empty tables are recreated; tables holding rows are renamed to
	// <name>_legacy_<ts> — rows survive verbatim, nothing is ever dropped
	// while non-empty. A failed rename aborts the whole migration (throw),
	// never a silent loss. FKs off during the shape swap per the documented
	// alter-table procedure (sqlite.org/lang_altertable.html).
	db.run("PRAGMA foreign_keys=OFF");
	try {
		db.run("BEGIN IMMEDIATE");
		for (const name of ["work_deps", "work_items"]) {
			const row = db
				.query(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(name) as { sql?: string } | undefined;
			if (!row?.sql || /PRIMARY KEY\s*\(\s*project/.test(row.sql)) continue; // absent or current shape
			const n = (
				db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
			).n;
			if (n === 0) db.run(`DROP TABLE "${name}"`);
			else {
				const backup = `${name}_legacy_${Date.now()}`;
				db.run(`ALTER TABLE "${name}" RENAME TO "${backup}"`);
				console.error(
					`[govdb] legacy ${name} held ${n} rows — preserved in ${backup} (project mapping ambiguous, not auto-converted)`,
				);
			}
		}
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error
			? new Error(
					`govdb work-graph migration refused (no data touched): ${e.message}`,
					{ cause: e },
				)
			: e;
	} finally {
		db.run("PRAGMA foreign_keys=ON");
	}
	db.run(
		"CREATE TABLE IF NOT EXISTS work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS work_deps (project TEXT NOT NULL, work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (project, work_id, depends_on), FOREIGN KEY (project, work_id) REFERENCES work_items(project, id) ON DELETE CASCADE, FOREIGN KEY (project, depends_on) REFERENCES work_items(project, id) ON DELETE CASCADE)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS work_sequences (project TEXT PRIMARY KEY, next_id INTEGER NOT NULL)",
	);
	// consults: quick questions between sessions — never claims, ownership, or
	// lane state. WORK = implement, CONSULT = answer, HANDOFF = take ownership.
	db.run(
		"CREATE TABLE IF NOT EXISTS consults (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, asker_sid TEXT NOT NULL, expert_sid TEXT NOT NULL, question TEXT NOT NULL, scope TEXT, state TEXT NOT NULL DEFAULT 'OPEN', answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER)",
	);
	// session registry (coord bootstrap): who exists, where, doing what role
	db.run(
		"CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')",
	);
	// v2 — capability-aware dispatch: work declares requires (csv), sessions
	// advertise capabilities (csv); work take refuses requires ⊄ capabilities.
	// NULL on either side = legacy = no constraint. Explicit migration step.
	const sessCols = (
		db.query("PRAGMA table_info(sessions)").all() as { name: string }[]
	).map((c) => c.name);
	if (!sessCols.includes("capabilities"))
		db.run("ALTER TABLE sessions ADD COLUMN capabilities TEXT");
	if (!sessCols.includes("transcript_path"))
		db.run("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
	const wiCols = (
		db.query("PRAGMA table_info(work_items)").all() as { name: string }[]
	).map((c) => c.name);
	if (!wiCols.includes("requires"))
		db.run("ALTER TABLE work_items ADD COLUMN requires TEXT");
	// origin (multi-machine readiness, owner 2026-09-28): "<host>:<agent>"
	// stamped at dispatch via `work take --origin` — which machine and which
	// agent backend claimed the item; surfaced on board cards. COALESCE at
	// take keeps the first dispatch's stamp across resume re-takes.
	if (!wiCols.includes("origin"))
		db.run("ALTER TABLE work_items ADD COLUMN origin TEXT");
	if (uv < 2) db.run("PRAGMA user_version = 2");
	// v4 — consult knowledge base: (problem → solution) pairs harvested from
	// answered consults; new consults resolve against it before routing to a
	// live expert. Standalone FTS5 index (rowid = consult_kb.id), all-trees
	// scope by design — a fix learned in one repo answers the same question
	// in another. (v3 was spent by the decisions schema.)
	if (uv < 4) {
		db.run(
			"CREATE TABLE IF NOT EXISTS consult_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL, solution TEXT NOT NULL, project TEXT NOT NULL, asked_by TEXT NOT NULL, answered_by TEXT NOT NULL, consult_id INTEGER, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL)",
		);
		db.run(
			"CREATE VIRTUAL TABLE IF NOT EXISTS consult_kb_fts USING fts5(problem)",
		);
		db.run("PRAGMA user_version = 4");
	}
	db.run(
		"CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	// v5 — row-image delta log (W33): sessions, claims, locks, facts, and
	// work_items all mutate IN PLACE with no event trail, so "what actually
	// changed between two points" (coord diff --since) was unreconstructable.
	// AFTER triggers append row images to `deltas`; before is NULL on insert,
	// after NULL on delete. events/cursors stay untracked — the bus already is
	// its own trail. CREATEs run every open (IF NOT EXISTS, so a dropped table
	// or trigger self-heals) and DDL never fires row triggers.
	db.run(
		"CREATE TABLE IF NOT EXISTS deltas (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tbl TEXT NOT NULL, op TEXT NOT NULL, pk TEXT NOT NULL, before TEXT, after TEXT)",
	);
	db.run("CREATE INDEX IF NOT EXISTS deltas_ts ON deltas(ts, seq)"); // --since <event-id> resolves ts → seq
	if (uv < 5) db.run("PRAGMA user_version = 5");
	// v6 — the knowledge layer (W91): distilled fleet knowledge as first-class
	// rows with the sortable axes (domain/area/origin_kind/origin_system/
	// code_origin) the plan→query→investigate workflow needs; state gates
	// promotion (worker writes candidates, human/merge promotes). DDL +
	// facts backfill in ONE transaction — a crash rolls back, next open retries.
	if (uv < 6) {
		db.run("BEGIN IMMEDIATE");
		try {
			db.run(
				"CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, domain TEXT, area TEXT, origin_kind TEXT, origin_system TEXT, code_origin TEXT, origin_sid TEXT, contributors TEXT, duplicate_of INTEGER, supersedes_id INTEGER, source_ref TEXT, source_hash TEXT, source TEXT NOT NULL DEFAULT 'knowledge-worker', state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER)",
			);
			// external-content FTS5 (W91 #7): the index holds ONLY the inverted
			// index — topic+fact text is read from knowledge at query time, so
			// text is stored exactly once. UNINDEXED filter columns fall through
			// to the content table by name (hence origin_kind, not kind).
			db.run(
				"CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
			);
			db.run(
				"CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(value, key UNINDEXED)",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts (rowid, value, key) VALUES (NEW.rowid, NEW.value, NEW.key); END",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN DELETE FROM facts_fts WHERE rowid = OLD.rowid; END",
			);
			db.run(
				"CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN DELETE FROM facts_fts WHERE rowid = OLD.rowid; INSERT INTO facts_fts (rowid, value, key) VALUES (NEW.rowid, NEW.value, NEW.key); END",
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS knowledge_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result_key TEXT, domain TEXT, area TEXT, code_origin TEXT, started_at INTEGER, origin_sid TEXT, source_ref TEXT, source_hash TEXT)",
			);
			db.run(
				"INSERT INTO facts_fts (rowid, value, key) SELECT rowid, value, key FROM facts WHERE value IS NOT NULL",
			);
			db.run("PRAGMA user_version = 6");
			db.run("COMMIT");
		} catch (e) {
			try {
				db.run("ROLLBACK");
			} catch {}
			throw e instanceof Error
				? new Error(
						`govdb knowledge-layer migration (v6) failed, rolled back: ${e.message}`,
						{ cause: e },
					)
				: e;
		}
	}
	// W91 schema-delta convergence (every open, idempotent): DBs that already
	// ran the first v6 draft pre-date the full knowledge shape — converge the
	// columns + backfill the ms clocks at every open, never silently drift.
	const knCols = (
		db.query("PRAGMA table_info(knowledge)").all() as { name: string }[]
	).map((c) => c.name);
	if (knCols.length) {
		const adds: [string, string][] = [
			["created_at", "INTEGER"],
			["updated_at", "INTEGER"],
			["origin_sid", "TEXT"],
			["contributors", "TEXT"],
			["duplicate_of", "INTEGER"],
			["supersedes_id", "INTEGER"],
			["source_ref", "TEXT"],
			["source_hash", "TEXT"],
		];
		for (const [col, ddl] of adds)
			if (!knCols.includes(col))
				db.run(`ALTER TABLE knowledge ADD COLUMN ${col} ${ddl}`);
		db.run("UPDATE knowledge SET created_at = ts WHERE created_at IS NULL");
		db.run(
			"UPDATE knowledge SET updated_at = COALESCE(updated_at, created_at, ts) WHERE updated_at IS NULL",
		);
	}
	// W91 #7: DBs that ran the earlier v6 draft hold a REGULAR fts5
	// knowledge_fts (its own text copy). Converge to external-content — drop,
	// recreate with content='knowledge', rebuild the index from knowledge rows,
	// and refresh the sync triggers to the documented external-content form.
	const ftsSql =
		(
			db
				.query(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'",
				)
				.get() as { sql?: string } | null
		)?.sql ?? "";
	if (ftsSql && !ftsSql.includes("content='knowledge'")) {
		db.run("DROP TRIGGER IF EXISTS knowledge_fts_ai");
		db.run("DROP TRIGGER IF EXISTS knowledge_fts_ad");
		db.run("DROP TRIGGER IF EXISTS knowledge_fts_au");
		db.run("DROP TABLE knowledge_fts");
		db.run(
			"CREATE VIRTUAL TABLE knowledge_fts USING fts5(topic, fact, domain UNINDEXED, area UNINDEXED, origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED, content='knowledge', content_rowid='id')",
		);
		db.run(
			"INSERT INTO knowledge_fts (rowid, topic, fact) SELECT id, topic, fact FROM knowledge",
		);
		db.run(
			"CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
		);
		db.run(
			"CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); END",
		);
		db.run(
			"CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN INSERT INTO knowledge_fts (knowledge_fts, rowid, topic, fact) VALUES ('delete', OLD.id, OLD.topic, OLD.fact); INSERT INTO knowledge_fts (rowid, topic, fact) VALUES (NEW.id, NEW.topic, NEW.fact); END",
		);
	}
	const kqCols = (
		db.query("PRAGMA table_info(knowledge_queue)").all() as { name: string }[]
	).map((c) => c.name);
	if (kqCols.length && !kqCols.includes("origin_sid"))
		db.run("ALTER TABLE knowledge_queue ADD COLUMN origin_sid TEXT");
	// W100: enqueue-time provenance — the declared source_ref (normalized) and
	// the sha256 of the FILE it names at enqueue time (producer has repo
	// access), passed through claim() into the final row. NULL hash = the ref
	// did not resolve for the producer — honest, never a doomed value.
	if (kqCols.length && !kqCols.includes("source_ref"))
		db.run("ALTER TABLE knowledge_queue ADD COLUMN source_ref TEXT");
	if (kqCols.length && !kqCols.includes("source_hash"))
		db.run("ALTER TABLE knowledge_queue ADD COLUMN source_hash TEXT");
	// one column table drives all 15 triggers so the images can never drift
	// from the schemas they mirror. Locks are the highest-churn rows in the
	// fleet (a renew per file edit), so lock rows are op-only (before/after
	// NULL): a renew carries no information beyond the path, and flooding the
	// log with lock images would drown the tables that matter. The json cost
	// measured in the noise either way (~5-7 µs/op, op-only vs full-image);
	// the other four tables carry full row images.
	const deltaImg = (cols: string[], r: "OLD" | "NEW"): string =>
		cols.length
			? `json_object(${cols.map((c) => `'${c}', ${r}.${c}`).join(", ")})`
			: "NULL";
	// ms clock: deltas must interleave with events.ts (--since <event-id> picks
	// the nearest later seq by ts), so second-granular strftime('%s') would
	// order same-second rows wrongly. unixepoch('subsec') is SQLite ≥3.42.
	let deltaNow = "strftime('%s','now') * 1000";
	try {
		db.query("SELECT unixepoch('subsec') AS ms").get();
		deltaNow = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
	} catch {}
	const deltaTables: { tbl: string; pk: string; cols: string[] }[] = [
		{
			tbl: "sessions",
			pk: "$.sid",
			cols: [
				"sid",
				"project",
				"role",
				"parent_sid",
				"worktree",
				"started_at",
				"hb",
				"state",
				"capabilities",
				"transcript_path",
			],
		},
		{
			tbl: "claims",
			pk: "$.sid || '/' || $.scope",
			cols: ["sid", "scope", "intent", "hot", "ts", "tp"],
		},
		{ tbl: "locks", pk: "$.path", cols: [] },
		{
			tbl: "facts",
			pk: "$.key",
			cols: ["key", "value", "source", "version", "ts"],
		},
		{
			tbl: "work_items",
			pk: "$.project || '/' || $.id",
			cols: [
				"project",
				"id",
				"parent_id",
				"title",
				"description",
				"state",
				"priority",
				"owner_sid",
				"created_by",
				"scope",
				"why_parallel",
				"result_sha",
				"required",
				"created_at",
				"updated_at",
				"requires",
			],
		},
		// W132 router governance tables — deltas coverage is the audit win:
		// adding entries here is the whole mechanism (v8 block below creates
		// the tables these triggers mirror).
		{
			tbl: "api_keys",
			pk: "$.key_id",
			cols: [
				"key_id",
				"key_hash",
				"jti",
				"name",
				"team",
				"actor",
				"token_type",
				"parent_key_id",
				"scopes",
				"rpm_limit",
				"tpm_limit",
				"expires_at",
				"rotated_at",
				"revoked_at",
				"created_at",
			],
		},
		{
			tbl: "teams",
			pk: "$.team_id",
			cols: ["team_id", "name", "department", "created_at"],
		},
		{
			tbl: "route_audit",
			pk: "$.rid",
			cols: [
				"rid",
				"ts",
				"actor",
				"dialect",
				"hint",
				"candidates",
				"resolved_target",
				"decision",
				"latency_class",
				"error_code",
			],
		},
		{
			tbl: "aid_events",
			pk: "$.id",
			cols: [
				"id",
				"ts",
				"sid",
				"work_item",
				"aid",
				"packet_id",
				"tokens_injected",
				"est_tok_saved",
			],
		},
		{
			tbl: "aid_rollup",
			pk: "$.hour_bucket || '/' || $.aid || '/' || $.domain || '/' || $.model_group",
			cols: [
				"hour_bucket",
				"aid",
				"domain",
				"model_group",
				"injected",
				"skipped",
				"tok_injected",
				"est_tok_saved",
				"requests",
			],
		},
		{
			tbl: "budget_state",
			pk: "$.key_id || '/' || $.window",
			cols: ["key_id", "window", "used_rpm", "used_tpm", "window_start"],
		},
		{
			tbl: "auth_events",
			pk: "$.id",
			cols: ["id", "ts", "actor", "event", "jti", "via"],
		},
	];
	// v7 — usage analytics (W127): sessions.actor/tags give Copilot-style
	// per-user/license drill-down (actor = user or license id; tags = JSON
	// {team, department, ...}), usage_rollup is the hourly token ledger the
	// board's /api/usage serves: one row per (hour_bucket, actor, model),
	// UPSERT-ADD semantics so harvesters never overwrite — they add. Adds ride
	// the established idempotent pattern (table_info-guarded ALTER, guarded
	// CREATE every open).
	if (!sessCols.includes("actor"))
		db.run("ALTER TABLE sessions ADD COLUMN actor TEXT");
	if (!sessCols.includes("tags"))
		db.run("ALTER TABLE sessions ADD COLUMN tags TEXT");
	db.run(
		"CREATE TABLE IF NOT EXISTS usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS usage_rollup_actor ON usage_rollup(actor, hour_bucket)",
	);
	if (uv < 7) db.run("PRAGMA user_version = 7");
	// v8 — buckle router governance (W132): the tables the native router's
	// governance layer writes to — W141 virtual keys (api_keys, teams), W136
	// audit rows (route_audit), W137 aid metering (aid_events, aid_rollup),
	// W135 O(1) budgets (budget_state) — declared HERE so the deltas trigger
	// loop (below, after the last CREATE) covers them automatically. The
	// audit trail IS the deltas log: one mechanism, zero per-table wiring.
	// All-new tables, no backfill, so plain guarded CREATEs every open (the
	// idempotent house pattern).
	// api_keys: HASHES only — a raw key is shown once at creation, never
	// persisted. Token mechanics (owner amendment): token_type access|refresh;
	// rotation = new row + parent_key_id chain + old row stamped rotated_at;
	// expires_at NULL = forever (the owner's forever pair; users: access 30d,
	// refresh NULL = rotate-until-infinity); jti = unique denylist key;
	// revocation is per-token (revoked_at) and per-actor (every row of the
	// actor) — both plain UPDATEs the deltas triggers already see.
	// auth_events: the issued|refreshed|rotated|revoked|rejected ledger.
	db.run(
		"CREATE TABLE IF NOT EXISTS api_keys (key_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, jti TEXT, name TEXT, team TEXT, actor TEXT, token_type TEXT NOT NULL DEFAULT 'access', parent_key_id TEXT, scopes TEXT, rpm_limit INTEGER, tpm_limit INTEGER, expires_at INTEGER, rotated_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL)",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys(key_hash)",
	); // auth = one hash lookup
	db.run("CREATE UNIQUE INDEX IF NOT EXISTS api_keys_jti ON api_keys(jti)"); // denylist checks
	db.run(
		"CREATE TABLE IF NOT EXISTS teams (team_id TEXT PRIMARY KEY, name TEXT, department TEXT, created_at INTEGER NOT NULL)",
	);
	// route_audit (W136 §6): one row per request — INSERTed at dispatch
	// (target already known), UPDATEd in place with the outcome joined by
	// rid; the deltas insert+update trigger pair captures both writes.
	// candidates = ordered top candidate ids (comma-joined); resolved_target
	// = kind:host:port/model; actor + dialect are the W127 /usage join keys
	// the doc pins. Denied requests audit too (belt doctrine, unchanged).
	db.run(
		"CREATE TABLE IF NOT EXISTS route_audit (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, dialect TEXT, hint TEXT NOT NULL DEFAULT '', candidates TEXT, resolved_target TEXT, decision TEXT NOT NULL, latency_class TEXT, error_code TEXT)",
	);
	db.run("CREATE INDEX IF NOT EXISTS route_audit_ts ON route_audit(ts, rid)"); // window scans for panels
	// aid_events: one row per aid decision; est_tok_saved stays NULL at
	// event time (W137 honesty rule — savings are A/B-derived at dashboard
	// time, never fabricated per-request). aid_rollup: the W137 §6 SQL
	// verbatim — composite PK (hour_bucket, aid, domain, model_group),
	// UPSERT-ADD semantics so hourly flushers never overwrite, they add.
	// usage_rollup (v7) is reused as-is for token outcomes; the ROI join is
	// aid_events(sid, work_item) ⋈ usage_rollup(actor, hour).
	db.run(
		"CREATE TABLE IF NOT EXISTS aid_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sid TEXT, work_item TEXT, aid TEXT NOT NULL, packet_id TEXT, tokens_injected INTEGER NOT NULL DEFAULT 0, est_tok_saved INTEGER)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS aid_rollup (hour_bucket INTEGER NOT NULL, aid TEXT NOT NULL, domain TEXT NOT NULL, model_group TEXT NOT NULL, injected INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, tok_injected INTEGER NOT NULL DEFAULT 0, est_tok_saved INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, aid, domain, model_group))",
	);
	// budget_state (W135): the O(1) counters' durable half — (key_id, window)
	// rows the router flushes async. Flush = upsert-ADD so a retried batch
	// can never lose counts; window_start moves to the flusher's value so a
	// rolled window restarts the count honestly.
	db.run(
		"CREATE TABLE IF NOT EXISTS budget_state (key_id TEXT NOT NULL, window TEXT NOT NULL, used_rpm INTEGER NOT NULL DEFAULT 0, used_tpm INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, PRIMARY KEY (key_id, window))",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, event TEXT NOT NULL, jti TEXT, via TEXT)",
	);
	if (uv < 8) db.run("PRAGMA user_version = 8");
	// the trigger loop runs AFTER the last CREATE (W132 moved it below the v8
	// block): a trigger references its table at creation time, so on a fresh
	// DB the loop must see every table it covers already in sqlite_master.
	// CREATE TRIGGER IF NOT EXISTS keeps it idempotent and self-healing.
	for (const { tbl, pk, cols } of deltaTables)
		for (const op of ["insert", "update", "delete"] as const) {
			const R = op === "delete" ? "OLD" : "NEW";
			db.run(
				`CREATE TRIGGER IF NOT EXISTS deltas_${tbl}_${op} AFTER ${op.toUpperCase()} ON ${tbl} BEGIN INSERT INTO deltas (ts, tbl, op, pk, before, after) VALUES (${deltaNow}, '${tbl}', '${op}', ${pk.replaceAll("$.", `${R}.`)}, ${op === "insert" ? "NULL" : deltaImg(cols, "OLD")}, ${op === "delete" ? "NULL" : deltaImg(cols, "NEW")}); END`,
			);
		}
	// v9 — W159 provenance sort: sessions.data_domain carries the W154
	// domain label (hub | private). NULL = nothing routed through yet (never
	// assume); recorded sticky most-restrictive by the routing plane via
	// recordSessionDomain. knowledge.hub_eligible / knowledge_queue.hub_eligible
	// carry the settle's sort (NULL = unsettled; 1 = hub session → the
	// hub-ward feed filters hub only; 0 = private/mixed → local shelf only).
	// Additive columns; pre-W159 rows stay NULL = unsettled, honestly.
	if (uv < 9) {
		const sessCols9 = (
			db.query("PRAGMA table_info(sessions)").all() as { name: string }[]
		).map((c) => c.name);
		if (!sessCols9.includes("data_domain"))
			db.run("ALTER TABLE sessions ADD COLUMN data_domain TEXT");
		const kqCols9 = (
			db.query("PRAGMA table_info(knowledge_queue)").all() as {
				name: string;
			}[]
		).map((c) => c.name);
		if (!kqCols9.includes("hub_eligible"))
			db.run("ALTER TABLE knowledge_queue ADD COLUMN hub_eligible INTEGER");
		const knCols9 = (
			db.query("PRAGMA table_info(knowledge)").all() as { name: string }[]
		).map((c) => c.name);
		if (!knCols9.includes("hub_eligible"))
			db.run("ALTER TABLE knowledge ADD COLUMN hub_eligible INTEGER");
		db.run("PRAGMA user_version = 9");
	}
	// v10 (W166) — knowledge.db split; see migrateKnowledgeSplit above.
	if (uv < 10) migrateKnowledgeSplit(db);
	migrateJSON(db);
	return db;
}

// W166 — knowledge.db: the knowledge workload's OWN SQLite/WAL file
// (docs/design/knowledge-db-2026-10-01.md): read-path pragmas for the FTS5
// hot path. Ordering: busy_timeout BEFORE journal_mode (the openGovernorDb
// shape — under contention the connection waits instead of throwing);
// page_size is baked at file creation, so 8192 rides every open (decisive
// on the first, a silent no-op once the file has pages).
export function openKnowledgeDb(): Database {
	mkdirSync(REG, { recursive: true });
	const db = new Database(`${REG}/knowledge.db`, { create: true });
	db.run("PRAGMA busy_timeout=2000");
	db.run("PRAGMA page_size=8192");
	try {
		db.run("PRAGMA journal_mode=WAL");
	} catch {
		const mode = (
			db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
		)?.journal_mode;
		if (mode?.toLowerCase() !== "wal")
			throw new Error(
				`knowledge.db WAL unavailable (got: ${mode ?? "unknown"})`,
			);
	}
	db.run("PRAGMA synchronous=NORMAL");
	db.run("PRAGMA mmap_size=1073741824");
	// W208 curation engine: retire proposals from the recency-decay sweep,
	// disposed by a human (approve = the row retires, dismiss = cooldown).
	// Self-healing CREATE on every open (the openGovernorDb doctrine); the
	// partial unique index keeps at most ONE open proposal per knowledge row.
	db.run(
		"CREATE TABLE IF NOT EXISTS knowledge_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, knowledge_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'retire', score REAL NOT NULL, age_days INTEGER NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', decided_by TEXT, decided_at INTEGER)",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS knowledge_proposals_one_open ON knowledge_proposals (knowledge_id) WHERE state = 'open'",
	);
	return db;
}

// ─── W92 store port ──────────────────────────────────────────────────────────
// The control-plane seam: consumers bind to GovernorStore, never to the DB
// file. Local is the special case of distributed (owner doctrine): the DEFAULT
// binding is the in-process SQLite Database (today's behavior, byte-identical
// output) and the SAME interface rides HTTP (bin/store-server.ts, loopback)
// for lanes on other machines. Address chain: env GOVERNOR_STORE_URL →
// ${REG}/store.url (coordinator-written one-liner) → in-process; the
// .local/mDNS legs land with cross-machine activation. Statement-shaped on
// purpose: a binding executes the exact SQL the CLIs run today — that is what
// keeps CLI output byte-compatible and makes the port a pure transport swap.
// Liveness sweeps (sweepStaleSessions) and token metrics (tokenUsage) read
// THIS host's ~/.claude/projects transcripts, so they stay Database-typed and
// sweep-taking verbs (coord bootstrap, coord gc) sweep only on db.local.
export interface StoreResult {
	changes: number;
	lastInsertRowid: number;
}

// the port's unit of exchange — bun:sqlite statements satisfy this structurally
export interface GovernorStatement {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): StoreResult;
}

export interface GovernorStore {
	// false on the HTTP binding: this process sees the local transcript tree,
	// so transcript-derived behavior (liveness sweeps) must not run remotely
	local: boolean;
	query(sql: string): GovernorStatement;
	run(sql: string, ...params: unknown[]): StoreResult;
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

// W166 — the control-plane store must never proxy knowledge statements:
// knowledge is no longer resident in governor.db, so a knowledge statement
// riding the control plane either fails ("no such table") or — far worse —
// silently puts the read-heavy FTS workload back on the write-hot file if
// the tables are ever resurrected. String literals are stripped first:
// events LIKE 'knowledge.%' and deltas tbl='knowledge' are legit
// control-plane SQL over the WORD, never the table.
export function knowledgeSqlViolation(sql: string): string | null {
	const bare = sql
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""');
	const m = /\bknowledge(?:_fts|_queue)?\b/.exec(bare);
	return m ? m[0] : null;
}

// HTTP binding: the same interface against bin/store-server.ts — sync by
// design (the CLIs are sync programs; one statement = one curl round trip).
// transaction(fn) holds a server-side BEGIN IMMEDIATE for the body's duration
// (client-tagged txid, serialized, idle-timeout rolled back), so work
// add/done/split and resume-session run unchanged on a remote lane.
export class HttpGovernorStore implements GovernorStore {
	readonly local = false;

	constructor(
		private base: string,
		private token: string | null,
	) {
		// eager probe: a dead server fails AT OPEN — work.ts's mirror fallback
		// and coord's module-top open both expect today's throw timing
		this.query("SELECT 1").get();
	}

	private rpc(
		mode: "get" | "all" | "run" | "tx",
		sql: string,
		params: unknown[],
	): { row?: unknown; rows?: unknown[] } & Partial<StoreResult> {
		const args = [
			"curl",
			"-sSf",
			"--max-time",
			"10",
			"-X",
			"POST",
			`${this.base}/rpc`,
			"-H",
			"content-type: application/json",
		];
		if (this.token) args.push("-H", `x-governor-token: ${this.token}`);
		args.push(
			"--data-binary",
			JSON.stringify({ mode, sql, params, txid: this.txid }),
		);
		const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0)
			throw new Error(
				`governor store ${this.base} unreachable (curl exit ${r.exitCode})`,
			);
		const out = JSON.parse(new TextDecoder().decode(r.stdout));
		// server-side refusals ride a 200 body ({err}) — curl -f cannot see them
		if (out.err) throw new Error(`governor store: ${out.err}`);
		return out;
	}

	query(sql: string): GovernorStatement {
		return {
			get: (...params) => this.rpc("get", sql, params).row,
			all: (...params) => this.rpc("all", sql, params).rows ?? [],
			run: (...params) =>
				this.rpc("run", sql, params) as unknown as StoreResult,
		};
	}

	run(sql: string, ...params: unknown[]): StoreResult {
		return this.rpc("run", sql, params) as unknown as StoreResult;
	}

	// bun:sqlite shape: transaction(fn) returns the callable that runs it. Over
	// HTTP the body's statements are TAGGED with a client txid; the server holds
	// BEGIN IMMEDIATE on its tx connection for the body's duration (serialized,
	// idle-timeout rolled back). A failed body rolls back before the throw.
	transaction<T>(fn: () => T): () => T {
		return () => {
			const id = crypto.randomUUID();
			this.txid = id; // begin CARRIES the txid — the server stamps it verbatim
			try {
				this.rpc("tx", "begin", []);
			} catch (e) {
				this.txid = null;
				throw e;
			}
			let out: T;
			try {
				out = fn();
			} catch (e) {
				try {
					this.rpc("tx", "rollback", []); // txid still set — must match
				} catch {}
				this.txid = null;
				throw e;
			}
			this.rpc("tx", "commit", []);
			this.txid = null;
			return out;
		};
	}

	close(): void {}
}

// binding resolver: GOVERNOR_STORE_URL wins, then ${REG}/store.url, else the
// in-process SQLite Database. GOVERNOR_STORE_URL=local forces in-process
// (tests, emergencies). The cast is the ONE place Database becomes the port —
// bun's Database already has the statement shape, only the type differs.
export function openStore(): GovernorStore {
	const raw = (process.env.GOVERNOR_STORE_URL ?? storeUrlFile() ?? "").trim();
	if (raw && raw !== "local")
		return new HttpGovernorStore(
			raw.replace(/\/+$/, ""),
			process.env.GOVERNOR_STORE_TOKEN ?? null,
		);
	const d = openGovernorDb() as unknown as GovernorStore;
	d.local = true;
	return d;
}

function storeUrlFile(): string | null {
	try {
		return readFileSync(`${REG}/store.url`, "utf8") || null;
	} catch {
		return null;
	}
}

// in-memory store for work.ts's mirror fallback — the port surface with zero
// file involvement (was a bare `new Database(":memory:")` in work.ts, which
// is a consumer and must not own a Database import)
export function openMemoryStore(): GovernorStore {
	const d = new Database(":memory:") as unknown as GovernorStore;
	d.local = true;
	return d;
}

// W33 retention: the delta log is a ring, not an archive — coord gc trims it
// on the same window as events. Returns rows removed.
export function pruneDeltas(db: Database, olderThanMs: number): number {
	return db
		.query("DELETE FROM deltas WHERE ts < ?")
		.run(Date.now() - olderThanMs).changes;
}

// JSON registries → SQL, once, idempotently (whoever runs first migrates; the
// second process sees the .migrated rename and skips). INSERT OR REPLACE keeps
// double-import harmless if two gates race before either renames.
function migrateJSON(db: Database): void {
	const CJ = `${REG}/claims.json`;
	if (existsSync(CJ)) {
		try {
			const legacy = JSON.parse(readFileSync(CJ, "utf8")) as Record<
				string,
				{
					sid?: string;
					scopes?: string[];
					intent?: string;
					ts?: number;
					tp?: string;
					hot?: boolean;
				}
			>;
			const ins = db.query(
				"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts, tp) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const [cid, c] of Object.entries(legacy)) {
				for (const s of c?.scopes ?? [])
					ins.run(
						c?.sid ?? cid,
						s,
						c?.intent ?? null,
						c?.hot ? 1 : 0,
						c?.ts ?? Date.now(),
						c?.tp ?? null,
					);
			}
			renameSync(CJ, `${CJ}.migrated`);
		} catch {}
	}
	const LJ = `${REG}/locks.json`;
	if (existsSync(LJ)) {
		try {
			const locks = JSON.parse(readFileSync(LJ, "utf8")) as Record<
				string,
				{
					sid: string;
					tool?: string;
					ts: number;
					tp?: string;
					hash?: string;
					seen?: string[];
				}
			>;
			const ins = db.query(
				"INSERT OR REPLACE INTO locks (path, sid, tool, ts, tp, hash, seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const [p, l] of Object.entries(locks)) {
				ins.run(
					p,
					l.sid,
					l.tool ?? null,
					l.ts ?? 0,
					l.tp ?? null,
					l.hash ?? null,
					l.seen ? JSON.stringify(l.seen) : null,
				);
			}
			renameSync(LJ, `${LJ}.migrated`);
		} catch {}
	}
}

// Liveness sweep shared by gc, coord bootstrap, the monitor, and session-start
// (every bootstrap sweeps). Two signals: hb-stale (updates only at bootstrap)
// + transcript-dead for TOP-LEVEL rows; parented lanes close at 24h. Never
// sweeps the coordinator (it sleeps between waves) or sessions waiting on an
// open decision. Swept sessions keep owned work — reclaim stays a human call.
export function sweepStaleSessions(
	db: Database,
	maxIdleMs = 20 * 60_000,
): number {
	const now = Date.now();
	const coordinatorSid =
		(
			db
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as { value: string } | null
		)?.value ?? null;
	let waiting: Set<string>;
	try {
		waiting = new Set(
			(
				db
					.query(
						"SELECT answer_to AS sid FROM decisions WHERE state = 'OPEN' AND answer_to IS NOT NULL",
					)
					.all() as { sid: string }[]
			).map((r) => r.sid),
		);
	} catch {
		waiting = new Set(); // no decisions table yet — board never ran
	}
	let n = 0;
	for (const r of db
		.query(
			"SELECT sid, role FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NULL AND hb < ?",
		)
		.all(now - maxIdleMs) as {
		sid: string;
		role: string;
	}[]) {
		if (r.role === "coordinator" || r.sid === coordinatorSid) continue;
		if (waiting.has(r.sid)) continue;
		if (liveTranscript(r.sid)) continue;
		db.query(
			"UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'",
		).run(r.sid);
		n++;
	}
	for (const r of db
		.query(
			"SELECT sid FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NOT NULL AND hb < ?",
		)
		.all(now - 24 * 3_600_000) as { sid: string }[]) {
		db.query(
			"UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'",
		).run(r.sid);
		n++;
	}
	return n;
}

// a transcript written within the last 15 minutes = live process
function liveTranscript(sid: string): boolean {
	const floor = Date.now() - 15 * 60_000;
	try {
		const glob = new Bun.Glob(`**/*${sid}*.jsonl`);
		for (const rel of glob.scanSync({
			cwd: `${process.env.HOME}/.claude/projects`,
			onlyFiles: true,
		})) {
			try {
				if (
					statSync(`${process.env.HOME}/.claude/projects/${rel}`).mtimeMs >
					floor
				)
					return true;
			} catch {}
		}
	} catch {}
	return false;
}
