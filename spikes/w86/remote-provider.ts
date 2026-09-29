/**
 * W86 spike — belt remote-provider awareness, prototype.
 *
 * Belt's registry.ts today knows only LOCAL specialists (typed port union,
 * mlx engines, resident/ondemand tiers). Multi-machine fleet awareness means
 * the registry can also name services on OTHER machines — starting with the
 * Synology NAS running Immich (server :2283, ML :3003 docker-internal).
 *
 * This module prototypes the `remote` provider kind + one routed call, so
 * follow-up items can land it in belt/bin/registry.ts + router.
 *
 * Run: bun spikes/w86/remote-provider.ts
 */

// ─── the shape registry.ts would gain ──────────────────────────────────────

export interface RemoteProvider {
	id: string; // stable id, e.g. "synology-immich"
	label: string;
	role: "embed"; // remote ML is embed-shaped today; widen as remotes appear
	kind: "immich"; // protocol adapter; widen: ollama | openai-compatible
	base_url: string; // "http://nas.threads.dk:2283"
	health_path: string; // "/api/server/ping" — cheap unauthenticated liveness
	/** belt never stores secrets — name of the env var holding the key */
	api_key_env: string;
	/** Synology hibernation: NIC answers ARP but TCP is silent until WoL */
	wakeable: boolean;
	wol_mac?: string;
	wol_broadcast?: string;
}

export const REMOTES: RemoteProvider[] = [
	{
		id: "synology-immich",
		label: "NAS Immich ML",
		role: "embed",
		kind: "immich",
		base_url: "http://nas.threads.dk:2283",
		health_path: "/api/server/ping",
		api_key_env: "IMMICH_API_KEY",
		wakeable: true,
		wol_mac: "90:09:d0:5a:ff:8f",
		wol_broadcast: "192.168.1.255:9",
	},
];

// ─── probe / wake / route ──────────────────────────────────────────────────

export type RemoteHealth = {
	alive: boolean;
	status?: number;
	version?: string;
};

/** Cheap unauthenticated liveness + version probe. */
export async function probeRemote(p: RemoteProvider): Promise<RemoteHealth> {
	try {
		const res = await fetch(`${p.base_url}${p.health_path}`, {
			signal: AbortSignal.timeout(1500),
		});
		if (res.status !== 200) return { alive: false, status: res.status };
		const version = await fetch(`${p.base_url}/api/server/version`, {
			signal: AbortSignal.timeout(1500),
		})
			.then((r) => r.text())
			.catch(() => undefined);
		return { alive: true, status: 200, version };
	} catch {
		return { alive: false };
	}
}

// Synology hibernation: TCP SYNs are dropped; only a magic packet wakes it.
export async function wakeRemote(
	p: RemoteProvider,
	maxWaitMs = 90_000,
): Promise<boolean> {
	const { magicPacket } = await import("./wol.ts");
	const sent = await magicPacket(p.wol_mac ?? "", p.wol_broadcast ?? "");
	if (!sent) return false;
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 4000));
		if ((await probeRemote(p)).alive) return true;
	}
	return false;
}

/** Ensure the remote is reachable — probe first, wake only if silent. */
export async function ensureRemote(p: RemoteProvider): Promise<RemoteHealth> {
	const first = await probeRemote(p);
	if (first.alive) return first;
	if (!p.wakeable) return first;
	console.log(`[remote] ${p.id} silent — sending WoL and waiting ...`);
	const woke = await wakeRemote(p);
	return woke ? probeRemote(p) : first;
}

// ─── the one routed call ───────────────────────────────────────────────────

export type RemoteCallResult = {
	remote: string;
	routed: boolean;
	embedded: boolean;
	detail: string;
};

/**
 * The one routed call: role "embed" → Immich smart-search (the server's
 * ML-backed embedding path). Degrades honestly: without IMMICH_API_KEY the
 * call still routes (reachability + auth verdict), but reports unembedded.
 */
export async function routeEmbedCall(
	p: RemoteProvider,
	query: string,
): Promise<RemoteCallResult> {
	const health = await ensureRemote(p);
	if (!health.alive) {
		return {
			remote: p.id,
			routed: false,
			embedded: false,
			detail: `unreachable after ensure (wakeable=${p.wakeable})`,
		};
	}
	return finishEmbedCall(p, query, health);
}

/** Keyed branch — POST /api/search/smart with the owner's Immich API key. */
async function finishEmbedCall(
	p: RemoteProvider,
	query: string,
	health: RemoteHealth,
): Promise<RemoteCallResult> {
	const key = process.env[p.api_key_env];
	if (!key) {
		return {
			remote: p.id,
			routed: true,
			embedded: false,
			detail: `alive v${health.version?.trim()} but ${p.api_key_env} unset — route verified, embed pending key`,
		};
	}
	const res = await fetch(`${p.base_url}/api/search/smart`, {
		method: "POST",
		headers: { "x-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({ query }),
	});
	return {
		remote: p.id,
		routed: true,
		embedded: res.ok,
		detail: `POST /api/search/smart -> ${res.status}`,
	};
}

// ─── main: run the prototype against the real NAS ──────────────────────────

if (import.meta.main) {
	const p = REMOTES[0];
	const out = await routeEmbedCall(p, "golden retriever on a beach");
	console.log(`[w86] routed call: ${JSON.stringify(out, null, 2)}`);
}
