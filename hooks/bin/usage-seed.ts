// hooks/bin/usage-seed.ts — W127 demo data: two fake actors (demo: prefix,
// clearly flagged) with synthetic sessions + weekday-hours-weighted usage
// rollups so every /usage chart demonstrates with data. Deterministic PRNG
// (mulberry32) → re-seed over the same window replaces rows (INSERT OR
// REPLACE on the (hour_bucket, actor, model) PK); --purge removes exactly
// the demo rows (actor LIKE 'demo:%', sids demo-*). No real identity data.
import type { Database } from "bun:sqlite";
import { openGovernorDb } from "../lib/govdb.ts";

const H = 3_600_000;

interface ActorSpec {
	actor: string;
	sid: string;
	tags: Record<string, string>;
	// model → daily base tokens (in, out, cacheR, cacheC)
	models: [string, string, [number, number, number, number]][];
}

const ACTORS: ActorSpec[] = [
	{
		actor: "demo:alice@demo",
		sid: "demo-alice",
		tags: { team: "platform", department: "infra" },
		models: [
			["glm-5.3-flash", "flash", [150000, 30000, 200000, 8000]],
			["claude-sonnet-5", "full", [25000, 6000, 20000, 1000]],
		],
	},
	{
		actor: "demo:bob@demo",
		sid: "demo-bob",
		tags: { team: "apps", department: "product" },
		models: [
			["luna-pro", "luna", [90000, 20000, 60000, 3000]],
			["local-swarm", "local", [40000, 9000, 20000, 1000]],
			["gpt-5.2", "full", [20000, 5000, 10000, 500]],
		],
	},
];

// mulberry32 — tiny deterministic PRNG so re-seeds are reproducible
const mulberry32 = (seed: number): (() => number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
	};
};

const DEMO_DAYS = 28;

export function seedUsage(
	db: Database,
	opts: { nowMs?: number } = {},
): { actors: number; rows: number } {
	const now = opts.nowMs ?? Date.now();
	const to = Math.floor(now / H) * H;
	const from = to - DEMO_DAYS * 24 * H;
	const rnd = mulberry32(0xc0ffee);
	const sess = db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state, actor, tags) VALUES (?, 'demo:usage', 'demo', NULL, NULL, ?, ?, 'CLOSED', ?, ?)",
	);
	const ins = db.query(
		"INSERT OR REPLACE INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	let rows = 0;
	for (let b = from; b <= to; b += H) {
		const d = new Date(b);
		const dayW = [0, 6].includes(d.getDay()) ? 0.3 : 1;
		const h = d.getHours();
		const hourW =
			h >= 9 && h <= 17 ? 1 : h >= 8 && h <= 18 ? 0.5 : h >= 20 ? 0.25 : 0.05;
		for (const spec of ACTORS) {
			for (const [model, group, base] of spec.models) {
				const w = dayW * hourW;
				if (rnd() > w + 0.05) continue;
				const jit = 0.5 + rnd();
				const i = Math.round((base[0] / 24) * w * jit);
				const o = Math.round((base[1] / 24) * w * jit);
				const cr = Math.round((base[2] / 24) * w * jit);
				const cc = Math.round((base[3] / 24) * w * jit);
				ins.run(
					b,
					spec.actor,
					model,
					group,
					i,
					o,
					cr,
					cc,
					Math.max(1, Math.round(6 * w * jit)),
				);
				rows++;
			}
		}
	}
	for (const spec of ACTORS)
		sess.run(
			spec.sid,
			spec.sid === "demo-alice" ? from : from + H,
			from,
			spec.actor,
			JSON.stringify(spec.tags),
		);
	return { actors: ACTORS.length, rows };
}

export function purgeUsage(db: Database): { rows: number; sessions: number } {
	const r1 = db
		.query("DELETE FROM usage_rollup WHERE actor LIKE 'demo:%'")
		.run();
	const r2 = db.query("DELETE FROM sessions WHERE sid LIKE 'demo-%'").run();
	return { rows: r1.changes, sessions: r2.changes };
}

if (import.meta.main) {
	const db = openGovernorDb();
	if (process.argv.includes("--purge")) {
		console.log(JSON.stringify(purgeUsage(db)));
	} else {
		console.log(JSON.stringify(seedUsage(db)));
	}
}
