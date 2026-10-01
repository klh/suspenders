// hooks/board/console-view.ts — W147 console: data gathering + policy patch builders (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { db, BELT_REPO } from "./context.ts";
import { json } from "./helpers.ts";
import { sessions } from "./data.ts";
import { resolveBelt } from "../lib/belt-locate.ts";
import {
	ConfigError,
	parsePolicy,
	policyWritePath,
	readBoardSettings,
	resolvePolicy,
} from "../lib/board-config.ts";
import type { PolicyPatch, PolicyGatewayParsed } from "../lib/board-config.ts";
import {
	ConsoleMe,
	BeltView,
	Feature,
	HealthProbe,
	LocalService,
	UpstreamGroup,
} from "../bin/console-html.ts";
import { YAML } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";

// ─── W147 console: data gathering for the console pages ───────────────────
export const consoleMe = (): ConsoleMe => {
	const row = db
		.query(
			"SELECT actor, tags FROM sessions WHERE actor IS NOT NULL ORDER BY started_at DESC, hb DESC LIMIT 1",
		)
		.get() as { actor: string; tags: string | null } | null;
	const actors = (
		db
			.query(
				"SELECT DISTINCT actor FROM sessions WHERE actor IS NOT NULL ORDER BY actor",
			)
			.all() as { actor: string }[]
	).map((r) => r.actor);
	let tags: Record<string, string> = {};
	try {
		tags = row?.tags ? (JSON.parse(row.tags) as Record<string, string>) : {};
	} catch {}
	return {
		actor: row?.actor ?? "unassigned",
		tags,
		actors,
		defaultActor: readBoardSettings().settings.default_actor ?? "",
	};
};

export const healthProbe = async (
	name: string,
	port: number,
): Promise<HealthProbe> => {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/status`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!r.ok) return { name, port, up: false, detail: `HTTP ${r.status}` };
		const j = (await r.json()) as {
			uptime_s?: number;
			requests?: { total?: number };
		};
		return {
			name,
			port,
			up: true,
			detail: `uptime ${Math.round(j.uptime_s ?? 0)}s · ${j.requests?.total ?? 0} req`,
		};
	} catch (e) {
		return {
			name,
			port,
			up: false,
			detail: e instanceof Error ? e.message.slice(0, 80) : "unreachable",
		};
	}
};

// buckle upstreams.yaml (read-only display): group name == wire id; an empty
// group is DORMANT — in the ladder but resolving to zero deployments.
export interface UpstreamsDoc {
	groups?: Record<string, unknown>;
}

export const readUpstreams = (): UpstreamGroup[] | null => {
	const p = `${process.env.BUCKLE_REPO ?? "/Volumes/Sensitive/github/klh/buckle"}/upstreams.yaml`;
	try {
		const doc = YAML.parse(readFileSync(p, "utf8")) as UpstreamsDoc;
		if (!doc || typeof doc !== "object" || !doc.groups) return null;
		return Object.entries(doc.groups).map(([name, tiers]) => ({
			name,
			tiers: Array.isArray(tiers) ? tiers.length : 0,
			dormant: !Array.isArray(tiers) || tiers.length === 0,
		}));
	} catch {
		return null;
	}
};

export const gatherBeltView = async (): Promise<BeltView> => {
	const pol = resolvePolicy({ beltRepo: BELT_REPO });
	let gateway: PolicyGatewayParsed | null = null;
	let policyError: string | null = null;
	if (pol) {
		try {
			gateway = parsePolicy(pol.text);
		} catch (e) {
			policyError =
				e instanceof ConfigError
					? e.message
					: e instanceof Error
						? e.message
						: String(e);
		}
	}
	const belt = await resolveBelt();
	const health = await Promise.all([
		healthProbe("buckle", 4101),
		healthProbe("belt gateway", 4100),
	]);
	return {
		policy: pol,
		gateway,
		policyError,
		beltApi: belt ? { url: belt.url, via: belt.via } : null,
		health,
		groups: readUpstreams(),
	};
};

export const gatherLocalView = (): LocalView => {
	const regPath =
		process.env.KLH_LOCAL_REGISTRY ??
		`${process.env.HOME}/.local/state/klh-local/registry.json`;
	try {
		const doc = JSON.parse(readFileSync(regPath, "utf8")) as {
			name?: string;
			port?: number;
			created_at?: string;
		}[];
		const services: LocalService[] = Array.isArray(doc)
			? doc
					.filter((s) => s && typeof s.name === "string")
					.map((s) => ({
						name: String(s.name),
						port: Number(s.port ?? 0),
						created: String(s.created_at ?? ""),
					}))
			: [];
		return { services, regPath, error: null };
	} catch (e) {
		return {
			services: [],
			regPath,
			error: e instanceof Error ? e.message : String(e),
		};
	}
};

// form → PolicyPatch. Belt edits the budgets; buckle edits the ladder
// (tiers on/off + order) and the cooldown TTL. Empty = leave unchanged.
export const formToPatch = (
	feature: Feature,
	f: URLSearchParams,
): PolicyPatch => {
	const num = (k: string): number | undefined => {
		const v = (f.get(k) ?? "").trim();
		if (v === "") return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : Number.NaN;
	};
	if (feature === "belt")
		return {
			num_retries: num("num_retries"),
			allowed_fails: num("allowed_fails"),
			cooldown_time: num("cooldown_time"),
		};
	const ladder: NonNullable<PolicyPatch["ladder"]> = { model: "", tiers: [] };
	for (const [k, v] of f.entries()) {
		if (!k.startsWith("ladder_")) continue;
		ladder.model = k.slice(7);
		ladder.tiers = (v ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return {
		ladder: ladder.model ? ladder : undefined,
		cooldown_time: num("cooldown_time"),
	};
};

// values JSON (the preview page's hidden field) → validated patch or throw
export const valuesToPatch = (raw: string): PolicyPatch => {
	const v = JSON.parse(raw) as Record<string, unknown>;
	const out: PolicyPatch = {};
	for (const k of ["num_retries", "allowed_fails", "cooldown_time"] as const) {
		const n = v[k];
		if (n === undefined || n === null || n === "") continue;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
			throw new ConfigError(`gateway.${k}: must be an integer >= 0`);
		out[k] = n;
	}
	if (v.ladder !== undefined && v.ladder !== null) {
		if (typeof v.ladder !== "object")
			throw new ConfigError("ladder: bad value");
		const l = v.ladder as { model?: unknown; tiers?: unknown };
		if (typeof l.model !== "string" || !Array.isArray(l.tiers))
			throw new ConfigError("ladder: bad value");
		out.ladder = { model: l.model, tiers: l.tiers.map((t) => String(t)) };
	}
	return out;
};

// The text the settings flow reads and rewrites: the env/runtime write path
// when it exists, else the resolved chain text (the new runtime file will be
// seeded from exactly this). One baseline for preview AND apply — the diff
// the operator confirms is the diff that lands.
export const policyBaseline = (): { text: string; mtimeMs: number } => {
	const wp = policyWritePath();
	if (existsSync(wp)) {
		const st = statSync(wp);
		return { text: readFileSync(wp, "utf8"), mtimeMs: st.mtimeMs };
	}
	const pol = resolvePolicy({ beltRepo: BELT_REPO });
	return { text: pol?.text ?? "version: 1\ngateway: {}\n", mtimeMs: 0 };
};
