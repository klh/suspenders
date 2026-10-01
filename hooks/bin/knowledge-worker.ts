// knowledge-worker.ts — W91: the knowledge ingest DAEMON (#8): a long-running
// drain loop over the knowledge_queue table spine (SQLite/WAL = the durable,
// inspectable broker — producers INSERT even when this process is down).
// p-queue, concurrency 1 (the distill model is single-instance — queue, never
// parallel-stomp it). SIGTERM: finish the current job, then exit.
//
// It consumes ONLY the ports (#9/#9b): KnowledgeStore + DistillClient via
// makeStore()/makeDistillClient() — the SQLite adapter is the only thing that
// touches governor.db. Policy layers live HERE (the loop), not in the store:
// mechanical secrets pass (redactSecrets) before any insert, near-duplicate
// gate via store.dedupeCheck (older fact kept, skip noted in the ledger).
// W103 adds the substitution contract's mechanical layer: doc-covered facts
// become POINTER rows (source_ref → the doc, fact → the non-obvious residue)
// or are rejected — never restatements of what one file already teaches.
// env:   INGEST_LLM_URL / INGEST_LLM_KEY / INGEST_LLM_MODEL — explicit
//        OpenAI-compatible distill endpoint (enterprise points at their own);
//        omit and the BeltDistillClient resolves belt via resolveBelt().
//        KNOWLEDGE_STORE_URL — reserved for a remote store adapter.
//        KNOWLEDGE_DOCS_ROOT — repo root for the substitution test; unset →
//        the mechanical check is OFF (prompt layer still applies).
// usage: bun hooks/bin/knowledge-worker.ts          (daemon: 5s poll loop)
//        bun hooks/bin/knowledge-worker.ts --once   (drain queued, exit)
import PQueue from "p-queue";
import {
	makeDistillClient,
	makeStore,
	type KnowledgeStore,
	type DistillItem,
} from "../lib/knowledge-ports.ts";
import {
	docForRef,
	loadDocs,
	loadRootDocs,
	pointerFromText,
	redactSecrets,
	substitutionCheck,
} from "../lib/knowledge.ts";
import { createHash } from "node:crypto";

const MAX_ATTEMPTS = 3;
const store: KnowledgeStore = makeStore();
const distill = makeDistillClient();

// W103: docs root for the substitution test. Unset → the check is OFF (logged
// once); the prompt layer (knowledgeworker.md) still applies. A pointer row's
// source_hash is the DOC's hash so knowledge-verify drift-checks the doc.
const DOCS_ROOT = process.env.KNOWLEDGE_DOCS_ROOT ?? null;
if (!DOCS_ROOT)
	console.error(
		"knowledge-worker: KNOWLEDGE_DOCS_ROOT unset — substitution check OFF (prompt layer still applies)",
	);
let draining = true;
const stop = (): void => {
	draining = false;
	console.error("knowledge-worker: SIGTERM — finishing current job, then exit");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// one job: claim → distill → secrets pass → dedupe gate → substitution → rows
async function processRow(rowId: number): Promise<void> {
	const job = await store.claim(rowId);
	if (!job) return; // claimed or purged meanwhile
	try {
		const items = await distill.distill(job.payload, {
			domain: job.domain,
			area: job.area,
			codeOrigin: job.codeOrigin,
			originSid: job.originSid,
		});
		const written: number[] = [];
		const skipped: string[] = [];
		let converted = 0;
		for (const it of items) {
			// mechanical secrets pass BEFORE anything: redact in place; a
			// private-key block rejects the candidate (LLM layer is not trusted)
			const top = redactSecrets(it.topic);
			const fac = redactSecrets(it.fact);
			if (top.rejected || fac.rejected) {
				skipped.push(
					`"${it.topic}" rejected: secret pattern (${[...top.hits, ...fac.hits].join(", ")})`,
				);
				continue;
			}
			const dup = await store.dedupeCheck({
				topic: top.text,
				fact: fac.text,
			});
			if (dup) {
				skipped.push(
					`"${it.topic}" near-duplicate of knowledge #${dup.id} ("${dup.topic}") — older kept`,
				);
				continue;
			}
			// W103 substitution contract: covered+residue → POINTER row
			// (ref → the doc, fact → residue, hash → the doc); covered without
			// residue → reject with the doc named in the ledger.
			const sub = substitutionGate(job.codeOrigin, job.sourceHash, {
				...it,
				fact: fac.text,
			});
			if (sub.skip) {
				skipped.push(sub.skip);
				continue;
			}
			if (sub.converted) converted++;
			written.push(
				await store.upsert({
					topic: top.text,
					fact: sub.fact,
					confidence: it.confidence,
					domain: job.domain ?? it.domain,
					area: job.area ?? it.area,
					originKind: it.originKind,
					originSystem: it.originSystem,
					sourceRef: sub.sourceRef,
					sourceHash: sub.sourceHash,
					originSid: job.originSid,
					supersedesId: it.supersedesId,
				}),
			);
		}
		await store.complete(
			job.id,
			{ written, skipped },
			job.domain,
			job.originSid,
		);
		console.log(
			`knowledge-ingest: #${job.id} "${job.source.slice(0, 40)}" → ${written.length} written, ${skipped.length} skipped${converted ? `, ${converted} converted to pointer rows` : ""}`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`knowledge-ingest: #${job.id} failed: ${msg}`);
		await store.fail(job.id, msg, job.attempts >= MAX_ATTEMPTS);
	}
}

// substitution gate (mechanical layer): corpus = docs under DOCS_ROOT + root
// README/AGENTS/CLAUDE + the job's code_origin file. Covered with residue →
// pointer row; covered without → reject; a model-declared source_ref is
// honored only when the file resolves (and is hashed) under DOCS_ROOT.
interface SubOut {
	fact: string;
	sourceRef: string | null;
	sourceHash: string;
	converted?: boolean;
	skip?: string;
}

function substitutionGate(
	codeOrigin: string | null,
	fallbackHash: string,
	it: DistillItem,
): SubOut {
	if (!DOCS_ROOT)
		return { fact: it.fact, sourceRef: codeOrigin, sourceHash: fallbackHash };
	return gateScan(codeOrigin, fallbackHash, it);
}

// corpus + verdict → SubOut (gate part 2)
function gateScan(
	codeOrigin: string | null,
	fallbackHash: string,
	it: DistillItem,
): SubOut {
	const root = DOCS_ROOT ?? ".";
	const docs = [...loadDocs(root), ...loadRootDocs(root)];
	const own = docForRef(root, codeOrigin);
	const v = substitutionCheck(it.fact, own ? [...docs, own] : docs);
	if (!v.covered) {
		// not doc-covered: honor a model-declared pointer ref when resolvable —
		// kept verbatim, never rewritten by the mechanical layer (W112 test)
		if (it.sourceRef) {
			const d = docForRef(root, it.sourceRef);
			if (d)
				return {
					fact: it.fact,
					sourceRef: it.sourceRef,
					sourceHash: sha256Hex(d.text),
				};
		}
		// W112 mechanical fallback: the model left source_ref empty (or named a
		// file that does not resolve) — extract doc paths from the fact text
		// and anchor to the first that EXISTS under DOCS_ROOT; hash = the file
		// content. Nothing resolves → the codeOrigin default below keeps the
		// trust marker honest.
		const p = pointerFromText(it.fact, root);
		if (p) return { fact: it.fact, sourceRef: p.ref, sourceHash: p.hash };
		return { fact: it.fact, sourceRef: codeOrigin, sourceHash: fallbackHash };
	}
	if (!v.residue)
		return {
			fact: it.fact,
			sourceRef: codeOrigin,
			sourceHash: fallbackHash,
			skip: `"${it.topic}" rejected: fully derivable from ${v.doc} (substitution contract)`,
		};
	return {
		fact: v.residue,
		sourceRef: v.doc,
		sourceHash: sha256Hex(v.docText ?? ""),
		converted: true,
	};
}

const sha256Hex = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

// oldest first (ts, id); p-queue serializes distill calls
async function tick(): Promise<void> {
	const next = await store.peekNext();
	if (next) await work.add(() => processRow(next.id));
}

const work = new PQueue({ concurrency: 1 });
await store.recoverOrphans(600_000); // dead worker's orphans requeue (#8)

if (process.argv.includes("--once")) {
	// manual/test mode: drain what is queued NOW, then exit. The launchd
	// daemon form runs the 5s poll loop below instead.
	if (!(await store.queuedCount()))
		console.log("knowledge-ingest: queue empty");
	for (;;) {
		if (!(await store.queuedCount())) break;
		await tick();
	}
	await work.onIdle();
	process.exit(0);
}

console.error("knowledge-worker daemon: poll 5s, p-queue concurrency 1");
setInterval(() => {
	if (draining) void tick();
}, 5000);
void tick();
work.on("idle", () => {
	if (!draining) process.exit(0);
});
