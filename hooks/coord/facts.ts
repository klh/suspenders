// hooks/coord/facts.ts — facts, capsules, kb lookup + retention (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import {
	die,
	arg,
	db,
	green,
	dim,
	cyan,
	kbLookup,
	projectIdentity,
	pruneDeltas,
	sweepStaleSessions,
	realpathSync,
} from "./shared.ts";
import type { Database } from "./shared.ts";

export async function cmdFact(rest: string[]): Promise<void> {
	const sub = rest[0];
	if (sub === "set") {
		const key = rest[1];
		let value = rest[2];
		const txt = arg("--text");
		// arg() returns null BOTH when absent and when bare — null, not
		// undefined, is the "no --text" signal (hotfix 2026-10-01: the prior
		// `!== undefined` check null-ed every positional fact set)
		if (txt != null) value = txt;
		// a flag-shaped value was the fact-set corruption bug (2026-09-30):
		// `fact set k --text "…"` swallowed "--text" as the value and the real
		// text vanished into an ignored positional — three A/B findings lost
		if (!key || value === undefined || value.startsWith("--"))
			die(
				"usage: fact set <key> <value> | fact set <key> --text <text> [--source s]",
			);
		const src = arg("--source") ?? "coord";
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		).run(key, value, src, Date.now());
		console.log(`fact ${key} = ${value}`);
	} else if (sub === "get") {
		const r = db
			.query("SELECT value, version, ts FROM facts WHERE key = ?")
			.get(rest[1] ?? "") as
			| { value: string; version: number; ts: number }
			| undefined;
		console.log(r ? `${r.value} (v${r.version})` : "(unset)");
	} else if (sub === "list") {
		const rows = db
			.query("SELECT key, value, version, ts FROM facts ORDER BY key")
			.all() as {
			key: string;
			value: string;
			version: number;
			ts: number;
		}[];
		console.log(
			rows.length
				? rows.map((r) => `${r.key} = ${r.value}  (v${r.version})`).join("\n")
				: "(no facts)",
		);
	} else die("usage: fact set <key> <value> | fact get <key> | fact list");
}

export async function cmdCapsule(rest: string[]): Promise<void> {
	// continuation capsule: the minimum restart packet (checkpoint/step/next/assumptions)
	const as = arg("--as") ?? rest[0];
	if (!as || rest[0] === "get") {
		const cap = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`lane.${as ?? ""}.capsule`) as { value: string } | null;
		console.log(cap?.value ?? dim("(no capsule)"));
	} else {
		const extra: Record<string, string> = {};
		for (const t of process.argv.slice(2)) {
			const m = /^--([\w-]+)=(.+)$/.exec(t);
			if (m && !["as"].includes(m[1])) extra[m[1]] = m[2];
		}
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, ts = excluded.ts",
		).run(
			`lane.${as}.capsule`,
			JSON.stringify({ ...extra, ts: Date.now() }),
			arg("--as") ?? as,
			Date.now(),
		);
		console.log(
			`${green("✓")} ${dim(`capsule stored for @${as.slice(0, 8)}`)}`,
		);
	}
}

export async function cmdLeaseRelease(rest: string[]): Promise<void> {
	// explicit handover: a session done with a file releases it now instead of
	// pinning it for its remaining TTL. Owner-predicated — only the caller's
	// own rows; taking a foreign lease is monitor --fix / arbitration work.
	const paths = rest.filter((r) => !r.startsWith("--"));
	const as = arg("--as");
	if (!paths.length || !as)
		die(
			"usage:knowledge-verify | knowledge-curate | lease-release <path...> --as <sid>",
		);
	const del = db.query("DELETE FROM locks WHERE path = ? AND sid = ?");
	let n = 0;
	for (const p of paths) {
		let P = p;
		try {
			P = realpathSync(p); // the gate stores canonical paths
		} catch {}
		n += del.run(P, as).changes;
	}
	console.log(
		`${green("✓")}knowledge-verify | knowledge-curate | lease-release: ${n} lock(s) released`,
	);
}

export async function cmdKb(rest: string[]): Promise<void> {
	// the fleet's shared memory: what consults have already answered
	const sub = rest[0];
	if (sub === "add") {
		// direct seed: distill a mistake/lesson without a consult round-trip
		// (owner 2026-09-28: harvest worker logs -> kb so mistakes don't repeat)
		const sep = rest.indexOf("--solution");
		const problem = rest.slice(1, sep === -1 ? rest.length : sep).join(" ");
		const solution =
			sep === -1
				? ""
				: rest
						.slice(sep + 1)
						.filter((a) => a !== "--as")
						.join(" ");
		const as = (() => {
			const i = rest.indexOf("--as");
			return i >= 0 ? rest[i + 1] : null;
		})();
		if (!problem || !solution)
			die('usage: kb add "<problem>" --solution "<solution>" [--as <sid>]');
		const kr = db
			.query(
				"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
			)
			.run(
				problem,
				solution,
				projectIdentity(),
				as ?? "harvest",
				as ?? "harvest",
				Date.now(),
			);
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
			kr.lastInsertRowid,
			problem,
		);
		console.log(`✓ kb#${kr.lastInsertRowid} seeded`);
		process.exit(0);
	}
	if (sub === "stats") {
		const tot = (
			db.query("SELECT COUNT(*) AS n FROM consult_kb").get() as { n: number }
		).n;
		const hits = (
			db.query("SELECT COALESCE(SUM(hits), 0) AS n FROM consult_kb").get() as {
				n: number;
			}
		).n;
		const byState = db
			.query("SELECT state, COUNT(*) AS n FROM consults GROUP BY state")
			.all() as { state: string; n: number }[];
		const lat = db
			.query(
				"SELECT answered_at - created_at AS ms FROM consults WHERE state = 'ANSWERED' AND answered_at IS NOT NULL ORDER BY ms",
			)
			.all() as { ms: number }[];
		const median = lat.length ? lat[Math.floor(lat.length / 2)].ms : 0;
		const s = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
		console.log(
			`kb: ${tot} solutions · ${hits} repeat questions auto-answered · consults: ${s("OPEN")} open, ${s("ANSWERED")} human, ${s("KB")} via kb, ${s("DECLINED")} declined`,
		);
		if (median && hits)
			console.log(
				dim(
					`median human answer ${Math.round(median / 60000)}min — est. ${Math.round((hits * median) / 60000)}min of round-trips skipped (hits × median)`,
				),
			);
	} else if (sub === "search") {
		const q = rest.slice(1).join(" ");
		if (!q) die('usage: kb search "<query words>" | kb list | kb stats');
		const hit = kbLookup(q);
		if (!hit) {
			console.log(dim("(no kb match)"));
			process.exitCode = 1;
		} else
			console.log(
				`${cyan(`kb#${hit.id}`)} ${dim(`learned from ${String(hit.answered_by).slice(0, 8)}, ${hit.hits} hits`)}\n  Q: ${hit.problem}\n  A: ${hit.solution}`,
			);
	} else if (sub === "list") {
		const rows = db
			.query(
				"SELECT id, problem, solution, answered_by, hits, created_at FROM consult_kb ORDER BY id DESC LIMIT 20",
			)
			.all() as {
			id: number;
			problem: string;
			solution: string;
			answered_by: string;
			hits: number;
		}[];
		console.log(
			rows
				.map(
					(r) =>
						`${cyan(`kb#${r.id}`)} ${dim(String(r.answered_by).slice(0, 8))} ${r.problem.slice(0, 50)} ${dim("→")} ${r.solution.slice(0, 50)}`,
				)
				.join("\n") || dim("(kb empty — answers land here via consult-reply)"),
		);
	} else die('usage: kb stats | kb list | kb search "<query words>"');
}

export async function cmdGc(rest: string[]): Promise<void> {
	// retention: events + closed sessions + their cursors age out; terminal
	// work items are the ledger and are NEVER auto-deleted
	const days = Number(arg("--days") ?? 30);
	const cut = Date.now() - days * 86_400_000;
	const e = db.query("DELETE FROM events WHERE ts < ?").run(cut).changes;
	const s = db
		.query("DELETE FROM sessions WHERE state = 'CLOSED' AND hb < ?")
		.run(cut).changes;
	const c = db
		.query("DELETE FROM cursors WHERE sid NOT IN (SELECT sid FROM sessions)")
		.run().changes;
	const f = db
		.query("DELETE FROM facts WHERE key LIKE 'lane.%' AND ts < ?")
		.run(cut).changes;
	// consults: open questions expire after 1h; closed threads age out
	const x = db
		.query(
			"UPDATE consults SET state = 'EXPIRED', answered_at = ? WHERE state = 'OPEN' AND created_at < ?",
		)
		.run(Date.now(), Date.now() - 3_600_000).changes;
	const cd = db
		.query(
			"DELETE FROM consults WHERE state IN ('ANSWERED','DECLINED','EXPIRED') AND answered_at < ? AND answered_at IS NOT NULL",
		)
		.run(cut).changes;
	const sw = db.local ? sweepStaleSessions(db as Database) : 0;
	const lk = db
		.query("DELETE FROM locks WHERE ts < ?")
		.run(Date.now() - 15 * 60_000).changes;
	const d = pruneDeltas(db as Database, days * 86_400_000);
	console.log(
		`gc: ${e} events, ${s} closed sessions, ${sw} stale RUNNING sessions swept, ${lk} expired locks, ${c} stale cursors, ${f} lane facts, ${x} consults expired, ${cd} consult threads pruned, ${d} deltas (>${days}d; work ledger untouched)`,
	);
}
