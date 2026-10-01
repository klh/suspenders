// hooks/lib/federation.ts — W154 spoke pull client. Pulls the hub's policy
// manifest + entitlements on an interval (bin/federation-pull.ts), stores
// last-known under the runtime config home, and feeds the echo menu shape
// ({hub_models[], local_entries[]}) for belt/board. Degradation law: hub
// unreachable = keep last-known, log honestly, never block routing (this
// module never throws for hub-down; callers get degraded: true). Law
// streams-over-buffers: capped stream reads, never res.json() on trust.
// Hub URL via env only — no real host in committed files. Sim mapping:
// source sim/spoke-profile.env and pass SIM_HUB_BUCKLE_URL as hubUrl.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./board-config.ts";

export interface HubModel {
	id: string;
	family: string | null;
	tier: string;
	locality: string;
	available: boolean;
}

export interface HubManifestShape {
	version: string;
	rules: unknown[];
	cr_queue: Array<Record<string, unknown>>;
}

export interface LastKnown {
	pulled_at: string;
	hub_url: string;
	manifest: HubManifestShape | null;
	entitlements: { models: HubModel[] } | null;
}

export interface FederationEnv {
	BUCKLE_HUB_URL?: string;
	BUCKLE_SPOKE_TOKEN?: string;
	BUCKLE_SECRETS_HOME?: string;
	HOME?: string;
}

/** Runtime config home (BUCKLE_SECRETS_HOME live-read — the auth.ts
 *  pattern; bun caches os.homedir() at process start). */
export function federationHome(env: FederationEnv = {}): string {
	const override = env.BUCKLE_SECRETS_HOME?.trim();
	if (override !== undefined && override.length > 0) return override;
	return join(env.HOME ?? homedir(), ".claude", "local-llm");
}

/** Last-known store path: <home>/federation-last-known.json. */
export function lastKnownPath(env: FederationEnv = {}): string {
	return join(federationHome(env), "federation-last-known.json");
}

const BODY_CAP = 64 * 1024;

class BodyTooBig extends Error {}

/** streams-over-buffers: capped stream read — never res.text()/res.json(). */
async function readCapped(
	res: Response,
	cap = BODY_CAP,
): Promise<Record<string, unknown>> {
	const reader = res.body?.getReader();
	if (reader === undefined) throw new Error("empty body");
	const dec = new TextDecoder();
	let text = "";
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel();
			throw new BodyTooBig(`body exceeded ${String(cap)}B cap`);
		}
		text += dec.decode(value, { stream: true });
	}
	text += dec.decode();
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("non-object body");
	return parsed;
}

/** Spoke-private local entries (belt-owned file, optional): the other half
 *  of the echo menu. Missing/broken file = empty entries, never an error. */
export function readLocalEntries(
	env: FederationEnv = {},
): Array<Record<string, unknown>> {
	const p = join(federationHome(env), "local-models.json");
	if (!existsSync(p)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		return Array.isArray(parsed)
			? (parsed as Array<Record<string, unknown>>)
			: [];
	} catch {
		return [];
	}
}

export interface PullResult {
	ok: boolean;
	degraded: boolean;
	reason: string | null;
	manifest: HubManifestShape | null;
	entitlements: { models: HubModel[] } | null;
	menu: {
		hub_models: HubModel[];
		local_entries: Array<Record<string, unknown>>;
	};
}

/** One authenticated GET against the hub, capped-stream parsed. */
async function fetchFedJson(
	hubUrl: string,
	path: string,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${hubUrl}${path}`, {
		headers,
		signal: AbortSignal.timeout(timeoutMs),
	});
	return readCapped(res);
}

/** Fetch both surfaces; throws on hub-down (the caller degrades). */
async function fetchPair(
	hubUrl: string,
	token: string | null,
	timeoutMs: number,
): Promise<{ man: HubManifestShape; ent: { models: HubModel[] } }> {
	const headers: Record<string, string> = {};
	if (token !== null && token.length > 0)
		headers.authorization = `Bearer ${token}`;
	const man = (await fetchFedJson(
		hubUrl,
		"/federation/policy-manifest",
		headers,
		timeoutMs,
	)) as unknown as HubManifestShape;
	const ent = (await fetchFedJson(
		hubUrl,
		"/federation/entitlements",
		headers,
		timeoutMs,
	)) as unknown as { models: HubModel[] };
	return { man, ent };
}

function degradedResult(
	reason: string,
	localEntries: Array<Record<string, unknown>>,
	prev: LastKnown | null,
): PullResult {
	console.error(
		`[federation] ${reason}; keeping last-known ${
			prev === null ? "(none yet)" : `from ${prev.pulled_at}`
		}`,
	);
	return {
		ok: false,
		degraded: true,
		reason,
		manifest: prev?.manifest ?? null,
		entitlements: prev?.entitlements ?? null,
		menu: {
			hub_models: prev?.entitlements?.models ?? [],
			local_entries: localEntries,
		},
	};
}

/** Read the last-known store; null when absent/unparseable. */
export function loadLastKnown(env: FederationEnv = {}): LastKnown | null {
	const p = lastKnownPath(env);
	if (!existsSync(p)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as LastKnown;
	} catch {
		return null;
	}
}

/** Fresh pull: both surfaces fetched, last-known written atomically. */
async function freshPull(
	hubUrl: string,
	token: string | null,
	env: FederationEnv,
	timeoutMs: number,
	localEntries: Array<Record<string, unknown>>,
): Promise<PullResult> {
	const { man, ent } = await fetchPair(hubUrl, token, timeoutMs);
	const lk: LastKnown = {
		pulled_at: new Date().toISOString(),
		hub_url: hubUrl,
		manifest: man,
		entitlements: ent,
	};
	mkdirSync(federationHome(env), { recursive: true });
	atomicWrite(lastKnownPath(env), JSON.stringify(lk));
	return {
		ok: true,
		degraded: false,
		reason: null,
		manifest: man,
		entitlements: ent,
		menu: { hub_models: ent.models ?? [], local_entries: localEntries },
	};
}

export interface PullOpts {
	env?: FederationEnv;
	hubUrl?: string;
	token?: string | null;
	timeoutMs?: number;
}

/** One pull cycle: manifest + entitlements → last-known store → echo menu.
 *  Never throws for hub-down — that state is `degraded: true` (degradation
 *  law), with the previous last-known file left untouched. */
export async function pullFederation(opts: PullOpts = {}): Promise<PullResult> {
	const env = opts.env ?? process.env;
	const hubUrl = (opts.hubUrl ?? env.BUCKLE_HUB_URL ?? "").replace(/\/$/, "");
	const token = opts.token ?? env.BUCKLE_SPOKE_TOKEN ?? null;
	const timeoutMs = opts.timeoutMs ?? 5000;
	const localEntries = readLocalEntries(env);
	if (hubUrl.length === 0)
		return degradedResult(
			"hub URL not configured (BUCKLE_HUB_URL)",
			localEntries,
			loadLastKnown(env),
		);
	try {
		return await freshPull(hubUrl, token, env, timeoutMs, localEntries);
	} catch (e) {
		return degradedResult(String(e), localEntries, loadLastKnown(env));
	}
}
