// hooks/board/onboarding.ts — W153: team onboarding wizard (the enterprise
// 5-step pattern from docs/board-v3-spec.md "First-run setup wizard").
//
//   1. optimize for (cost | balanced | speed)          ─┐ persisted config
//   2. team profile (primary work, mix, team, actor)   ─┘ (suspenders-board.json)
//   3. machine assessment — detected hardware, acceleration, memory
//   4. recommended installation — runner, models, sizes, fixed ports
//   5. verification — advice LLM + hook gates + gateway health probes
//
// Steps 1–2 ride the EXISTING settings preview→apply flow (one write path,
// config-over-code): the wizard form validates then reuses suspPreviewOk's
// diff+confirm page, and apply is /console/settings/apply untouched. Steps
// 3–5 are read-only gathering. Nothing here auto-fires inference or writes
// policy — step 4 is advice; routing edits stay on the settings pages.
import { cpus, freemem, platform, arch, totalmem } from "node:os";
import {
	ConfigError,
	formToBoardSettings,
	readBoardSettings,
} from "../lib/board-config.ts";
import type { BoardSettingsState } from "../lib/board-config.ts";
import type {
	ConsoleMe,
	MachineAssessment,
	OnboardingArgs,
	RecommendedInstall,
} from "../bin/console-html.ts";
import { previewPage } from "../bin/console-html.ts";
import { healthProbe } from "./console-view.ts";
import { setupChecks } from "./data.ts";
import { htmlHdr, suspPreviewOk } from "./settings.ts";

// ─── step 3: machine assessment (platform APIs, zero subprocesses) ────────
export const machineAssessment = (): MachineAssessment => {
	const isAppleSilicon =
		platform() === "darwin" && (cpus()[0]?.model ?? "").includes("Apple");
	return {
		platform: platform(),
		arch: arch(),
		chip: cpus()[0]?.model ?? "unknown",
		cores: cpus().length,
		totalMemGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
		freeMemGb: Math.round((freemem() / 2 ** 30) * 10) / 10,
		accel: isAppleSilicon
			? "Metal (Apple GPU) · unified memory"
			: platform() === "darwin"
				? "CPU only (Intel mac — no discrete GPU detected)"
				: "CPU only",
	};
};

// ─── step 4: recommended installation (pure, derived from step 3) ─────────
// Memory-tiered, honest by construction: the only named model is the one the
// fleet has actually run (coord fact breath.spike.respiro records the MLX
// Qwen3-Coder-30B 4-bit build); other tiers name a class + approximate
// download size, never a fabricated id. Sizes are approximate.
export const recommendInstallation = (
	a: MachineAssessment,
): RecommendedInstall => {
	const runner =
		a.platform === "darwin" && a.arch === "arm64"
			? "MLX runner (Metal) — the belt local-swarm tier"
			: a.platform === "darwin"
				? "llama.cpp (CPU build) — the belt local-swarm tier"
				: a.arch === "arm64" || a.arch === "x64"
					? "llama.cpp / vLLM — the belt local-swarm tier"
					: "none auto-detected — configure a remote belt gateway instead";
	const big = a.totalMemGb >= 48;
	const models: RecommendedModel[] = big
		? [
				{
					name: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
					sizeGb: "~18 GB",
					note: "coding · the fleet's proven 30B-class local build",
				},
				{
					name: "8–14B instruct class, 4-bit (MLX)",
					sizeGb: "~5–9 GB",
					note: "general/fast tier",
				},
			]
		: [
				{
					name: "8–14B instruct class, 4-bit",
					sizeGb: "~5–9 GB",
					note:
						a.totalMemGb >= 16
							? "fits 16–48 GB machines"
							: "fits <16 GB machines",
				},
				{
					name: "3–4B instruct class, 4-bit",
					sizeGb: "~2–3 GB",
					note: "fallback tier when the 8–14B is tight",
				},
			];
	return {
		runner,
		models,
		ports: [
			{ name: "belt gateway", port: 4100 },
			{ name: "buckle", port: 4101 },
			{ name: "fleet board", port: 7799 },
		],
		note: "recommendation only — apply routing edits on the settings pages (config-over-code); nothing here writes policy",
	};
};

// ─── step 5: verification (existing probes, no new ones) ──────────────────
// setupChecks() reads the LIVE settings.json + launchd — advisory only,
// each check carries its own fix; asserted to its row shape once here.
export const gatherOnboardingView = async (): Promise<OnboardingArgs> => {
	const machine = machineAssessment();
	const [rawChecks, gateway] = await Promise.all([
		setupChecks(),
		Promise.all([
			healthProbe("belt gateway", 4100),
			healthProbe("buckle", 4101),
		]),
	]);
	const checks = (
		rawChecks as {
			id?: unknown;
			label?: unknown;
			ok?: unknown;
			detail?: unknown;
			fix?: unknown;
		}[]
	).map((c) => ({
		id: String(c.id ?? ""),
		label: String(c.label ?? ""),
		ok: c.ok === true,
		detail: String(c.detail ?? ""),
		fix: c.fix === null || c.fix === undefined ? null : String(c.fix),
	}));
	return {
		set: readBoardSettings(),
		machine,
		recommend: recommendInstallation(machine),
		checks,
		gateway,
	};
};

// ─── the wizard's preview: validate steps 1–2, then the shared diff page ──
// Same contract as suspPreview: honest error page, nothing written on
// invalid; the OK path is suspPreviewOk verbatim so confirm/apply is the
// EXISTING /console/settings/apply (mtime guard, atomic write) untouched.
export const onboardingPreview = (
	f: URLSearchParams,
	me: ConsoleMe,
): Response => {
	const bad = (msg: string): Response => {
		const ea = {
			feature: "suspenders" as const,
			diff: [] as string[],
			valuesJson: "",
			mtimeMs: "0",
			target: readBoardSettings().path,
			error: msg,
		};
		return new Response(previewPage(ea, me), { headers: htmlHdr() });
	};
	try {
		const p = formToBoardSettings({
			optimize_for: f.get("optimize_for") ?? "",
			primary_work: f.get("primary_work") ?? "",
			work_mix: f.get("work_mix") ?? "",
			team: f.get("team") ?? "",
			department: f.get("department") ?? "",
			default_actor: f.get("default_actor") ?? "",
		});
		// the one cross-field rule the wizard owns: "mix" needs its weights
		if (p.primary_work === "mix" && !p.work_mix)
			throw new ConfigError(
				'work_mix: required when primary work is "mix" (e.g. coding:60,architecture:40)',
			);
		return suspPreviewOk(p, me);
	} catch (e) {
		return bad(e instanceof Error ? e.message : String(e));
	}
};

// JSON shape used by tests/board tooling to check wizard state without HTML
export const onboardingState = (): {
	ok: true;
	onboarded: boolean;
	settings: BoardSettingsState["settings"];
} => {
	const s = readBoardSettings().settings;
	return {
		ok: true,
		onboarded: Boolean(s.optimize_for || s.primary_work || s.team),
		settings: s,
	};
};
