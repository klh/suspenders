// deploy/healthcheck/probe.ts — the health sidecar (owner law 2026-10-05):
// a healthcheck is only valid when it does NOT run in the served process.
// Liveness = HEARTBEAT AGE: the server regenerates status.json every ~1s
// from its own event loop (heartbeat.ts), and this sidecar serves the
// verdict — compose health hits the SIDECAR, never the server.
//   fresh heartbeat         -> 200 {state:"healthy"}
//   stale/missing heartbeat -> active probe of the server:
//     probe fails           -> 502 {state:"unhealthy"} (server down)
//     probe ok, few misses  -> 200 {state:"degraded"} for a grace window,
//                              then 502 (regenerations KEEP not happening)
//   cli: bun probe.ts --target URL — one-shot, exit 0/1

import { readFileSync } from "node:fs";

interface ProbeArgs {
	target: string;
	heartbeat: string;
	listen?: number;
	every: number;
	maxAge: number;
	grace: number;
	timeout: number;
}

function parseArgs(argv: string[]): ProbeArgs {
	const a: ProbeArgs = {
		target: "",
		heartbeat: "",
		every: 5000,
		maxAge: 5000,
		grace: 2,
		timeout: 2000,
	};
	for (let i = 0; i < argv.length; i++) {
		const f = argv[i];
		const v = argv[i + 1];
		if (v === undefined) continue;
		if (f === "--target") a.target = v;
		else if (f === "--heartbeat") a.heartbeat = v;
		else if (f === "--listen") a.listen = Number(v);
		else if (f === "--every") a.every = Number(v);
		else if (f === "--max-age") a.maxAge = Number(v);
		else if (f === "--grace") a.grace = Number(v);
		else if (f === "--timeout") a.timeout = Number(v);
		i++;
	}
	return a;
}

interface Verdict {
	state: "healthy" | "degraded" | "unhealthy";
	ok: boolean;
	hbAgeMs: number | null;
	probe: { status: number; ms: number } | null;
	checkedAt: string;
}

/** Age of the served process's last status.json heartbeat (null: absent). */
function hbAge(path: string): number | null {
	try {
		const hb = JSON.parse(readFileSync(path, "utf8")) as { ts: number };
		return Date.now() - hb.ts;
	} catch {
		return null;
	}
}

async function activeProbe(
	target: string,
	timeoutMs: number,
): Promise<{ status: number; ms: number }> {
	const t0 = Date.now();
	try {
		const r = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
		return { status: r.status, ms: Date.now() - t0 };
	} catch {
		return { status: 0, ms: Date.now() - t0 };
	}
}

function mk(
	state: Verdict["state"],
	hbAgeMs: number | null,
	probe: Verdict["probe"],
): Verdict {
	return {
		state,
		ok: state !== "unhealthy",
		hbAgeMs,
		probe,
		checkedAt: new Date().toISOString(),
	};
}

/** The owner's state machine: heartbeat age decides; the active probe only
 *  breaks ties and catches a hard-down server. */
async function judge(a: ProbeArgs, streak: number): Promise<Verdict> {
	const age = a.heartbeat.length > 0 ? hbAge(a.heartbeat) : null;
	if (age !== null && age <= a.maxAge) return mk("healthy", age, null);
	const probe = await activeProbe(a.target, a.timeout);
	if (probe.status === 0) return mk("unhealthy", age, probe);
	if (streak < a.grace) return mk("degraded", age, probe);
	return mk("unhealthy", age, probe); // regenerations KEEP not happening
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.target.length === 0) {
		console.log(
			"usage: probe.ts --target URL [--heartbeat file] [--listen port] [--every ms] [--max-age ms] [--grace n]",
		);
		process.exit(2);
	}
	// CLI mode: one shot, exit code carries the verdict.
	if (args.listen === undefined) {
		const v = await judge(args, 0);
		console.log(JSON.stringify(v));
		process.exit(v.ok ? 0 : 1);
	}
	// Server mode: judge on an interval; the streak tracks consecutive
	// degraded verdicts so "regenerations KEEP not happening" tips unhealthy.
	let streak = 0;
	let last: Verdict = await judge(args, streak);
	if (last.state === "degraded") streak++;
	const tick = async (): Promise<void> => {
		const v = await judge(args, streak);
		streak = v.state === "degraded" ? streak + 1 : 0;
		last = v;
	};
	void tick();
	const timer = setInterval(() => {
		void tick();
	}, args.every);
	timer.unref?.();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: args.listen,
		fetch: () =>
			Response.json(
				{ target: args.target, ...last },
				{ status: last.ok ? 200 : 502 },
			),
	});
	console.log(
		`healthcheck: sidecar on http://127.0.0.1:${server.port}/status -> ${args.target}` +
			` (heartbeat: ${args.heartbeat.length > 0 ? args.heartbeat : "none"})`,
	);
}

await main();
