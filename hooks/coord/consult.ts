// hooks/coord/consult.ts — cross-agent consults (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import {
	die,
	arg,
	db,
	green,
	dim,
	cyan,
	red,
	kbLookup,
	lessonLookup,
	rankExperts,
	projectIdentity,
} from "./shared.ts";

export async function cmdConsult(rest: string[]): Promise<void> {
	// a question, not work: no claims, no ownership change, no lane state.
	// Fleet-internal transport (event bus); cross-session questions go via
	// native @session messaging with who-knows for discovery.
	const as = arg("--as");
	const scope = arg("--scope");
	const known = new Set(["--as", "--scope", "--best", "--no-kb"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	let expert: string | null = null;
	let question: string;
	if (rest.includes("--best")) {
		question = pos.join(" ");
		const best = rankExperts(projectIdentity(), question, scope, as)[0];
		if (!best) die("no ranked expert — nobody live has touched this");
		expert = best.sid;
	} else {
		expert = pos[0] ?? null;
		question = pos.slice(1).join(" ");
	}
	if (!as) die("consult requires --as <asker-sid>");
	if (!expert || !question)
		die(
			'usage: consult [--best] "<question>" | consult <sid> <question> [--scope s] --as <asker>',
		);
	// the plane answers before people do: a lesson hit skips the expert
	// liveness check too — the plane routes nothing, so nothing must be live
	const lessonHit = rest.includes("--no-kb") ? null : lessonLookup(question);
	if (
		!lessonHit &&
		!db
			.query(
				"SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING'",
			)
			.get(expert, projectIdentity())
	)
		die(`${expert.slice(0, 8)} is not a live session in this project`);
	// knowledge first: an answered consult already in the store answers this
	// without spending an expert round-trip (--no-kb forces live routing)
	const kbHit = rest.includes("--no-kb") ? null : kbLookup(question);
	if (lessonHit) {
		const r = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, answer, created_at, answered_at) VALUES (?, ?, ?, ?, ?, 'LESSON', ?, ?, ?)",
			)
			.run(
				projectIdentity(),
				as,
				"plane",
				question,
				scope,
				lessonHit.value,
				Date.now(),
				Date.now(),
			);
		const cid = `C${r.lastInsertRowid}`;
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', ?, ?, ?)",
		).run(
			Date.now(),
			as,
			scope,
			JSON.stringify({
				consult: cid,
				state: "LESSON",
				answer: lessonHit.value,
				lesson: lessonHit.key,
			}),
			as,
		);
		console.log(
			`${green("✓")} ${cyan(cid)} answered from the plane ${dim(`(${lessonHit.key}) — full note: coord fact get ${lessonHit.key}; --no-kb routes to a human`)}`,
		);
	} else if (kbHit) {
		const r = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, answer, created_at, answered_at) VALUES (?, ?, ?, ?, ?, 'KB', ?, ?, ?)",
			)
			.run(
				projectIdentity(),
				as,
				kbHit.answered_by,
				question,
				scope,
				kbHit.solution,
				Date.now(),
				Date.now(),
			);
		const cid = `C${r.lastInsertRowid}`;
		const expertLive = !!db
			.query("SELECT 1 FROM sessions WHERE sid = ? AND state = 'RUNNING'")
			.get(kbHit.answered_by);
		db.query(
			"UPDATE consult_kb SET hits = hits + 1, last_hit_at = ? WHERE id = ?",
		).run(Date.now(), kbHit.id);
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', ?, ?, ?)",
		).run(
			Date.now(),
			as,
			scope,
			JSON.stringify({
				consult: cid,
				state: "KB",
				answer: kbHit.solution,
				kb: {
					id: kbHit.id,
					solved_by: kbHit.answered_by,
					expert_live: expertLive,
				},
			}),
			as,
		);
		console.log(
			`${green("✓")} ${cyan(cid)} answered from the knowledge base ${dim(`(learned from ${kbHit.answered_by.slice(0, 8)}${expertLive ? ", still live" : ""}, ${kbHit.hits} prior hits) — --no-kb routes to a human`)}`,
		);
	} else {
		const r = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)",
			)
			.run(projectIdentity(), as, expert, question, scope, Date.now());
		const cid = `C${r.lastInsertRowid}`;
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', ?, ?, ?)",
		).run(
			Date.now(),
			as,
			scope,
			JSON.stringify({ consult: cid, q: question }),
			expert,
		);
		console.log(`CONSULT ${cyan(cid)} ${dim("→")} ${expert.slice(0, 8)}`);
	}
}

export async function cmdConsultReply(rest: string[]): Promise<void> {
	const as = arg("--as");
	const known = new Set(["--as", "--decline"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	const decline = rest.includes("--decline");
	const cid = pos[0];
	const text = pos.slice(1).join(" ");
	if (!cid || (!text && !decline) || !as)
		die('usage: consult-reply <C##> "<answer>" [--decline] --as <expert-sid>');
	const c = db
		.query("SELECT * FROM consults WHERE id = ? AND project = ?")
		.get(Number(String(cid).replace(/^C/i, "")), projectIdentity()) as
		| { id: number; asker_sid: string; expert_sid: string; state: string }
		| undefined;
	if (!c) die(`no such consult: ${cid}`);
	if (c.expert_sid !== as)
		die(`${cid} is addressed to ${String(c.expert_sid).slice(0, 8)}, not you`);
	if (c.state !== "OPEN") die(`${cid} is ${c.state}`);
	const st = decline ? "DECLINED" : "ANSWERED";
	db.query(
		"UPDATE consults SET state = ?, answer = ?, answered_at = ? WHERE id = ?",
	).run(st, decline ? null : text, Date.now(), c.id);
	// harvest: every human answer becomes fleet knowledge — the next asker
	// with the same question resolves without the round-trip
	if (!decline) {
		const kr = db
			.query(
				"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				c.question,
				text,
				projectIdentity(),
				c.asker_sid,
				as,
				c.id,
				Date.now(),
			);
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
			kr.lastInsertRowid,
			c.question,
		);
	}
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult.answer', NULL, ?, ?)",
	).run(
		Date.now(),
		as,
		JSON.stringify({ consult: cid, state: st, answer: decline ? null : text }),
		c.asker_sid,
	);
	console.log(
		`${st} ${cyan(String(cid))} ${dim("→")} ${String(c.asker_sid).slice(0, 8)}`,
	);
}

export async function cmdConsults(rest: string[]): Promise<void> {
	// my consult queue: OPEN questions addressed to me + my recent threads
	const as = arg("--as");
	if (!as) die("usage: consults --as <sid>");
	const rows = db
		.query(
			"SELECT id, asker_sid, question, state, answer FROM consults WHERE project = ? AND (expert_sid = ? OR asker_sid = ?) ORDER BY id DESC LIMIT 20",
		)
		.all(projectIdentity(), as, as) as {
		id: number;
		asker_sid: string;
		question: string;
		state: string;
		answer: string | null;
	}[];
	console.log(
		rows
			.map((r) => {
				const cid = `C${r.id}`;
				if (r.state === "OPEN")
					return `${red("?")} ${cyan(cid)} ← ${dim(`from ${String(r.asker_sid).slice(0, 8)}`)} ${r.question.slice(0, 60)}`;
				return `${green("✓")} ${cyan(cid)} → ${dim(`asked ${String(r.asker_sid).slice(0, 8)}`)} ${String(r.answer ?? "").slice(0, 60)}`;
			})
			.join("\n") || dim("(no consults)"),
	);
}

export async function cmdWhoKnows(rest: string[]): Promise<void> {
	// contextual expertise: who recently TOUCHED this beats nominal strength
	const scope = arg("--scope");
	const known = new Set(["--scope"]);
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		pos.push(rest[i]);
	}
	const q = pos.join(" ");
	if (!q && !scope) die('usage: who-knows "query words" [--scope src/x]');
	const rows = rankExperts(projectIdentity(), q, scope).slice(0, 5);
	console.log(
		rows
			.map((r) => `${r.sid.slice(0, 8)}  ${r.score.toFixed(2)}  ${dim(r.hint)}`)
			.join("\n") || dim("(no ranked session — nobody live has touched this)"),
	);
}
