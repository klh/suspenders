// fleet-board.ts — live control-plane dashboard. Read-only over governor.db
// except the human decision endpoints (/api/answer /api/ack /api/advise) and
// the board-owned decisions table below. Serves a page that polls every
// second (WAL allows concurrent readers).
// Start from anywhere:  bun ~/.claude/bin/fleet-board.ts [--port 7799]
// then open http://127.0.0.1:<port> — dropdown lists every known session;
// focusing a session shows its project's TODO / IN-FLIGHT / DONE board,
// its claims, inbox, lane state, and the event tail.
import { openGovernorDb } from "../lib/govdb.ts";
import { HTML } from "./fleet-board-html.ts";

// sibling CLIs resolve relative to this file — the board is relocatable
const CLI = (f: string) => new URL(f, import.meta.url).pathname;

const db = openGovernorDb();
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 7799) || 7799;
const BIND = process.env.SUSPENDERS_BIND ?? "127.0.0.1";

// decision lifecycle (OPEN/ANSWERED/DISMISSED), owned by the board: NEED%
// events must not vanish when the recipient acks their inbox — cursors track
// delivery, this table tracks the human decision. Backfilled idempotently
// from the bus (dead-letter alias targets included); answers keep the fork's
// event id as the correlation key.
db.run(`CREATE TABLE IF NOT EXISTS decisions (
	event_id INTEGER PRIMARY KEY,
	target TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'OPEN',
	answer_note TEXT,
	answer_to TEXT,
	answered_at INTEGER,
	closed_at INTEGER,
	created_at INTEGER NOT NULL
)`);

const syncDecisions = (): void =>
	db
		.query("INSERT OR IGNORE INTO decisions (event_id, target, created_at) SELECT id, target, ? FROM events WHERE kind LIKE 'NEED%' AND target IS NOT NULL")
		.run(Date.now());

const esc = (s: unknown): string =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// write endpoints are for the human at this board: same-origin only. Host
// must be loopback or the bind itself (DNS-rebind protection); a present
// Origin must match the Host (CSRF protection). Absent Origin = non-browser
// client (curl, hooks) — Host check still applies.
function writeGuard(req: Request, url: URL): Response | null {
	const host = (req.headers.get("host") ?? "").toLowerCase().replace(/\.$/, "");
	const hname = host.replace(/:\d+$/, "");
	const okHost =
		["localhost", "127.0.0.1", "::1", "[::1]", "[0:0:0:0:0:0:0:1]"].includes(hname) ||
		hname === BIND.toLowerCase() ||
		hname === `[${BIND.toLowerCase()}]`;
	if (!host || !okHost) return json({ ok: false, error: "untrusted host" }, 403);
	const origin = req.headers.get("origin");
	if (origin) {
		try {
			if (new URL(origin).host.toLowerCase() !== host) return json({ ok: false, error: "cross-origin request" }, 403);
		} catch {
			return json({ ok: false, error: "bad origin" }, 403);
		}
	}
	return null;
}

// JSON-body endpoints must declare application/json (a plain form POST from
// another site can't forge it cross-origin) and must parse.
async function readJson(req: Request): Promise<{ ok: true; body: any } | { ok: false; resp: Response }> {
	const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (ct !== "application/json") return { ok: false, resp: json({ ok: false, error: "content-type must be application/json" }, 415) };
	try {
		return { ok: true, body: await req.json() };
	} catch {
		return { ok: false, resp: json({ ok: false, error: "malformed json body" }, 400) };
	}
}

// failure notes ride the work.failed event payload ($.work = item id) — the
// board shows why a lane died, not just that it died
const failNote = (id: string): string | null => {
	try {
		const r = db
			.query("SELECT payload FROM events WHERE kind = 'work.failed' AND json_extract(payload, '$.work') = ? ORDER BY id DESC LIMIT 1")
			.get(id) as { payload: string | null } | null;
		const note = r?.payload ? (JSON.parse(r.payload) as any).note : null;
		return note ? String(note).slice(0, 300) : null;
	} catch {
		return null;
	}
};

function ago(ts: number | null | undefined): number {
	return ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : -1;
}

function label(sid: string, role: string): string {
	const rows = db.query("SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4").all(sid) as { intent: string | null }[];
	const c = rows.find((r) => r.intent && !String(r.intent).startsWith("restored by monitor"));
	if (c?.intent) return String(c.intent).slice(0, 24);
	if (role === "coordinator") return "coordinator";
	return sid.slice(0, 8);
}

function sessions(): unknown[] {
	return db
		.query("SELECT sid, role, state, parent_sid, project, hb FROM sessions ORDER BY state, sid")
		.all()
		.map((s: any) => ({
			sid: s.sid,
			label: label(s.sid, s.role),
			role: s.role,
			state: s.state,
			parent: s.parent_sid,
			project: s.project,
			hbAgo: ago(s.hb),
		}));
}

function board(): Record<string, unknown>[] {
	const projects = db
		.query("SELECT DISTINCT project FROM work_items WHERE state NOT IN ('DONE','SUPERSEDED') OR state = 'DONE'")
		.all() as { project: string }[];
	return projects.map(({ project }) => {
		const items = db
			.query("SELECT id, state, owner_sid, title, priority, result_sha, requires, updated_at FROM work_items WHERE project = ? ORDER BY priority DESC, id")
			.all(project) as any[];
		const doneIds = new Set(items.filter((w) => w.state === "DONE").map((w) => w.id));
		const depRows = db
			.query("SELECT work_id, depends_on FROM work_deps WHERE project = ? AND depends_on NOT IN (SELECT id FROM work_items WHERE project = ? AND state = 'DONE')")
			.all(project, project) as any[];
		const blocked = new Set(depRows.map((r: any) => r.work_id));
		const openDeps: Record<string, string[]> = {};
		for (const r of depRows) (openDeps[r.work_id] ??= []).push(r.depends_on);
		const shape = (w: any) => ({
			id: w.id,
			state: w.state,
			owner: w.owner_sid,
			title: w.title,
			sha: w.result_sha,
			requires: w.requires,
			blocked: blocked.has(w.id),
			deps: openDeps[w.id] ?? null,
			note: w.state === "FAILED" ? failNote(w.id) : null,
			updatedAgo: ago(w.updated_at),
		});
		return {
			project,
			name: project.split("/").pop()?.replace(/\.git$/, "") || project.split("/").slice(-2, -1).pop() || project,
			doneN: doneIds.size,
			total: items.length,
			pct: items.length ? Math.round((doneIds.size / items.length) * 100) : 0,
			todo: items.filter((w) => w.state === "READY" && !blocked.has(w.id)).map(shape),
			gated: items.filter((w) => (w.state === "READY" && blocked.has(w.id)) || w.state === "BLOCKED" || w.state === "PAUSED").map(shape),
			inflight: items.filter((w) => w.state === "CLAIMED" || w.state === "RUNNING").map(shape),
			done: items.filter((w) => w.state === "DONE").slice(-30).reverse().map(shape),
			other: items.filter((w) => w.state === "FAILED" || w.state === "SUPERSEDED" || w.state === "ORPHANED" || w.state === "SHATTERED").map(shape),
		};
	});
}

function claims(): unknown[] {
	return db
		.query("SELECT sid, scope, intent, hot, ts FROM claims ORDER BY sid, scope")
		.all()
		.map((c: any) => ({ sid: c.sid, scope: c.scope, intent: c.intent, hot: !!c.hot, tsAgo: ago(c.ts) }));
}

function events(): unknown[] {
	return db
		.query("SELECT id, ts, source, kind, scope, payload, target FROM events ORDER BY id DESC LIMIT 50")
		.all()
		.map((e: any) => {
			let note = "";
			try {
				note = e.payload ? Object.entries(JSON.parse(e.payload)).map(([k, v]) => k + "=" + String(v).slice(0, 40)).join(" ") : "";
			} catch {
				note = "(malformed)";
			}
			return { id: e.id, tsAgo: ago(e.ts), source: e.source, kind: e.kind, scope: e.scope, target: e.target, note };
		});
}

function laneFacts(sid: string): Record<string, unknown> {
	const rows = db.query("SELECT key, value FROM facts WHERE key = ? OR key = ?").all("lane." + sid + ".state", "lane." + sid + ".capsule") as any[];
	const out: Record<string, unknown> = {};
	for (const r of rows) out[r.key.split(".").pop()!] = r.value;
	return out;
}

function inbox(sid: string): unknown[] {
	const cur = (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as { event_id: number } | null)?.event_id ?? 0;
	return db
		.query("SELECT id, ts, source, kind, payload FROM events WHERE target = ? AND id > ? ORDER BY id")
		.all(sid, cur)
		.map((e: any) => ({ id: e.id, tsAgo: ago(e.ts), source: e.source, kind: e.kind, note: e.payload }));
}

function needsMap(): Record<
	string,
	{ id: number; tsAgo: number; source: string; scope?: string | null; note: string; options?: string[]; advice?: any; adviceError?: string }[]
> {
	const out: Record<string, { id: number; tsAgo: number; source: string; scope?: string | null; note: string; options?: string[]; advice?: any; adviceError?: string }[]> = {};
	// OPEN decisions only, straight off the lifecycle table — no cursor
	// filters (an inbox ack must not hide an unanswered fork) and no board.ack
	// facts. syncDecisions backfills dead-letter alias targets too.
	syncDecisions();
	const rows = db
		.query("SELECT d.event_id AS id, d.target AS sid, e.scope AS scope, e.ts, e.source, e.payload FROM decisions d JOIN events e ON e.id = d.event_id WHERE d.state = 'OPEN' ORDER BY e.id")
		.all() as any[];
	for (const e of rows) {
		let note = "";
		let options: string[] | undefined;
		try {
			const p = e.payload ? JSON.parse(e.payload) : {};
			note = String(p.note ?? p.question ?? e.payload ?? "");
			if (Array.isArray(p.options) && p.options.length) options = p.options.map(String).slice(0, 8);
		} catch {
			note = String(e.payload ?? "");
		}
		// advice from hooks/bin/advise.ts (fact advice.<id>; error variant if
		// the LLM call failed) — the human still decides
		let advice: any;
		let adviceError: string | undefined;
		const a = db.query("SELECT value FROM facts WHERE key = ?").get("advice." + e.id) as { value: string } | null;
		if (a) {
			try {
				advice = JSON.parse(a.value);
			} catch {}
		} else {
			const err = db.query("SELECT value FROM facts WHERE key = ?").get(`advice.${e.id}.error`) as { value: string } | null;
			if (err) adviceError = err.value.slice(0, 200);
		}
		(out[e.sid] ??= []).push({ id: e.id, tsAgo: ago(e.ts), source: e.source, scope: e.scope, note, options, advice, adviceError });
	}
	return out;
}

function payload(): unknown {
	const ss = sessions();
	const labels: Record<string, string> = {};
	for (const s of ss as any[]) labels[s.sid] = s.label;
	for (const c of db.query("SELECT DISTINCT sid FROM claims").all() as { sid: string }[]) {
		if (!labels[c.sid]) labels[c.sid] = label(c.sid, "worker");
	}
	const zombies = (db.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'").all() as { key: string; value: string }[]).map((z) => ({
		item: z.key.slice("zombie.".length),
		// old monitor versions wrote a leading article — strip it at the boundary
		label: z.value.replace(/^an? /, ""),
	}));
	return {
		ts: Date.now(),
		sessions: ss,
		labels,
		projects: board(),
		claims: claims(),
		events: events(),
		needs: needsMap(),
		zombies,
	};
}

function payloadFor(sid: string): unknown {
	const base = payload() as any;
	const s = base.sessions.find((x: any) => x.sid === sid);
	return {
		...base,
		focus: sid,
		focusProject: s?.project ?? null,
		inbox: inbox(sid),
		lane: laneFacts(sid),
	};
}



Bun.serve({
	port: PORT,
	hostname: BIND,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/api/data") {
			const sid = url.searchParams.get("session") ?? "";
			return json(sid ? payloadFor(sid) : payload());
		}
		if (req.method === "POST" && url.pathname === "/api/answer") {
			// the board's single write: relay a human answer into the event bus
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			let to = String(parsed.body?.to ?? "");
			const note = String(parsed.body?.note ?? "").trim().slice(0, 2000);
			const forEvent = Number(parsed.body?.forEvent ?? 0);
			if (!to || !note) return json({ ok: false, error: "missing target or note" }, 400);
			// answers correlate to a fork — reject unknown ids instead of
			// silently answering nothing
			if (forEvent && !db.query("SELECT 1 AS x FROM events WHERE id = ? AND kind LIKE 'NEED%'").get(forEvent))
				return json({ ok: false, error: "unknown event id: " + forEvent }, 404);
			// accept full sids, unique prefixes, or live bus aliases (an identity
			// that has emitted before — e.g. a coordinator's chosen --as name)
			const exact = db.query("SELECT sid FROM sessions WHERE sid = ?").get(to) as { sid: string } | null;
			if (exact) to = exact.sid;
			else {
				const cands = db.query("SELECT sid FROM sessions WHERE sid LIKE ? || '%'").all(to) as { sid: string }[];
				if (cands.length === 1) to = cands[0]!.sid;
				else {
					const alias = !!db.query("SELECT 1 AS x FROM events WHERE source = ? LIMIT 1").get(to);
					if (!alias) return json({ ok: false, error: cands.length > 1 ? "ambiguous sid: " + to : "unknown target session: " + to }, 400);
				}
			}
			const p = Bun.spawnSync(["bun", CLI("coord.ts"), "emit", "ANSWER", "--to", to, "--note", note, "--as", "fleet-board"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = (p.stdout.toString() + " " + p.stderr.toString()).trim();
			if (p.exitCode === 0 && forEvent) {
				// answered — lifecycle state, correlated to the fork's event id
				syncDecisions();
				db.query("UPDATE decisions SET state = 'ANSWERED', answer_note = ?, answer_to = ?, answered_at = ? WHERE event_id = ?").run(
					note,
					to,
					Date.now(),
					forEvent,
				);
			}
			return json({ ok: p.exitCode === 0, output: out.slice(0, 400), to }, p.exitCode === 0 ? 200 : 500);
		}
		if (req.method === "POST" && url.pathname === "/api/ack") {
			// dismiss a question answered out-of-band
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const id = Number(parsed.body?.id ?? 0);
			if (!id) return json({ ok: false, error: "missing event id" }, 400);
			const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
			if (!ev) return json({ ok: false, error: "unknown event id: " + id }, 404);
			if (!ev.kind.startsWith("NEED")) return json({ ok: false, error: "not a decision event: " + id }, 400);
			syncDecisions();
			db.query("UPDATE decisions SET state = 'DISMISSED', closed_at = ? WHERE event_id = ?").run(Date.now(), id);
			return json({ ok: true });
		}
		if (req.method === "POST" && url.pathname === "/api/advise") {
			// fire hooks/bin/advise.ts detached — it writes fact advice.<id> when
			// the LLM answers; the 1s poll picks it up. Human decides after.
			const guard = writeGuard(req, url);
			if (guard) return guard;
			const parsed = await readJson(req);
			if (!parsed.ok) return parsed.resp;
			const id = Number(parsed.body?.id ?? 0);
			if (!id) return json({ ok: false, error: "missing event id" }, 400);
			const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
			if (!ev) return json({ ok: false, error: "unknown event id: " + id }, 404);
			if (!ev.kind.startsWith("NEED")) return json({ ok: false, error: "not a decision event: " + id }, 400);
			const child = Bun.spawn(["bun", CLI("advise.ts"), String(id)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			child.unref();
			return json({ ok: true, started: true });
		}
		if (url.pathname === "/")
			return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		return new Response("not found", { status: 404 });
	},
});
console.log(`fleet board → http://127.0.0.1:${PORT}  (governor.db, 1s poll; writes: /api/answer /api/ack /api/advise)`);

// best-effort Bonjour/mDNS: while the board runs, http://suspenders.local:PORT
// resolves from Bonjour-capable machines on the LAN. The name belongs to the
// dns-sd/avahi child — it vanishes when the board dies (auto-renames to
// suspenders-2.local on conflict). Skip silently when neither tool exists.
const mdnsCmd = process.platform === "darwin" ? ["dns-sd", "-R", "suspenders", "_http._tcp", ".", String(PORT)] : ["avahi-publish", "-s", "suspenders", "_http._tcp", String(PORT)];
try {
	const mdns = Bun.spawn(mdnsCmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const killMdns = () => {
		try {
			mdns.kill();
		} catch {}
	};
	process.on("exit", killMdns);
	// Bun's exit handlers don't fire on bare SIGTERM/SIGINT — without these,
	// orphaned dns-sd children accumulate and fight over the service name
	process.on("SIGTERM", () => {
		killMdns();
		process.exit(0);
	});
	process.on("SIGINT", () => {
		killMdns();
		process.exit(0);
	});
	console.log(`mDNS service "suspenders" registered (Bonjour discovery) — local URL http://127.0.0.1:${PORT}`);
} catch {
	// no mDNS tooling — loopback URL still works
}
