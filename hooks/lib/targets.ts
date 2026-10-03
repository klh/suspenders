// hooks/lib/targets.ts — fleet-wide install targets (W298).
//
// Detection is entirely the vendored vercel-labs/skills registry
// (./vendor/skills-agents.ts, 70+ CLI/agent homes, copied verbatim and
// unmodified — see that file's header). This module only adds OUR layer on
// top: which of those detected targets have a suspenders hook-gate wire
// script (hooks/dialects/<cli>/wire.ts), and which are merely detected but
// not yet wired — gated, not removed, so the full breadth stays visible for
// future adapters (docs/cli-dialect-pattern.md covers adding one).
import { join } from "node:path";
import {
	agents,
	detectInstalledAgents,
	getAgentConfig,
	type AgentConfig,
	type AgentType,
} from "./vendor/skills-agents.ts";

export type { AgentType, AgentConfig };

/** Targets with a real hooks/dialects/<cli>/wire.ts (W296 + codex's W73/W66 original). */
const WIRE_SCRIPT: Partial<Record<AgentType, string>> = {
	codex: "codex",
	"github-copilot": "copilot",
	grok: "grok",
	cline: "cline",
};

/** claude-code wires natively via its own settings.json hooks — no wire.ts. */
const NATIVE: ReadonlySet<AgentType> = new Set(["claude-code"]);

export interface FleetTarget {
	type: AgentType;
	displayName: string;
	/** True once a real CLI home dir is found on this machine. */
	installed: boolean;
	/** True if suspenders has a hook adapter for this target (wired or native). */
	supported: boolean;
	/** True if wiring is Claude Code's own built-in hooks, not a wire.ts run. */
	native: boolean;
	/** Absolute path to hooks/dialects/<cli>/wire.ts, when supported and not native. */
	wireScriptPath?: string;
}

const dialectsRoot = (repoRoot: string): string =>
	join(repoRoot, "hooks", "dialects");

/** Build the full target list: every vendored agent, gated by our support. */
export function listTargets(repoRoot: string): FleetTarget[] {
	return (Object.keys(agents) as AgentType[])
		.filter((type) => type !== "universal") // not a real install target
		.map((type) => {
			const cfg = getAgentConfig(type);
			const dialect = WIRE_SCRIPT[type];
			const native = NATIVE.has(type);
			return {
				type,
				displayName: cfg.displayName,
				installed: false, // filled in by detectFleetTargets (async)
				supported: native || dialect !== undefined,
				native,
				wireScriptPath: dialect
					? join(dialectsRoot(repoRoot), dialect, "wire.ts")
					: undefined,
			};
		});
}

/** Detect which of the vendored 70+ targets are actually installed here. */
export async function detectFleetTargets(
	repoRoot: string,
): Promise<FleetTarget[]> {
	const installedTypes = new Set(await detectInstalledAgents());
	return listTargets(repoRoot).map((t) => ({
		...t,
		installed: installedTypes.has(t.type),
	}));
}
