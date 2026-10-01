// hooks/coord/knowledge.ts — knowledge layer queue/promote/retire/verify (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import {
	die,
	arg,
	green,
	dim,
	cyan,
	amber,
	renderKnowledgeHit,
	makeStore,
	enqueueKnowledge,
	readFileSync,
	createHash,
} from "./shared.ts";

export async function cmdKnowledge(rest: string[]): Promise<void> {
	// W91 — ranked FTS5 search over the knowledge layer: distilled knowledge
	// rows (filterable by domain/area/origin), then facts (key+value) and
	// consult_kb. The cheap read in plan → query → investigate the unknowns:
	// agents hit this BEFORE working so known gotchas are not re-learned.
	const knownK = new Set([
		"--domain",
		"--area",
		"--origin-kind",
		"--origin-system",
		"--limit",
		"--json",
	]);
	const posK: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--json") continue;
		if (knownK.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		posK.push(rest[i]);
	}
	const kq = posK.join(" ").trim();
	// #9b: consumers reach knowledge ONLY through the store port
	const kHits = kq
		? await makeStore().search({
				query: kq,
				domain: arg("--domain"),
				area: arg("--area"),
				originKind: arg("--origin-kind"),
				originSystem: arg("--origin-system"),
				limit: Number(arg("--limit") ?? 10),
			})
		: [];
	if (rest.includes("--json")) {
		console.log(JSON.stringify({ query: kq, hits: kHits }));
		if (!kHits.length) process.exitCode = 1;
	} else if (!kHits.length) {
		console.log(dim(`(no knowledge for: ${kq || "(empty query)"})`));
		process.exitCode = 1;
	} else {
		for (const h of kHits) renderKnowledgeHit(h, dim, cyan);
	}
}

export async function cmdKnowledgeEnqueue(rest: string[]): Promise<void> {
	// feed the standalone ingest worker (hooks/bin/knowledge-worker.ts, launchd
	// com.suspenders.knowledge-ingest): the worker distills the payload with
	// the configured LLM into CANDIDATE knowledge rows — promotion stays
	// human/merge-gated. --domain/--area/--code-origin are human hints; they
	// win over the model's guesses.
	const source = arg("--source");
	const payload = arg("--payload");
	if (!source || !payload)
		die(
			'usage: knowledge-enqueue --source <why> --payload "<text>" [--domain d] [--area a] [--code-origin repo/path] [--as sid]',
		);
	const qid = await enqueueKnowledge({
		source,
		payload,
		domain: arg("--domain"),
		area: arg("--area"),
		codeOrigin: arg("--code-origin"),
		originSid: arg("--as"),
	});
	console.log(
		`${green("✓")} queued #${qid} — the ingest worker takes the oldest queued row per pass`,
	);
}

export async function cmdKnowledgePromote(rest: string[]): Promise<void> {
	// candidate → active: THE gated promotion step (humans/merges only)
	const id = Number(rest[0]);
	if (!id) die("usage: knowledge-promote <id>");
	const ok = await makeStore().promote(id);
	if (!ok) die(`knowledge #${id} is not a candidate (or missing)`);
	console.log(`${green("✓")} knowledge #${id} → active`);
}

export async function cmdKnowledgeRetire(rest: string[]): Promise<void> {
	// active/candidate → retired: exits search; superseded_by records the heir
	const id = Number(rest[0]);
	if (!id) die("usage: knowledge-retire <id> [--superseded-by <id>]");
	const by = Number(arg("--superseded-by") ?? 0) || null;
	const ok = await makeStore().retire(id, by);
	if (!ok) die(`knowledge #${id} is already retired (or missing)`);
	console.log(`${green("✓")} knowledge #${id} → retired`);
}

export async function cmdKnowledgeNote(rest: string[]): Promise<void> {
	// micro-update by a contributing agent: append to the row's contributors
	// ledger (sid + ts + what changed) and bump updated_at. Mechanical —
	// the note text is provenance, not evaluation.
	const id = Number(rest[0]);
	const what = arg("--what");
	const as = arg("--as");
	if (!id || !what || !as)
		die('usage: knowledge-note <id> --what "what changed" --as <sid>');
	// #9b: micro-updates go through the store port
	const n = await makeStore().note(id, as, what);
	if (n < 0) die(`no such knowledge: #${id}`);
	console.log(
		`${green("✓")} knowledge #${id} noted by ${as.slice(0, 8)} (${n} contributor entries)`,
	);
}

export async function cmdKnowledgeVerify(rest: string[]): Promise<void> {
	// mechanical staleness check (#7): re-hash the source_ref file and compare
	// with source_hash taken at index time. Mismatch = drift, reported (the
	// row is not mutated — flagging stays a human/agent decision).
	const id = rest[0] ? Number(rest[0]) : null;
	// #9b: rows come through the store port; the FILE hash check is local I/O
	const rows = await makeStore().verifyRows(id);
	if (!rows.length) {
		console.log(dim("(nothing verifiable — no source_ref/source_hash rows)"));
		process.exitCode = 1;
	} else {
		for (const r of rows) {
			try {
				const cur = createHash("sha256")
					.update(readFileSync(r.sourceRef, "utf8"))
					.digest("hex");
				console.log(
					cur === r.sourceHash
						? `${green("✓")} k#${r.id} ${r.topic.slice(0, 40)} — source unchanged`
						: `${amber("⚠")} k#${r.id} ${r.topic.slice(0, 40)} — DRIFT: source changed since index`,
				);
			} catch {
				console.log(
					dim(
						`k#${r.id} ${r.topic.slice(0, 40)} — source_ref unreadable: ${r.sourceRef}`,
					),
				);
			}
		}
	}
}

export async function cmdKnowledgeCurate(rest: string[]): Promise<void> {
	// W103 substitution curation: flag rows restating what ONE repo file/doc
	// already teaches — human review decides pointer-ize vs retire; flagged
	// rows stay in place (state untouched, append-only contributor note).
	const repoRoot = arg("--repo") ?? process.cwd();
	const res = await makeStore().curate({
		repoRoot,
		by: arg("--as") ?? "coord-curate",
	});
	for (const f of res.flagged)
		console.log(
			`${amber("⚠")} k#${f.id} "${f.topic.slice(0, 48)}" — derivable from ${f.doc} (${f.coverage}% terms)`,
		);
	console.log(
		`${green("✓")} curate: ${res.flagged.length}/${res.checked} rows flagged for review (left in place, state unchanged)`,
	);
}
