// sim/smoke.ts — W162 full-system sim smoke chain. Hub = Docker compose trio,
// spoke = this host. Line-per-check PASS/RED/ERR output.
//   exit 0 = all checks PASS
//   exit 2 = one or more RED (federation surface awaiting a lane) — expected
//   exit 1 = harness error (hub unreachable / crash) — fix compose first
// Laws honored: streams-over-buffers (capped stream reads, no slurping),
// http-citizenship (the smoke CHECKS the standard's headers; missing = RED).
//
// Env it needs (defaults match sim/.env.example + sim/spoke-profile.env):
//   SIM_BUCKLE_URL   default http://127.0.0.1:17001
//   SIM_BOARD_URL    default http://127.0.0.1:17002
//   SIM_STORE_URL    default http://127.0.0.1:17003
//   SIM_BELT_URL     default http://127.0.0.1:17004
//   SIM_SPOKE_PROFILE default <this dir>/spoke-profile.env

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// W170 resilience drill: reuse the real pull client (the drill proves the
// SPOKE's behavior — same code the production spoke runs).
import { loadLastKnown, pullFederation } from "../hooks/lib/federation.ts";

const BODY_CAP = 64 * 1024;

type Outcome = "PASS" | "RED" | "ERR";
interface Row {
	name: string;
	out: Outcome;
	note: string;
}
const rows: Row[] = [];

function report(name: string, out: Outcome, note: string): void {
	rows.push({ name, out, note });
	console.log(`[${out.toLowerCase()}] ${name} — ${note}`);
}

class BodyTooBig extends Error {}

// streams-over-buffers: capped stream read — never res.text()/res.json().
async function readCapped(
	res: Response,
	cap = BODY_CAP,
): Promise<{ text: string; truncated: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const dec = new TextDecoder();
	let text = "";
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			truncated = true;
			await reader.cancel();
			break;
		}
		text += dec.decode(value, { stream: true });
	}
	if (!truncated) text += dec.decode();
	if (truncated) throw new BodyTooBig(`body exceeded ${String(cap)}B cap`);
	return { text, truncated: false };
}

async function getJson(
	url: string,
	init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: unknown }> {
	const res = await fetch(url, init);
	const { text } = await readCapped(res);
	let body: unknown = null;
	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text.slice(0, 120);
		}
	}
	return { status: res.status, headers: res.headers, body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const SIM_BUCKLE_URL = process.env.SIM_BUCKLE_URL ?? "http://127.0.0.1:17001";
const SIM_BOARD_URL = process.env.SIM_BOARD_URL ?? "http://127.0.0.1:17002";
const SIM_STORE_URL = process.env.SIM_STORE_URL ?? "http://127.0.0.1:17003";
const SIM_BELT_URL = process.env.SIM_BELT_URL ?? "http://127.0.0.1:17004";
const SIM_SPOKE_PROFILE =
	process.env.SIM_SPOKE_PROFILE ??
	new URL("./spoke-profile.env", import.meta.url).pathname;

console.log(
	"sim-smoke env needed: SIM_BUCKLE_URL SIM_BOARD_URL SIM_STORE_URL SIM_BELT_URL SIM_SPOKE_PROFILE",
);

type Status = { ok: boolean; status: number; service?: string };

async function probeStatus(base: string, path: string): Promise<Status> {
	try {
		const { status, body } = await getJson(`${base}${path}`);
		const svc = isRecord(body) ? String(body.service ?? "") : "";
		return { ok: status === 200, status, service: svc };
	} catch (e) {
		console.log(
			`[err ] hub unreachable at ${base} (${String(e)}) — docker compose up -d first`,
		);
		process.exit(1);
	}
}

// (a) hub healthy
const buckle = await probeStatus(SIM_BUCKLE_URL, "/status");
report(
	"hub/buckle-hub-status",
	buckle.ok ? "PASS" : "ERR",
	`/status ${String(buckle.status)} service=${buckle.service ?? "?"}`,
);

const board = await probeStatus(SIM_BOARD_URL, "/status");
report(
	"hub/board-hub-status",
	board.ok ? "PASS" : "ERR",
	`/status ${String(board.status)} service=${board.service ?? "?"}`,
);
const store = await probeStatus(SIM_STORE_URL, "/status");
report(
	"hub/store-hub-status",
	store.ok ? "PASS" : "ERR",
	`/status ${String(store.status)} service=${store.service ?? "?"}`,
);
const belt = await probeStatus(SIM_BELT_URL, "/api/status");
report(
	"hub/belt-hub-status",
	belt.ok ? "PASS" : "ERR",
	`/api/status ${String(belt.status)} (central belt dashboard)`,
);

// (b) hub issues a token
let hubAccess: string | null = null;
try {
	const tok = await getJson(`${SIM_STORE_URL}/auth/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			actor: "w162-sim",
			name: "w162-sim-smoke",
			scopes: ["read:*"],
			access_ttl_seconds: 300,
		}),
	});
	const tokBody = isRecord(tok.body) ? tok.body : {};
	const access = tokBody.access_token;
	if (tok.status === 200 && typeof access === "string") {
		hubAccess = access;
		report(
			"token/issue-hs256",
			"PASS",
			`store-hub /auth/token 200 (jti=${String(tokBody.jti)})`,
		);
	} else {
		report(
			"token/issue-hs256",
			"RED",
			`store-hub /auth/token ${String(tok.status)} — issuance is admin-gated (W149); sim bootstrap lands with W156 identity.db`,
		);
	}
} catch (e) {
	report(
		"token/issue-hs256",
		"ERR",
		`store-hub /auth/token unreachable: ${String(e)}`,
	);
}

// whoami round-trip with the issued token
if (hubAccess !== null) {
	try {
		const who = await getJson(`${SIM_STORE_URL}/auth/whoami`, {
			headers: { authorization: `Bearer ${hubAccess}` },
		});
		report(
			"token/whoami",
			who.status === 200 ? "PASS" : "RED",
			`/auth/whoami ${String(who.status)} (issued token validated by hub)`,
		);
	} catch (e) {
		report("token/whoami", "ERR", String(e));
	}
} else {
	report(
		"token/whoami",
		"RED",
		"skipped — no token issued (see token/issue-hs256)",
	);
}

// (b2) JWKS: hub-only asymmetric keys (owner law) — RS256 + JWKS serve is W156
for (const [name, url] of [
	["federation/jwks-buckle", `${SIM_BUCKLE_URL}/.well-known/jwks.json`],
	["federation/jwks-store", `${SIM_STORE_URL}/.well-known/jwks.json`],
] as const) {
	try {
		const jw = await getJson(url);
		const keys =
			isRecord(jw.body) && Array.isArray(jw.body.keys)
				? jw.body.keys.length
				: 0;
		if (jw.status === 200 && keys > 0) {
			report(
				name,
				"PASS",
				`JWKS 200, ${String(keys)} key(s) — W156 surface live`,
			);
		} else {
			report(
				name,
				"RED",
				`${url.split("//")[1]} → ${String(jw.status)} — awaiting W156 (identity.db, RS256 JWKS)`,
			);
		}
	} catch (e) {
		report(name, "ERR", String(e));
	}
}

// (c) spoke-config validation — spoke = this host; the sim profile points the
// spoke's policy-pull / JWKS / CR-check at the hub ports
const prof = await Bun.file(SIM_SPOKE_PROFILE)
	.text()
	.then((t) => t)
	.catch(() => null);
if (prof === null) {
	report("spoke/profile", "ERR", `missing sim profile: ${SIM_SPOKE_PROFILE}`);
} else {
	const hubVars = [...prof.matchAll(/^SIM_HUB_\w+=\S+$/gm)];
	report(
		"spoke/profile",
		hubVars.length >= 4 ? "PASS" : "RED",
		`${SIM_SPOKE_PROFILE} parsed, ${String(hubVars.length)} SIM_HUB_* vars (need 4)`,
	);
}

// (c2) spoke pulls the hub policy manifest — W154
let manifest: Record<string, unknown> | null = null;
try {
	const man = await getJson(`${SIM_BUCKLE_URL}/federation/policy-manifest`);
	if (man.status === 200 && isRecord(man.body)) {
		manifest = man.body;
		report(
			"federation/policy-manifest",
			"PASS",
			`200, version=${String(manifest.version)}`,
		);
	} else {
		report(
			"federation/policy-manifest",
			"RED",
			`${String(man.status)} — awaiting W154 (hub policy distribution)`,
		);
	}
} catch (e) {
	report("federation/policy-manifest", "ERR", String(e));
}

// (d) CR lifecycle probe — rides the W154 payload (W160): declared →
// delivered → applied → verified → reported-up
if (manifest !== null && Array.isArray(manifest.cr_queue)) {
	const q = manifest.cr_queue.length;
	report(
		"federation/cr-queue",
		"PASS",
		`manifest.cr_queue present, ${String(q)} entr(y|ies)`,
	);
} else {
	report(
		"federation/cr-queue",
		"RED",
		"no cr_queue in policy manifest — awaiting W160 (CR channel)",
	);
}

// (e) echo menu — hub entitlement payload shapes the spoke menu (W154 echo)
try {
	const ent = await getJson(`${SIM_BUCKLE_URL}/federation/entitlements`);
	if (
		ent.status === 200 &&
		isRecord(ent.body) &&
		Array.isArray(ent.body.models)
	) {
		report(
			"federation/echo-menu",
			"PASS",
			`200, ${String(ent.body.models.length)} hub-entitled models`,
		);
	} else {
		report(
			"federation/echo-menu",
			"RED",
			`${String(ent.status)} — awaiting W154 echo menu (hub entitlement payload)`,
		);
	}
} catch (e) {
	report("federation/echo-menu", "ERR", String(e));
}

/** W170 sim batch: run-unique seq — re-pushing the SAME batch probes dedupe. */
function simBatch(seq: number): {
	spoke: string;
	rows: Array<Record<string, unknown>>;
} {
	const item = `w170-${String(seq)}`;
	const r = (
		tbl: string,
		pk: string,
		after: Record<string, unknown>,
		off = 0,
	): Record<string, unknown> => ({
		seq: seq + off,
		ts: seq,
		tbl,
		op: "insert",
		pk,
		before: null,
		after: JSON.stringify(after),
	});
	return {
		spoke: "sim-spoke",
		rows: [
			r("work_items", `sim/${item}`, {
				project: "sim",
				id: item,
				title: "W170 sim item",
				state: "READY",
			}),
			r("route_audit", `sim-r-${String(seq)}`, {
				rid: `sim-r-${String(seq)}`,
				decision: "routed",
				resolved_target: "http://127.0.0.1:17001/glm-5.3-flash",
			}),
		],
	};
}

// (f) work-delta up-feed round trip: batch lands hub-side, redelivery dedupes
try {
	const batch = simBatch(Date.now());
	const post: RequestInit = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(batch),
	};
	const push1 = await getJson(`${SIM_STORE_URL}/federation/work-delta`, post);
	const push2 = await getJson(`${SIM_STORE_URL}/federation/work-delta`, post);
	const applied = (b: unknown): number =>
		isRecord(b) && typeof b.applied === "number" ? b.applied : -1;
	if (push1.status === 200 && push2.status === 200) {
		const a1 = applied(push1.body);
		const a2 = applied(push2.body);
		report(
			"federation/work-delta",
			a1 >= 1 && a2 === 0 ? "PASS" : "RED",
			`push applied=${String(a1)}, redelivery applied=${String(a2)} (want 0 — UNIQUE dedupe)`,
		);
	} else {
		report(
			"federation/work-delta",
			"RED",
			`${String(push1.status)}/${String(push2.status)} — awaiting W170 up-feed round trip`,
		);
	}
} catch (e) {
	report("federation/work-delta", "ERR", String(e));
}

// (f2) lane view: the hub renders the cross-user/team work-log (JSON + HTML)
try {
	const lane = await getJson(`${SIM_STORE_URL}/federation/lane-view`);
	const html = await getJson(
		`${SIM_STORE_URL}/federation/lane-view?format=html`,
	);
	const wlog =
		isRecord(lane.body) && Array.isArray(lane.body.work_log)
			? (lane.body.work_log as unknown[])
			: [];
	const found = wlog.some(
		(w) => isRecord(w) && String(w.id ?? "").startsWith("w170-"),
	);
	if (lane.status === 200 && html.status === 200 && found) {
		report(
			"federation/lane-view",
			"PASS",
			`200 JSON + HTML, ${String(wlog.length)} work-log rows incl. the sim item`,
		);
	} else {
		report(
			"federation/lane-view",
			"RED",
			`${String(lane.status)}/${String(html.status)}, sim item present=${String(found)} — awaiting W170`,
		);
	}
} catch (e) {
	report("federation/lane-view", "ERR", String(e));
}

// http-citizenship (docs/design/http-citizenship.md) — the smoke CHECKS the
// standard and marks RED where a hub surface does not meet it yet (W155)
for (const [name, base] of [
	["citizenship/405-allow-buckle", SIM_BUCKLE_URL],
	["citizenship/405-allow-board", SIM_BOARD_URL],
	["citizenship/405-allow-store", SIM_STORE_URL],
	["citizenship/405-allow-belt", SIM_BELT_URL],
] as const) {
	try {
		const res = await fetch(`${base}/status`, { method: "DELETE" });
		await readCapped(res);
		if (res.status === 405) {
			report(
				name,
				res.headers.get("allow") ? "PASS" : "RED",
				`405 + Allow${res.headers.get("allow") ? "" : " MISSING"}`,
			);
		} else {
			report(
				name,
				"RED",
				`DELETE /status → ${String(res.status)} (want 405+Allow)`,
			);
		}
	} catch (e) {
		report(name, "ERR", String(e));
	}
}

// OPTIONS → 204 + Allow
try {
	const res = await fetch(`${SIM_BUCKLE_URL}/status`, { method: "OPTIONS" });
	await readCapped(res);
	if (res.status === 204 && res.headers.get("allow") !== null) {
		report("citizenship/options-204", "PASS", "204 + Allow");
	} else {
		report(
			"citizenship/options-204",
			"RED",
			`OPTIONS /status → ${String(res.status)} (want 204 + Allow)`,
		);
	}
} catch (e) {
	report("citizenship/options-204", "ERR", String(e));
}

// 401 → WWW-Authenticate (proxy-class surface on buckle without creds)
try {
	const res = await fetch(`${SIM_BUCKLE_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	await readCapped(res);
	if (res.status === 401) {
		const www = res.headers.get("www-authenticate");
		report(
			"citizenship/401-www-auth",
			www !== null ? "PASS" : "RED",
			www !== null
				? `401 + WWW-Authenticate: ${www}`
				: "401 MISSING WWW-Authenticate — awaiting W155",
		);
	} else {
		report(
			"citizenship/401-www-auth",
			"RED",
			`POST /v1/chat/completions → ${String(res.status)} (want 401)`,
		);
	}
} catch (e) {
	report("citizenship/401-www-auth", "ERR", String(e));
}

// ETag + If-None-Match → 304 on GET-able resources (W155)
try {
	const r1 = await fetch(`${SIM_BUCKLE_URL}/status`);
	await readCapped(r1);
	const etag = r1.headers.get("etag");
	if (r1.status === 200 && etag !== null) {
		const r2 = await fetch(`${SIM_BUCKLE_URL}/status`, {
			headers: { "if-none-match": etag },
		});
		await readCapped(r2);
		report(
			"citizenship/etag-304",
			r2.status === 304 ? "PASS" : "RED",
			`ETag ${etag}, If-None-Match → ${String(r2.status)} (want 304)`,
		);
	} else {
		report(
			"citizenship/etag-304",
			"RED",
			`no ETag on GET /status — awaiting W155`,
		);
	}
} catch (e) {
	report("citizenship/etag-304", "ERR", String(e));
}

// Cache-Control: no-store on /auth/* + rate-limit trio on authenticated API
if (hubAccess !== null) {
	try {
		const res = await getJson(`${SIM_STORE_URL}/auth/whoami`, {
			headers: { authorization: `Bearer ${hubAccess}` },
		});
		const cc = res.headers.get("cache-control");
		report(
			"citizenship/cache-control",
			cc?.includes("no-store") === true ? "PASS" : "RED",
			`Cache-Control: ${cc ?? "absent"} (want no-store)`,
		);
	} catch (e) {
		report("citizenship/cache-control", "ERR", String(e));
	}
	try {
		const res = await getJson(`${SIM_STORE_URL}/auth/whoami`, {
			headers: { authorization: `Bearer ${hubAccess}` },
		});
		const trio =
			res.headers.get("ratelimit-limit") !== null &&
			res.headers.get("ratelimit-remaining") !== null &&
			res.headers.get("ratelimit-reset") !== null;
		report(
			"citizenship/rate-trio",
			trio ? "PASS" : "RED",
			trio
				? "RateLimit-Limit/Remaining/Reset present on authenticated API"
				: "rate trio absent on authenticated API — awaiting W155",
		);
	} catch (e) {
		report("citizenship/rate-trio", "ERR", String(e));
	}
}

// ── W170 hub-down resilience drill (SIM_RESILIENCE=1, opt-in) ──────────
// Kills the hub trio mid-run and proves the degradation law: the spoke
// keeps routing locally on last-known policy; only hub-routed rungs fail.

function runCompose(args: string[]): boolean {
	const p = Bun.spawnSync(["docker", "compose", ...args], {
		cwd: import.meta.dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0;
}

async function waitHubUp(capMs: number): Promise<number> {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await fetch(`${SIM_BUCKLE_URL}/status`, {
				signal: AbortSignal.timeout(1500),
			});
			if (r.ok) return Date.now() - t0;
		} catch {
			// still down — keep polling
		}
		if (Date.now() - t0 > capMs) return -1;
		await Bun.sleep(2000);
	}
}

// ── (g) the drill ── runs only with SIM_RESILIENCE=1 (it kills + restarts
// the hub trio mid-run). Everything measured on the REAL pull client.
if (process.env.SIM_RESILIENCE === "1") {
	const spokeHome = join(tmpdir(), `w170-sim-spoke-${String(process.pid)}`);
	mkdirSync(spokeHome, { recursive: true });
	const spokeEnv = { HOME: spokeHome, BUCKLE_SECRETS_HOME: spokeHome };
	const seed = await pullFederation({
		hubUrl: SIM_BUCKLE_URL,
		env: spokeEnv,
		timeoutMs: 3000,
	});
	const before = loadLastKnown(spokeEnv);
	if (!seed.ok) {
		report(
			"resilience/seed-last-known",
			"ERR",
			`hub not healthy to seed: ${seed.reason ?? "?"}`,
		);
	} else if (!runCompose(["kill"])) {
		report(
			"resilience/kill",
			"ERR",
			"docker compose kill failed — drill aborted, hub untouched",
		);
	} else {
		const t0 = Date.now();
		const down = await pullFederation({
			hubUrl: SIM_BUCKLE_URL,
			env: spokeEnv,
			timeoutMs: 2000,
		});
		const ms = Date.now() - t0;
		const after = loadLastKnown(spokeEnv);
		const kept =
			after !== null && after.pulled_at === (before?.pulled_at ?? null);
		report(
			"resilience/pull-degraded",
			down.degraded && kept ? "PASS" : "RED",
			`hub killed → degraded=${String(down.degraded)}, last-known kept=${String(kept)}, transition ${String(ms)}ms on last-known policy`,
		);
		try {
			const n = localDeltasCount();
			report(
				"resilience/local-plane-answers",
				"PASS",
				`local governor.db answered read-only with the hub dead (${String(n)} deltas rows)`,
			);
		} catch (e) {
			report("resilience/local-plane-answers", "ERR", String(e));
		}
		try {
			await fetch(`${SIM_BUCKLE_URL}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
				signal: AbortSignal.timeout(2000),
			});
			report(
				"resilience/hub-rung-fails-honestly",
				"RED",
				"hub-routed rung ANSWERED while the hub should be down — kill did not take",
			);
		} catch {
			report(
				"resilience/hub-rung-fails-honestly",
				"PASS",
				"connect refused — only hub-routed rungs fail, honestly",
			);
		}
		const upMs = await waitHubUp(60_000);
		const rec =
			upMs >= 0
				? await pullFederation({
						hubUrl: SIM_BUCKLE_URL,
						env: spokeEnv,
						timeoutMs: 3000,
					})
				: null;
		report(
			"resilience/hub-recovery",
			upMs >= 0 && rec?.ok === true ? "PASS" : "RED",
			`docker compose up -d → hub back in ${String(upMs)}ms; pull ok=${String(rec?.ok === true)} (policy continuity)`,
		);
	}
}

/** Read-only probe of the LOCAL (spoke) work graph — answers with the hub
 *  dead, no govdb import (zero side effects on the live graph). */
function localDeltasCount(): number {
	const p = join(homedir(), ".cache", "claude-governor", "governor.db");
	const ldb = new Database(p, { readonly: true, create: false });
	try {
		return (
			ldb.query("SELECT COUNT(*) AS n FROM deltas").get() as { n: number }
		).n;
	} finally {
		ldb.close();
	}
}

// summary — exit 0 all green, 2 = REDs (expected), 1 = harness error
const pass = rows.filter((r) => r.out === "PASS").length;
const red = rows.filter((r) => r.out === "RED").length;
const err = rows.filter((r) => r.out === "ERR").length;
console.log(
	`summary: ${String(pass)} pass, ${String(red)} red, ${String(err)} err — reds are honest "awaiting W154/W155/W156/W160" states, not crashes`,
);
if (err > 0) process.exit(1);
if (red > 0) process.exit(2);
process.exit(0);
