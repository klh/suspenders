// services.test.ts — the ONE service manifest: renderers must produce valid
// launchd plists and systemd user-units for every entry, with direct-call
// assertions per service and no unresolved __X__ tokens anywhere.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	SERVICES,
	resolveCtx,
	subAll,
	renderLaunchd,
	renderSystemd,
	label,
	unitBase,
	systemdEnable,
	type Svc,
} from "../hooks/lib/services.ts";

const LA = resolveCtx("launchd", {
	bun: "/bun",
	home: "/Users/t",
	prefix: "/p",
	repo: "/r",
	ladder: "git merge --no-ff {branch}",
});
const SD = resolveCtx("systemd", { ...LA });
const noTokens = (t: string): void => expect(t).not.toMatch(/__[A-Z]+__/);
const svc = (name: string): Svc => {
	const s = SERVICES.find((x) => x.name === name);
	if (!s) throw new Error(`no such service: ${name}`);
	return s;
};

describe("manifest hygiene", () => {
	test("unique names and logs", () => {
		const names = SERVICES.map((s) => s.name);
		expect(new Set(names).size).toBe(SERVICES.length);
		expect(new Set(SERVICES.map((s) => s.log)).size).toBe(SERVICES.length);
	});
	test("kind fields consistent", () => {
		for (const s of SERVICES) {
			expect(s.args.length).toBeGreaterThan(0);
			if (s.kind === "interval") expect(s.everySec ?? 0).toBeGreaterThan(0);
			if (s.kind === "calendar") expect(s.calendar).toBeDefined();
			if (s.kind === "daemon") {
				expect(s.everySec).toBeUndefined();
				expect(s.calendar).toBeUndefined();
			}
		}
	});
	test("every entry points at a real hooks/bin script", () => {
		const bin = join(import.meta.dir, "..", "hooks", "bin");
		for (const s of SERVICES) {
			const first = s.args[0].replace("__PREFIX__", "/p");
			expect(first.startsWith("/p/bin/")).toBe(true);
			expect(existsSync(join(bin, first.slice("/p/bin/".length)))).toBe(true);
		}
	});
});

describe("token substitution", () => {
	test("subAll resolves tokens; PATH chain bakes home", () => {
		expect(subAll(LA, "__HOME__/x __PREFIX__ __REPO__")).toBe(
			"/Users/t/x /p /r",
		);
		expect(LA.path.startsWith("/Users/t/")).toBe(true);
		expect(SD.path.startsWith("/Users/t/")).toBe(true);
	});
});

describe("launchd render", () => {
	test("board: keepalive daemon with env and darwin PATH", () => {
		const out = renderLaunchd(svc("board"), LA);
		expect(out).toContain("com.suspenders.board");
		expect(out).toContain("KeepAlive");
		expect(out).toContain("RunAtLoad");
		expect(out).toContain("SUSPENDERS_BIND");
		expect(out).toContain("/Users/t/.local/bin");
		noTokens(out);
	});
	test("db-backup: calendar 10:00 plus RunAtLoad", () => {
		const out = renderLaunchd(svc("db-backup"), LA);
		expect(out).toContain("StartCalendarInterval");
		expect(out).toContain("Hour");
		expect(out).toContain("<string>10</string>");
		expect(out).toContain("<string>0</string>");
		noTokens(out);
	});
});

test("ladder default flows through both renderers", () => {
	const out = renderLaunchd(svc("fleet-loop"), LA);
	expect(out).toContain("git merge --no-ff {branch}");
	const { unit } = renderSystemd(svc("fleet-loop"), SD);
	expect(unit).toContain(`--ladder "git merge --no-ff {branch}"`);
});
test("fleet-monitor: StartInterval 900", () => {
	const out = renderLaunchd(svc("fleet-monitor"), LA);
	expect(out).toContain("<key>StartInterval</key><string>900</string>");
	noTokens(out);
});
test("llm-keepwarm: Nice and distinct stderr log", () => {
	const out = renderLaunchd(svc("llm-keepwarm"), LA);
	expect(out).toContain("<key>Nice</key><string>10</string>");
	expect(out).toContain("/tmp/llm-keepwarm.err");
	noTokens(out);
});

describe("systemd render", () => {
	test("daemons: Restart=always, enable .service, no timer", () => {
		for (const s of SERVICES.filter((x) => x.kind === "daemon")) {
			const { unit, timer } = renderSystemd(s, SD);
			expect(unit).toContain("Restart=always");
			expect(unit).toContain("WantedBy=default.target");
			expect(timer).toBeNull();
			noTokens(unit);
		}
	});
	test("db-backup: oneshot service and OnCalendar timer", () => {
		const { unit, timer } = renderSystemd(svc("db-backup"), SD);
		expect(unit).toContain("Type=oneshot");
		if (!timer) throw new Error("db-backup must emit a timer");
		expect(timer).toContain("OnCalendar=*-*-* 10:00:00");
		expect(timer).toContain("Persistent=true");
		expect(timer).toContain("WantedBy=timers.target");
	});
	test("fleet-monitor: OnActiveSec plus OnUnitActiveSec", () => {
		const { timer } = renderSystemd(svc("fleet-monitor"), SD);
		if (!timer) throw new Error("fleet-monitor must emit a timer");
		expect(timer).toContain("OnActiveSec=1s");
		expect(timer).toContain("OnUnitActiveSec=900s");
	});
});

describe("install wiring", () => {
	test("enable list covers all services exactly once", () => {
		const all = SERVICES.flatMap(systemdEnable);
		expect(all.length).toBe(SERVICES.length);
		expect(new Set(all).size).toBe(SERVICES.length);
		for (const s of SERVICES) {
			const want = s.kind === "daemon" ? "service" : "timer";
			expect(systemdEnable(s)[0].endsWith(want)).toBe(true);
		}
	});
	test("knowledge-worker note survives as comment and env", () => {
		const { unit } = renderSystemd(svc("knowledge-worker"), SD);
		expect(unit).toContain("distill target: local large model");
		// sdQuote leaves special-char-free values bare — valid systemd syntax
		expect(unit).toContain("Environment=INGEST_LLM_URL=http://127.0.0.1:8903");
	});
	test("labels and unit names", () => {
		expect(label(svc("board"))).toBe("com.suspenders.board");
		expect(unitBase(svc("board"))).toBe("suspenders-board");
	});
});
