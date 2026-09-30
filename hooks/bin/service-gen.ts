// service-gen.ts — emit/install the fleet services from the ONE manifest
// (lib/services.ts): launchd plists on darwin, systemd user-units on linux.
// Replaces the per-repo __HOME__ plist templates; install.sh --with-services
// calls this. Idempotent — re-emitting overwrites in place, install bootout/
// re-bootstraps (launchd) or daemon-reload + re-enables (systemd).
// usage:
//   bun service-gen.ts emit --target launchd|systemd [--dir <out>] [ctx flags]
//   bun service-gen.ts install --target launchd|systemd [--dir <out>] [ctx flags]
// ctx flags: --bun --home --prefix --repo --ladder (defaults: this bun, $HOME,
//   the harness dir this file lives in, cwd, DEFAULT_LADDER)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	SERVICES,
	resolveCtx,
	renderLaunchd,
	renderSystemd,
	label,
	unitBase,
	systemdEnable,
	type SvcTarget,
	type SvcCtx,
} from "../lib/services.ts";

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1] : undefined;
};
const MODE = process.argv[2];
const TARGET = (arg("--target") ?? "") as SvcTarget;
if (TARGET !== "launchd" && TARGET !== "systemd") {
	console.error("service-gen: --target must be launchd or systemd");
	process.exit(1);
}
if (MODE !== "emit" && MODE !== "install") {
	console.error(
		"usage: bun service-gen.ts <emit|install> --target launchd|systemd [--dir <out>] [--bun --home --prefix --repo --ladder]",
	);
	process.exit(1);
}
// default prefix = the harness dir this generator runs from (<prefix>/bin/)
const HERE_PREFIX = join(import.meta.dir, "..");
const ctx: SvcCtx = resolveCtx(TARGET, {
	bun: arg("--bun"),
	home: arg("--home"),
	prefix: arg("--prefix") ?? HERE_PREFIX,
	repo: arg("--repo"),
	ladder: arg("--ladder"),
});
const DIR =
	arg("--dir") ??
	(TARGET === "launchd"
		? join(ctx.home, "Library", "LaunchAgents")
		: join(ctx.home, ".config", "systemd", "user"));

// ---- render + write all units ----
const written: string[] = [];
mkdirSync(DIR, { recursive: true });
for (const s of SERVICES) {
	if (TARGET === "launchd") {
		const f = join(DIR, `${label(s)}.plist`);
		writeFileSync(f, renderLaunchd(s, ctx));
		written.push(f);
	} else {
		const { unit, timer } = renderSystemd(s, ctx);
		const f = join(DIR, `${unitBase(s)}.service`);
		writeFileSync(f, unit);
		written.push(f);
		if (timer) {
			const t = join(DIR, `${unitBase(s)}.timer`);
			writeFileSync(t, timer);
			written.push(t);
		}
	}
}

// ---- install: load what was written (emit stops here) ----
if (MODE === "install") {
	const run = (args: string[]): number => {
		const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
		return p.exitCode ?? 1;
	};
	if (TARGET === "launchd") {
		const uid = process.getuid();
		for (const s of SERVICES) {
			run(["launchctl", "bootout", `gui/${uid}/${label(s)}`]); // not loaded yet = fine
			const rc = run([
				"launchctl",
				"bootstrap",
				`gui/${uid}`,
				join(DIR, `${label(s)}.plist`),
			]);
			if (rc !== 0) {
				console.error(
					`service-gen: launchctl bootstrap failed for ${label(s)} (rc ${rc})`,
				);
				process.exit(2);
			}
			console.log(`→ loaded ${label(s)}`);
		}
	} else {
		if (run(["systemctl", "--user", "daemon-reload"]) !== 0) {
			console.error(
				"service-gen: systemctl --user daemon-reload failed — is a user bus reachable?",
			);
			process.exit(2);
		}
		for (const s of SERVICES) {
			const units = systemdEnable(s);
			const rc = run(["systemctl", "--user", "enable", "--now", ...units]);
			if (rc !== 0) {
				console.error(
					`service-gen: systemctl --user enable --now ${units.join(" ")} failed (rc ${rc})`,
				);
				process.exit(2);
			}
			console.log(`→ enabled ${units.join(" ")}`);
		}
	}
} else {
	console.log(`service-gen: emitted ${written.length} file(s) → ${DIR}`);
}
