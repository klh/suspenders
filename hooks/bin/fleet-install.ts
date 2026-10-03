#!/usr/bin/env bun
// hooks/bin/fleet-install.ts — detect-and-prompt installer for hook wiring
// across every CLI/agent target we might run as (W298).
//
// Lifted pattern (not just inspiration — the actual decision flow) from
// vercel-labs/skills (npm `skills`, MIT): detect every known CLI home dir
// on this machine (hooks/lib/vendor/skills-agents.ts, vendored verbatim,
// 70+ targets), then:
//   0 detected  -> full interactive multiselect across all supported targets
//   1 detected  -> auto-select it (unless --agent/-y overrides)
//   2+ detected -> interactive multiselect, pre-populated with the detected set
// Only targets with a suspenders hook adapter (hooks/dialects/<cli>/wire.ts)
// or native wiring (claude-code) are selectable; every other vendored target
// still shows up, gated with a "not yet supported" hint — W296's folder
// pattern plus docs/cli-dialect-pattern.md is how a future one gets added.
//
//   bun hooks/bin/fleet-install.ts                 # detect + prompt
//   bun hooks/bin/fleet-install.ts --agent codex,cline
//   bun hooks/bin/fleet-install.ts --agent '*' -y   # wire every supported target, no prompt
//   bun hooks/bin/fleet-install.ts --dry-run        # print the plan, wire nothing
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
	detectFleetTargets,
	listTargets,
	type FleetTarget,
} from "../lib/targets.ts";

const REPO = `${import.meta.dir}/../..`;

interface Flags {
	agent?: string[];
	yes: boolean;
	dryRun: boolean;
}

function parseFlags(argv: string[]): Flags {
	const flags: Flags = { yes: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--yes" || a === "-y") flags.yes = true;
		else if (a === "--dry-run") flags.dryRun = true;
		else if (a === "--agent") {
			const next = argv[++i] ?? "";
			flags.agent = next === "*" ? ["*"] : next.split(",").map((s) => s.trim());
		}
	}
	return flags;
}

function exitCancelled(): never {
	p.cancel("Installation cancelled");
	process.exit(process.stdin.isTTY ? 0 : 1);
}

async function wireTarget(
	target: FleetTarget,
): Promise<{ ok: boolean; note: string }> {
	if (target.native)
		return {
			ok: true,
			note: "native (claude-code reads its own settings.json)",
		};
	if (!target.wireScriptPath) return { ok: false, note: "no wire script" };
	const proc = Bun.spawn(["bun", target.wireScriptPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return {
		ok: code === 0,
		note: (code === 0 ? out : err).trim().split("\n").pop() ?? "",
	};
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	p.intro("suspenders fleet-install — wire hook gates across CLI targets");

	const spinner = p.spinner();
	spinner.start("Detecting installed CLI/agent targets…");
	const all = await detectFleetTargets(REPO);
	const installed = all.filter((t) => t.installed);
	spinner.stop(
		`${all.length} known targets, ${installed.length} detected on this machine`,
	);

	const supportedInstalled = installed.filter((t) => t.supported);
	const unsupportedInstalled = installed.filter((t) => !t.supported);
	if (unsupportedInstalled.length > 0) {
		p.log.info(
			`Detected but not yet wireable: ${unsupportedInstalled.map((t) => pc.dim(t.displayName)).join(", ")} ` +
				`— see docs/cli-dialect-pattern.md to add one`,
		);
	}

	let selected: FleetTarget[];

	if (flags.agent?.includes("*")) {
		selected = supportedInstalled;
		p.log.info(
			`--agent '*': wiring all ${selected.length} supported detected target(s)`,
		);
	} else if (flags.agent) {
		const byType = new Map(all.map((t) => [t.type, t]));
		selected = flags.agent.map((name) => {
			const t = byType.get(name as FleetTarget["type"]);
			if (!t) {
				p.log.error(`Unknown target: ${name}`);
				process.exit(1);
			}
			if (!t.supported) {
				p.log.error(
					`${t.displayName} has no hook adapter yet (gated) — cannot wire`,
				);
				process.exit(1);
			}
			return t;
		});
	} else if (supportedInstalled.length === 0) {
		if (flags.yes) {
			p.log.warn(
				"No supported targets detected; nothing to wire (pass --agent to force one)",
			);
			selected = [];
		} else {
			const supportedAll = listTargets(REPO).filter((t) => t.supported);
			const choice = await p.multiselect({
				message:
					"No installed targets auto-detected. Select targets to wire anyway:",
				options: supportedAll.map((t) => ({
					value: t.type,
					label: t.displayName,
				})),
				required: false,
			});
			if (p.isCancel(choice)) exitCancelled();
			const chosen = new Set(choice as string[]);
			selected = supportedAll.filter((t) => chosen.has(t.type));
		}
	} else if (supportedInstalled.length === 1 || flags.yes) {
		selected = supportedInstalled;
		p.log.info(
			`Wiring: ${selected.map((t) => pc.cyan(t.displayName)).join(", ")}` +
				(flags.yes && supportedInstalled.length > 1
					? " (-y: all detected, no prompt)"
					: ""),
		);
	} else {
		const choice = await p.multiselect({
			message: "Multiple targets detected. Which ones should get hook wiring?",
			options: supportedInstalled.map((t) => ({
				value: t.type,
				label: t.displayName,
			})),
			initialValues: supportedInstalled.map((t) => t.type),
			required: false,
		});
		if (p.isCancel(choice)) exitCancelled();
		const chosen = new Set(choice as string[]);
		selected = supportedInstalled.filter((t) => chosen.has(t.type));
	}

	if (selected.length === 0) {
		p.outro("Nothing selected — no wiring performed");
		return;
	}

	if (flags.dryRun) {
		for (const t of selected) {
			p.log.step(
				`[dry] ${t.displayName}: ${t.native ? "native" : t.wireScriptPath}`,
			);
		}
		p.outro(
			`--dry-run: ${selected.length} target(s) would be wired, nothing touched`,
		);
		return;
	}

	for (const t of selected) {
		const result = await wireTarget(t);
		if (result.ok) p.log.success(`${t.displayName}: ${result.note}`);
		else p.log.error(`${t.displayName}: ${result.note}`);
	}

	p.outro(`Done — ${selected.length} target(s) processed`);
}

await main();
