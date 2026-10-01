// hooks/bin/federation-up.ts — W170 spoke up-feed entry. Loop mode by default
// (FEDERATION_UP_INTERVAL_S, default 60s); --once for the sim and tests.
// Hub store URL from BUCKLE_HUB_STORE_URL only (sim: SIM_HUB_STORE_URL — the
// suspenders hub store, :17003 in the sim). Degradation is normal operation:
// a failed push logs one honest line, keeps the cursor, never blocks local
// routing. --once exits 2 on degraded (honest signal), loop never exits.
import { pushWorkDeltas } from "../lib/federation-up.ts";

const INTERVAL_S = Number(process.env.FEDERATION_UP_INTERVAL_S ?? "60");

async function cycle(): Promise<boolean> {
	const out = await pushWorkDeltas();
	if (out.ok) {
		console.log(
			`[federation-up] ok pushed=${String(out.pushed)} through_seq=${String(out.throughSeq)}`,
		);
		return true;
	}
	console.error(`[federation-up] degraded: ${out.reason ?? "unknown"}`);
	return false;
}

if (import.meta.main) {
	if (process.argv.includes("--once")) {
		const ok = await cycle();
		process.exit(ok ? 0 : 2);
	}
	console.log(
		`[federation-up] loop every ${String(INTERVAL_S)}s (BUCKLE_HUB_STORE_URL=${process.env.BUCKLE_HUB_STORE_URL ?? "unset"})`,
	);
	for (;;) {
		await cycle();
		await Bun.sleep(INTERVAL_S * 1000);
	}
}
