// deploy/healthcheck/heartbeat.ts — the SERVER side of the health law
// (owner 2026-10-05): every service regenerates a static status.json every
// ~1s from its OWN event loop — a wedged server stops writing. Content is
// prometheus-endpoint flavored: timestamp, pid, uptime, memory, event-loop
// lag (the write-interval drift IS the lag measurement). The health sidecar
// judges liveness by file age first; only an active probe breaks a tie.
// Atomic write (tmp + rename) so readers never see partial JSON.

import { renameSync, writeFileSync } from "node:fs";

export interface HeartbeatRecord {
	ts: number;
	pid: number;
	uptimeSec: number;
	mem: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
	loopLagMs: number;
}

export function startHeartbeat(path: string, everyMs = 1000): () => void {
	let expected = Date.now() + everyMs;
	const write = (): void => {
		try {
			const mu = process.memoryUsage();
			const rec: HeartbeatRecord = {
				ts: Date.now(),
				pid: process.pid,
				uptimeSec: Math.round(process.uptime()),
				mem: {
					rssMb: Math.round(mu.rss / 1048576),
					heapUsedMb: Math.round(mu.heapUsed / 1048576),
					heapTotalMb: Math.round(mu.heapTotal / 1048576),
				},
				loopLagMs: Math.max(0, Date.now() - expected),
			};
			expected = Date.now() + everyMs;
			writeFileSync(`${path}.tmp`, JSON.stringify(rec));
			renameSync(`${path}.tmp`, path);
		} catch {
			// a failed heartbeat write must never kill the server
		}
	};
	write();
	const timer = setInterval(write, everyMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
