// hooks/coord/supervisor.ts — W266.1: `coord supervisor ensure|status`.
// ensure = converge the repo's fleet services onto launchd (plist-from-
// template → LaunchAgents → bootstrap → governor.db row). status = the live
// truth: rows × one `launchctl list` probe, matched by realpath repo
// (projectIdentity derivation), foreign-repo rows rendered dim.
import { resolve } from "node:path";
import { amber, cyan, db, die, dim, green, red } from "./shared.ts";
import {
	canonicalRepo,
	ensureSupervisor,
	listServices,
	liveStates,
	launchctlTable,
	plistVars,
	supervisorRows,
} from "../lib/supervisor.ts";

const LAUNCHD_DIR = resolve(import.meta.dir, "..", "launchd");
const LAUNCH_AGENTS = `${process.env.HOME ?? ""}/Library/LaunchAgents`;

const usage = (): never =>
	die("usage: coord supervisor ensure [service...] | status [--json]");

const templateVars = (repo: string): Record<string, string> =>
	plistVars({
		bun: Bun.which("bun") ?? process.execPath,
		home: process.env.HOME ?? "",
		// this module lives at <PREFIX>/coord/ — .. is the install PREFIX
		prefix: resolve(import.meta.dir, ".."),
		repo,
		beltUrl: process.env.BELT_URL ?? "http://127.0.0.1:4100",
		beltToken: process.env.BELT_TOKEN ?? "",
	});

export async function cmdSupervisor(rest: string[]): Promise<void> {
	const sub = rest[0] ?? "";
	const repo = canonicalRepo(process.cwd());
	if (sub === "ensure") {
		const want = rest.slice(1).filter((s) => !s.startsWith("--"));
		const services = want.length ? want : listServices(LAUNCHD_DIR);
		if (!services.length) usage();
		if (process.platform !== "darwin")
			die(
				"supervisor ensure: launchd is macOS-only — nothing to converge here",
			);
		const vars = templateVars(repo);
		let okN = 0;
		const lines: string[] = [];
		for (const s of services) {
			const r = ensureSupervisor({
				db,
				service: s,
				repo,
				launchdDir: LAUNCHD_DIR,
				launchAgentsDir: LAUNCH_AGENTS,
				vars,
			});
			if (r.ok) okN++;
			lines.push(r.line);
		}
		console.log(lines.join("\n"));
		console.log(
			dim(
				`${okN}/${services.length} ensured — repo ${repo} · live truth: coord supervisor status`,
			),
		);
		return;
	}
	if (sub === "status") {
		const wantJson = rest.includes("--json");
		const probe = launchctlTable();
		const rows = supervisorRows(db);
		const live = liveStates(rows, probe.table, repo, probe.ok);
		if (wantJson) {
			console.log(
				JSON.stringify({ repo, probeOk: probe.ok, supervisors: live }),
			);
			return;
		}
		console.log(
			`SUPERVISORS  repo=${repo}${probe.ok ? "" : "  (launchd unreachable — states UNKNOWN)"}`,
		);
		if (!rows.length) {
			console.log(
				dim("(no supervision rows — converge with: coord supervisor ensure)"),
			);
			return;
		}
		for (const l of live) {
			const g =
				l.state === "UP"
					? green("▶")
					: l.state === "UNKNOWN"
						? dim("·")
						: red("✗");
			const pid = l.pid ? ` pid ${l.pid}` : "";
			const foreign = l.repoMatch ? "" : amber(" (other repo)");
			console.log(
				`  ${g} ${cyan(l.service.padEnd(16))} ${l.state.padEnd(11)}${pid}${foreign}`,
			);
		}
		return;
	}
	usage();
}
