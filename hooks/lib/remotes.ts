// hooks/lib/remotes.ts — suspenders' slice of the remote LLM registry.
// Reads the SAME runtime config belt uses: ~/.claude/local-llm/remotes.json
// (never committed — real hosts/IPs/MACs stay local; the repo ships
// placeholders). DNS first, ip_fallback only when resolution fails.
// Suspenders needs three things: probe-only liveness for keepwarm (never WoL
// from a 4-min daemon — that would defeat Synology hibernation), an
// openai-protocol chat fallback for advise, and WoL-ensure for the rare,
// important routed calls. Spike: spikes/w86/ (bfde191).
import dgram from "node:dgram";
import { existsSync, readFileSync } from "node:fs";

export interface RemoteEndpoint {
	port: number;
	// openai = /v1/models + /v1/chat/completions; llama = llama.cpp server
	// (/health); immich = Immich SERVER api (smart-search), not the ML container
	protocol: "openai" | "llama" | "immich";
	roles: string[]; // general | advise | research | embed ...
	model?: string;
	/** name of the env var holding the immich x-api-key — never the key */
	api_key_env?: string;
	/** opt-in probe-only liveness from the 4-min keepwarm daemon */
	keepwarm_probe?: boolean;
}

export interface RemoteMachine {
	name: string;
	host: string; // DNS first on every call
	ip_fallback?: string; // only when resolution fails
	mac?: string; // WoL target for hibernating machines
	wol_broadcast?: string; // "ip:port", e.g. subnet :9
	endpoints: RemoteEndpoint[];
}

export interface EndpointHealth {
	alive: boolean;
	ms: number;
	status?: number;
}

/** Runtime config location — under HOME so tests can point it elsewhere. */
export function configPath(): string {
	return `${process.env.HOME}/.claude/local-llm/remotes.json`;
}

/** Missing file = empty registry (graceful: no remotes configured). */
export function loadRemotes(): RemoteMachine[] {
	const path = configPath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			machines?: RemoteMachine[];
		};
		return Array.isArray(parsed.machines) ? parsed.machines : [];
	} catch {
		console.error(`remotes: ${path} is not valid JSON — skipping registry`);
		return [];
	}
}

/** Flattened (machine, endpoint) pairs, filtered by role. */
export function endpointsWithRole(
	role: string,
): { machine: RemoteMachine; endpoint: RemoteEndpoint }[] {
	const out: {
		machine: RemoteMachine;
		endpoint: RemoteEndpoint;
	}[] = [];
	for (const machine of loadRemotes())
		for (const endpoint of machine.endpoints)
			if (endpoint.roles.includes(role)) out.push({ machine, endpoint });
	return out;
}

/** DNS first, ip_fallback only when resolution fails. */
export async function resolveHost(
	host: string,
	fallback?: string,
): Promise<string | null> {
	const look = (): string | null => {
		try {
			const r = Bun.spawnSync([
				"/usr/bin/dscacheutil",
				"-q",
				"host",
				"-a",
				"name",
				host,
			]);
			const line = r.stdout
				.toString()
				.split("\n")
				.find((l) => l.startsWith("ip_address:"));
			const ip = line ? line.split(" ")[1]?.trim() : undefined;
			return ip || null;
		} catch {
			return null;
		}
	};
	return look() ?? fallback ?? null;
}

/** Protocol-aware liveness probe: any HTTP answer = alive; only transport
 *  failure = dead. openai → GET /v1/models; llama → GET /health; immich →
 *  GET /api/server/ping (unauthenticated, cheap). */
export async function probeEndpoint(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
): Promise<EndpointHealth> {
	const ip = await resolveHost(machine.host, machine.ip_fallback);
	if (!ip) return { alive: false, ms: 0 };
	const path =
		ep.protocol === "openai"
			? "/v1/models"
			: ep.protocol === "llama"
				? "/health"
				: "/api/server/ping";
	const t0 = Date.now();
	try {
		const r = await fetch(`http://${ip}:${ep.port}${path}`, {
			signal: AbortSignal.timeout(4000),
		});
		return { alive: r.status < 600, ms: Date.now() - t0, status: r.status };
	} catch {
		return { alive: false, ms: Date.now() - t0 };
	}
}

/** Synology hibernation: NIC answers ARP but TCP is silent until a magic
 *  packet. Ported verbatim from spikes/w86/wol.ts (bfde191, proven on the
 *  real NAS). */
export async function sendWoL(mac: string, target: string): Promise<boolean> {
	const clean = mac.replace(/[:-]/g, "").toLowerCase();
	if (clean.length !== 12) return false;
	const payload = Buffer.concat([
		Buffer.alloc(6, 0xff),
		Buffer.from(clean.repeat(16), "hex"),
	]);
	const [ip, portStr] = target.split(":");
	const port = Number(portStr || "9");
	return new Promise((resolve) => {
		const sock = dgram.createSocket("udp4");
		sock.bind(() => {
			sock.setBroadcast(true);
			sock.send(payload, port, ip, (err) => {
				// broadcast to the subnet can miss on some APs — retry all-ones
				const retry = (err2: Error | null) => {
					sock.close();
					resolve(!err2);
				};
				if (err) sock.send(payload, port, "255.255.255.255", retry);
				else {
					sock.close();
					resolve(true);
				}
			});
		});
	});
}

/** Ensure reachability: probe → (WoL + wait, only if configured) → probe.
 *  Hibernation wake takes ~40s on the NAS; cap at maxWaitMs. */
export async function ensureEndpoint(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
	maxWaitMs = 90_000,
): Promise<EndpointHealth> {
	const first = await probeEndpoint(machine, ep);
	if (first.alive) return first;
	if (!machine.mac || !machine.wol_broadcast) return first;
	if (!(await sendWoL(machine.mac, machine.wol_broadcast))) return first;
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 4000));
		const again = await probeEndpoint(machine, ep);
		if (again.alive) return again;
	}
	return first;
}

/** One openai-protocol chat call to a remote endpoint. Slow NAS CPUs get a
 *  long timeout — the caller decides what "too long" means. */
export async function chatRemote(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
	messages: { role: string; content: string }[],
	opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<{ text: string; ms: number; model: string }> {
	const ip = await resolveHost(machine.host, machine.ip_fallback);
	if (!ip) throw new Error(`cannot resolve ${machine.host}`);
	const model = ep.model ?? "local";
	const t0 = Date.now();
	const r = await fetch(`http://${ip}:${ep.port}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			messages,
			max_tokens: opts?.maxTokens ?? 500,
			temperature: opts?.temperature ?? 0.2,
		}),
		signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
	});
	if (!r.ok)
		throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	return {
		text: j.choices?.[0]?.message?.content ?? "",
		ms: Date.now() - t0,
		model,
	};
}
