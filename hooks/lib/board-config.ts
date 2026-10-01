// hooks/lib/board-config.ts — W147 console: the board's config surface.
// Read/validate/preview/apply for the two real config files the console
// manages, config-over-code, never a code edit:
//
//   routing-policy.yaml  — the shared belt+buckle routing policy. Chain
//     (belt bin/router-policy.ts pattern): BELT_POLICY/BUCKLE_POLICY env →
//     ~/.claude/local-llm/routing-policy.yaml (runtime) → committed default.
//     The console DISPLAYS the resolved file and WRITES the runtime copy
//     (or the env-named file when the operator pinned one) — never the
//     committed default. Apply is atomic (tmp + rename). Activation is NOT
//     instantaneous: belt emits litellm.yaml via gateway-config.ts and
//     kicks the launchd job BETWEEN fan-outs (a reload drops in-flight
//     streams); buckle loads the policy at boot.
//
//   suspenders-board.json — board knobs (~/.claude/local-llm/): a settings
//     file read by the live board process (status_refresh_s feeds servicemon
//     at boot; harvest_ttl_s is maybeHarvest's default TTL; default_actor
//     feeds the console avatar's demo switch preselect).
//
// Every write path here is an allowlisted constant (or the env-pinned policy
// path the operator already owns). Invalid config = rejected with the parse
// error; nothing partial ever lands (validate-then-atomic-write).
import { YAML } from "bun";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { scrub } from "./servicemon.ts";

// ─── errors ───────────────────────────────────────────────────────────────
export class ConfigError extends Error {}

// ─── routing-policy.yaml (belt + buckle share one file) ───────────────────
export interface PolicyGateway {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
}

interface PolicyDoc {
	version?: unknown;
	gateway?: unknown;
}

// Native-router semantics (belt bin/router-policy.ts parity). Defaults live
// in the loader chain, so absent keys keep belt/buckle's own defaults.
export const POLICY_DEFAULTS = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
} as const;

export interface PolicyGatewayParsed {
	num_retries: number;
	allowed_fails: number;
	cooldown_time: number;
	fallbacks: Record<string, string[]>;
}

const isIntGte0 = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0;

// Owner directive (belt bin/routing-policy.yaml + buckle): NEVER flashx —
// same upstream family saturates together, and flashx is too expensive.
const validateLadder = (fallbacks: Record<string, string[]>): string | null => {
	for (const [model, tiers] of Object.entries(fallbacks)) {
		if (
			!Array.isArray(tiers) ||
			!tiers.length ||
			!tiers.every((t) => typeof t === "string" && t.length > 0)
		)
			return `fallbacks.${model}: must be a non-empty list of tier names`;
		if (tiers.includes("flashx"))
			return `fallbacks.${model}: flashx is refused (owner directive: same upstream family saturates together, flashx is too expensive)`;
	}
	return null;
};

// Shape + version checks shared by parse (read) and patch (validate-after).
function policyChecked(text: string): PolicyGateway {
	let doc: PolicyDoc;
	try {
		doc = YAML.parse(text) as PolicyDoc;
	} catch (e) {
		throw new ConfigError(
			`YAML parse failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc))
		throw new ConfigError("policy must be a YAML mapping (gateway: ...)");
	if (doc.version !== undefined && doc.version !== 1)
		throw new ConfigError(
			`unsupported policy version: ${String(doc.version)} — version: 1 only`,
		);
	const g = (doc.gateway ?? {}) as PolicyGateway;
	if (g === null || typeof g !== "object" || Array.isArray(g))
		throw new ConfigError("gateway: must be a mapping");
	return g;
}

// Parse + validate. Throws ConfigError carrying the underlying parse message
// so the settings page can show WHY a config is invalid, verbatim.
export function parsePolicy(text: string): PolicyGatewayParsed {
	const g = policyChecked(text);
	for (const k of ["num_retries", "allowed_fails", "cooldown_time"] as const) {
		const v = g[k];
		if (v !== undefined && !isIntGte0(v))
			throw new ConfigError(`gateway.${k}: must be an integer >= 0`);
	}
	const fb = (g.fallbacks ?? {}) as Record<string, string[]>;
	if (typeof fb !== "object" || fb === null || Array.isArray(fb))
		throw new ConfigError("gateway.fallbacks: must be a mapping");
	const ladderErr = validateLadder(fb);
	if (ladderErr) throw new ConfigError(ladderErr);
	return {
		num_retries: g.num_retries ?? POLICY_DEFAULTS.num_retries,
		allowed_fails: g.allowed_fails ?? POLICY_DEFAULTS.allowed_fails,
		cooldown_time: g.cooldown_time ?? POLICY_DEFAULTS.cooldown_time,
		fallbacks: fb,
	};
}

export interface ResolvedPolicy {
	path: string;
	source: "env" | "runtime" | "default";
	text: string;
	mtimeMs: number;
}

// The same chain belt's bin/router-policy.ts walks (env → runtime copy →
// committed default), so the console shows exactly what belt/buckle load.
export function resolvePolicy(opts?: {
	explicitPath?: string;
	beltRepo?: string;
	buckleRepo?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
}): ResolvedPolicy | null {
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? env.HOME ?? "";
	const beltRepo = opts?.beltRepo ?? env.BELT_REPO ?? "";
	const buckleRepo = opts?.buckleRepo ?? env.BUCKLE_REPO ?? "";
	const cands: { path: string; source: ResolvedPolicy["source"] }[] = [
		{
			path: opts?.explicitPath || env.BELT_POLICY || env.BUCKLE_POLICY || "",
			source: "env",
		},
		{
			path: `${home}/.claude/local-llm/routing-policy.yaml`,
			source: "runtime",
		},
		{ path: `${beltRepo}/bin/routing-policy.yaml`, source: "default" },
		{ path: `${buckleRepo}/routing-policy.yaml`, source: "default" },
	];
	for (const c of cands) {
		if (!c.path || !existsSync(c.path)) continue;
		try {
			const st = statSync(c.path);
			return {
				path: c.path,
				source: c.source,
				text: readFileSync(c.path, "utf8"),
				mtimeMs: st.mtimeMs,
			};
		} catch {}
	}
	return null;
}

// The write target: the env-pinned file when the operator set one, else the
// runtime copy (which beats the committed default). NEVER the committed
// default itself — config-over-code, the repo default stays pristine.
export function policyWritePath(opts?: {
	explicitPath?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
}): string {
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? env.HOME ?? "";
	// an EMPTY env var counts as unset — ?? alone would pass "" through and
	// resolve the write target to ""
	const envPath = env.BELT_POLICY || env.BUCKLE_POLICY || undefined;
	return (
		opts?.explicitPath ??
		envPath ??
		`${home}/.claude/local-llm/routing-policy.yaml`
	);
}

// Atomic write: temp file in the SAME directory (rename is same-fs atomic)
// then rename over the target. Belt/buckle never see a half-written policy.
export function atomicWrite(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

// ─── comment-preserving line patch ────────────────────────────────────────
interface Edit {
	lines: string[];
	changed: boolean;
}

// Scalar knob: replace in place (keeps indent + comments), or insert under
// `gateway:`; a gateway-less doc gets the block appended at EOF.
const setScalar = (lines: string[], key: string, val: number): Edit => {
	const prefix = `${key}:`;
	const i = lines.findLastIndex((l) => l.trimStart().startsWith(prefix));
	if (i >= 0) {
		const t = lines[i].trimStart();
		const indent = lines[i].slice(0, lines[i].length - t.length);
		const next = lines.slice();
		next[i] = `${indent}${prefix} ${val}`;
		return { lines: next, changed: true };
	}
	const gi = lines.findIndex((l) => l.trimEnd() === "gateway:");
	if (gi < 0) {
		const next = lines.slice();
		next.push("gateway:", `  ${prefix} ${val}`);
		return { lines: next, changed: true };
	}
	const next = lines.slice();
	next.splice(gi + 1, 0, `  ${prefix} ${val}`);
	return { lines: next, changed: true };
};

// Ladder tier list: rewrite the `model: [a, b, c]` flow line in place (keeps
// indent + any trailing comment placement stays with the line it was on).
const setLadder = (lines: string[], model: string, tiers: string[]): Edit => {
	const prefix = `${model}:`;
	const rendered = `${prefix} [${tiers.join(", ")}]`;
	const i = lines.findIndex((l) => l.trimStart().startsWith(prefix));
	if (i >= 0) {
		const t = lines[i].trimStart();
		const indent = lines[i].slice(0, lines[i].length - t.length);
		const next = lines.slice();
		next[i] = `${indent}${rendered}`;
		return { lines: next, changed: true };
	}
	const fi = lines.findIndex((l) => l.trimEnd() === "fallbacks:");
	if (fi < 0) return { lines, changed: false };
	const next = lines.slice();
	next.splice(fi + 1, 0, `  ${rendered}`);
	return { lines: next, changed: true };
};

export interface PolicyPatch {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	// replaces the model's tier list — order IS priority (first = primary)
	ladder?: { model: string; tiers: string[] };
}

// Line-patch the policy text (comments preserved), then PROVE the result
// parses + validates — belt/buckle's loaders must accept exactly this.
export function patchPolicyText(text: string, patch: PolicyPatch): string {
	let out = text;
	if (patch.ladder?.model) {
		const e = setLadder(
			out.split("\n"),
			patch.ladder.model,
			patch.ladder.tiers,
		);
		if (!e.changed) throw new ConfigError("no fallbacks: section to edit");
		out = e.lines.join("\n");
	}
	for (const [k, v] of Object.entries(patch)) {
		if (k === "ladder" || v === undefined) continue;
		const e = setScalar(out.split("\n"), k, v as number);
		out = e.lines.join("\n");
	}
	parsePolicy(out); // throws ConfigError when the patched doc is invalid
	return out;
}

// Small line diff for the preview page: common prefix/suffix trimmed, the
// middle shown as del/add blocks (a full LCS diff is overkill here).
export function diffLines(a: string, b: string): string[] {
	const al = a.split("\n");
	const bl = b.split("\n");
	let p = 0;
	while (p < al.length && p < bl.length && al[p] === bl[p]) p++;
	let s = 0;
	while (
		s < al.length - p &&
		s < bl.length - p &&
		al[al.length - 1 - s] === bl[bl.length - 1 - s]
	)
		s++;
	const out: string[] = [];
	for (let i = p; i < al.length - s; i++) out.push(`- ${al[i]}`);
	for (let i = p; i < bl.length - s; i++) out.push(`+ ${bl[i]}`);
	return out;
}

// ─── suspenders-board.json (the board's own knobs) ────────────────────────
export interface BoardSettings {
	status_refresh_s?: number;
	harvest_ttl_s?: number;
	default_actor?: string;
	default_executors?: string[];
}

export const boardSettingsPath = (home = process.env.HOME ?? ""): string =>
	`${home}/.claude/local-llm/suspenders-board.json`;

const numKnob = (
	o: Record<string, unknown>,
	k: string,
	min: number,
): number | undefined => {
	const v = o[k];
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v < min)
		throw new ConfigError(`${k}: must be a number >= ${min}`);
	return v;
};

// Unknown keys are ignored on read but DROPPED on write — the settings file
// stays exactly the three knobs the console manages, nothing opaque.
export function validateBoardSettings(v: unknown): BoardSettings {
	if (v === null || typeof v !== "object" || Array.isArray(v))
		throw new ConfigError("board settings must be a JSON object");
	const o = v as Record<string, unknown>;
	const out: BoardSettings = {};
	const sr = numKnob(o, "status_refresh_s", 0);
	if (sr !== undefined) out.status_refresh_s = sr;
	const ht = numKnob(o, "harvest_ttl_s", 1);
	if (ht !== undefined) out.harvest_ttl_s = ht;
	const da = o.default_actor;
	if (da !== undefined && da !== null && da !== "") {
		if (typeof da !== "string" || da.length > 200)
			throw new ConfigError("default_actor: must be a string (max 200 chars)");
		out.default_actor = da;
	}
	const de = o.default_executors;
	if (de !== undefined && de !== null) {
		if (
			!Array.isArray(de) ||
			de.length > 20 ||
			de.some((s) => typeof s !== "string" || s.length > 200 || !s)
		)
			throw new ConfigError(
				"default_executors: must be an array of 1-20 non-empty strings (max 200 chars each)",
			);
		out.default_executors = de as string[];
	}
	return out;
}

export interface BoardSettingsState {
	path: string;
	exists: boolean;
	mtimeMs: number;
	settings: BoardSettings;
	error: string | null;
}

// Read the board knobs file — missing file = defaults, invalid JSON =
// surfaced (never silently ignored), unknown keys tolerated.
export function readBoardSettings(
	path = boardSettingsPath(),
): BoardSettingsState {
	if (!existsSync(path))
		return { path, exists: false, mtimeMs: 0, settings: {}, error: null };
	try {
		const st = statSync(path);
		const text = readFileSync(path, "utf8");
		return {
			path: scrub(path),
			exists: true,
			mtimeMs: st.mtimeMs,
			settings: validateBoardSettings(JSON.parse(text)),
			error: null,
		};
	} catch (e) {
		return {
			path: scrub(path),
			exists: true,
			mtimeMs: 0,
			settings: {},
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// Form semantics: empty string = unset (removes the knob). Numbers coerce
// from the form strings; anything non-numeric throws the honest error.
export function formToBoardSettings(f: Record<string, string>): BoardSettings {
	return validateBoardSettings({
		status_refresh_s:
			f.status_refresh_s === "" ? undefined : Number(f.status_refresh_s),
		harvest_ttl_s: f.harvest_ttl_s === "" ? undefined : Number(f.harvest_ttl_s),
		default_actor: f.default_actor,
	});
}

// Merge-apply the settings file: read → merge → validate → mtime guard →
// atomic write. expectedMtime (from the preview step) rejects concurrent
// edits — the operator confirms a diff of what they SAW.
export function applyBoardSettings(
	path: string,
	patch: BoardSettings,
	expectedMtimeMs?: number,
): { applied: BoardSettings } {
	if (existsSync(path)) {
		const st = statSync(path);
		if (
			expectedMtimeMs !== undefined &&
			Math.abs(st.mtimeMs - expectedMtimeMs) > 1
		)
			throw new ConfigError(
				"config changed since the preview — review the fresh diff and confirm again",
			);
	}
	const curText = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	const cur = validateBoardSettings(JSON.parse(curText));
	const merged: BoardSettings = { ...cur, ...patch };
	for (const k of Object.keys(merged) as (keyof BoardSettings)[])
		if (merged[k] === undefined) delete merged[k];
	validateBoardSettings(merged);
	atomicWrite(path, `${JSON.stringify(merged, null, "\t")}\n`);
	return { applied: merged };
}
