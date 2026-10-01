// hooks/board/demo.ts — seedDemo: the demo partition sealer (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { db, DEMO, REG_DIR } from "./context.ts";
import { syncDecisions } from "./lanes.ts";
import { sessions, board, claims, events, payload } from "./data.ts";
import { orchestrate } from "./orch.ts";
import { existsSync, writeFileSync } from "node:fs";

export function seedDemo(): void {
	const demo = `${REG_DIR}/demo`;
	const demoSids = ["demo-wait", "demo-work", "demo-pause", "demo-zomb"];
	// demo-seal (2026-09-27, owner): after the demo partition was wiped from
	// the real home, a stray --demo re-seeded it and its Bonjour registration
	// stole the suspenders.local name — the owner watched their real board
	// turn into the demo. Guard: once a home has EVER seeded demo (marker
	// file), seeding an EMPTY partition again requires SUSPENDERS_DEMO=1.
	// Existing partitions keep their idempotent heartbeat refresh.
	const hasDemo = !!db
		.query("SELECT 1 AS x FROM work_items WHERE project = ?")
		.get(demo);
	if (
		!hasDemo &&
		existsSync(`${REG_DIR}/.demo-sealed`) &&
		process.env.SUSPENDERS_DEMO !== "1"
	) {
		console.error(
			`fleet board: --demo refused — this home sealed demo seeding after a wipe (delete ${REG_DIR}/.demo-sealed or set SUSPENDERS_DEMO=1 to override)`,
		);
		process.exit(3);
	}
	if (hasDemo) {
		// re-runs keep the seeded fleet's heartbeats fresh without re-seeding
		db.query(
			`UPDATE sessions SET hb = ? WHERE sid IN (${demoSids.map(() => "?").join(",")})`,
		).run(Date.now(), ...demoSids);
		writeFileSync(`${REG_DIR}/.demo-sealed`, "");
		return;
	}
	const now = Date.now();
	const min = 60_000;
	// captured for the post-commit answer pass (declared out here — the try
	// block dies at COMMIT)
	let answeredForkA = 0;
	let answeredForkB = 0;
	db.run("BEGIN IMMEDIATE");
	try {
		for (const [sid, state, hbMin] of [
			["demo-wait", "RUNNING", 1],
			["demo-work", "RUNNING", 1],
			["demo-pause", "PAUSED", 12],
		] as const)
			db.query(
				"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'worker', ?, ?, ?)",
			).run(sid, demo, now - 6 * 60 * min, now - hbMin * min, state);
		db.query(
			"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES ('demo-zomb', ?, 'worker', ?, ?, 'RUNNING')",
		).run(demo, now - 8 * 60 * min, now - 180 * min);
		// claim intents — owner_label renders these instead of raw sids
		for (const [sid, intent] of [
			["demo-wait", "review lane"],
			["demo-work", "backend lane"],
			["demo-pause", "docs lane"],
		] as const)
			db.query(
				"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts) VALUES (?, ?, ?, 0, ?)",
			).run(sid, demo, intent, now);
		db.query(
			"INSERT OR REPLACE INTO work_sequences (project, next_id) VALUES (?, 5)",
		).run(demo);
		for (const [id, title, state, owner, ageMin] of [
			["W1", "demo: triage the advice queue", "READY", null, 240],
			["W2", "demo: export board data as CSV", "CLAIMED", "demo-work", 90],
			["W3", "demo: migrate the settings schema", "BLOCKED", null, 45],
			["W4", "demo: retire the legacy feed", "DONE", null, 150],
		] as const)
			db.query(
				"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'demo', ?, ?)",
			).run(
				demo,
				id,
				title,
				state,
				owner,
				now - ageMin * min,
				now - ageMin * min,
			);
		// a dozen bus events with realistic spacing. Every NEED% fork is a real
		// event so syncDecisions materializes it — no shortcut rows.
		let evTs = now - 150 * min;
		const ev = (
			kind: string,
			source: string,
			scope: string | null,
			payload: Record<string, unknown>,
			target: string | null,
		): number => {
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
			).run(
				evTs,
				source,
				kind,
				scope,
				JSON.stringify({ project: demo, ...payload }),
				target,
			);
			evTs += 2 * min;
			return (
				db.query("SELECT last_insert_rowid() AS id").get() as { id: number }
			).id;
		};
		ev(
			"NOTE",
			"demo-work",
			"W4",
			{ work: "W4", note: "legacy feed retired, readers cut over" },
			null,
		);
		ev(
			"landed",
			"demo-work",
			"W4",
			{ work: "W4", note: "feed off", sha: "b7d903a" },
			null,
		);
		ev(
			"work.started",
			"demo-work",
			"W2",
			{ work: "W2", note: "export scaffolding" },
			null,
		);
		ev(
			"checkpoint",
			"demo-work",
			"W2",
			{ work: "W2", note: "CSV writer + tests" },
			null,
		);
		ev(
			"checkpoint",
			"demo-work",
			"W2",
			{ work: "W2", note: "streaming for big exports" },
			null,
		);
		ev("test_green", "demo-work", "W2", { work: "W2", sha: "4f8c2e1" }, null);
		ev(
			"NEED_DECISION",
			"demo-wait",
			"W2",
			{ work: "W2", note: "ship the export behind a flag or straight?" },
			"demo-wait",
		);
		ev(
			"NEED_DECISION",
			"demo-work",
			"W3",
			{ work: "W3", note: "drop the cache layer or escalate the flaky tests?" },
			"demo-work",
		);
		answeredForkA = ev(
			"NEED_DECISION",
			"demo-pause",
			"W2",
			{ work: "W2", note: "keep the 1s board poll or back off to 5s?" },
			"demo-pause",
		);
		answeredForkB = ev(
			"NEED_DECISION",
			"demo-work",
			"W3",
			{ work: "W3", note: "schema migration before or after launch?" },
			"demo-work",
		);
		ev(
			"NOTE",
			"demo-pause",
			"W3",
			{ work: "W3", note: "waiting on the migration call" },
			null,
		);
		ev(
			"checkpoint",
			"demo-pause",
			"W3",
			{ work: "W3", note: "capsule banked before the pause" },
			null,
		);
		db.run("COMMIT");
	} catch (e) {
		db.run("ROLLBACK");
		throw e;
	}
	syncDecisions(); // materializes all four forks from the real NEED events
	// two of them the human already answered — answered_at = now so the
	// ACK heuristic can't re-fire on the (older) seeded events
	for (const [id, note, to] of [
		[answeredForkA, "1s is fine — the page is local", "demo-pause"],
		[answeredForkB, "after launch", "demo-work"],
	] as const)
		db.query(
			"UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(note, to, Date.now(), crypto.randomUUID(), id);
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, ts) VALUES ('zombie.W3', 'a demo lane ZOMBIE (hb 3h)', 'fleet-board --demo', ?)",
	).run(now);
	console.log(`demo seeded → ${demo}`);
}

if (DEMO) {
	seedDemo();
	writeFileSync(`${REG_DIR}/.demo-sealed`, ""); // any successful demo run seals this home against silent re-seeding after a wipe
}

// W57 — orchestrate box part 1: config + endpoint constants + model resolve.
// The LLM proposes a plan item + parallel children from a goal; the human
// registers it as a plan-gated work split (endpoints below, before /llms.txt).
// The advice contract applies: the LLM proposes, the human registers — the
// proposal is never auto-registered.
