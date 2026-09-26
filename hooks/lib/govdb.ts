// hooks/lib/govdb.ts — shared governor registry DB (SQLite, WAL).
// One connection shape for every writer (governor gate, files gate; the
// standalone claim CLI keeps its own copy) + one-time JSON→SQL migrations so
// gates never read two sources of truth. busy_timeout is set BEFORE
// journal_mode: under contention the connection waits instead of throwing;
// WAL is persistent once set and verified on open.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REG = `${process.env.HOME}/.cache/claude-governor`;

// one project identity for the whole control plane: realpath of the repo's
// COMMON git dir — every worktree of one repo shares one Work Graph, and
// work.ts / coord.ts bootstrap / a future consult layer can never disagree
export function projectIdentity(): string {
	try {
		const r = Bun.spawnSync(["git", "-C", process.cwd(), "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode === 0) {
			const dir = new TextDecoder().decode(r.stdout).trim();
			if (dir) return realpathSync(resolve(process.cwd(), dir));
		}
	} catch {}
	return realpathSync(process.cwd());
}

// capability vocabulary for capability-aware dispatch (schema v2):
// work_items.requires ⊆ sessions.capabilities or work take refuses
export const CAPABILITIES = ["shell", "fs", "git", "build", "mcp", "vision", "browser", "network"];

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
export function workTiming(db: Database, project: string, nowMs = Date.now()): ItemTiming[] {
	const rows = db
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND json_extract(payload, '$.project') = ? ORDER BY ts, id",
		)
		.all(project) as { id: number; ts: number; kind: string; payload: string | null }[];
	const open = new Map<string, number>(); // work id → open claim-segment start ts
	const out = new Map<string, ItemTiming>();
	const item = (work: string): ItemTiming => {
		let t = out.get(work);
		if (!t) {
			t = { project, work, firstClaim: 0, lastEvent: 0, wallMs: 0, agentMs: 0, claims: 0, releases: 0, done: false, failed: false };
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
	for (const t of out.values()) if (t.firstClaim) t.wallMs = t.lastEvent - t.firstClaim;
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

export function tokenUsage(db: Database, project: string, nowMs = Date.now()): Map<string, ItemTokens | null> {
	const rows = db
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND json_extract(payload, '$.project') = ? ORDER BY ts, id",
		)
		.all(project) as { id: number; ts: number; kind: string; payload: string | null }[];
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
			wins.get(p.work)!.push({ start: r.ts, end: 0 });
			if (p.by) (sids.get(p.work) ?? sids.set(p.work, []).get(p.work)!).push(p.by);
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
				const tp = (db.query("SELECT transcript_path FROM sessions WHERE sid = ?").get(sid) as { transcript_path?: string | null } | undefined)?.transcript_path;
				if (tp) paths.add(tp);
			}
			if (!paths.size) continue;
			let maxM = 0;
			for (const tp of paths) maxM = Math.max(maxM, statSync(tp).mtimeMs); // missing file throws → fail soft below
			const key = `metrics.tokens.${project.replace(/[^A-Za-z0-9._-]/g, "-")}.${work}`;
			const cached = JSON.parse((db.query("SELECT value FROM facts WHERE key = ?").get(key) as { value?: string } | null)?.value ?? "null") as
				| { in: number; out: number; cacheR: number; cacheC: number; at: number; tpMtime: number }
				| null;
			if (done.has(work) && cached?.tpMtime === maxM) {
				// cache hit: item terminal and transcript untouched since last parse
				out.set(work, { work, in: cached.in, out: cached.out, cacheR: cached.cacheR, cacheC: cached.cacheC });
				continue;
			}
			const t: ItemTokens = { work, in: 0, out: 0, cacheR: 0, cacheC: 0 };
			const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
			for (const tp of paths) {
				for (const line of readFileSync(tp, "utf8").split("\n")) {
					if (!line.includes('"type":"assistant"')) continue; // cheap pre-filter — only assistant lines carry usage
					let ts = NaN;
					let u: Record<string, unknown> | undefined;
					try {
						const o = JSON.parse(line) as { timestamp?: string; message?: { usage?: Record<string, unknown> } };
						ts = Date.parse(o.timestamp ?? "");
						u = o.message?.usage;
					} catch {}
					if (!u || !Number.isFinite(ts)) continue;
					if (!ws.some((w) => ts >= w.start && ts <= (w.end || nowMs))) continue;
					t.in += n(u.input_tokens);
					t.out += n(u.output_tokens);
					t.cacheR += n(u.cache_read_input_tokens);
					t.cacheC += n(u.cache_creation_input_tokens);
				}
			}
			out.set(work, t);
			db.query(
				"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'coord', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
			).run(key, JSON.stringify({ in: t.in, out: t.out, cacheR: t.cacheR, cacheC: t.cacheC, at: nowMs, tpMtime: maxM }), nowMs);
		} catch {
			// fail soft: a bad/missing transcript never blocks metrics
		}
	}
	return out;
}

export function openGovernorDb(): Database {
	mkdirSync(REG, { recursive: true });
	const db = new Database(`${REG}/governor.db`, { create: true });
	db.run("PRAGMA busy_timeout=2000");
	try {
		db.run("PRAGMA journal_mode=WAL");
	} catch {
		const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode?: string })?.journal_mode;
		if (mode?.toLowerCase() !== "wal") throw new Error(`governor.db WAL unavailable (got: ${mode ?? "unknown"})`);
	}
	db.run("PRAGMA synchronous=NORMAL");
	db.run("PRAGMA foreign_keys=ON"); // composite FKs guard work_deps against cross-project/orphan edges
	// schema versioning via PRAGMA user_version: baseline 1 = composite-PK work
	// graph. Future migrations must be explicit steps (v1→v2), never inferred.
	const uv = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
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
	const evCols = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
	if (!evCols.includes("target")) db.run("ALTER TABLE events ADD COLUMN target TEXT");
	db.run("CREATE TABLE IF NOT EXISTS cursors (sid TEXT PRIMARY KEY, event_id INTEGER NOT NULL)");
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
			const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
				| { sql?: string }
				| undefined;
			if (!row?.sql || /PRIMARY KEY\s*\(\s*project/.test(row.sql)) continue; // absent or current shape
			const n = (db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
			if (n === 0) db.run(`DROP TABLE "${name}"`);
			else {
				const backup = `${name}_legacy_${Date.now()}`;
				db.run(`ALTER TABLE "${name}" RENAME TO "${backup}"`);
				console.error(`[govdb] legacy ${name} held ${n} rows — preserved in ${backup} (project mapping ambiguous, not auto-converted)`);
			}
		}
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error ? new Error(`govdb work-graph migration refused (no data touched): ${e.message}`, { cause: e }) : e;
	} finally {
		db.run("PRAGMA foreign_keys=ON");
	}
	db.run(
		"CREATE TABLE IF NOT EXISTS work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS work_deps (project TEXT NOT NULL, work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (project, work_id, depends_on), FOREIGN KEY (project, work_id) REFERENCES work_items(project, id) ON DELETE CASCADE, FOREIGN KEY (project, depends_on) REFERENCES work_items(project, id) ON DELETE CASCADE)",
	);
	db.run("CREATE TABLE IF NOT EXISTS work_sequences (project TEXT PRIMARY KEY, next_id INTEGER NOT NULL)");
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
	const sessCols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
	if (!sessCols.includes("capabilities")) db.run("ALTER TABLE sessions ADD COLUMN capabilities TEXT");
	if (!sessCols.includes("transcript_path")) db.run("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
	const wiCols = (db.query("PRAGMA table_info(work_items)").all() as { name: string }[]).map((c) => c.name);
	if (!wiCols.includes("requires")) db.run("ALTER TABLE work_items ADD COLUMN requires TEXT");
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
		db.run("CREATE VIRTUAL TABLE IF NOT EXISTS consult_kb_fts USING fts5(problem)");
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
	// one column table drives all 15 triggers so the images can never drift
	// from the schemas they mirror. Locks are the highest-churn rows in the
	// fleet (a renew per file edit), so lock rows are op-only (before/after
	// NULL): a renew carries no information beyond the path, and flooding the
	// log with lock images would drown the tables that matter. The json cost
	// measured in the noise either way (~5-7 µs/op, op-only vs full-image);
	// the other four tables carry full row images.
	const deltaImg = (cols: string[], r: "OLD" | "NEW"): string =>
		cols.length ? `json_object(${cols.map((c) => `'${c}', ${r}.${c}`).join(", ")})` : "NULL";
	// ms clock: deltas must interleave with events.ts (--since <event-id> picks
	// the nearest later seq by ts), so second-granular strftime('%s') would
	// order same-second rows wrongly. unixepoch('subsec') is SQLite ≥3.42.
	let deltaNow = "strftime('%s','now') * 1000";
	try {
		db.query("SELECT unixepoch('subsec') AS ms").get();
		deltaNow = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
	} catch {}
	const deltaTables: { tbl: string; pk: string; cols: string[] }[] = [
		{ tbl: "sessions", pk: "$.sid", cols: ["sid", "project", "role", "parent_sid", "worktree", "started_at", "hb", "state", "capabilities", "transcript_path"] },
		{ tbl: "claims", pk: "$.sid || '/' || $.scope", cols: ["sid", "scope", "intent", "hot", "ts", "tp"] },
		{ tbl: "locks", pk: "$.path", cols: [] },
		{ tbl: "facts", pk: "$.key", cols: ["key", "value", "source", "version", "ts"] },
		{ tbl: "work_items", pk: "$.project || '/' || $.id", cols: ["project", "id", "parent_id", "title", "description", "state", "priority", "owner_sid", "created_by", "scope", "why_parallel", "result_sha", "required", "created_at", "updated_at", "requires"] },
	];
	for (const { tbl, pk, cols } of deltaTables)
		for (const op of ["insert", "update", "delete"] as const) {
			const R = op === "delete" ? "OLD" : "NEW";
			db.run(
				`CREATE TRIGGER IF NOT EXISTS deltas_${tbl}_${op} AFTER ${op.toUpperCase()} ON ${tbl} BEGIN INSERT INTO deltas (ts, tbl, op, pk, before, after) VALUES (${deltaNow}, '${tbl}', '${op}', ${pk.replaceAll("$.", `${R}.`)}, ${op === "insert" ? "NULL" : deltaImg(cols, "OLD")}, ${op === "delete" ? "NULL" : deltaImg(cols, "NEW")}); END`,
			);
		}
	migrateJSON(db);
	return db;
}

// W33 retention: the delta log is a ring, not an archive — coord gc trims it
// on the same window as events. Returns rows removed.
export function pruneDeltas(db: Database, olderThanMs: number): number {
	return db.query("DELETE FROM deltas WHERE ts < ?").run(Date.now() - olderThanMs).changes;
}

// JSON registries → SQL, once, idempotently (whoever runs first migrates; the
// second process sees the .migrated rename and skips). INSERT OR REPLACE keeps
// double-import harmless if two gates race before either renames.
function migrateJSON(db: Database): void {
	const CJ = `${REG}/claims.json`;
	if (existsSync(CJ)) {
		try {
			const legacy = JSON.parse(readFileSync(CJ, "utf8")) as Record<
				string, { sid?: string; scopes?: string[]; intent?: string; ts?: number; tp?: string; hot?: boolean }
			>;
			const ins = db.query(
				"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts, tp) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const [cid, c] of Object.entries(legacy)) {
				for (const s of c?.scopes ?? []) ins.run(c?.sid ?? cid, s, c?.intent ?? null, c?.hot ? 1 : 0, c?.ts ?? Date.now(), c?.tp ?? null);
			}
			renameSync(CJ, `${CJ}.migrated`);
		} catch {}
	}
	const LJ = `${REG}/locks.json`;
	if (existsSync(LJ)) {
		try {
			const locks = JSON.parse(readFileSync(LJ, "utf8")) as Record<
				string, { sid: string; tool?: string; ts: number; tp?: string; hash?: string; seen?: string[] }
			>;
			const ins = db.query(
				"INSERT OR REPLACE INTO locks (path, sid, tool, ts, tp, hash, seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const [p, l] of Object.entries(locks)) {
				ins.run(p, l.sid, l.tool ?? null, l.ts ?? 0, l.tp ?? null, l.hash ?? null, l.seen ? JSON.stringify(l.seen) : null);
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
export function sweepStaleSessions(db: Database, maxIdleMs = 20 * 60_000): number {
	const now = Date.now();
	const coordinatorSid = (db.query("SELECT value FROM facts WHERE key = 'coordinator.sid'").get() as { value: string } | null)?.value ?? null;
	let waiting: Set<string>;
	try {
		waiting = new Set((db.query("SELECT answer_to AS sid FROM decisions WHERE state = 'OPEN' AND answer_to IS NOT NULL").all() as { sid: string }[]).map((r) => r.sid));
	} catch {
		waiting = new Set(); // no decisions table yet — board never ran
	}
	let n = 0;
	for (const r of db.query("SELECT sid, role FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NULL AND hb < ?").all(now - maxIdleMs) as {
		sid: string;
		role: string;
	}[]) {
		if (r.role === "coordinator" || r.sid === coordinatorSid) continue;
		if (waiting.has(r.sid)) continue;
		if (liveTranscript(r.sid)) continue;
		db.query("UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'").run(r.sid);
		n++;
	}
	for (const r of db.query("SELECT sid FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NOT NULL AND hb < ?").all(now - 24 * 3_600_000) as { sid: string }[]) {
		db.query("UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'").run(r.sid);
		n++;
	}
	return n;
}

// a transcript written within the last 15 minutes = live process
function liveTranscript(sid: string): boolean {
	const floor = Date.now() - 15 * 60_000;
	try {
		const glob = new Bun.Glob(`**/*${sid}*.jsonl`);
		for (const rel of glob.scanSync({ cwd: `${process.env.HOME}/.claude/projects`, onlyFiles: true })) {
			try {
				if (statSync(`${process.env.HOME}/.claude/projects/${rel}`).mtimeMs > floor) return true;
			} catch {}
		}
	} catch {}
	return false;
}
