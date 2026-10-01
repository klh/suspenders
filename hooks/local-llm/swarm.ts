#!/usr/bin/env bun
// swarm.ts — unified LLM specialist swarm manager.
// Bun/TS only. Model/ports come from registry.ts (single source of truth).
//
// Usage:
//   bun swarm.ts start       — start all specialists + router, then exit
//   bun swarm.ts serve       — resident supervisor: revive dead children
//   bun swarm.ts stop        — stop everything
//   bun swarm.ts status      — show running specialists
//   bun swarm.ts download    — download all specialist models
//   bun swarm.ts restart     — stop + start
//
// LOCAL_LLM_HOME / LOCAL_LLM_LOG_DIR env override the kit/home locations so
// installs and tests can point the tools at scratch dirs.

import { spawn, execSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
} from "node:fs";
import { SPECIALISTS, DOWNLOAD_MODELS, residentSet } from "./registry.ts";
import { spawnArgs, mlxLogPath } from "./spawner.ts";

const HOME = process.env.HOME;
// download-only — server argv lives in spawner.ts (spawnArgs), shared with the
// router's on-demand path so boot and demand can't drift.
const MLX_PYTHON = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
const LLM_HOME = process.env.LOCAL_LLM_HOME ?? `${HOME}/.claude/local-llm`;
const LOG_DIR = process.env.LOCAL_LLM_LOG_DIR ?? `${HOME}/.claude-insights`;
const ROUTER = `${LLM_HOME}/router-shim.ts`;

// ─── helpers ───
const isUp = async (port: number): Promise<boolean> => {
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

const getModel = async (port: number): Promise<string> => {
	try {
		const r = await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		const j = await r.json();
		return j.data?.[0]?.id ?? "?";
	} catch {
		return "down";
	}
};

const killPort = (port: number): void => {
	try {
		execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, {
			stdio: "pipe",
		});
	} catch {}
};

// mlx_lm /v1/models lists the whole HF cache (first id ≠ served model) —
// verify the actually-loaded model from the process args instead.
const psModel = (port: number): string | null => {
	const pid = Bun.spawnSync(["lsof", "-ti", `:${port}`])
		.stdout.toString()
		.trim()
		.split("\n")[0];
	if (!pid) return null;
	const cmd = Bun.spawnSync([
		"ps",
		"-o",
		"command",
		"-p",
		pid,
	]).stdout.toString();
	return cmd.match(/--model\s+(\S+)/)?.[1] ?? null;
};

// ─── lifecycle ───
async function cmdStart(): Promise<void> {
	console.log("🚀 Starting specialist swarm…");

	// Fire-and-forget: spawn all MLX servers + router, then exit immediately.
	// Specialists load in the background; check readiness with `swarm.ts status`.
	// BELT_TIER=minimal scopes this to the ≤4GB residents (extract + rerank).
	const resident = residentSet();

	for (const s of resident) {
		if (await isUp(s.port)) {
			console.log(`  ✓ :${s.port} ${s.label} (already running)`);
			continue;
		}
		console.log(`  → :${s.port} ${s.label} (loading in background)`);
		const log = mlxLogPath(s.port);
		const shellCmd = `nohup ${spawnArgs(s).join(" ")} >> ${log} 2>&1 &`;
		Bun.spawn(["/bin/sh", "-c", shellCmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	}

	// Router
	const routerUp = await isUp(4000);
	if (!routerUp) {
		console.log("  → :4000 router-swarm (starting)");
		const shellCmd = `nohup bun ${ROUTER} >> ${LOG_DIR}/mlx-router.log 2>&1 &`;
		Bun.spawn(["/bin/sh", "-c", shellCmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} else {
		console.log("  ✓ :4000 router (already running)");
	}

	console.log("\n  All specialists spawning in background.");
	console.log("  Check readiness: bun ~/.claude/local-llm/swarm.ts status");
	process.exit(0);
}

async function cmdStop(): Promise<void> {
	console.log("🛑 Stopping swarm…");
	killPort(4000);
	for (const s of SPECIALISTS) killPort(s.port);
	console.log("  All stopped.");
}

async function cmdStatus(): Promise<void> {
	console.log("📊 Swarm status:\n");
	let total_ram = 0;
	for (const s of SPECIALISTS) {
		const up = await isUp(s.port);
		const model = up
			? s.engine === "rapid"
				? await getModel(s.port)
				: (psModel(s.port) ?? "down")
			: "down";
		const tier = s.tier === "resident" ? "" : " (on demand)";
		if (up) total_ram += s.ram_gb;
		console.log(
			`  ${up ? "✓" : "✗"} :${s.port}  ${s.label.padEnd(15)} ${model.replace("mlx-community/", "")}${tier}`,
		);
	}
	const routerUp = await isUp(4000);
	console.log(`  ${routerUp ? "✓" : "✗"} :4000  router (Anthropic API)`);
	console.log(`\n  RAM in use: ~${total_ram.toFixed(1)}GB / 128GB`);
}

async function cmdDownload(): Promise<void> {
	console.log(
		`📥 Downloading ${DOWNLOAD_MODELS.length} models (~61GB total)…\n`,
	);
	const procs = DOWNLOAD_MODELS.map(({ model, revision }) => {
		const name = model.split("/")[1];
		console.log(`  → ${name} @ ${revision.slice(0, 7)}…`);
		return spawn(
			MLX_PYTHON,
			[
				"-c",
				`from huggingface_hub import snapshot_download; snapshot_download("${model}", revision="${revision}")`,
			],
			{ stdio: "pipe" },
		);
	});
	await Promise.all(
		procs.map((p) => new Promise((resolve) => p.on("exit", resolve))),
	);
	console.log("\n✓ All downloads complete");
}

// ─── serve: resident supervisor (lesson.launchd-swarm-revival) ───
// `start` spawns and exits. Under launchd KeepAlive that was the flaw: the
// script exits after spawning, so a dead child had no watcher, and KeepAlive
// restarts of the exited script just re-ran the spawn loop. `serve` stays
// alive as the supervisor — it revives dead residents (specialists + router)
// with per-port backoff, keeps a size-bounded log, and KeepAlive now means
// what it should: restart only the supervisor, which on relaunch adopts live
// children (isUp) and revives dead ones.
const SERVE_INTERVAL_MS = 15_000;
const SERVE_BACKOFF_BASE_MS = 2_000;
const SERVE_BACKOFF_MAX_MS = 5 * 60_000;
const SERVE_LOG_MAX_BYTES = 512 * 1024;

interface ServeChild {
	proc?: Bun.Subprocess;
	revivals: number;
	lastReviveAt: number;
}

const serveChildren = new Map<number, ServeChild>();

function serveLog(msg: string): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		const log = `${LOG_DIR}/swarm-serve.log`;
		try {
			if (statSync(log).size > SERVE_LOG_MAX_BYTES) renameSync(log, `${log}.1`);
		} catch {}
		appendFileSync(log, `${new Date().toISOString()} ${msg}\n`);
	} catch {}
}

type ServeTarget = { port: number; argv: string[]; label: string };

const serveTargets = (): ServeTarget[] => [
	...residentSet().map((s) => ({
		port: s.port,
		argv: spawnArgs(s),
		label: s.label,
	})),
	{ port: 4000, argv: [process.execPath, ROUTER], label: "router" },
];

async function serveOnce(): Promise<void> {
	for (const t of serveTargets()) {
		const up = await isUp(t.port);
		if (up) {
			const stable = serveChildren.get(t.port);
			if (stable) stable.revivals = 0; // stable span: reset crash backoff
			continue;
		}
		await reviveOne(t);
	}
}

async function reviveOne(t: ServeTarget): Promise<void> {
	const rec = serveChildren.get(t.port) ?? { revivals: 0, lastReviveAt: 0 };
	const prev = rec.proc;
	// spawned but not yet listening — loading, not dead: never double-spawn
	if (prev && prev.exitCode === null && prev.signalCode === null) return;
	const backoff = Math.min(
		SERVE_BACKOFF_MAX_MS,
		SERVE_BACKOFF_BASE_MS * 2 ** Math.max(0, rec.revivals - 1),
	);
	if (rec.revivals > 0 && Date.now() - rec.lastReviveAt < backoff) return;
	killPort(t.port);
	const fd = openSync(mlxLogPath(t.port), "a");
	const proc = Bun.spawn(t.argv, { stdin: "ignore", stdout: fd, stderr: fd });
	closeSync(fd);
	serveChildren.set(t.port, {
		proc,
		revivals: rec.revivals + 1,
		lastReviveAt: Date.now(),
	});
	serveLog(
		`♨ revived :${t.port} ${t.label} (revive #${rec.revivals + 1}, pid ${proc.pid})`,
	);
}

async function cmdServe(): Promise<void> {
	const ports = serveTargets()
		.map((t) => `:${t.port}`)
		.join(" ");
	console.log(`👀 supervising ${ports} — log: ${LOG_DIR}/swarm-serve.log`);
	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, () => {
			serveLog(`serve exits on ${sig} — children keep running`);
			process.exit(0);
		});
	}
	for (;;) {
		await serveOnce();
		await Bun.sleep(SERVE_INTERVAL_MS);
	}
}

// ─── dispatch ───
const cmd = process.argv[2] ?? "status";
switch (cmd) {
	case "start":
		await cmdStart();
		break;
	case "serve":
		await cmdServe();
		break;
	case "stop":
		await cmdStop();
		break;
	case "status":
		await cmdStatus();
		break;
	case "restart":
		await cmdStop();
		await new Promise((r) => setTimeout(r, 2000));
		await cmdStart();
		break;
	case "download":
		await cmdDownload();
		break;
	default:
		console.log(
			`Usage: bun swarm.ts {start|serve|stop|status|restart|download}\n`,
		);
		console.log(`Specialists (from registry.ts):`);
		for (const s of SPECIALISTS) {
			console.log(`  :${s.port}  ${s.label}  (${s.ram_gb}GB, ${s.tier})`);
		}
		console.log(`  :4000  router (Anthropic API entrypoint)`);
}
