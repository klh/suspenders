// hooks/lib/supervisor.ts — W266.1: the launchd supervision plane.
// `coord supervisor ensure` converges the repo's fleet services onto launchd
// (plist-from-template + governor.db row + realpath repo matching); the
// SessionStart hook injects the live supervisor fact + the exact fix command.
// launchd is macOS-only; everything degrades honestly elsewhere (CI, Linux):
// probe → UNKNOWN, ensure → refuses with a line, nothing throws.
//
// Injection points for tests: `runner` (launchctl/git), `dirs` (template dir,
// LaunchAgents dir) — no test touches the live launchd or the live governor.db.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

// ─── identity ────────────────────────────────────────────────────────────────

/** The repo a supervision row belongs to: realpath of the COMMON git dir —
 *  the exact projectIdentity() derivation (govdb.ts), parameterized so any
 *  worktree of one repo converges onto the same row. */
export const canonicalRepo = (dir: string, sh: Sh = realSh): string => {
	try {
		const r = sh(["git", "-C", dir, "rev-parse", "--git-common-dir"]);
		if (r.code === 0) {
			const d = r.out.trim();
			if (d) return realpathOf(resolve(dir, d));
		}
	} catch {}
	return realpathOf(dir);
};

const realpathOf = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

// ─── IO seams ────────────────────────────────────────────────────────────────

export interface RunResult {
	code: number;
	out: string;
}
export type Sh = (cmd: string[]) => RunResult;

const realSh: Sh = (cmd): RunResult => {
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`,
	};
};

/** Parsed `launchctl list` body: label → pid (null = loaded, not running). */
export type LaunchdTable = Map<string, number | null>;

/** `launchctl list` rows are `PID\tStatus\tLabel` — `-` PID = loaded but not
 *  running. Lines that do not parse (headers, noise) are skipped. */
export const parseLaunchctlList = (out: string): LaunchdTable => {
	const t: LaunchdTable = new Map();
	for (const line of out.split("\n")) {
		const cols = line.split("\t");
		if (cols.length < 3) continue;
		const pid = cols[0] === "-" ? null : Number(cols[0]);
		t.set(cols[cols.length - 1].trim(), Number.isFinite(pid) ? pid : null);
	}
	return t;
};

/** One probe for the whole plane: `launchctl list` → { ok, table }. ok=false
 *  = launchd unreachable (Linux/CI) — consumers render UNKNOWN, never a
 *  false alarm. */
export const launchctlTable = (
	sh: Sh = realSh,
): { ok: boolean; table: LaunchdTable } => {
	const r = sh(["launchctl", "list"]);
	return {
		ok: r.code === 0 || r.out.trim().length > 0,
		table: parseLaunchctlList(r.out),
	};
};

// ─── template rendering ──────────────────────────────────────────────────────

export interface PlistVars {
	bun: string;
	home: string;
	prefix: string;
	repo: string;
	beltUrl: string;
	beltToken: string;
}

/** Same substitution install.sh does, as data — __VAR__ tokens only, so a
 *  template can never smuggle shell into the render. */
export const plistVars = (v: PlistVars): Record<string, string> => ({
	__BUN__: v.bun,
	__HOME__: v.home,
	__PREFIX__: v.prefix,
	__REPO__: v.repo,
	__BELT_URL__: v.beltUrl,
	__BELT_TOKEN__: v.beltToken,
});

export const renderPlist = (
	template: string,
	vars: Record<string, string>,
): string => {
	let out = template;
	for (const [k, val] of Object.entries(vars)) out = out.split(k).join(val);
	return out;
};

/** Unrendered template = a landmine (launchd execs `__BUN__`). `ensure` refuses
 *  to install a plist that still carries a placeholder. */
export const hasUnrenderedVar = (text: string): boolean =>
	/__[A-Z_]+__/.test(text);

// ─── service discovery ───────────────────────────────────────────────────────

/** The templates THIS checkout ships: hooks/launchd/com.suspenders.<svc>.plist.
 *  Config-over-code — a template present = a service supervisable here. */
export const listServices = (launchdDir: string): string[] => {
	const out: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(launchdDir) as string[];
	} catch {
		return out; // no template dir → nothing supervisable here (honest empty)
	}
	for (const e of entries) {
		const m = /^com\.suspenders\.(.+)\.plist$/.exec(e);
		if (m) out.push(m[1]);
	}
	return out.sort();
};

export const labelOf = (service: string): string => `com.suspenders.${service}`;

export const serviceOf = (label: string): string | null => {
	const m = /^com\.suspenders\.(.+)$/.exec(label);
	return m ? m[1] : null;
};

// ─── governor.db rows ────────────────────────────────────────────────────────

export interface SupervisorRow {
	label: string;
	repo: string;
	plist: string;
	service: string;
	ts: number;
}

export const upsertSupervisor = (db: Database, row: SupervisorRow): void => {
	db.query(
		"INSERT INTO supervisors (label, repo, plist, service, ts) VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(label) DO UPDATE SET repo = excluded.repo, plist = excluded.plist, service = excluded.service, ts = excluded.ts",
	).run(row.label, row.repo, row.plist, row.service, row.ts);
};

export const supervisorRows = (db: Database): SupervisorRow[] =>
	db
		.query(
			"SELECT label, repo, plist, service, ts FROM supervisors ORDER BY label",
		)
		.all() as SupervisorRow[];

// ─── live status ─────────────────────────────────────────────────────────────

export type LiveState = "UP" | "DOWN" | "NOT-LOADED" | "UNKNOWN";

export interface SupervisorLive {
	label: string;
	service: string;
	repo: string;
	pid: number | null;
	state: LiveState;
	repoMatch: boolean;
}

/** Combine governor.db rows with one parsed `launchctl list` table. A row the
 *  table lacks = NOT-LOADED (bootout'd or never bootstrapped); a loaded row
 *  with no pid = DOWN (launchd gave up); pid = UP. probeOk=false (launchd
 *  unreachable, e.g. CI/Linux) → UNKNOWN for every row — honest, never a
 *  false alarm. Rows for OTHER repos carry repoMatch false — render dim. */
export const liveStates = (
	rows: SupervisorRow[],
	table: LaunchdTable,
	currentRepo: string | null,
	probeOk = true,
): SupervisorLive[] =>
	rows.map((r) => {
		const loaded = probeOk && table.has(r.label);
		const pid = probeOk ? (table.get(r.label) ?? null) : null;
		const state: LiveState = !probeOk
			? "UNKNOWN"
			: !loaded
				? "NOT-LOADED"
				: pid
					? "UP"
					: "DOWN";
		return {
			label: r.label,
			service: r.service || serviceOf(r.label) || r.label,
			repo: r.repo,
			pid,
			state,
			repoMatch: currentRepo === null || r.repo === currentRepo,
		};
	});

// ─── ensure ──────────────────────────────────────────────────────────────────

export interface EnsureOpts {
	db: Database;
	service: string;
	/** the repo the plist supervises — canonical, never a worktree */
	repo: string;
	launchdDir: string;
	launchAgentsDir: string;
	vars: Record<string, string>;
	sh?: Sh;
	now?: number;
}

export interface EnsureResult {
	ok: boolean;
	line: string;
	row?: SupervisorRow;
}

/** Converge ONE service: render its template → install to LaunchAgents →
 *  bootout (ignore) → bootstrap → upsert the governor.db row. Refuses a
 *  template that still carries an unrendered var and a non-macOS box. */
export const ensureSupervisor = (o: EnsureOpts): EnsureResult => {
	const sh = o.sh ?? realSh;
	const label = labelOf(o.service);
	const tpl = join(o.launchdDir, `${label}.plist`);
	if (!existsSync(tpl))
		return { ok: false, line: `✗ ${label} — no template at ${tpl}` };
	const rendered = renderPlist(readFileSync(tpl, "utf8"), o.vars);
	if (hasUnrenderedVar(rendered))
		return {
			ok: false,
			line: `✗ ${label} — template still carries a placeholder after render`,
		};
	const plistPath = join(o.launchAgentsDir, `${label}.plist`);
	mkdirSync(o.launchAgentsDir, { recursive: true });
	writeFileSync(plistPath, rendered);
	const uid = process.getuid?.() ?? 501;
	sh(["launchctl", "bootout", `gui/${uid}/${label}`]); // not loaded → exit≠0, fine
	const bs = sh(["launchctl", "bootstrap", `gui/${uid}`, plistPath]);
	const row: SupervisorRow = {
		label,
		repo: o.repo,
		plist: plistPath,
		service: o.service,
		ts: o.now ?? Date.now(),
	};
	upsertSupervisor(o.db, row);
	return {
		ok: bs.code === 0,
		line: `✓ ${label} ensured (${bs.code === 0 ? "bootstrapped" : `bootstrap exit ${bs.code}`})`,
		row,
	};
};

// ─── SessionStart injection ──────────────────────────────────────────────────

/** The supervisor FACT for a session's bootstrap packet — live status + the
 *  exact fix command. null = nothing to say (no rows, or launchd unreachable —
 *  UNKNOWN never cries wolf). Fires only on this repo's rows (repoMatch). */
export const supervisorFactLine = (
	live: SupervisorLive[],
	coordPath: string,
): string | null => {
	const mine = live.filter((l) => l.repoMatch);
	if (!mine.length || mine.some((l) => l.state === "UNKNOWN")) return null;
	const down = mine.filter((l) => l.state !== "UP");
	if (!down.length)
		return `SUPERVISOR ${mine.length} UP (${mine.map((l) => l.service).join(", ")})`;
	const names = down.map((l) => `${l.service} ${l.state}`).join(" · ");
	return `SUPERVISOR ${names} — fix: bun ${coordPath} supervisor ensure`;
};
