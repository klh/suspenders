// services.ts — the ONE service manifest: every long-running and periodic
// fleet service in a single typed table, plus renderers that emit launchd
// plists (darwin) and systemd user-units (linux) from it. Replaces the
// per-repo __HOME__ plist templates — install.sh --with-services feeds the
// same manifest to bin/service-gen.ts on either platform, which flips the
// suspenders fleet layer to Linux-supported.
// consumed by bin/service-gen.ts (emit/install); imported by tests.

export type SvcTarget = "launchd" | "systemd";

// render context — concrete values substituted into manifest tokens
export interface SvcCtx {
	bun: string; // bun binary path
	home: string; // user home
	prefix: string; // installed harness prefix
	repo: string; // repo the loop/harvest operate on
	ladder: string; // fleet-loop merge ladder template
	path: string; // PATH env for services (per-target chain)
}

// service schedule kinds — daemon (keep-alive) vs timer-driven runs
export type SvcKind = "daemon" | "interval" | "calendar";

export interface Svc {
	name: string; // short name — com.suspenders.<name> / suspenders-<name>
	desc: string; // human one-liner (systemd Description=)
	note?: string; // carried into the unit as a comment
	args: string[]; // argv AFTER bun; may carry __X__ tokens
	kind: SvcKind;
	keepAlive?: boolean; // daemon: restart on exit (KeepAlive / Restart=always)
	runAtLoad?: boolean; // fire once at load/enable (RunAtLoad / OnActiveSec)
	everySec?: number; // interval: seconds between runs (StartInterval / OnUnitActiveSec)
	calendar?: { hour: number; minute: number }; // calendar: daily fire time (StartCalendarInterval / OnCalendar)
	env?: Record<string, string>; // service environment
	nice?: number; // process priority
	log: string; // stdout path (stderr follows unless logErr differs)
	logErr?: string; // distinct stderr path
}

// PATH chains — launchd/systemd give services a minimal PATH; these restore
// the user environment. Tokens resolved with home at resolveCtx time.
export const DARWIN_PATH =
	"__HOME__/.local/bin:__HOME__/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const LINUX_PATH =
	"__HOME__/.local/bin:__HOME__/.bun/bin:/usr/local/bin:/usr/bin:/bin";
// default merge ladder — fleet-loop's own default; override per machine with
// service-gen install --ladder '<project ladder with {branch}>'
export const DEFAULT_LADDER = "git merge --no-ff {branch}";

// the manifest — one entry per fleet service. Adding a service = adding an
// entry; both platforms get it on the next install.
export const SERVICES: Svc[] = [
	{
		name: "board",
		desc: "suspenders fleet board (:7799)",
		args: ["__PREFIX__/bin/fleet-board.ts"],
		kind: "daemon",
		keepAlive: true,
		runAtLoad: true,
		env: { SUSPENDERS_BIND: "0.0.0.0", PATH: "__PATH__" },
		log: "/tmp/fleet-board.log",
	},
	{
		name: "db-backup",
		desc: "daily governor.db GFS backup (10:00)",
		args: ["__PREFIX__/bin/db-backup.ts"],
		kind: "calendar",
		calendar: { hour: 10, minute: 0 },
		runAtLoad: true,
		log: "/tmp/governor-backup.log",
	},
	{
		name: "fleet-loop",
		desc: "Work Graph merge/dispatch loop",
		args: [
			"__PREFIX__/bin/fleet-loop.ts",
			"watch",
			"--repo",
			"__REPO__",
			"--ladder",
			"__LADDER__",
			"--every",
			"120",
		],
		kind: "daemon",
		keepAlive: true,
		runAtLoad: true,
		log: "/tmp/fleet-loop.log",
	},
	{
		name: "fleet-monitor",
		desc: "control-plane health monitor (--fix, 15-min)",
		args: ["__PREFIX__/bin/monitor.ts", "--fix"],
		kind: "interval",
		everySec: 900,
		runAtLoad: true,
		log: "/tmp/fleet-monitor.log",
	},
	{
		name: "harvest",
		desc: "session harvest pass (15-min)",
		args: ["__PREFIX__/bin/harvest.ts", "run", "--repo", "__REPO__"],
		kind: "interval",
		everySec: 900,
		runAtLoad: true,
		log: "/tmp/suspenders-harvest.log",
	},
	{
		name: "knowledge-api",
		desc: "knowledge layer read API",
		args: ["__PREFIX__/bin/knowledge-api.ts"],
		kind: "daemon",
		keepAlive: true,
		runAtLoad: true,
		log: "/tmp/suspenders-knowledge-api.log",
	},
	{
		name: "knowledge-worker",
		desc: "knowledge ingest queue worker (distill)",
		// distill target: local large model by default (owner 2026-09-30 —
		// knowledge ingest is a slow-queue chore, keep it off the paid cloud;
		// unset/override via env to route through belt instead)
		note: "distill target: local large model by default (owner 2026-09-30) — override INGEST_LLM_URL to route through belt instead",
		args: ["__PREFIX__/bin/knowledge-worker.ts"],
		kind: "daemon",
		keepAlive: true,
		env: { INGEST_LLM_URL: "http://127.0.0.1:8903" },
		log: "/tmp/suspenders-knowledge-worker.log",
	},
	{
		name: "llm-keepwarm",
		desc: "1-token keepwarm ping over the resident LLM fleet (4-min)",
		args: ["__PREFIX__/bin/llm-keepwarm.ts"],
		kind: "interval",
		everySec: 240,
		runAtLoad: true,
		nice: 10,
		log: "/tmp/llm-keepwarm.log",
		logErr: "/tmp/llm-keepwarm.err",
	},
];

// ---- naming: launchd label / systemd unit base ----
export const label = (s: Svc): string => `com.suspenders.${s.name}`;
export const unitBase = (s: Svc): string => `suspenders-${s.name}`;
// what install enables: daemons enable the service, timers enable the timer
export const systemdEnable = (s: Svc): string[] => [
	s.kind === "daemon" ? `${unitBase(s)}.service` : `${unitBase(s)}.timer`,
];

// ---- token substitution ----
const TOKEN = /__(BUN|HOME|PREFIX|REPO|LADDER|PATH)__/g;
export const subAll = (ctx: SvcCtx, text: string): string =>
	text.replaceAll(TOKEN, (_m, key) => ctx[key.toLowerCase() as keyof SvcCtx]);

// concrete context — bun defaults to THIS interpreter (the generator always
// runs under bun), path resolves its home tokens per target up front
export const resolveCtx = (
	target: SvcTarget,
	o: Partial<SvcCtx> = {},
): SvcCtx => {
	const home = o.home ?? process.env.HOME ?? "";
	const rawPath = target === "launchd" ? DARWIN_PATH : LINUX_PATH;
	return {
		bun: o.bun ?? process.execPath,
		home,
		prefix: o.prefix ?? "",
		repo: o.repo ?? process.cwd(),
		ladder: o.ladder ?? DEFAULT_LADDER,
		path: o.path ?? rawPath.replaceAll("__HOME__", home),
	};
};

// ---- launchd plist renderer (darwin) ----
const xmlEsc = (s: string): string =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// XML comments cannot carry "--" — normalize to em dashes
const commentSafe = (s: string): string => s.replaceAll(/--+/g, "—");

export const renderLaunchd = (s: Svc, ctx: SvcCtx): string => {
	const val = (t: string): string => subAll(ctx, t);
	const L: string[] = [];
	const pair = (k: string, v: string): void =>
		L.push(`  <key>${xmlEsc(k)}</key><string>${xmlEsc(v)}</string>`);
	const flag = (k: string): void => L.push(`  <key>${xmlEsc(k)}</key><true/>`);
	L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
	L.push(
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
	);
	L.push(`<plist version="1.0"><dict>`);
	if (s.note) L.push(`  <!-- ${commentSafe(val(s.note))} -->`);
	pair("Label", label(s));
	L.push(`  <key>ProgramArguments</key><array>`);
	L.push(`    <string>${xmlEsc(ctx.bun)}</string>`);
	for (const a of s.args) L.push(`    <string>${xmlEsc(val(a))}</string>`);
	L.push(`  </array>`);
	if (s.env && Object.keys(s.env).length > 0) {
		L.push(`  <key>EnvironmentVariables</key><dict>`);
		for (const [k, v] of Object.entries(s.env)) pair(k, val(v));
		L.push(`  </dict>`);
	}
	if (s.nice !== undefined) pair("Nice", String(s.nice));
	if (s.kind === "daemon") {
		if (s.keepAlive) flag("KeepAlive");
		if (s.runAtLoad) flag("RunAtLoad");
	} else if (s.kind === "interval") {
		pair("StartInterval", String(s.everySec));
		if (s.runAtLoad) flag("RunAtLoad");
	} else {
		L.push(`  <key>StartCalendarInterval</key><dict>`);
		pair("Hour", String(s.calendar?.hour));
		pair("Minute", String(s.calendar?.minute));
		L.push(`  </dict>`);
		if (s.runAtLoad) flag("RunAtLoad");
	}
	pair("StandardOutPath", val(s.log));
	pair("StandardErrorPath", val(s.logErr ?? s.log));
	L.push(`</dict></plist>`);
	return `${L.join("\n")}\n`;
};

// ---- systemd user-unit renderer (linux) ----
// quote for systemd ExecStart/Environment word-splitting: bare when the value
// is shell-safe, otherwise double-quoted with backslash escapes
const sdQuote = (s: string): string =>
	/^[\w@+=:,./-]+$/.test(s)
		? s
		: `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const calSpec = (c: { hour: number; minute: number }): string =>
	`*-*-* ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}:00`;

export interface SdUnits {
	unit: string; // suspenders-<name>.service content
	timer: string | null; // suspenders-<name>.timer content, null for daemons
}

export const renderSystemd = (s: Svc, ctx: SvcCtx): SdUnits => {
	const val = (t: string): string => subAll(ctx, t);
	const timed = s.kind !== "daemon";
	const head = (suffix: string): string[] => {
		const H = [`# ${unitBase(s)}${suffix} — ${s.desc}`];
		if (s.note) H.push(`# ${commentSafe(s.note)}`);
		return H;
	};
	const S: string[] = [`[Service]`];
	if (timed) S.push(`Type=oneshot`);
	for (const [k, v] of Object.entries(s.env ?? {}))
		S.push(`Environment=${sdQuote(`${k}=${val(v)}`)}`);
	S.push(
		`ExecStart=${sdQuote(ctx.bun)} ${s.args.map((a) => sdQuote(val(a))).join(" ")}`,
	);
	if (!timed)
		S.push(s.keepAlive ? `Restart=always` : `Restart=no`, `RestartSec=5s`);
	if (s.nice !== undefined) S.push(`Nice=${s.nice}`);
	S.push(
		`StandardOutput=append:${val(s.log)}`,
		`StandardError=append:${val(s.logErr ?? s.log)}`,
	);
	const tail = timed ? [] : [``, `[Install]`, `WantedBy=default.target`];
	const unit = [
		...head(".service"),
		``,
		`[Unit]`,
		`Description=${val(s.desc)}`,
		...S,
		...tail,
	]
		.join("\n")
		.concat("\n");
	let timer: string | null = null;
	if (timed) {
		// calendar → OnCalendar; interval → fire at activation then every N s.
		// Persistent=true is ignored for monotonic timers, applied to calendar.
		const sched =
			s.kind === "calendar"
				? [`OnCalendar=${calSpec(s.calendar)}`]
				: [`OnActiveSec=1s`, `OnUnitActiveSec=${s.everySec}s`];
		timer = [
			...head(".timer"),
			``,
			`[Unit]`,
			`Description=${val(s.desc)} (timer)`,
			``,
			`[Timer]`,
			...sched,
			`Persistent=true`,
			``,
			`[Install]`,
			`WantedBy=timers.target`,
		]
			.join("\n")
			.concat("\n");
	}
	return { unit, timer };
};
