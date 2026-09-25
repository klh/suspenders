// hooks/gates/governor.ts — PreToolUse(Edit|Write|NotebookEdit|MultiEdit):
// the file-edit governor (owner directive 2026-09-14: "launch a governor —
// they ask for allowance to edit files"). Two layers, one registry DB:
//   1. coarse AREA CLAIMS (governor.db/claims, written via bin/claim.ts) —
//      soft by default (cross-area touches are drift-logged for the
//      coordinator), hard only where the coordinator marked an area hot.
//   2. per-file LEASES (governor.db/locks) — lease-on-first-touch: the first
//      writer CLAIMS a file for its session; any other session is DENIED with
//      instructions to request access from the orchestrator. Leases renew on
//      every allowed touch; a quiet-but-alive lane keeps its lease (owner
//      transcript mtime is probed), a dead one releases.
// Everything persists in SQLite/WAL (lib/govdb.ts): concurrent gate processes
// are arbitrated by the DB, single-statement reads are always fresh, and the
// old lost-update dance (atomic rename + fresh-reload-before-deny) is gone.
// Gates FAIL OPEN: a dead/contended registry never blocks an edit.
import { allow, deny, type HookInput } from "../lib/hookio.ts";
import { openGovernorDb } from "../lib/govdb.ts";
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

const REG = `${process.env.HOME}/.cache/claude-governor`;
const DRIFT = `${REG}/drift.jsonl`;
const EXEMPT = `${REG}/exempt.json`;
export const TTL_MS = 15 * 60_000;

// Canonical path: symlinks resolved for what exists, nearest existing ancestor
// otherwise (Write-new has no file yet). Keys in the locks table are canonical.
function canon(F: string): string {
	try {
		return realpathSync(F);
	} catch {
		// file doesn't exist (Write-new) — canonicalize the parent, keep leaf
		try {
			return `${realpathSync(dirname(F))}/${basename(F)}`;
		} catch {
			return resolve(F);
		}
	}
}

function loadJSON<T>(p: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return fallback;
	}
}

// Stable LANE identity: subagents inherit the parent's session_id, so raw
// session_id makes sibling subagents share lease ownership (two lanes could
// edit one file). Discriminate by the transcript — subagent transcripts live
// under /subagents/<agent>.jsonl. Main-lane ids are unchanged, so leases
// written before this are still owned by their session. Shared with the Bash
// gate: both enforcers must compute the SAME owner identity.
export function laneId(hook: HookInput): string {
	const sid: string = hook.session_id ?? "unknown";
	const tp: string = hook.transcript_path ?? "";
	const m = tp.match(/\/subagents\/([^/]+?)(?:\.jsonl)?\/?$/);
	return m ? `${sid}#${m[1]}` : sid;
}

// Lease expiry: quiet 15 min AND owner transcript dead/silent ⇒ gone.
// A quiet-but-alive lane keeps its lease. Shared with the Bash gate.
export function leaseExpired(rec: { ts: number; tp?: string | null }, now = Date.now()): boolean {
	if (now - rec.ts <= TTL_MS) return false;
	try {
		if (rec.tp && existsSync(rec.tp) && now - statSync(rec.tp).mtimeMs < TTL_MS) return false;
	} catch {
		return false; // transcript unreadable — keep the lease (fail open)
	}
	return true;
}

export function governorGate(hook: HookInput): never {
	const ti = hook.tool_input ?? {};
	const F: string = ti.file_path ?? ti.notebook_path ?? "";
	if (!F) allow();
	const sid = hook.session_id ?? "unknown";
	// Subagents inherit the parent session's session_id, so an exempt-list
	// hit alone would leak the orchestrator's exemption to every subagent.
	// Subagent transcripts always live under /subagents/ — strip the
	// exemption there so each subagent takes a real lease. Exemption stays
	// SESSION-scoped; every ownership decision below uses the lane id.
	const isSubagent = (hook.transcript_path ?? "").includes("/subagents/");
	if (!isSubagent && existsSync(EXEMPT)) {
		const exempt = loadJSON<string[]>(EXEMPT, []);
		if (exempt.includes(sid)) allow();
	}
	const lane = laneId(hook);

	const now = Date.now();
	const tpSelf = hook.transcript_path ?? "";

	// registry DB — fail open: if it cannot open, no leases/claims enforce
	let db: Database | null = null;
	try {
		db = openGovernorDb();
	} catch {
		db = null;
	}

	// ---- lease sweep: dead owners release; alive-but-quiet lanes renew ----
	// Deletes and renewals are owner-predicated: a row re-leased to someone
	// else between the SELECT and the mutation is never touched.
	if (db) {
		const rows = db.query("SELECT path, sid, ts, tp FROM locks").all() as { path: string; sid: string; ts: number; tp: string | null }[];
		const del = db.query("DELETE FROM locks WHERE path = ? AND sid = ?");
		const renew = db.query("UPDATE locks SET ts = ? WHERE path = ? AND sid = ?");
		for (const r of rows) {
			if (leaseExpired(r, now)) del.run(r.path, r.sid);
			else if (now - r.ts > TTL_MS) renew.run(now, r.path, r.sid);
		}
	}

	const P = canon(F);
	// ---- coarse-claim layer: soft unless hot; own-claim touches heartbeat ----
	if (db) {
		try {
			const rows = db.query("SELECT sid, scope, intent, hot, ts, tp FROM claims").all() as {
				sid: string; scope: string; intent: string | null; hot: number; ts: number; tp: string | null;
			}[];
			const upd = db.query("UPDATE claims SET ts = ?, tp = ? WHERE sid = ?");
			let hitScope: string | null = null;
			let hitRow: (typeof rows)[number] | null = null;
			let hitHot = false;
			for (const r of rows) {
				if (r.sid === lane) {
					if (scopeCovers(r.scope, P)) {
						try {
							upd.run(now, tpSelf || r.tp, lane);
						} catch {}
					}
					continue;
				}
				if (leaseExpired(r)) continue;
				if (!hitScope && scopeCovers(r.scope, P)) {
					hitScope = r.scope;
					hitRow = r;
					hitHot = !!r.hot;
				}
			}
			if (hitScope && hitRow) {
				if (hitHot) {
					deny(
						`GOVERNOR: ${P} is inside a HOT claimed area (${hitScope}) — session ${hitRow.sid.slice(0, 8)}` +
							`${hitRow.intent ? `, delivering: ${hitRow.intent}` : ""}. A collision was already observed here; ` +
							`edits inside this area are serialized until the coordinator cools it. ` +
							`Work elsewhere or SendMessage "main" for arbitration.` + activeRoster(),
					);
				}
				// advisory by default: allow the edit, log the cross-area touch for the
				// coordinator's conflict monitor (it re-scopes, hot-marks, or orders the merge)
				try {
					appendFileSync(DRIFT, JSON.stringify({ at: now, lane: lane.slice(0, 12), path: P, area: hitScope, owner: hitRow.sid.slice(0, 12) }) + "\n");
				} catch {}
			}
		} catch {
			// claims read failed (contention) — claims layer off this call
		}
	}

	// ---- per-file lease layer ----
	if (db) {
		const row = db.query("SELECT path, sid, tool, ts, tp, hash, seen FROM locks WHERE path = ?").get(P) as {
			path: string; sid: string; tool: string | null; ts: number; tp: string | null; hash: string | null; seen: string | null;
		} | null;
		if (row && row.sid !== lane) {
			deny(
				`GOVERNOR: ${P} is leased to another agent (session ${row.sid.slice(0, 8)}, ` +
					`active ${Math.round((now - row.ts) / 60000)} min ago). Do NOT edit it in parallel. ` +
					`Options: (1) work your owned region elsewhere; (2) if this file is essential, ` +
					`state in one line WHY your edit matters now and SendMessage to "main" for access — ` +
					`the governor integrates requests rather than denying them. ` +
					`Leases expire after 15 min without renewal.` + activeRoster(),
			);
		}
		// content-version check: same session re-touching a file whose content
		// changed since its last governed touch ⇒ someone wrote it outside the
		// governor (shell bypass, external editor). Deny once to force a re-read;
		// the retry re-claims with the fresh hash. A hash the ecosystem already
		// observed post-write (prettier/qlty-fmt feeds land in the lease's seen
		// ring via the PostToolUse gate) is our own write — bless on sight.
		let hash: string | null = null;
		if (existsSync(P)) {
			try {
				hash = createHash("sha256").update(readFileSync(P)).digest("hex").slice(0, 16);
			} catch {
				// unreadable — skip the version check rather than block
			}
		}
		if (row && row.sid === lane && row.hash && hash && row.hash !== hash) {
			let seen: string[] = [];
			try {
				seen = row.seen ? (JSON.parse(row.seen) as string[]) : [];
			} catch {}
			if (seen.includes(hash)) {
				db.query("UPDATE locks SET hash = ?, ts = ? WHERE path = ? AND sid = ?").run(hash, now, P, lane);
				allow();
			}
			db.query("DELETE FROM locks WHERE path = ? AND sid = ?").run(P, lane);
			deny(
				`GOVERNOR: ${P} changed on disk since your last governed edit ` +
					`(${row.hash.slice(0, 8)} → ${hash.slice(0, 8)}) — written outside the governor. ` +
					`RE-READ the file, then retry WITH a one-line reason this edit matters now ` +
					`(the governor integrates; it only prevents blind concurrent write errors).` +
					activeRoster(),
			);
		}
		// atomic acquire/renew: INSERT wins the path by the UNIQUE constraint; an
		// existing row is only overwritten when it is OURS (renewal). The old
		// read-then-upsert raced: two first-writers both saw no lock and both
		// allowed. Owner-conditional upsert: a lost race yields changes = 0 and
		// the caller is denied instead of silently stealing the lease.
		const got = db.query(
			"INSERT INTO locks (path, sid, tool, ts, tp, hash) VALUES (?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(path) DO UPDATE SET tool = excluded.tool, ts = excluded.ts, tp = excluded.tp, hash = excluded.hash " +
				"WHERE locks.sid = excluded.sid",
		).run(P, lane, hook.tool_name ?? "?", now, tpSelf || null, hash);
		if (got.changes === 0) {
			deny(
				`GOVERNOR: ${P} was leased to another agent mid-check (lost the acquire race) — ` +
					`do NOT edit it in parallel; SendMessage to "main" for access if essential.` + activeRoster(),
			);
		}
	}
	allow();
}

/** The incoming agents' workload (owner 2026-09-22: "query incoming agents
 * workload and what it is delivering"): when a real external write blocks an
 * edit, name who is active and what each is delivering, from the progress
 * registry. Never blocks. */
function activeRoster(): string {
	try {
		const dir = "/tmp/agent-progress";
		if (!existsSync(dir)) return "";
		const now = Date.now();
		const rows: string[] = [];
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as {
					at?: number; id?: string; label?: string; done?: number; total?: number;
				};
				if (!j.at || now - j.at > 15 * 60_000) continue;
				rows.push(`${j.id ?? f.replace(/\.json$/, "")} — ${j.label ?? "working"} (${j.done ?? 0}/${j.total ?? 0})`);
			} catch {}
		}
		return rows.length ? `\nActive agents right now: ${rows.join("; ")}.` : "";
	} catch {
		return "";
	}
}

function scopeCovers(scope: string, P: string): boolean {
	if (scope === P) return true;
	const s = scope.replace(/\/\*\*?$/, "");
	if (s.startsWith("/")) return P === s || P.startsWith(`${s}/`); // absolute scope
	// relative scope: match by path-segment suffix — worktree-portable (each
	// lane's absolute root differs; "src/facets/mcp" must hit all of them)
	return P === s || P.endsWith(`/${s}`) || P.includes(`/${s}/`);
}
