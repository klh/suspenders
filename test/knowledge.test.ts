// knowledge.test.ts — W91 knowledge layer end-to-end: enqueue → worker (LLM
// stub) → candidate rows → dedup on a second pass → coord knowledge search
// (incl. domain/area/origin filters) → promote/retire lifecycle → MCP stdio
// server answers read_knowledge. Isolated temp HOME + repo; the distill LLM
// is a local Bun.serve stub, so no real model is needed.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
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
	const db = new Database(DB, { readonly: true });
	const rows = db.query(sql).all() as T[];
	db.close();
	return rows;
}

// bootstrap: the first CLI open runs migrations (v6 included)
run(["kb", "stats"]);

// the distill LLM stub: /v1/models names the model; /v1/chat/completions
// returns a canned distillation so no real model is needed
const stub = Bun.serve({
	port: 0,
	fetch(req) {
		const u = new URL(req.url);
		if (u.pathname === "/v1/models")
			return Response.json({ data: [{ id: "stub-distiller" }] });
		if (u.pathname === "/v1/chat/completions")
			return Response.json({
				choices: [
					{
						message: {
							content: JSON.stringify(
								distillArr(u.searchParams.get("echo") ?? ""),
							),
						},
					},
				],
			});
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

afterAll(() => {
	stub.stop(true);
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

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
		expect(w.err).toBe("");
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
		const payload = JSON.parse(call.content?.[0]?.text ?? "{}") as {
			hits: { kind: string }[];
		};
		expect(payload.hits.some((h) => h.kind === "knowledge")).toBe(true);
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
