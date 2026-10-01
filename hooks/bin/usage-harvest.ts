// hooks/bin/usage-harvest.ts — W127 usage data layer. Library + thin CLI.
// Mines THIS host's ~/.claude/projects/**/*.jsonl transcripts for assistant
// usage rows (tokenUsage precedent in govdb.ts), aggregates them into hourly
// (hour_bucket, actor, model) buckets, and UPSERT-ADDS them into
// governor.db's usage_rollup. Idempotent per transcript via a facts-table
// cursor {offset, mtime}: an unchanged transcript is skipped (no double
// count); a grown one is read as an append-only tail (JSONL transcripts are
// append-only), so each usage line is aggregated exactly once. Runs as a
// board-API subroutine (TTL-gated maybeHarvest) — never a daemon.
import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { openGovernorDb } from "../lib/govdb.ts";
import { readBoardSettings } from "../lib/board-config.ts";
import { harvestAids } from "./aid-harvest.ts";

// routing-doctrine classes (belt routing-policy.yaml ladder: flash → local →
// cloud full models); the raw model string is kept alongside the group.
export type ModelGroup = "flash" | "full" | "luna" | "local" | "other";

export function modelGroup(model: string): ModelGroup {
	const m = model.toLowerCase().replace(/^[a-z0-9]+\//, ""); // strip anthropic/ etc.
	if (m.includes("flash")) return "flash";
	if (m.includes("luna")) return "luna";
	if (/(local|swarm|ollama|llama|gguf|hermes)/.test(m)) return "local";
	if (/^(claude|gpt|o[0-9]|gemini|grok|deepseek)/.test(m)) return "full";
	return "other";
}

export interface HarvestStats {
	files: number; // transcripts seen
	harvested: number; // transcripts whose tail was read
	skipped: number; // unchanged (cursor hit) — the idempotency fast path
	requests: number; // assistant usage rows aggregated
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
}

interface Cursor {
	o: number; // byte offset of the first unharvested byte
	m: number; // mtimeMs at last harvest
}

const tpKey = (p: string): string => {
	const h = new Bun.CryptoHasher("sha1");
	h.update(p);
	return `usage.tp.${h.digest("hex")}`;
};

const n = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

// byte tail of a file from `start` — sync keeps the harvest deterministic
// (and maybeHarvest reentrancy trivial)
function readTail(path: string, start: number): string {
	const fh = openSync(path, "r");
	try {
		const len = fstatSync(fh).size - start;
		if (len <= 0) return "";
		const buf = Buffer.allocUnsafe(len);
		readSync(fh, buf, 0, len, start);
		return buf.toString("utf8");
	} finally {
		closeSync(fh);
	}
}

export function harvestUsage(
	db: Database,
	opts: { root?: string } = {},
): HarvestStats {
	const root = opts.root ?? `${process.env.HOME}/.claude/projects`;
	const out: HarvestStats = {
		files: 0,
		harvested: 0,
		skipped: 0,
		requests: 0,
		inTok: 0,
		outTok: 0,
		cacheR: 0,
		cacheC: 0,
	};
	// actor attribution: transcript basename → sessions.sid → actor. No
	// session row (or NULL actor) ⇒ "unassigned" — honest, never guessed.
	const actorOf = new Map<string, { actor: string | null }>();
	for (const r of db
		.query("SELECT sid, actor FROM sessions WHERE actor IS NOT NULL")
		.all() as { sid: string; actor: string | null }[])
		actorOf.set(r.sid, { actor: r.actor });
	const getCur = (key: string): Cursor | null => {
		const row = db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string | null;
		} | null;
		if (!row?.value) return null;
		try {
			const c = JSON.parse(row.value) as { o?: unknown; m?: unknown };
			return typeof c.o === "number" && typeof c.m === "number"
				? { o: c.o, m: c.m }
				: null;
		} catch {
			return null;
		}
	};
	const setCur = db.query(
		"INSERT INTO facts (key, value, source, ts) VALUES (?, ?, 'usage-harvest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts",
	);
	const upsert = db.query(
		"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hour_bucket, actor, model) DO UPDATE SET in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok, cache_r = cache_r + excluded.cache_r, cache_c = cache_c + excluded.cache_c, requests = requests + excluded.requests",
	);
	const add = new Map<
		string,
		{
			h: number;
			actor: string;
			model: string;
			group: ModelGroup;
			in: number;
			out: number;
			cr: number;
			cc: number;
			req: number;
		}
	>();
	const bump = (
		h: number,
		actor: string,
		model: string,
		u: {
			input_tokens?: unknown;
			output_tokens?: unknown;
			cache_read_input_tokens?: unknown;
			cache_creation_input_tokens?: unknown;
		},
	) => {
		const key = `${h}\u0000${actor}\u0000${model}`;
		let r = add.get(key);
		if (!r) {
			r = {
				h,
				actor,
				model,
				group: modelGroup(model),
				in: 0,
				out: 0,
				cr: 0,
				cc: 0,
				req: 0,
			};
		}
		r.in += n(u.input_tokens);
		r.out += n(u.output_tokens);
		r.cr += n(u.cache_read_input_tokens);
		r.cc += n(u.cache_creation_input_tokens);
		r.req += 1;
		add.set(key, r);
	};
	const glob = new Bun.Glob("**/*.jsonl");
	for (const rel of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
		out.files++;
		const abs = join(root, rel);
		let st: { size: number; mtimeMs: number };
		try {
			const s = statSync(abs);
			st = { size: s.size, mtimeMs: s.mtimeMs };
		} catch {
			continue; // vanished mid-scan — next harvest catches the remainder
		}
		const key = tpKey(abs);
		let cur = getCur(key);
		if (cur && st.size < cur.o) cur = null; // truncated → full re-read (rare)
		if (cur && st.size === cur.o && st.mtimeMs === cur.m) {
			out.skipped++;
			continue; // unchanged transcript: the idempotency fast path
		}
		const start = cur?.o ?? 0;
		const text = readTail(abs, start);
		const nl = text.lastIndexOf("\n");
		if (nl === -1) {
			// no complete line in the tail — advance nothing, retry next pass
			setCur.run(key, JSON.stringify({ o: start, m: st.mtimeMs }), Date.now());
			continue;
		}
		const body = text.slice(0, nl + 1);
		const next = start + nl + 1;
		const sid = basename(rel).replace(/\.jsonl$/, "");
		const actor = actorOf.get(sid)?.actor ?? "unassigned";
		for (const line of body.split("\n")) {
			if (!line.includes('"type":"assistant"')) continue;
			let o:
				| {
						timestamp?: string;
						message?: { model?: string; usage?: Record<string, unknown> };
				  }
				| undefined;
			try {
				o = JSON.parse(line);
			} catch {
				continue;
			}
			const ts = Date.parse(o?.timestamp ?? "");
			const u = o?.message?.usage;
			if (!u || !Number.isFinite(ts)) continue;
			const model = o?.message?.model ?? "";
			bump(Math.floor(ts / 3_600_000) * 3_600_000, actor, model, u);
			out.requests++;
			out.inTok += n(u.input_tokens);
			out.outTok += n(u.output_tokens);
			out.cacheR += n(u.cache_read_input_tokens);
			out.cacheC += n(u.cache_creation_input_tokens);
		}
		setCur.run(key, JSON.stringify({ o: next, m: st.mtimeMs }), Date.now());
		out.harvested++;
	}
	if (add.size) {
		db.run("BEGIN IMMEDIATE");
		try {
			for (const r of add.values())
				upsert.run(
					r.h,
					r.actor,
					r.model,
					r.group,
					r.in,
					r.out,
					r.cr,
					r.cc,
					r.req,
				);
			db.run("COMMIT");
		} catch (e) {
			try {
				db.run("ROLLBACK");
			} catch {}
			throw e;
		}
	}
	return out;
}

// board-API entry: harvest at most once per TTL; concurrent/reentrant calls
// (same process or overlapping board requests) fold into the running one.
// W147: the default TTL rides the console settings file (~/.claude/local-llm/
// suspenders-board.json harvest_ttl_s) — config-over-code, 300s when unset.
let inFlight = false;
const defaultTtlMs = (): number => {
	const s = readBoardSettings().settings.harvest_ttl_s;
	return s && s >= 1 ? s * 1000 : 5 * 60_000;
};
export function maybeHarvest(
	db: Database,
	ttlMs = defaultTtlMs(),
): HarvestStats | null {
	const row = db
		.query("SELECT value FROM facts WHERE key = 'usage.harvestAt'")
		.get() as { value: string | null } | null;
	const at = Number(row?.value ?? 0);
	if (inFlight || (Number.isFinite(at) && at > 0 && Date.now() - at < ttlMs))
		return null;
	inFlight = true;
	try {
		const s = harvestUsage(db);
		db.query(
			"INSERT INTO facts (key, value, source, ts) VALUES ('usage.harvestAt', ?, 'usage-harvest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
		).run(String(Date.now()), Date.now());
		// W142: aid metering rides the same TTL gate (fire-and-forget — the
		// report built this tick may lag one cycle; aids are garnish).
		void harvestAids(db).catch((e: unknown) =>
			console.error(
				`[aid-harvest] soft: ${e instanceof Error ? e.message : e}`,
			),
		);
		return s;
	} catch (e) {
		console.error(
			`[usage-harvest] failed soft: ${e instanceof Error ? e.message : e}`,
		);
		return null;
	} finally {
		inFlight = false;
	}
}

if (import.meta.main) {
	const db = openGovernorDb();
	const force = process.argv.includes("--force");
	const s = maybeHarvest(db, force ? 0 : undefined);
	console.log(JSON.stringify(s ?? { skipped: "ttl-fresh" }));
}
