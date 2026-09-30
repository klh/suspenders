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
// env:   INGEST_LLM_URL / INGEST_LLM_KEY / INGEST_LLM_MODEL — explicit
//        OpenAI-compatible distill endpoint (enterprise override — points at
//        their own gateway); omit (default) and BeltDistillClient resolves
//        belt via resolveBelt() and sends hint 'prefer local distill
//        reasoning' — belt decides, local-first (W96).
//        KNOWLEDGE_STORE_URL — reserved for a remote store adapter.
// usage: bun hooks/bin/knowledge-worker.ts          (daemon: 5s poll loop)
//        bun hooks/bin/knowledge-worker.ts --once   (drain queued, exit)
import PQueue from "p-queue";
import {
	makeDistillClient,
	makeStore,
	type KnowledgeStore,
} from "../lib/knowledge-ports.ts";
import { redactSecrets } from "../lib/knowledge.ts";

const MAX_ATTEMPTS = 3;
const store: KnowledgeStore = makeStore();
const distill = makeDistillClient();
let draining = true;
const stop = (): void => {
	draining = false;
	console.error("knowledge-worker: SIGTERM — finishing current job, then exit");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// one job: claim → distill → secrets pass → dedupe gate → candidate rows
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
			written.push(
				await store.upsert({
					topic: top.text,
					fact: fac.text,
					confidence: it.confidence,
					domain: job.domain ?? it.domain,
					area: job.area ?? it.area,
					originKind: it.originKind,
					originSystem: it.originSystem,
					sourceRef: job.codeOrigin,
					sourceHash: job.sourceHash,
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
			`knowledge-ingest: #${job.id} "${job.source.slice(0, 40)}" → ${written.length} written, ${skipped.length} skipped`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`knowledge-ingest: #${job.id} failed: ${msg}`);
		await store.fail(job.id, msg, job.attempts >= MAX_ATTEMPTS);
	}
}

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
