// scripts/lib/governor.ts — W187 adaptive backpressure governor: the fleet
// steps back sequentially and slowly on its own — humans never say "thin
// it". Three inputs, one decision:
//
//   live      graph CLAIMED rows whose owner_sid resolves to an alive pid
//             (kill -0 on the .fleet/lanes.json entry) — NOT registry
//             entries, which prune/re-parent and undercount (the W187
//             symptom: dispatch said 2/8 while the graph showed 13 ◐).
//   pressure  429 rate (belt/route_audit error_code window) + lane deaths
//             (claim→release/fail segments shorter than 10 min, replayed
//             from the same bus events workTiming replays in govdb.ts).
//   cap       effective_target: the base --target policy stepped DOWN 1 per
//             pressure event with a 60s cooldown between steps, UP 1 per
//             clean 10-min window; floor 2. dispatch pauses while
//             live >= cap. Every step emits a `governor.step` bus event —
//             throttling is observable, never mysterious.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

// brief-pinned pacing: sequential and slow
export const FLOOR = 2;
export const STEP_COOLDOWN_MS = 60_000;
export const CLEAN_WINDOW_MS = 10 * 60_000;
export const DEATH_WINDOW_MS = 10 * 60_000; // "lane-death-within-10min rate"
export const R429_THRESHOLD = 0.1; // burst = ≥10% of windowed requests…
export const R429_BURST_MIN = 2; // …and at least 2 hits (one 429 is noise)
export const STATE_PATH = `${process.env.HOME}/.cache/claude-governor/backpressure.json`;

export type Step = {
	at: number;
	dir: "down" | "up";
	from: number;
	to: number;
	reason: string;
};

export type GovernorState = {
	effective: number;
	lastStepAt: number; // 0 = never stepped
	cleanSince: number; // clean-window clock anchor (last step/pressure ts)
	history: Step[]; // bounded ring — the last 20 steps
};

const clamp = (v: number, lo: number, hi: number): number =>
	Math.min(hi, Math.max(lo, v));
export const freshState = (baseTarget: number): GovernorState => ({
	effective: baseTarget,
	lastStepAt: 0,
	cleanSince: 0,
	history: [],
});

/** Missing file → fresh; corrupt JSON → fresh (a broken state file must
 *  never take the dispatch loop down); base changes clamp into range. */
export const loadState = (path: string, baseTarget: number): GovernorState => {
	if (!existsSync(path)) return freshState(baseTarget);
	try {
		const raw = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<GovernorState>;
		return {
			effective: clamp(Number(raw.effective ?? baseTarget), FLOOR, baseTarget),
			lastStepAt: Number(raw.lastStepAt ?? 0),
			cleanSince: Number(raw.cleanSince ?? 0),
			history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
		};
	} catch {
		return freshState(baseTarget);
	}
};

export const saveState = (path: string, state: GovernorState): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
};

// --- observations ---------------------------------------------------------
export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** THE W187 counter fix: live lanes = distinct owner_sids on graph CLAIMED
 *  rows that show liveness — an alive registry pid (kill -0) OR a current
 *  coord claim (the claims table — the same signal `coord fleet` projects;
 *  the registry prunes/re-parents and went stale fleet-wide on 2026-10-02,
 *  leaving kill -0 nothing to probe). A lane holding two claims is ONE live
 *  lane; a claim with neither signal is a zombie claim, not a live lane. */
export const countLiveGraphClaims = (
	db: Database,
	project: string,
	lanes: { sid: string; pid: number }[],
	aliveFn: (pid: number) => boolean = alive,
	coordLive: Set<string> = new Set(),
): { live: number; claims: number } => {
	const pidBySid = new Map(
		lanes.filter((l) => l.pid > 0).map((l) => [l.sid, l.pid]),
	);
	const rows = db
		.query(
			"SELECT owner_sid FROM work_items WHERE project = ? AND state = 'CLAIMED' AND owner_sid IS NOT NULL",
		)
		.all(project) as { owner_sid: string }[];
	let live = 0;
	const seen = new Set<string>();
	for (const r of rows) {
		const sid = r.owner_sid;
		if (seen.has(sid)) continue;
		seen.add(sid);
		const pid = pidBySid.get(sid);
		if ((pid !== undefined && aliveFn(pid)) || coordLive.has(sid)) live++;
	}
	return { live, claims: rows.length };
};
/** 429 rate over the window from belt's route_audit trail (governor.db,
 *  W136 §6): error_code LIKE '%429%' vs all rows. Empty window → no
 *  pressure — the metric degrades to silence when belt is quiet. */
export const read429 = (
	db: Database,
	windowMs: number,
	nowMs = Date.now(),
): { total: number; hits: number } => {
	const since = nowMs - windowMs;
	const row = (sql: string): number =>
		(db.query(sql).get(since) as { c: number }).c;
	return {
		total: row("SELECT COUNT(*) AS c FROM route_audit WHERE ts > ?"),
		hits: row(
			"SELECT COUNT(*) AS c FROM route_audit WHERE ts > ? AND error_code LIKE '%429%'",
		),
	};
};
/** lane deaths in the window: claim→release/fail segments (the same events
 *  workTiming replays) closed within DEATH_WINDOW_MS of the claim AND
 *  landing inside the window. work.done closes a segment without pressure —
 *  finishing fast is the opposite of dying. A 2×window lookback bounds the
 *  pairing (longer segments cannot produce in-window deaths). */
export const laneDeaths = (db: Database, nowMs = Date.now()): number => {
	const since = nowMs - 2 * DEATH_WINDOW_MS;
	const rows = db
		.query(
			"SELECT ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.failed','work.done') AND ts > ? ORDER BY ts, id",
		)
		.all(since) as { ts: number; kind: string; payload: string | null }[];
	const open = new Map<string, number>();
	let deaths = 0;
	for (const r of rows) {
		let work = "";
		try {
			work = (JSON.parse(r.payload ?? "{}") as { work?: string }).work ?? "";
		} catch {
			// malformed payload — the segment is unpairable, skip it
		}
		if (!work) continue;
		if (r.kind === "work.claimed") {
			open.set(work, r.ts);
			continue;
		}
		const start = open.get(work);
		if (start === undefined) continue;
		open.delete(work);
		if (
			r.kind !== "work.done" &&
			r.ts > nowMs - DEATH_WINDOW_MS &&
			r.ts - start <= DEATH_WINDOW_MS
		)
			deaths++;
	}
	return deaths;
};
// --- the step machine -------------------------------------------------------

/** pure: one governor evaluation → maybe one step. Sequential and slow: at
 *  most one step per evaluation, a cooldown between downs, a full clean
 *  window before each up. Pressure (even absorbed at floor/cooldown)
 *  restarts the clean clock — the system never climbs while hurting. */
export const nextStep = (
	state: GovernorState,
	o: { live: number; deaths: number; r429: { total: number; hits: number } },
	baseTarget: number,
	nowMs = Date.now(),
): { state: GovernorState; step: Step | null } => {
	const s: GovernorState = {
		...state,
		effective: clamp(state.effective, FLOOR, baseTarget),
		history: [...state.history],
	};
	const rate = o.r429.total > 0 ? o.r429.hits / o.r429.total : 0;
	const pressure =
		o.deaths > 0
			? `${o.deaths} lane death${o.deaths === 1 ? "" : "s"} within ${DEATH_WINDOW_MS / 60_000}min window`
			: o.r429.hits >= R429_BURST_MIN && rate >= R429_THRESHOLD
				? `429 burst: ${o.r429.hits}/${o.r429.total} = ${Math.round(rate * 100)}% in ${DEATH_WINDOW_MS / 60_000}min window (threshold ${R429_THRESHOLD * 100}%)`
				: null;
	if (pressure) {
		s.cleanSince = nowMs;
		if (nowMs - s.lastStepAt >= STEP_COOLDOWN_MS && s.effective > FLOOR) {
			const step: Step = {
				at: nowMs,
				dir: "down",
				from: s.effective,
				to: s.effective - 1,
				reason: pressure,
			};
			s.effective = step.to;
			s.lastStepAt = nowMs;
			s.history = [...s.history, step].slice(-20);
			return { state: s, step };
		}
		return { state: s, step: null }; // cooling down / at floor — absorbed
	}
	if (
		s.effective < baseTarget &&
		s.cleanSince > 0 &&
		nowMs - s.cleanSince >= CLEAN_WINDOW_MS &&
		nowMs - s.lastStepAt >= STEP_COOLDOWN_MS
	) {
		const step: Step = {
			at: nowMs,
			dir: "up",
			from: s.effective,
			to: s.effective + 1,
			reason: `clean ${CLEAN_WINDOW_MS / 60_000}min window — no deaths, 429 rate ${Math.round(rate * 100)}% under threshold`,
		};
		s.effective = step.to;
		s.lastStepAt = nowMs;
		s.cleanSince = nowMs;
		s.history = [...s.history, step].slice(-20);
		return { state: s, step };
	}
	return { state: s, step: null };
};
/** board visibility: one bus event per step (the board's activity feed
 *  renders any kind verbatim) — same INSERT contract as coord emit. */
export const emitStep = (db: Database, project: string, step: Step): void => {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload) VALUES (?, ?, 'governor.step', NULL, ?)",
	).run(
		step.at,
		"governor",
		JSON.stringify({
			project,
			note: `${step.dir} ${step.from}→${step.to}: ${step.reason}`,
		}),
	);
};

/** one dispatch-cycle evaluation: count → observe → step → persist → emit.
 *  readOnly (dry-run) observes the current cap and steps nothing. State is
 *  saved on every live evaluation — cleanSince restarts under pressure even
 *  when no step fires. */
export const runGovernor = (o: {
	db: Database;
	project: string;
	baseTarget: number;
	lanes: { sid: string; pid: number }[];
	statePath: string;
	readOnly?: boolean;
	nowMs?: number;
}): { cap: number; live: number; claims: number; step: Step | null } => {
	const nowMs = o.nowMs ?? Date.now();
	// liveness beyond the registry: a current coord claim (claims table is
	// machine-global — a cross-project claim counts live here; bounded noise)
	const coordLive = new Set(
		(
			o.db.query("SELECT DISTINCT sid FROM claims").all() as { sid: string }[]
		).map((r) => r.sid),
	);
	const { live, claims } = countLiveGraphClaims(
		o.db,
		o.project,
		o.lanes,
		undefined,
		coordLive,
	);
	const state = loadState(o.statePath, o.baseTarget);
	if (o.readOnly) return { cap: state.effective, live, claims, step: null };
	const deaths = laneDeaths(o.db, nowMs);
	const r429 = read429(o.db, DEATH_WINDOW_MS, nowMs);
	const { state: next, step } = nextStep(
		state,
		{ live, deaths, r429 },
		o.baseTarget,
		nowMs,
	);
	saveState(o.statePath, next);
	if (step) emitStep(o.db, o.project, step);
	return { cap: next.effective, live, claims, step };
};
