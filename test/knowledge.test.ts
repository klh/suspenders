// knowledge.test.ts — W91 knowledge layer end-to-end: enqueue → worker (LLM
// stub) → candidate rows → dedup on a second pass → coord knowledge search
// (incl. domain/area/origin filters) → promote/retire lifecycle → MCP stdio
// server answers read_knowledge. Isolated temp HOME + repo; the distill LLM
// is a local Bun.serve stub, so no real model is needed.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-knowledge-"));
const REPO = mkdtempSync(join(process.cwd(), ".tmp-knowledge-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const worker = join(
	import.meta.dir,
	"..",
	"hooks",
	"bin",
	"knowledge-worker.ts",
);
const mcp = join(import.meta.dir, "..", "hooks", "bin", "knowledge-mcp.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
// W166: knowledge rows + queue live in knowledge.db post-split — assertions
// naming knowledge tables read THAT file (the port law, test-side).
const KDB = join(HOME, ".cache", "claude-governor", "knowledge.db");

// projectIdentity(), mirrored: git-common-dir from inside the temp repo
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
void PROJ;

function run(args: string[], extraEnv: Record<string, string> = {}) {
	const p = Bun.spawnSync(["bun", coord, ...args], {
		cwd: REPO,
		env: { ...env, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

// async on purpose: spawnSync would block this test process's event loop,
// starving the in-process stub server (deadlock — the worker's fetch would
// never resolve). Bun.spawn keeps the loop free to answer the stub.
async function runWorker(extraEnv: Record<string, string> = {}) {
	const p = Bun.spawn(["bun", worker, "--once"], {
		cwd: REPO,
		env: { ...env, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { out, err, code: await p.exited };
}

function q<T>(sql: string): T[] {
	// knowledge tables ride knowledge.db post-split (W166); everything else
	// (events, sessions, facts) is control-plane governor.db.
	const f = /\bknowledge(?:_queue|_fts)?\b/.test(sql) ? KDB : DB;
	const db = new Database(f, { readonly: true });
	const rows = db.query(sql).all() as T[];
	db.close();
	return rows;
}

// bootstrap: the first CLI open runs migrations (v6 included)
run(["kb", "stats"]);

// W103 fixture: the doc the substitution fixtures derive from — the covered
// sentences share its terms, the residues carry unique tokens (marker-w103a)
const DOC_REL = "docs/pointer-source.md";
mkdirSync(join(REPO, "docs"), { recursive: true });
const DOC_TEXT =
	"Fleet knowledge rows must never restate what a single file already teaches. The substitution contract converts doc-covered facts to pointer rows and keeps the non-obvious residue only.";
writeFileSync(join(REPO, DOC_REL), DOC_TEXT);

// W112 fixture: a second doc a MODEL-declared source_ref points at
const MODEL_REF_REL = "docs/model-ref.md";
const MODEL_REF_TEXT =
	"Model-declared source refs are honored verbatim by the mechanical gate.";
writeFileSync(join(REPO, MODEL_REF_REL), MODEL_REF_TEXT);

// W100 fixture: the doc an enqueue-declared ref points at (hashed at ENQUEUE
// time by the producer, never the payload) — content never mutated by tests
const W100_REF_REL = "docs/w100-ref.md";
const W100_REF_TEXT =
	"W100 fixture: enqueue-time hashing captures the FILE at enqueue, never the payload.";
writeFileSync(join(REPO, W100_REF_REL), W100_REF_TEXT);

// W100 drift-cycle doc: enqueued, verified fresh, then overwritten — its own
// file so no other test's row is disturbed by the mutation
const W100_DRIFT_REL = "docs/w100-drift.md";
writeFileSync(join(REPO, W100_DRIFT_REL), "W100 drift fixture: content v1.");

// the distill LLM stub: /v1/models names the model; /v1/chat/completions
// returns a canned distillation so no real model is needed. W103: the stub
// reads the payload and returns substitution-themed items for the W103 runs.
const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		if (u.pathname === "/v1/models")
			return Response.json({ data: [{ id: "stub-distiller" }] });
		if (u.pathname === "/v1/chat/completions") {
			const body = (await req.json().catch(() => null)) as {
				messages?: { content?: string }[];
			} | null;
			const text = body?.messages?.map((m) => m.content ?? "").join(" ") ?? "";
			const items = text.includes("w112-")
				? w112Items(text)
				: text.includes("w100-")
					? w100Items(text)
					: text.includes("w103-substitution")
						? w103Items()
						: text.includes("w103-curate-bait")
							? baitItem()
							: distillArr(u.searchParams.get("echo") ?? "");
			return Response.json({
				choices: [{ message: { content: JSON.stringify(items) } }],
			});
		}
		return new Response("not found", { status: 404 });
	},
});
const INGEST_ENV = {
	INGEST_LLM_URL: `http://127.0.0.1:${stub.port}/v1/chat/completions`,
};

// canned distillation: two durable items; the payload echo discriminates the
// dedup run from the first run
function distillArr(echo: string): unknown[] {
	return [
		{
			topic: "gate race discipline",
			fact: `always set INGEST_LLM_KEY = ghp_aaaaaaaaaaaaaaaaaaaaaaaa1 before gate chunks marker-${echo}`,
			confidence: 0.8,
			domain: "suspenders",
			area: "gates",
			origin_kind: "lesson",
			origin_system: "mac-m5max",
		},
		{
			topic: "launchd cadence",
			fact: `launchd StartInterval re-runs the worker; one queue row per pass keeps passes cheap marker-${echo}`,
			confidence: 0.7,
			domain: "suspenders",
			area: "launchd",
			origin_kind: "decision",
			origin_system: null,
		},
	];
}

// W103 substitution-themed distillations (payload discriminator: w103-substitution)
function w103Items(): unknown[] {
	return [
		{
			// covered sentence + novel residue → POINTER row conversion
			topic: "docs covered pointer",
			fact: "The substitution contract converts doc-covered facts to pointer rows and keeps the non-obvious residue only. Quirk: marker-w103a.",
			confidence: 0.9,
			domain: "suspenders",
			area: "gates",
			origin_kind: "lesson",
			origin_system: null,
		},
		rejectItem(),
	];
}

// fully doc-covered item with NO residue → the contract REJECTS it at ingest
function rejectItem(): unknown {
	return {
		topic: "fully derivable bait",
		fact: "The substitution contract converts doc-covered facts to pointer rows never restatements.",
		confidence: 0.9,
		domain: "suspenders",
		area: "gates",
		origin_kind: "lesson",
		origin_system: null,
	};
}

// curate-bait item (payload discriminator: w103-curate-bait) — lands when the
// worker runs WITHOUT KNOWLEDGE_DOCS_ROOT, mirroring the pre-contract seeder
// rows the curation verb must flag
function baitItem(): unknown[] {
	return [
		{
			topic: "curate bait row",
			fact: "Fleet knowledge rows must never restate what a single file already teaches. bait residue zq7k",
			confidence: 0.9,
			domain: "suspenders",
			area: "gates",
			origin_kind: "lesson",
			origin_system: null,
		},
	];
}

// W100 items (payload discriminator: "w100-"): one row per unique marker so
// the near-dup gate never merges the probes; facts carry NO path-like tokens
// (so the gate's codeOrigin fallback lands) and each carries 5 unique filler
// tokens (so pairwise term overlap stays under the 0.6 near-dup threshold)
function w100Items(text: string): unknown[] {
	const marker = /w100-[a-z]+/.exec(text)?.[0] ?? "w100-x";
	return [
		{
			topic: `w100 probe ${marker}`,
			fact: `Provenance ${marker}: ${marker}-fq ${marker}-qz ${marker}-mx ${marker}-jw ${marker}-kz.`,
			confidence: 0.9,
			domain: "suspenders",
			area: "gates",
			origin_kind: "lesson",
			origin_system: null,
			source_ref: null,
		},
	];
}

afterAll(() => {
	stub.stop(true);
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// ─── W112 pointer-row fixtures ───
// one payload shape, three model behaviors; the facts stay below the
// substitution-coverage threshold (unique marker tokens) so each exercises
// the NOT-covered branch of the gate. Discriminator: "w112-" in the request.
function w112Items(text: string): unknown[] {
	const fact = text.includes("w112-fallback")
		? "Mechanical fallback quirk: facts naming docs/pointer-source.md anchor pointer rows only when the file exists. zq112fb"
		: text.includes("w112-model-ref")
			? "Model emitted refs stay verbatim even when the fact also names docs/pointer-source.md. zq112mr"
			: "Absent path probe: names docs/absent-zq112.md that is not on disk. zq112ms";
	const topic = text.includes("w112-fallback")
		? "w112 mechanical fallback"
		: text.includes("w112-model-ref")
			? "w112 model ref verbatim"
			: "w112 absent path honest";
	const sourceRef = text.includes("w112-model-ref")
		? "docs/model-ref.md"
		: null;
	return [
		{
			topic,
			fact,
			confidence: 0.9,
			domain: "suspenders",
			area: "gates",
			origin_kind: "lesson",
			origin_system: null,
			source_ref: sourceRef,
		},
	];
}

describe("knowledge ingest pipeline", () => {
	const PAYLOAD =
		"session learnings: the lint gate races the formatter on multi-chunk edits; always let the gate build each chunk. launchd passes stay cheap when the queue is empty.";

	test("worker distills a queued row into candidate knowledge", async () => {
		const e = run([
			"knowledge-enqueue",
			"--source",
			"w91 verify",
			"--payload",
			PAYLOAD,
			"--domain",
			"suspenders",
			"--area",
			"gates",
			"--as",
			"autow91test",
		]);
		expect(e.code).toBe(0);
		expect(e.out).toContain("queued #1");
		const w = await runWorker(INGEST_ENV);
		// W103: stderr carries only the docs-root advisory when unset
		expect(w.err).toContain("substitution check OFF");
		expect(w.out).toContain("2 written, 0 skipped");
		const rows = q<{
			id: number;
			topic: string;
			state: string;
			source: string;
			domain: string | null;
		}>("SELECT id, topic, state, source, domain FROM knowledge ORDER BY id");
		expect(rows.length).toBe(2);
		expect(rows[0].state).toBe("candidate");
		expect(rows[0].source).toBe("knowledge-worker");
		expect(rows[0].domain).toBe("suspenders"); // enqueue hint wins
		const facts = q<{ fact: string; origin_sid: string | null }>(
			"SELECT fact, origin_sid FROM knowledge WHERE id = 1",
		)[0];
		expect(facts.fact).toContain("[REDACTED]"); // mechanical secrets pass
		expect(facts.fact).not.toContain("ghp_");
		expect(facts.origin_sid).toBe("autow91test"); // provenance via --as
		const qr = q<{ state: string; result_key: string }>(
			"SELECT state, result_key FROM knowledge_queue WHERE id = 1",
		)[0];
		expect(qr.state).toBe("done");
		expect(qr.result_key).toContain('"written":[1,2]');
	});

	test("re-ingesting the same payload skips near-duplicates (older kept)", async () => {
		const e = run([
			"knowledge-enqueue",
			"--source",
			"w91 dedup verify",
			"--payload",
			"same learnings again marker-dup",
		]);
		expect(e.code).toBe(0);
		const w = await runWorker(INGEST_ENV);
		expect(w.out).toContain("0 written, 2 skipped");
		const n = q<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge")[0].n;
		expect(n).toBe(2); // nothing new
		const skip = JSON.parse(
			q<{ result_key: string }>(
				"SELECT result_key FROM knowledge_queue WHERE id = 2",
			)[0].result_key,
		) as { skipped: string[] };
		expect(skip.skipped[0]).toContain("near-duplicate of knowledge #1");
	});

	test("empty queue: worker exits 0 immediately", async () => {
		const w = await runWorker(INGEST_ENV);
		expect(w.code).toBe(0);
		expect(w.out).toContain("queue empty");
	});
});

describe("knowledge search", () => {
	test("coord knowledge finds distilled rows; filters narrow honestly", () => {
		const s = run(["knowledge", "gate race discipline chunks"]);
		expect(s.code).toBe(0);
		expect(s.out).toContain("k#1");
		expect(s.out).toContain("candidate");
		const j = JSON.parse(run(["knowledge", "gate chunks", "--json"]).out) as {
			hits: { kind: string; id: number }[];
		};
		expect(j.hits.some((h) => h.kind === "knowledge")).toBe(true);
		const miss = run(["knowledge", "totally unrelated quantum words"]);
		expect(miss.code).toBe(1);
		expect(miss.out).toContain("(no knowledge for:");
	});

	test("filters narrow; promote/retire lifecycle gates search", () => {
		// "marker" is the one term both distilled rows share. The --area hint
		// was row-wide (enqueue hint wins over model guesses), so --area gates
		// matches both; --origin-system mac-m5max narrows to row 1 only
		// (row 2's origin_system is null).
		const both = run(["knowledge", "marker"]);
		expect(both.out).toContain("k#1");
		expect(both.out).toContain("k#2");
		const area = run(["knowledge", "marker", "--area", "gates"]);
		expect(area.out).toContain("k#1");
		expect(area.out).toContain("k#2");
		const sys = run(["knowledge", "marker", "--origin-system", "mac-m5max"]);
		expect(sys.out).toContain("k#1");
		expect(sys.out).not.toContain("k#2");
		const p = run(["knowledge-promote", "1"]);
		expect(p.out).toContain("#1 → active");
		expect(
			q<{ state: string }>("SELECT state FROM knowledge WHERE id = 1")[0].state,
		).toBe("active");
		const r = run(["knowledge-retire", "2", "--superseded-by", "1"]);
		expect(r.out).toContain("#2 → retired");
		expect(
			q<{ superseded_by: number | null }>(
				"SELECT superseded_by FROM knowledge WHERE id = 2",
			)[0].superseded_by,
		).toBe(1);
		const s = run(["knowledge", "launchd StartInterval cadence passes"]);
		expect(s.out).not.toContain("k#2"); // retired exits search
		const again = run(["knowledge-retire", "2"]);
		expect(again.code).toBe(2); // die() exits 2
	});
});

describe("knowledge MCP server", () => {
	test("read_knowledge answers over stdio JSON-RPC", async () => {
		const proc = Bun.spawn(["bun", mcp], {
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const send = (o: unknown) => proc.stdin.write(`${JSON.stringify(o)}\n`);
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2024-11-05" },
		});
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		send({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "read_knowledge",
				arguments: { query: "gate race discipline chunks" },
			},
		});
		await proc.stdin.flush();
		const lines: string[] = await readStdioLines(proc, 3);
		expect(lines.length).toBeGreaterThanOrEqual(3);
		const byId = new Map<number, Record<string, unknown>>();
		for (const l of lines) {
			try {
				const m = JSON.parse(l) as {
					id?: number;
					result?: Record<string, unknown>;
				};
				if (m.id != null) byId.set(m.id, m.result ?? {});
			} catch {}
		}
		const tools = byId.get(2) as { tools?: { name: string }[] };
		expect(tools.tools?.[0]?.name).toBe("read_knowledge");
		const call = byId.get(3) as { content?: { text: string }[] };
		const text = call.content?.[0]?.text ?? "";
		// W103: prose cards, not a JSON.stringify blob — header + precedence
		// preamble + per-hit trust line (state · age · hash), card ids k#
		expect(text).toContain("fleet knowledge —");
		expect(text).toContain("Precedence:");
		expect(text).toContain("k#1");
		expect(text).toContain("age ");
		expect(text).toContain("hash ");
		expect(() => JSON.parse(text)).toThrow();
		proc.kill();
	});
});

// collect N newline-delimited JSON-RPC responses off an MCP server's stdout
async function readStdioLines(
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
	want: number,
): Promise<string[]> {
	const reader = proc.stdout.getReader();
	const lines: string[] = [];
	const decode = new TextDecoder();
	const deadline = Date.now() + 10_000;
	while (lines.length < want && Date.now() < deadline) {
		const raw = await Promise.race([
			reader.read(),
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
		]);
		if (raw === "timeout" || raw.done) break;
		lines.push(
			...decode
				.decode(raw.value)
				.split("\n")
				.filter((l) => l.trim()),
		);
	}
	return lines;
}

// ─── W103 dosu deltas: substitution contract, trust, prose cards, curate ───

// small local helper so the fixture hash matches the worker's
import { createHash } from "node:crypto";
const sha256Hex = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

describe("W103 substitution contract", () => {
	test("doc-covered fact converts to a pointer row; fully-derivable rejects", async () => {
		const e = run([
			"knowledge-enqueue",
			"--source",
			"w103 substitution",
			"--payload",
			"w103-substitution: pointer conversion probe",
		]);
		expect(e.code).toBe(0);
		// worker WITH the docs root — the mechanical contract is active
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.err).toBe("");
		expect(w.out).toContain("1 written, 1 skipped");
		expect(w.out).toContain("converted to pointer rows");
		// the residue IS the fact; the ref points at the DOC; hash = doc hash
		const row = q<{
			fact: string;
			source_ref: string | null;
			source_hash: string | null;
		}>(
			"SELECT fact, source_ref, source_hash FROM knowledge WHERE topic = 'docs covered pointer'",
		)[0];
		expect(row.fact).toBe("Quirk: marker-w103a.");
		expect(row.source_ref).toBe(DOC_REL);
		expect(row.source_hash).toBe(sha256Hex(DOC_TEXT));
		// the fully-derivable item is rejected with the doc named in the ledger
		const skip = JSON.parse(
			q<{ result_key: string }>(
				"SELECT result_key FROM knowledge_queue ORDER BY id DESC LIMIT 1",
			)[0].result_key,
		) as { skipped: string[] };
		expect(skip.skipped[0]).toContain("fully derivable from");
	});
});

describe("W103 curation", () => {
	test("knowledge-curate flags a pre-contract row, leaves it in place", async () => {
		// seed a pre-contract row: worker WITHOUT KNOWLEDGE_DOCS_ROOT, mirroring
		// the W93 seeder — the fact lands verbatim, unobserved by the contract
		const e = run([
			"knowledge-enqueue",
			"--source",
			"w103 curate bait",
			"--payload",
			"w103-curate-bait: seeder-era restatement",
		]);
		expect(e.code).toBe(0);
		const w = await runWorker(INGEST_ENV); // no docs root → contract off
		expect(w.out).toContain("1 written, 0 skipped");
		const bait = q<{ id: number; state: string }>(
			"SELECT id, state FROM knowledge WHERE topic = 'curate bait row'",
		)[0];
		expect(bait.state).toBe("candidate");
		// curation: the bait row is flagged for HUMAN review — not deleted
		const c = run(["knowledge-curate", "--repo", REPO, "--as", "w103test"]);
		expect(c.code).toBe(0);
		expect(c.out).toContain("curate bait row");
		expect(c.out).toContain("rows flagged for review");
		const flaggedRow = q<{ state: string; contributors: string }>(
			"SELECT state, contributors FROM knowledge WHERE topic = 'curate bait row'",
		)[0];
		expect(flaggedRow.state).toBe("candidate"); // left in place
		expect(flaggedRow.contributors).toContain("curate-flag"); // note appended
	});
});

describe("W103 knowledge-api faces", () => {
	const api = join(import.meta.dir, "..", "hooks", "bin", "knowledge-api.ts");
	const PORT = 47957; // test-only; collision unlikely and non-fatal

	test("POST /search renders cards + trust markers; POST /curate flags", async () => {
		const proc = Bun.spawn(["bun", api], {
			env: {
				...env,
				KNOWLEDGE_API_PORT: String(PORT),
				KNOWLEDGE_REPO_ROOT: REPO,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			// readiness poll
			let up = false;
			for (let i = 0; i < 40 && !up; i++) {
				await new Promise((r) => setTimeout(r, 250));
				up = await fetch(`http://127.0.0.1:${PORT}/`)
					.then((r) => r.ok)
					.catch(() => false);
			}
			expect(up).toBe(true);
			const s = (await fetch(`http://127.0.0.1:${PORT}/search`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "marker-w103a" }),
			}).then((r) => r.json())) as {
				preamble: string;
				cards: string;
				hits: {
					kind: string;
					state?: string;
					ageDays?: number;
					trust?: string;
				}[];
			};
			// model face: prose cards led by the precedence preamble
			expect(s.preamble.startsWith("Precedence:")).toBe(true);
			expect(s.cards).toContain("fleet knowledge —");
			expect(s.cards).toContain("k#");
			expect(s.cards).toContain("age ");
			expect(s.cards).toContain("hash verified"); // pointer row → doc hash matches
			// programmatic face: hits carry state, age, and the trust marker
			const k = s.hits.find((h) => h.kind === "knowledge");
			expect(k?.state).toBe("candidate");
			expect(typeof k?.ageDays).toBe("number");
			expect(k?.trust).toBe("verified");
			// curation route: same store port, HTTP face
			const c = (await fetch(`http://127.0.0.1:${PORT}/curate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ repo: REPO, by: "api-test" }),
			}).then((r) => r.json())) as {
				checked: number;
				flagged: { id: number; topic: string }[];
			};
			expect(c.checked).toBeGreaterThanOrEqual(3);
			expect(c.flagged.some((f) => f.topic === "curate bait row")).toBe(true);
			// W100: /enqueue hashes the source_ref FILE on the producer side
			const e = (await fetch(`http://127.0.0.1:${PORT}/enqueue`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					source: "w100 api enqueue",
					payload: "w100-api: api-face probe",
					source_ref: "docs/w100-ref.md",
				}),
			}).then((r) => r.json())) as { queued: number };
			expect(e.queued).toBeGreaterThan(0);
			const apiq = q<{ source_ref: string | null; source_hash: string | null }>(
				`SELECT source_ref, source_hash FROM knowledge_queue WHERE id = ${e.queued}`,
			)[0];
			expect(apiq.source_ref).toBe(W100_REF_REL);
			expect(apiq.source_hash).toBe(sha256Hex(W100_REF_TEXT));
		} finally {
			proc.kill();
		}
	});
});

// ─── W112 mechanical pointer fallback ───

import { extractDocPaths, pointerFromText } from "../hooks/lib/knowledge.ts";

describe("W112 extractDocPaths", () => {
	test("extracts repo-relative paths from prose, deduped, order kept", () => {
		expect(
			extractDocPaths(
				"gate lives in hooks/lib/knowledge.ts, then docs/w112-notes.md, then docs/w112-notes.md again",
			),
		).toEqual(["hooks/lib/knowledge.ts", "docs/w112-notes.md"]);
	});

	test("rejects lookalikes: URL remainders, absolute paths, versions", () => {
		expect(
			extractDocPaths("spec at https://example.com/guide.md ends"),
		).toEqual([]);
		expect(extractDocPaths("http://host/x.md too")).toEqual([]);
		expect(extractDocPaths("shipped v1.2.md then 1.2.1.md")).toEqual([]);
		expect(extractDocPaths("absolute /etc/nailgun.toml path")).toEqual([]);
	});

	test("pointerFromText: first EXISTING path wins, else null", () => {
		expect(pointerFromText("only docs/absent-zz.md here", REPO)).toBeNull();
		expect(pointerFromText("see docs/pointer-source.md", REPO)).toEqual({
			ref: DOC_REL,
			hash: sha256Hex(DOC_TEXT),
		});
	});
});

describe("W112 pointer rows through the worker", () => {
	const enq = (marker: string) =>
		run([
			"knowledge-enqueue",
			"--source",
			"w112 verify",
			"--payload",
			`${marker}: probe`,
		]);
	const rowByTopic = (topic: string) =>
		q<{ source_ref: string | null; source_hash: string | null }>(
			`SELECT source_ref, source_hash FROM knowledge WHERE topic = '${topic}'`,
		);

	test("model-empty source_ref is filled mechanically, hash = doc content", async () => {
		expect(enq("w112-fallback").code).toBe(0);
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.err).toBe("");
		expect(w.out).toContain("1 written, 0 skipped");
		const rows = rowByTopic("w112 mechanical fallback");
		expect(rows.length).toBe(1);
		expect(rows[0].source_ref).toBe(DOC_REL);
		expect(rows[0].source_hash).toBe(sha256Hex(DOC_TEXT));
	});

	test("model-declared source_ref is preserved untouched", async () => {
		expect(enq("w112-model-ref").code).toBe(0);
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.err).toBe("");
		const rows = rowByTopic("w112 model ref verbatim");
		expect(rows.length).toBe(1);
		// the model's ref verbatim — NOT the doc the fact text names
		expect(rows[0].source_ref).toBe(MODEL_REF_REL);
		expect(rows[0].source_hash).toBe(sha256Hex(MODEL_REF_TEXT));
	});

	test("fact naming a missing file leaves source_ref empty (honest trust)", async () => {
		expect(enq("w112-missing").code).toBe(0);
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.err).toBe("");
		const rows = rowByTopic("w112 absent path honest");
		expect(rows.length).toBe(1);
		expect(rows[0].source_ref).toBeNull();
	});
});

// ─── W100 enqueue-time source hashing ───

import { normalizeSourceRef } from "../hooks/lib/knowledge-ports.ts";

describe("W100 normalizeSourceRef", () => {
	test("strips explanatory suffixes, keeps the leading path", () => {
		expect(normalizeSourceRef("hooks/lib/govdb.ts projectIdentity()")).toBe(
			"hooks/lib/govdb.ts",
		);
		expect(normalizeSourceRef("hooks/bin/work.ts shaOnMain (W60)")).toBe(
			"hooks/bin/work.ts",
		);
		expect(
			normalizeSourceRef("hooks/bin/fleet-loop.ts + docs/fleet-loop.md"),
		).toBe("hooks/bin/fleet-loop.ts");
		expect(normalizeSourceRef("docs/x.md — why it matters")).toBe("docs/x.md");
		expect(normalizeSourceRef("docs/x.md—attached")).toBe("docs/x.md");
		expect(normalizeSourceRef("docs/plain.md")).toBe("docs/plain.md");
		expect(normalizeSourceRef("  docs/spaced.md  ")).toBe("docs/spaced.md");
	});
});

describe("W100 enqueue-time source hashing", () => {
	const enq = (marker: string, codeOrigin: string) =>
		run([
			"knowledge-enqueue",
			"--source",
			"w100 verify",
			"--payload",
			`${marker}: probe`,
			"--code-origin",
			codeOrigin,
		]);
	const rowByTopic = (topic: string) =>
		q<{ source_ref: string | null; source_hash: string | null }>(
			`SELECT source_ref, source_hash FROM knowledge WHERE topic = '${topic}'`,
		);

	test("resolvable ref: file hash rides the queue into the row (not the payload)", async () => {
		expect(
			enq("w100-resolvable", "docs/w100-ref.md — prose suffix (why)").code,
		).toBe(0);
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.err).toBe("");
		expect(w.out).toContain("1 written, 0 skipped");
		// queue pass-through: normalized ref + the FILE's hash at enqueue time
		const qr = q<{
			source_ref: string | null;
			source_hash: string | null;
		}>(
			"SELECT source_ref, source_hash FROM knowledge_queue WHERE source = 'w100 verify' ORDER BY id DESC LIMIT 1",
		)[0];
		expect(qr.source_ref).toBe(W100_REF_REL); // suffix normalized out
		expect(qr.source_hash).toBe(sha256Hex(W100_REF_TEXT));
		const row = rowByTopic("w100 probe w100-resolvable")[0];
		expect(row.source_ref).toBe(W100_REF_REL);
		expect(row.source_hash).toBe(sha256Hex(W100_REF_TEXT));
	});

	test("missing ref: row lands with a NULL hash (no doomed value)", async () => {
		expect(enq("w100-missing", "docs/absent-w100.md").code).toBe(0);
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.out).toContain("1 written, 0 skipped");
		const row = rowByTopic("w100 probe w100-missing")[0];
		expect(row.source_ref).toBe("docs/absent-w100.md");
		expect(row.source_hash).toBeNull();
	});

	test("verify flags DRIFT only when the file content actually changed", async () => {
		expect(enq("w100-drift", "docs/w100-drift.md").code).toBe(0);
		const w = await runWorker({ ...INGEST_ENV, KNOWLEDGE_DOCS_ROOT: REPO });
		expect(w.out).toContain("1 written, 0 skipped");
		// fresh: stored hash matches the live file
		const before = run(["knowledge-verify"]);
		expect(before.out).toContain("source unchanged");
		// live-file mutation AFTER index → real drift, not by-construction
		writeFileSync(
			join(REPO, W100_DRIFT_REL),
			"W100 drift fixture: content v2 — changed after index.",
		);
		const after = run(["knowledge-verify"]);
		expect(after.out).toContain("DRIFT");
	});
});

// ─── W245 search stage: origin_kind prior + 1-hop pointer expansion ───

import { knowledgeSearch } from "../hooks/lib/knowledge.ts";

describe("W245 search stage", () => {
	// minimal column subset — the search SQL only touches these columns
	const KSCHEMA = `CREATE TABLE knowledge (
	id INTEGER PRIMARY KEY,
	ts INTEGER NOT NULL,
	topic TEXT NOT NULL,
	fact TEXT NOT NULL,
	domain TEXT,
	area TEXT,
	origin_kind TEXT,
	origin_system TEXT,
	source_ref TEXT,
	state TEXT NOT NULL DEFAULT 'candidate',
	updated_at INTEGER)`;

	// external-content FTS — indexed by explicit inserts, not triggers
	const FSCHEMA = `CREATE VIRTUAL TABLE knowledge_fts USING fts5(
	topic, fact,
	domain UNINDEXED, area UNINDEXED,
	origin_kind UNINDEXED, origin_system UNINDEXED, state UNINDEXED,
	content='knowledge', content_rowid='id')`;

	type RawHit = KnowledgeHit & { origin_kind?: string | null };
	let autoId = 0;
	const NOW = Date.now();
	const graphDb = (): Database => {
		const db = new Database(":memory:");
		db.exec(`${KSCHEMA}; ${FSCHEMA}`);
		return db;
	};

	// seed one row into the content table + its FTS index row
	const seed = (
		db: Database,
		row: {
			topic: string;
			fact: string;
			originKind?: string | null;
			domain?: string | null;
			area?: string | null;
			sourceRef?: string | null;
			state?: string;
		},
	): number => {
		const id = ++autoId;
		db.query(
			`INSERT INTO knowledge (id, ts, topic, fact, domain, area,
				origin_kind, origin_system, source_ref, state, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			NOW,
			row.topic,
			row.fact,
			row.domain ?? null,
			row.area ?? null,
			row.originKind ?? null,
			null,
			row.sourceRef ?? null,
			row.state ?? "active",
			NOW,
		);
		db.query(
			`INSERT INTO knowledge_fts (rowid, topic, fact, domain, area,
				origin_kind, origin_system, state)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			row.topic,
			row.fact,
			row.domain ?? null,
			row.area ?? null,
			row.originKind ?? null,
			null,
			row.state ?? "active",
		);
		return id;
	};

	const hitsOf = (db: Database, query: string, filters = {}) =>
		knowledgeSearch(db, query, filters) as RawHit[];

	test("origin_kind prior: incident > lesson > decision > fact at equal text", () => {
		const db = graphDb();
		seed(db, {
			topic: "gate race",
			fact: "let the gate build each chunk quxma",
			originKind: "fact",
		});
		seed(db, {
			topic: "gate race",
			fact: "let the gate build each chunk qzdec",
			originKind: "decision",
		});
		seed(db, {
			topic: "gate race",
			fact: "let the gate build each chunk zqles",
			originKind: "lesson",
		});
		seed(db, {
			topic: "gate race",
			fact: "let the gate build each chunk mqinc",
			originKind: "incident",
		});
		const hits = hitsOf(db, "gate build chunk");
		expect(hits.map((h) => h.origin_kind)).toEqual([
			"incident",
			"lesson",
			"decision",
			"fact",
		]);
		// isolated rows (no shared axes) never gain hop markers
		expect(hits.every((h) => h.hop === undefined)).toBe(true);
	});

	test("1-hop edges: pointer before domain; retired excluded", () => {
		const db = graphDb();
		const a = seed(db, {
			topic: "seed row",
			fact: "gates wobbling under qlty check words",
			domain: "suspenders",
			area: "gates",
			originKind: "incident",
			sourceRef: "docs/shared.md",
		});
		const p = seed(db, {
			topic: "pointer sibling",
			fact: "wholly unrelated vocabulary zqptr",
			originKind: "fact",
			sourceRef: "docs/shared.md",
		});
		const b = seed(db, {
			topic: "domain sibling",
			fact: "differing text entirely zqdom",
			domain: "suspenders",
			area: "gates",
			originKind: "incident",
		});
		seed(db, {
			topic: "retired sibling",
			fact: "also differing text zqret",
			domain: "suspenders",
			area: "gates",
			state: "retired",
		});
		const hits = hitsOf(db, "gates wobbling qlty");
		expect(hits[0]?.id).toBe(a);
		const exp = hits.filter((h) => h.hop === 1);
		expect(exp.map((h) => h.id)).toEqual([p, b]);
		expect(exp.map((h) => h.via)).toEqual(["pointer", "domain"]);
	});

	test("1-hop expansion obeys axis filters and the limit cap", () => {
		const db = graphDb();
		const a = seed(db, {
			topic: "seed two",
			fact: "board sizing tokens zqtw",
			domain: "suspenders",
			area: "board",
			originKind: "incident",
		});
		seed(db, {
			topic: "neighbor other area",
			fact: "off-axis text zqoa",
			domain: "suspenders",
			area: "gates",
		});
		const b = seed(db, {
			topic: "neighbor same area",
			fact: "on-axis text zqon",
			domain: "suspenders",
			area: "board",
		});
		// origin-kind filter binds the expansion: fact-prior neighbor drops
		const f = hitsOf(db, "board sizing tokens", { originKind: "incident" });
		expect(f.some((h) => h.id === a)).toBe(true);
		expect(f.some((h) => h.id === b)).toBe(false);
		// limit caps the expansion and cannot resurrect a retired row
		const l = hitsOf(db, "board sizing tokens", { limit: 1 });
		const exp = l.filter((h) => h.hop === 1);
		expect(exp.length).toBeLessThanOrEqual(1);
	});

	test("coord CLI search renders 1-hop cards from the pipeline graph", () => {
		// marker-w103a primary-matches the docs-covered-pointer row; the
		// w112-fallback row shares its source_ref → pulled in as hop 1
		const s = run(["knowledge", "marker-w103a"]);
		expect(s.code).toBe(0);
		expect(s.out).toContain("1-hop pointer");
		const j = JSON.parse(run(["knowledge", "marker-w103a", "--json"]).out) as {
			hits: { hop?: number; via?: string }[];
		};
		expect(j.hits.some((h) => h.hop === 1 && h.via === "pointer")).toBe(true);
	});
});
