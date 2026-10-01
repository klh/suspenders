// fleet-board.ts — live control-plane dashboard. Read-only over governor.db
// except the decision endpoints (/api/decisions /api/answer /api/ack
// /api/advise) and
// the board-owned decisions table below. Serves a page that polls every
// second (WAL allows concurrent readers).
// Start from anywhere:  bun ~/.claude/bin/fleet-board.ts [--port 7799]
// then open http://127.0.0.1:<port> — dropdown lists every known session;
// focusing a session shows its project's TODO / IN-FLIGHT / DONE board,
// its claims, inbox, lane state, and the event tail.

import { db, PORT, BIND } from "../board/context.ts";
import { json } from "../board/helpers.ts";
import { projectList } from "../board/lanes.ts";
import { board, claims, inbox } from "../board/data.ts";
import { orchestrate } from "../board/orch.ts";
import { tokenUsage } from "../lib/govdb.ts";
import { scrub, servicemon } from "../lib/servicemon.ts";
import { readBoardSettings } from "../lib/board-config.ts";
import { hostname } from "node:os";
import { handleData } from "../board/routes-data.ts";
import { handleUsage } from "../board/routes-usage.ts";
import { handleDrawer } from "../board/routes-drawer.ts";
import { handleActions } from "../board/routes-actions.ts";
import { handleOrch } from "../board/routes-orch.ts";
import { handleConsole } from "../board/routes-console.ts";
import { handleMeta } from "../board/routes-meta.ts";
// W157: seedDemo() self-invokes at demo.ts module load — the monolith
// executed it inline before Bun.serve; the side-effect import keeps that
// timing (nothing else imports the demo module)
import "../board/demo.ts";

let tokAggAt = 0;
function feedTokens(): void {
	if (tokAggAt && sm.refreshS > 0 && Date.now() - tokAggAt < sm.refreshS * 1000)
		return;
	tokAggAt = Date.now();
	for (const p of projectList()) {
		const agg = { in: 0, out: 0, cacheR: 0, cacheC: 0 };
		for (const t of tokenUsage(db, p, Date.now()).values()) {
			if (!t) continue;
			agg.in += t.in;
			agg.out += t.out;
			agg.cacheR += t.cacheR;
			agg.cacheC += t.cacheC;
		}
		const proj = scrub(p);
		sm.tokensSet("in", agg.in, { project: proj });
		sm.tokensSet("out", agg.out, { project: proj });
		sm.tokensSet("cache_read", agg.cacheR, { project: proj });
		sm.tokensSet("cache_create", agg.cacheC, { project: scrub(p) });
	}
}

const sm = servicemon({
	service: "fleet-board",
	port: PORT,
	onMetrics: feedTokens,
	// W147: suspenders-board.json beats the env at board start (the file IS
	// the config-over-code surface the settings page writes)
	refreshS: readBoardSettings().settings.status_refresh_s,
});

const base = {
	port: PORT,
	hostname: BIND,
	async fetch(req) {
		const url = new URL(req.url);
		// W157: the original 30-route if-chain, order preserved, split into
		// per-area handlers — first match wins exactly as before
		for (const h of [
			handleData,
			handleUsage,
			handleDrawer,
			handleActions,
			handleOrch,
			handleConsole,
			handleMeta,
		]) {
			const r = await h(req, url);
			if (r) return r;
		}
		return new Response("not found", { status: 404 });
	},
};

// W125 — the observability wrap: /status + /metrics ride the SAME fetch via
// lib/servicemon.ts; the route body above stays untouched.
Bun.serve(sm.wrapped(base));
console.log(
	`fleet board → http://127.0.0.1:${PORT}  (governor.db, 1s poll; writes: /api/answer /api/ack /api/advise /api/comment /api/start /api/ship /api/orchestrate)`,
);

// best-effort Bonjour/mDNS: while the board runs, http://suspenders.local:PORT
// resolves from Bonjour-capable machines on the LAN. The name belongs to the
// dns-sd/avahi child — it vanishes when the board dies (auto-renames to
// suspenders-2.local on conflict). Skip silently when neither tool exists.
// SUSPENDERS_MDNS=0 opts out — on macOS the dns-sd registration claims the
// service host name and poisons .local resolution for the very name it advertises
// demo boards never announce themselves as suspenders.local unless forced —
// a screenshot board must not steal the name the real board owns
const isDemo = process.argv.includes("--demo");
if (
	process.env.SUSPENDERS_MDNS === "1" ||
	(process.env.SUSPENDERS_MDNS !== "0" && !isDemo)
) {
	const mdnsCmd =
		process.platform === "darwin"
			? ["dns-sd", "-R", "suspenders", "_http._tcp", ".", String(PORT)]
			: ["avahi-publish", "-s", "suspenders", "_http._tcp", String(PORT)];
	try {
		const mdns = Bun.spawn(mdnsCmd, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
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
		console.log(
			`mDNS service "suspenders" registered (Bonjour discovery) — local URL http://127.0.0.1:${PORT}`,
		);
	} catch {
		// no mDNS tooling — loopback URL still works
	}
}
