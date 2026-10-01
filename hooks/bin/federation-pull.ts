// hooks/bin/federation-pull.ts — W154 spoke pull client entry. Loop mode by
// default (FEDERATION_PULL_INTERVAL_S, default 300s); --once for the sim and
// tests. Hub URL from BUCKLE_HUB_URL only (no real host in committed files;
// sim: source sim/spoke-profile.env and map SIM_HUB_BUCKLE_URL). Degradation
// is normal operation: a failed pull logs one honest line, keeps last-known,
// never blocks routing. --once exits 2 on degraded (honest signal for the
// caller), loop mode never exits on hub-down.
import { pullFederation } from "../lib/federation.ts";

const INTERVAL_S = Number(process.env.FEDERATION_PULL_INTERVAL_S ?? "300");

async function cycle(): Promise<boolean> {
	const out = await pullFederation();
	if (out.ok) {
		const models = out.menu.hub_models.length;
		const crs = out.manifest?.cr_queue.length ?? 0;
		console.log(
			`[federation-pull] ok version=${out.manifest?.version} models=${String(models)} cr_queue=${String(crs)}`,
		);
		return true;
	}
	console.error(`[federation-pull] degraded: ${out.reason ?? "unknown"}`);
	return false;
}

if (import.meta.main) {
	if (process.argv.includes("--once")) {
		const ok = await cycle();
		process.exit(ok ? 0 : 2);
	}
	console.log(
		`[federation-pull] loop every ${String(INTERVAL_S)}s (BUCKLE_HUB_URL=${process.env.BUCKLE_HUB_URL ?? "unset"})`,
	);
	for (;;) {
		await cycle();
		await Bun.sleep(INTERVAL_S * 1000);
	}
}
