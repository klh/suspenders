// hooks/lib/machines.ts — W176 machine capability registry: the work graph's
// answer to belt's LLM registry (remotes.ts). One row per fleet machine in
// governor.db; roles share the CAPABILITIES vocabulary, so the routing
// contract is the same set-inclusion check work take already runs
// (roles ⊇ work_items.requires), and cpu×ram is the "beefy box" ranking.
// Pure read/rank logic lives here so fleet-loop dispatch (--machine auto)
// and the coord CLI share ONE source of truth. Registry mutations land in
// the delta up-feed (machines ∈ govdb deltaTables): a remote machine's
// writes ride the W92 store port into the hub's deltas log, tailable with
// `coord diff --table machines --since <cursor>`.
import type { GovernorStore } from "./govdb.ts";

export interface MachineRow {
	name: string;
	host: string;
	roles: string | null;
	cpu_cores: number | null;
	ram_gb: number | null;
	gpu: string | null;
	store_url: string | null;
	state: string;
	last_hb: number;
	origin_sid: string | null;
	created_at: number;
	updated_at: number;
}

/** Heartbeat freshness window — matches the /tmp agent-progress TTL
 *  convention (15 min): silent longer than this = stale for routing. */
export const MACHINE_HB_STALE_MS = 15 * 60_000;

export const machineFresh = (hb: number, now: number): boolean =>
	now - hb <= MACHINE_HB_STALE_MS;

export const parseRoles = (csv: string | null): string[] =>
	(csv ?? "").split(",").filter(Boolean);

/** roles ⊇ need — the SAME contract work take enforces on sessions. */
export const coversRoles = (roles: string[], need: string[]): boolean =>
	need.every((n) => roles.includes(n));

/** The "beefy box" score: cpu×ram as a compute proxy; nulls rank last. */
export const beefyScore = (m: MachineRow): number =>
	(m.cpu_cores ?? 0) * (m.ram_gb ?? 0);

export interface RoutePick {
	machine: MachineRow | null;
	reason: string; // honest no-pick reasons for the CLI + dispatch error path
}

/** Route: active + fresh machines whose roles cover `need`, ranked beefiest
 *  first (cpu×ram), heartbeat recency as tiebreak. `now` is a parameter —
 *  tests pin the clock. */
export function pickMachine(
	store: GovernorStore,
	need: string[],
	now: number,
): RoutePick {
	const rows = store
		.query("SELECT * FROM machines WHERE state = 'active' ORDER BY name")
		.all() as MachineRow[];
	const capable = rows.filter(
		(m) =>
			coversRoles(parseRoles(m.roles), need) && machineFresh(m.last_hb, now),
	);
	if (rows.length === 0)
		return { machine: null, reason: "registry empty — no machines registered" };
	if (capable.length === 0)
		return {
			machine: null,
			reason: `no active+fresh machine covers [${need.join(",") || "any"}]`,
		};
	capable.sort(
		(a, b) => beefyScore(b) - beefyScore(a) || b.last_hb - a.last_hb,
	);
	return { machine: capable[0], reason: "ok" };
}
