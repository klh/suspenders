// spawner.ts — on-demand specialist lifecycle, shared by swarm.ts (boot) and
// router-shim.ts (demand-driven spawn of tier:"ondemand" specialists like
// :8906). Args derive from registry.ts — the single source of truth — so a
// registry edit changes both boot and on-demand spawn behavior.
//
// ensureUp(s) returns immediately when the port already answers; otherwise it
// spawns the specialist (argument-array Bun.spawn, no shell), polls readiness
// and surfaces the log tail on early exit. Concurrent callers share one
// in-flight load per port (single-flight map).

import { openSync, readFileSync } from "node:fs";
import type { Specialist } from "./registry.ts";

const HOME = process.env.HOME;
const MLX_PYTHON = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
// rapid-mlx 0.15.0 via uv tool env — absolute path so launchd never needs PATH
// (brew formula still on 0.14.3; benched 2026-09-23: 115.9 vs 107.4 tok/s
// under load, flat vs quiet-machine — adopted for flags/aliases, not speed).
const RAPID = `${HOME}/.local/share/uv/tools/rapid-mlx/bin/rapid-mlx`;
const LOG_DIR = process.env.LOCAL_LLM_LOG_DIR ?? `${HOME}/.claude-insights`;

export const mlxLogPath = (port: number): string =>
	`${LOG_DIR}/mlx-${port}.log`;

// Full argv for one specialist server (binary first) — consumed by both the
// direct Bun.spawn here and swarm.ts's nohup boot path.
export function spawnArgs(s: Specialist): string[] {
	if (s.engine === "rapid") {
		return [
			RAPID,
			"serve",
			s.model,
			"--host",
			"127.0.0.1",
			"--port",
			String(s.port),
			...(s.flags ?? []),
		];
	}
	return [
		MLX_PYTHON,
		"-m",
		"mlx_lm.server",
		"--port",
		String(s.port),
		"--model",
		s.model,
		"--prompt-cache-size",
		"10",
		"--prompt-cache-bytes",
		"4GB",
		...(s.flags ?? []),
	];
}

export const isUp = async (port: number): Promise<boolean> => {
	try {
		// Any HTTP response = listening. The router (:4000) answers 404 on
		// /v1/models by design — it only implements Anthropic /v1/messages.
		await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		return true;
	} catch {
		return false;
	}
};

export interface EnsureResult {
	up: boolean;
	cold: boolean; // true when this call did the spawning
	waitedMs: number;
	error?: string; // log tail when the spawned process died loading
}

const COLD_TIMEOUT_MS = 90_000; // 5.6GB 9B loads in seconds; 90s is generous

const pending = new Map<number, Promise<EnsureResult>>();

async function spawnAndWait(s: Specialist): Promise<EnsureResult> {
	const t0 = Date.now();
	const log = mlxLogPath(s.port);
	const fd = openSync(log, "a");
	const child = Bun.spawn(spawnArgs(s), {
		stdin: "ignore",
		stdout: fd,
		stderr: fd,
	});
	while (Date.now() - t0 < COLD_TIMEOUT_MS) {
		if (child.exitCode !== null || child.signalCode !== null) {
			let tail = "";
			try {
				tail = readFileSync(log, "utf8").slice(-400);
			} catch {}
			return {
				up: false,
				cold: true,
				waitedMs: Date.now() - t0,
				error: `spawn exited (code=${child.exitCode ?? child.signalCode}): ${tail}`,
			};
		}
		if (await isUp(s.port)) {
			return { up: true, cold: true, waitedMs: Date.now() - t0 };
		}
		await Bun.sleep(500);
	}
	return {
		up: false,
		cold: true,
		waitedMs: Date.now() - t0,
		error: `no readiness within ${COLD_TIMEOUT_MS / 1000}s`,
	};
}

// Ready-or-reason. Single-flight per port: concurrent cold requests share the
// load wait instead of double-spawning.
export function ensureUp(s: Specialist): Promise<EnsureResult> {
	const inflight = pending.get(s.port);
	if (inflight) return inflight;
	const job = (async (): Promise<EnsureResult> => {
		if (await isUp(s.port)) return { up: true, cold: false, waitedMs: 0 };
		return spawnAndWait(s);
	})();
	pending.set(s.port, job);
	job.finally(() => pending.delete(s.port)).catch(() => {});
	return job;
}
