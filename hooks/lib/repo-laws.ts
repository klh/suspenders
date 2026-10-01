// hooks/lib/repo-laws.ts — W164: repo-scoped routing laws + the BYO-LLM
// user plane. ONE grammar module — the .llm dotfile and the console editors
// both import this parser (two editors, one store, one grammar).
//
// Grammar (owner FINAL, docs/design/buckle/routing-laws-2026-10-01.md):
//   prefer=<expr>   soft law — full fits rank first, degrade by policy
//   must=<expr>     hard law — no healthy full fit = honest error, never a
//                   silent substitute
//   tier=<name>     complexity floor — simple|medium|complex|very_complex
//   fallback=<csv>  ordered ladder (order = priority; flashx refused)
// One law per line, '#' comments, blank lines skipped. Invalid lines fail
// LOUDLY with the line number — every error collected, never a silent guess.
// Discovery is git-like: nearest .llm upward from the working dir, stopping
// at the repo root (a parent repo's laws never leak into a nested repo).
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "./board-config.ts";

// ─── grammar ───────────────────────────────────────────────────────────────
export type LawVerb = "prefer" | "must";

export interface LawLine {
	line: number;
	verb: LawVerb;
	expr: string; // validated W96 expression (local|cloud|host:|model:|tags)
}

export interface DotfileError {
	line: number;
	why: string;
}

export interface DotfileLaws {
	laws: LawLine[];
	tier: string | null; // simple|medium|complex|very_complex
	fallback: string[] | null; // ordered ladder
}

export type DotfileParse =
	| { ok: true; doc: DotfileLaws }
	| { ok: false; errors: DotfileError[] };

const LAW_KEYS = new Set(["prefer", "must", "tier", "fallback"]);
const TOKEN_MAX = 64;
const TOKENS_MAX = 12;
const TIERS = new Set(["simple", "medium", "complex", "very_complex"]);
// Owner directive (belt bin/routing-policy.yaml): NEVER flashx.
const FLASHX = /\bflashx\b/i;

/** Validate the expression side of a prefer=/must= line with the W96 token
 *  rules (belt bin/route-policy.ts parity): whitespace tokens, 1–12 tokens,
 *  each ≤64 chars, at most one location, at most one model:. Tags are
 *  regexp sources — a non-compiling tag degrades to a literal substring
 *  test downstream, so it is never a hard grammar error here. */
export function parseLawExpr(
	expr: string,
): { ok: true } | { ok: false; why: string } {
	const tokens = expr.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length || tokens.length > TOKENS_MAX)
		return {
			ok: false,
			why: `law expression: 1–${String(TOKENS_MAX)} whitespace-separated tokens, e.g. 'local distill reasoning'`,
		};
	let location = false;
	let model = false;
	for (const tok of tokens) {
		if (tok.length > TOKEN_MAX)
			return {
				ok: false,
				why: `law token over ${String(TOKEN_MAX)} chars: '${tok.slice(0, 24)}…'`,
			};
		if (tok === "local" || tok === "cloud") {
			if (location) return { ok: false, why: `duplicate location ('${tok}')` };
			location = true;
		} else if (tok.startsWith("host:")) {
			if (location) return { ok: false, why: `duplicate location ('${tok}')` };
			if (tok === "host:")
				return { ok: false, why: "host: needs a server name" };
			location = true;
		} else if (tok.startsWith("model:")) {
			if (model) return { ok: false, why: "duplicate model:" };
			if (tok === "model:")
				return { ok: false, why: "model: needs an id or glob" };
			model = true;
		}
	}
	return { ok: true };
}

/** Parse a whole .llm dotfile (or the mirrored laws array) — ALL invalid
 *  lines collected with their line numbers (loud, never a guess). */
export function parseLlmDotfile(text: string): DotfileParse {
	const errors: DotfileError[] = [];
	const laws: LawLine[] = [];
	let tier: string | null = null;
	let fallback: string[] | null = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const n = i + 1;
		const t = lines[i].trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		const key = eq < 0 ? "" : t.slice(0, eq).trim();
		const val = eq < 0 ? "" : t.slice(eq + 1).trim();
		if (!LAW_KEYS.has(key)) {
			errors.push({
				line: n,
				why: `unknown law key '${(eq < 0 ? t : key).slice(0, 24)}' — expected prefer=, must=, tier=, fallback=`,
			});
			continue;
		}
		if (key === "prefer" || key === "must") {
			const v = parseLawExpr(val);
			if (!v.ok) {
				errors.push({ line: n, why: `${key}=: ${v.why}` });
				continue;
			}
			laws.push({ line: n, verb: key, expr: val });
		} else if (key === "tier") {
			const tv = val.toLowerCase();
			if (!TIERS.has(tv)) {
				errors.push({
					line: n,
					why: `tier=: must be one of simple|medium|complex|very_complex, got '${val.slice(0, 24)}'`,
				});
				continue;
			}
			if (tier !== null) {
				errors.push({ line: n, why: "tier= set more than once" });
				continue;
			}
			tier = tv;
		} else if (key === "fallback") {
			if (fallback !== null) {
				errors.push({ line: n, why: "fallback= set more than once" });
				continue;
			}
			const tiers = val
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (!tiers.length) {
				errors.push({
					line: n,
					why: "fallback=: needs a comma-separated tier list",
				});
				continue;
			}
			if (tiers.some((x) => FLASHX.test(x))) {
				errors.push({
					line: n,
					why: "fallback=: flashx is refused (owner directive: same upstream family saturates together, flashx is too expensive)",
				});
				continue;
			}
			fallback = tiers;
		}
	}
	return finishDotfileDoc(errors, laws, tier, fallback);
}

/** Shared tail: emit the doc when clean, else the error list. */
function finishDotfileDoc(
	errors: DotfileError[],
	laws: LawLine[],
	tier: string | null,
	fallback: string[] | null,
): DotfileParse {
	if (errors.length) return { ok: false, errors };
	return { ok: true, doc: { laws, tier, fallback } };
}

/** Laws → dotfile text (the serializer half of the round-trip; the console
 *  apply path runs the result back through the parser before writing). */
export function serializeLaws(doc: DotfileLaws): string {
	const out: string[] = [
		"# .llm — repo routing laws (W96 grammar; one law per line)",
	];
	for (const l of doc.laws) out.push(`${l.verb}=${l.expr}`);
	if (doc.tier !== null) out.push(`tier=${doc.tier}`);
	if (doc.fallback !== null) out.push(`fallback=${doc.fallback.join(", ")}`);
	return `${out.join("\n")}\n`;
}

// ─── discovery (git-like upward, repo-root bounded) ────────────────────────
const DOTFILE = ".llm";
const MAX_WALK = 64; // depth cap — never walk into a symlink farm
// W199.1 (W181 L18) — .llm is grammar text; 64 KB is ample. Caps the hostile-
// repo shapes: symlink → arbitrary-file read-out, giant file → memory hangup.
const DOTFILE_MAX_BYTES = 64 * 1024;

/** W199.1 (W181 L18) — read the .llm dotfile ONLY as a regular file: lstat
 *  (never follow a symlink), non-regular refused, reads capped at 64 KB. */
export function readLlmDotfile(path: string): string | null {
	let st: Stats;
	try {
		st = lstatSync(path);
	} catch {
		return null;
	}
	if (!st.isFile() || st.size > DOTFILE_MAX_BYTES) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Nearest .llm upward from startDir; the walk stops at the repo root (the
 *  first dir containing .git) so a parent's laws never leak into a repo.
 *  Returns the dotfile PATH, or null when no law source exists. */
export function findLlmDotfile(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < MAX_WALK; i++) {
		const candidate = join(dir, DOTFILE);
		try {
			// W199.1 (W181 L18) — regular files only: a symlinked .llm is skipped
			if (lstatSync(candidate).isFile()) return candidate;
		} catch {} // absent — keep walking
		if (existsSync(join(dir, ".git"))) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

// ─── reconciliation (owner law: DOTFILES WIN, 2026-10-01) ──────────────────
export type Reconciliation =
	| {
			state: "adopt" | "dotfile-wins" | "config-governs";
			effective: string;
			configEntry: string | null;
			why: string;
	  }
	| {
			state: "defaults";
			effective: null;
			configEntry: null;
			why: string;
	  };

/** The 4-state reconciliation over raw texts — (a) dotfile+no config →
 *  adopt (config materialized FROM the dotfile); (b) dotfile+config →
 *  dotfile wins, config mirrors it; (c) no dotfile+config → config governs;
 *  (d) neither → belt's own defaults. configEntry is the text the config
 *  store SHOULD hold after reconciliation (null = leave as-is / remove). */
export function reconcileRepoLaws(input: {
	dotfile: string | null;
	config: string | null;
}): Reconciliation {
	const { dotfile, config } = input;
	if (dotfile !== null && config === null)
		return {
			state: "adopt",
			effective: dotfile,
			configEntry: dotfile,
			why: "dotfile found with no config entry — config materialized from the dotfile",
		};
	return finishReconcile(dotfile, config);
}

/** States b/c/d: both present → dotfile-wins (config mirrors); config only
 *  → config-governs; neither → belt's own defaults. */
function finishReconcile(
	dotfile: string | null,
	config: string | null,
): Reconciliation {
	if (dotfile !== null && config !== null)
		return {
			state: "dotfile-wins",
			effective: dotfile,
			configEntry: dotfile,
			why: "dotfile wins — the config entry mirrors it (config is a live mirror, the dotfile is the source)",
		};
	if (config !== null)
		return {
			state: "config-governs",
			effective: config,
			configEntry: null,
			why: "no dotfile — the config entry governs as the repo's effective policy",
		};
	return {
		state: "defaults",
		effective: null,
		configEntry: null,
		why: "no law source — belt's own default policy governs",
	};
}

// ─── BYO-LLM user plane (keys by NAME, never a value) ─────────────────────
export interface UserPlaneEntry {
	name: string; // unique short name — menu label + candidate machine prefix
	base: string; // endpoint base URL, e.g. https://llm.example.net/v1
	model: string; // model id served at that endpoint
	key_name?: string; // key NAME in the secrets home (<home>/keys/<name>) — NEVER the value
	roles?: string[]; // routing roles this entry serves
}

/** User secrets home (auth.ts KEY MATERIAL LAW parity: BUCKLE_SECRETS_HOME
 *  overrides; key files live under keys/ at mode 600). */
export function secretsHome(env: NodeJS.ProcessEnv = {}): string {
	const o = env.BUCKLE_SECRETS_HOME?.trim();
	if (o !== undefined && o.length > 0) return o;
	return join(env.HOME ?? homedir(), ".claude", "local-llm");
}

/** Key file path: <secrets-home>/keys/<name> — referenced by NAME from
 *  config, value read at call time only. */
export const userKeyPath = (
	name: string,
	env: NodeJS.ProcessEnv = {},
): string => join(secretsHome(env), "keys", name);

// field names that carry key MATERIAL — hard-refused in any user-plane entry
const KEY_VALUE_FIELDS = new Set(["api_key", "apikey", "key", "token"]);

/** Validate one BYO entry — shape + URL + the key-material law. Returns the
 *  error sentence, or null when the entry is valid. */
export function validateUserPlaneEntry(e: unknown): string | null {
	if (e === null || typeof e !== "object" || Array.isArray(e))
		return "entry must be an object {name, base, model, key_name?, roles?}";
	const o = e as Record<string, unknown>;
	for (const f of KEY_VALUE_FIELDS)
		if (f in o)
			return `entry '${String(o.name ?? "?")}': field '${f}' carries key MATERIAL — keys live in the secrets home by NAME (key_name), never in config`;
	return checkUserPlaneFields(o);
}

/** Field checks: name/base/model — each with an honest, specific refusal. */
function checkUserPlaneFields(o: Record<string, unknown>): string | null {
	const name = o.name;
	if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/i.test(name))
		return "name: 1–32 chars [a-z0-9-]";
	const base = o.base;
	if (typeof base !== "string" || base.length === 0)
		return "base: endpoint base URL required";
	try {
		const u = new URL(base);
		if (u.protocol !== "https:" && u.protocol !== "http:")
			return `base: http(s) URL required, got '${u.protocol}'`;
	} catch {
		return `base: not a URL: '${String(base).slice(0, 40)}'`;
	}
	const model = o.model;
	if (typeof model !== "string" || model.length === 0 || model.length > 128)
		return "model: 1–128 chars";
	return checkUserPlaneOptional(o);
}

/** key_name (a NAME, not material) + optional roles list. */
function checkUserPlaneOptional(o: Record<string, unknown>): string | null {
	const kn = o.key_name;
	if (
		kn !== undefined &&
		kn !== null &&
		(typeof kn !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(kn))
	)
		return "key_name: 1–64 chars [a-z0-9._-]";
	const roles = o.roles;
	if (roles !== undefined && roles !== null) {
		if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string"))
			return "roles: must be a list of role names";
	}
	return null;
}

/** User-plane store: <secrets-home>/local-models.json — the W154 echo
 *  menu's local half, now with the BYO contract (plane: user stamped on
 *  read; invalid entries dropped LOUDLY, never silently served). */
export interface UserPlaneRead {
	entries: (UserPlaneEntry & { plane: "user" })[];
	errors: string[];
}

export function userPlanePath(env: NodeJS.ProcessEnv = {}): string {
	return join(secretsHome(env), "local-models.json");
}

export function readUserPlane(env: NodeJS.ProcessEnv = {}): UserPlaneRead {
	const p = userPlanePath(env);
	if (!existsSync(p)) return { entries: [], errors: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return {
			entries: [],
			errors: [`local-models.json does not parse: ${String(e)}`],
		};
	}
	return listUserPlane(parsed);
}

/** Validate a whole user-plane list: valid entries stamped plane:"user",
 *  invalid ones dropped with their error collected (loud, index named). */
function listUserPlane(parsed: unknown): UserPlaneRead {
	const out: UserPlaneRead = { entries: [], errors: [] };
	if (!Array.isArray(parsed)) {
		out.errors.push("local-models.json must be a JSON array of entries");
		return out;
	}
	parsed.forEach((e, i) => {
		const err = validateUserPlaneEntry(e);
		if (err !== null) {
			out.errors.push(`entry[${String(i)}]: ${err}`);
			return;
		}
		const o = e as UserPlaneEntry;
		out.entries.push({ ...o, plane: "user" });
	});
	return out;
}

/** Atomic write of the user plane (validate-all-then-write; any invalid
 *  entry aborts the write with its error). */
export function writeUserPlane(
	entries: unknown[],
	env: NodeJS.ProcessEnv = {},
): { ok: true; wrote: number } | { ok: false; why: string } {
	const errs: string[] = [];
	for (const [i, e] of entries.entries()) {
		const err = validateUserPlaneEntry(e);
		if (err !== null) errs.push(`entry[${String(i)}]: ${err}`);
	}
	if (errs.length) return { ok: false, why: errs.join("\n") };
	mkdirSync(secretsHome(env), { recursive: true });
	atomicWrite(userPlanePath(env), JSON.stringify(entries, null, "\t"));
	return { ok: true, wrote: entries.length };
}

/** Read one user key — the KEY MATERIAL LAW: value lives at
 *  <secrets-home>/keys/<name> at mode 600; missing file or wrong mode is an
 *  honest refusal (never a guess, never a fallback to config values). */
export function readUserKey(
	name: string,
	env: NodeJS.ProcessEnv = {},
): { ok: true; key: string } | { ok: false; why: string } {
	const p = userKeyPath(name, env);
	if (!existsSync(p))
		return {
			ok: false,
			why: `key '${name}': no key file at ${p} — place the secret there at mode 600`,
		};
	const st = statSync(p);
	if ((st.mode & 0o777) !== 0o600)
		return {
			ok: false,
			why: `key '${name}': ${p} must be mode 600 (got ${(st.mode & 0o777).toString(8)})`,
		};
	return { ok: true, key: readFileSync(p, "utf8").trim() };
}

// ─── per-repo laws config store (the reconciliation target) ───────────────
export interface RepoLawsEntry {
	name: string; // repo basename
	dotfile: string; // mirrored/adopted dotfile text (same grammar, one parser)
	source: "dotfile" | "config"; // who is the source right now
	updated_at: string;
}

export interface RepoLawsConfig {
	repos: Record<string, RepoLawsEntry>;
}

export const repoLawsConfigPath = (env: NodeJS.ProcessEnv = {}): string =>
	join(secretsHome(env), "repo-laws.json");

export function readRepoLawsConfig(
	env: NodeJS.ProcessEnv = {},
): RepoLawsConfig {
	const p = repoLawsConfigPath(env);
	if (!existsSync(p)) return { repos: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			return { repos: {} };
		const o = parsed as Record<string, unknown>;
		const repos = o.repos;
		if (repos === null || typeof repos !== "object" || Array.isArray(repos))
			return { repos: {} };
		return { repos: repos as Record<string, RepoLawsEntry> };
	} catch {
		return { repos: {} };
	}
}

/** Reconcile-apply for one repo: decide the state, return the entry the
 *  config store SHOULD hold (null = remove the entry). The caller writes. */
export function reconcileApply(
	root: string,
	env: NodeJS.ProcessEnv = {},
): {
	state: Reconciliation["state"];
	entry: RepoLawsEntry | null;
	why: string;
} {
	const dotPath = join(root, DOTFILE);
	// W199.1 (W181 L18) — capped, regular-file-only read (symlinks refused)
	const dotfile = readLlmDotfile(dotPath);
	const cfg = readRepoLawsConfig(env);
	const existing = cfg.repos[root] ?? null;
	const r = reconcileRepoLaws({
		dotfile,
		config: existing === null ? null : existing.dotfile,
	});
	if (r.state === "defaults")
		return { state: r.state, entry: null, why: r.why };
	if (r.state === "config-governs")
		return { state: r.state, entry: existing, why: r.why };
	return {
		state: r.state,
		entry: {
			name: basename(root),
			dotfile: r.configEntry ?? "",
			source: "dotfile",
			updated_at: new Date().toISOString(),
		},
		why: r.why,
	};
}
