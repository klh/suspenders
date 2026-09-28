// hooks/bin/harvest.ts — fleet curriculum harvester (W77). Mines lane
// transcripts (claude + codex) for mistake signals, clusters them, writes
// recurring ones into consult_kb (answered_by="harvest") so future consults
// self-serve, and reports lesson candidates for human promotion into
// lesson.* facts. Never writes lesson.* itself — machine-written doctrine
// pushed to every session is how curriculum pollution happens.
// Idempotent: per-transcript byte cursors (harvest.cursor.*) and cluster
// keys (harvest.seen.*) live in the facts table; one HARVEST event per run.
// usage: bun harvest.ts scan|run --repo <path> [--days N]  (scan writes nothing)
// env:   HOME (transcript roots; launchd sets it — no other config)
import { openGovernorDb } from "../lib/govdb.ts";
import {
	clusterSignals,
	discoverTranscripts,
	mungePath,
	newClaudeState,
	parseClaudeRow,
	parseCodexRow,
	resetCodexCalls,
	type Signal,
} from "../lib/harvest.ts";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const mode = argv[0] ?? "";
const arg = (name: string): string | null => {
	const i = argv.indexOf(name);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const repo = arg("--repo") ?? process.cwd();
const days = Number(arg("--days") ?? "7");

const die = (msg: string): never => {
	console.error(msg);
	process.exit(2);
};

if (mode !== "scan" && mode !== "run")
	die("usage: bun harvest.ts scan|run --repo <path> [--days N]");
if (!Number.isInteger(days) || days < 1 || days > 60)
	die("--days must be 1..60");

const db = openGovernorDb();
// kb rows join the fleet's project identity — git-common-dir, the same value
// consult-reply writes, so consult lookups stay project-scoped as usual
const projs = Bun.spawnSync(
	["git", "-C", repo, "rev-parse", "--git-common-dir"],
	{
		stdout: "pipe",
		stderr: "ignore",
	},
);
const project =
	projs.exitCode === 0 && projs.stdout
		? new TextDecoder().decode(projs.stdout).trim() || repo
		: repo;

const cursorKey = (path: string): string => `harvest.cursor.${mungePath(path)}`;
const seenKey = (key: string): string => `harvest.seen.${mungePath(key)}`;
const fact = (key: string): string | null =>
	(
		db.query("SELECT value FROM facts WHERE key = ?").get(key) as
			| { value: string }
			| undefined
	)?.value ?? null;

const cursors = new Map<string, number>();
for (const r of db
	.query("SELECT key, value FROM facts WHERE key LIKE 'harvest.cursor.%'")
	.all() as { key: string; value: string }[]) {
	cursors.set(r.key, Number(r.value) || 0);
}

// ---- pass 1: parse new transcript content since each file's cursor ----

const refs = await discoverTranscripts(repo, homedir(), days);
const signals: Signal[] = [];
const newOffsets = new Map<string, number>();
let scanned = 0;
for (const ref of refs) {
	scanned++;
	const at = cursors.get(cursorKey(ref.path)) ?? 0;
	let start = at;
	let text = "";
	let size = 0;
	try {
		const f = Bun.file(ref.path);
		size = f.size;
		if (size < start) start = 0; // truncated/rotated: full rescan
		text = await f.slice(start, size).text();
	} catch {
		continue; // vanished mid-run: not scanned, cursor untouched
	}
	if (!text) continue;
	// only complete lines advance the cursor — a live lane may be mid-append
	const lines = text.split("\n");
	if (!text.endsWith("\n")) lines.pop();
	if (!lines.length) continue;
	const consumed = `${lines.join("\n")}\n`;
	const newAt = start + Buffer.byteLength(consumed);
	if (ref.backend === "claude") {
		const state = newClaudeState();
		for (const line of lines) {
			if (!line.trim()) continue;
			let row: unknown;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			const sig = parseClaudeRow(state, row as never);
			if (sig) signals.push(sig);
		}
	} else {
		resetCodexCalls();
		for (const line of lines) {
			if (!line.trim()) continue;
			let row: unknown;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			const sig = parseCodexRow(row as never, ref.item);
			if (sig) signals.push(sig);
		}
	}
	newOffsets.set(ref.path, newAt);
}

// ---- pass 2: cluster + (run mode) write kb rows, cursors, event ----

const clusters = clusterSignals(signals);
const candidates = clusters.filter((c) => c.items.length >= 2);
const now = Date.now();
let written = 0;
let known = 0;
const wroteKeys = new Set<string>();

const applyTx = db.transaction(() => {
	for (const c of clusters) {
		if (fact(seenKey(c.key))) {
			known++;
			continue;
		}
		const problem = `Recurring ${c.kind} in lane transcripts (${c.items.join(", ")}): ${c.subject}`;
		const solution = `${c.detail}\n— harvested from lane transcripts ${new Date(now).toISOString().slice(0, 10)}; the evidence names the fix — read the gate/spec it points at before writing here again.`;
		const kr = db
			.query(
				"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at) VALUES (?, ?, ?, 'harvest', 'harvest', NULL, ?)",
			)
			.run(problem, solution.slice(0, 600), project, now);
		// FTS index row — without it consult lookup never self-serves this row
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
			kr.lastInsertRowid,
			problem,
		);
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, ts) VALUES (?, '1', ?)",
		).run(seenKey(c.key), now);
		written++;
		wroteKeys.add(c.key);
	}
	for (const [path, at] of newOffsets)
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, ts) VALUES (?, ?, ?)",
		).run(cursorKey(path), String(at), now);
	if (written > 0)
		db.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'harvest', 'HARVEST', ?, ?, NULL)",
		).run(
			now,
			project,
			JSON.stringify({
				repo,
				scanned,
				signals: signals.length,
				clusters: clusters.length,
				written,
				candidates: candidates.map((c) => c.subject).slice(0, 10),
			}),
		);
});

if (mode === "run") applyTx();

// ---- report ----

const name = repo.split("/").filter(Boolean).at(-1) ?? repo;
const summary =
	mode === "run"
		? `${written} new kb rows, ${known} already known`
		: "scan — nothing written";
console.log(
	`HARVEST ${name} — ${scanned} transcripts, ${signals.length} signals, ${clusters.length} clusters, ${summary}`,
);
for (const c of clusters) {
	const tag =
		mode === "scan" ? "preview" : wroteKeys.has(c.key) ? "→ kb" : "known";
	console.log(
		`  ${c.kind}  ×${c.count}  lanes ${c.items.join(",")}  ${c.subject}  [${tag}]`,
	);
}
if (candidates.length)
	console.log("lesson candidates (hit in ≥2 lanes) — promote by hand:");
for (const c of candidates)
	console.log(
		`  coord fact set lesson.<topic> "${c.subject} — ${c.detail.split("\n")[0]}" --source harvest   (lanes ${c.items.slice().sort().join(", ")})`,
	);
