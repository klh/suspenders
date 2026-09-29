/**
 * W86 spike — discover the Synology NAS Immich ML service on the LAN.
 *
 * Evidence-first, three phases:
 *  1. Candidates: ARP neighbor cache + mDNS browse (Synology-ish service
 *     types) + subnet sweep on Immich/DSM ports.
 *  2. Probes: HTTP GET /ping on :3003 (Immich ML), :3001 (Immich server),
 *     GET / on :5000 (DSM).
 *  3. Contract: GET /openapi.json from any :3003 hit — paths + the /predict
 *     request schema, so nothing here rests on training data.
 *
 * Run: bun spikes/w86/discover.ts
 */
import { $ } from "bun";

type Probe = {
	target: string;
	port: number;
	status?: number;
	body?: string;
	error?: string;
};

function parseArp(src: string | Buffer): { name: string; ip: string }[] {
	const out = String(src);
	const hits: { name: string; ip: string }[] = [];
	for (const m of out.matchAll(/(\S+) \(([\d.]+)\) at ([0-9a-f:]{11,})/gi)) {
		hits.push({ name: m[1], ip: m[2] });
	}
	return hits;
}

async function probeHttp(
	host: string,
	port: number,
	path: string,
	timeoutMs = 1500,
): Promise<Probe> {
	const target = `http://${host}:${port}${path}`;
	try {
		const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
		const body = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
		return { target, port, status: res.status, body };
	} catch (e) {
		return {
			target,
			port,
			error: String(e)
				.replace(/^Error[:\s]*/i, "")
				.slice(0, 90),
		};
	}
}

// --- Phase 1: candidates -------------------------------------------------

const arp = await $`arp -a`.quiet().nothrow();
const arpHosts = parseArp(arp.stdout ?? "");

// mDNS: browse the service types Synology boxes advertise (containers like
// Immich don't register Bonjour, so this names the NAS, not the ML port).
const mdnsTypes = [
	"_smb._tcp",
	"_http._tcp",
	"_adisk._tcp",
	"_webdav._tcp",
	"_nfs._tcp",
];
const mdnsNames = new Set<string>();
await Promise.all(
	mdnsTypes.map(async (type) => {
		const p = Bun.spawn(["dns-sd", "-B", type, "local."], { stdout: "pipe" });
		await new Promise((r) => setTimeout(r, 2000));
		p.kill();
		const text = await new Response(p.stdout).text();
		for (const line of text.split("\n")) {
			// "... 10  _http._tcp  local.  DiskStation"
			const parts = line.trim().split(/\s+/);
			const inst = parts.at(-1);
			if (
				parts[0] === "0" &&
				inst &&
				!inst.startsWith("_") &&
				inst !== "local."
			) {
				mdnsNames.add(inst.replace(/\\032.*$/, "").trim());
			}
		}
	}),
);

// Subnet from the primary interface, then sweep it on the Immich/DSM ports.
const ifconfig = await $`ifconfig`.quiet().nothrow();
const subnets: { base: string; self: string }[] = [];
for (const m of String(ifconfig.stdout ?? "").matchAll(
	/inet (192\.168\.\d+|10\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+)\.(\d+) /g,
)) {
	subnets.push({ base: `${m[1]}.`, self: m[2] });
}
const candidates = new Set<string>();
for (const s of subnets) {
	for (let i = 1; i <= 254; i++) {
		if (String(i) !== s.self) candidates.add(s.base + i);
	}
}
for (const h of arpHosts) candidates.add(h.ip);

const namedCandidates = [
	"nas.local",
	"DiskStation.local",
	"diskstation.local",
	"synology.local",
	"ds.local",
	"immich.local",
	...mdnsNames,
].map((n) => n.toLowerCase());

const probeTargets = [...candidates, ...namedCandidates];

// --- Phase 2: probes ------------------------------------------------------

console.log(
	`[w86] subnets: ${subnets.map((s) => s.base + "x").join("  ")} | mdns: ${[...mdnsNames].join(", ") || "(none)"}`,
);
console.log(
	`[w86] probing ${probeTargets.length} hosts x {3003, 3001, 5000} ...`,
);
const probes = await Promise.all(
	probeTargets.flatMap((host) => [
		probeHttp(host, 3003, "/ping", 1200),
		probeHttp(host, 3001, "/api/server/ping", 1200),
		probeHttp(host, 5000, "/", 1200),
	]),
);

const mlHits = probes.filter((p) => p.port === 3003 && p.status === 200);
const serverHits = probes.filter((p) => p.port === 3001 && p.status === 200);
const dsmHits = probes.filter((p) => p.port === 5000 && p.status === 200);

function brief(ps: Probe[]): string {
	return ps.map((p) => p.target.replace("http://", "")).join(", ") || "(none)";
}
console.log(`[w86] Immich ML :3003 -> ${brief(mlHits)}`);
console.log(`[w86] Immich server :3001 -> ${brief(serverHits)}`);
console.log(`[w86] DSM :5000 -> ${brief(dsmHits)}`);
for (const h of [...mlHits, ...serverHits, ...dsmHits]) {
	console.log(`      ${h.target} :: ${h.body}`);
}

// --- Phase 3: the real /predict contract ----------------------------------

for (const hit of mlHits) {
	const host = hit.target.replace("http://", "").split(":")[0];
	const openapi = await probeHttp(host, 3003, "/openapi.json", 3000);
	if (openapi.status !== 200) {
		console.log(
			`[w86] ${host}:3003 has no /openapi.json (${openapi.error ?? openapi.status})`,
		);
		continue;
	}
	console.log(`[w86] openapi.json from ${host}:3003:`);
	const spec = JSON.parse(openapi.body ?? "{}") as {
		paths?: Record<string, unknown>;
	};
	console.log(`      paths: ${Object.keys(spec.paths ?? {}).join(", ")}`);
	// body was truncated at 200 chars — refetch full for the predict schema
	const res = await fetch(`http://${host}:3003/openapi.json`, {
		signal: AbortSignal.timeout(3000),
	});
	const full = (await res.json()) as {
		paths?: Record<
			string,
			{
				post?: {
					requestBody?: { content?: Record<string, { schema?: unknown }> };
				};
			}
		>;
		components?: { schemas?: Record<string, unknown> };
	};
	const predict = full.paths?.["/predict"]?.post?.requestBody?.content;
	const schemaName = JSON.stringify(predict ?? {}).match(
		/#\/components\/schemas\/([^"}]+)/,
	)?.[1];
	if (schemaName) {
		const s = full.components?.schemas?.[schemaName];
		console.log(`      /predict body schema (${schemaName}):`);
		console.log(
			JSON.stringify(s, null, 2)
				.split("\n")
				.map((l) => `        ${l}`)
				.join("\n"),
		);
	}
}
