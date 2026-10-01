// db-backup.ts — rolling backups of governor.db: daily generations for
// 1-7 days, plus the 14-day, 1-month, and 3-month generations. Snapshots via
// `VACUUM INTO` — a consistent SQLite read that includes WAL contents, safe
// against concurrent fleet writers. Every run also prints a sanity line from
// the fresh snapshot (integrity + work_items count) so a corrupt or empty
// backup is visible at a glance. Grandfather-father-son rotation: keep the
// newest snapshot per generation slot, delete older duplicates and anything
// beyond 90 days.
// usage: bun db-backup.ts [--home <dir>] [--dest <dir>]
//   (defaults: $HOME, ~/Library/Application Support/governor-backups)
import { Database } from "bun:sqlite";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1] : undefined;
};
const HOME = arg("--home") ?? process.env.HOME ?? "";
const DEST =
	arg("--dest") ??
	join(HOME, "Library", "Application Support", "governor-backups");
const SRC = join(HOME, ".cache", "claude-governor", "governor.db");
const DAY = 86_400_000;

if (!SRC || !existsSync(SRC)) {
	console.error(`db-backup: no governor.db at ${SRC}`);
	process.exit(1);
}
mkdirSync(DEST, { recursive: true });

// ---- snapshot: consistent read incl. WAL ----
const stamp = Date.now();
const out = join(DEST, `governor-${stamp}.db`);
const src = new Database(SRC, { readonly: true });
src.exec(`VACUUM INTO '${out}'`);
src.close();

// ---- sanity: the backup must open, pass integrity, hold rows ----
const check = new Database(out, { readonly: true });
const integrity =
	(
		check.query("PRAGMA integrity_check").get() as
			| { integrity_check: string }
			| undefined
	)?.integrity_check ?? "missing";
const items = (
	check.query("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }
).n;
const sessions = (
	check.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
).n;
check.close();
console.log(
	`db-backup: ${out} (integrity ${integrity}, ${items} work items, ${sessions} sessions)`,
);
if (integrity !== "ok") {
	console.error(
		`db-backup: SNAPSHOT FAILED INTEGRITY — investigate before rotation`,
	);
	process.exit(2);
}

// ---- W166: knowledge.db rides along — checkpoint (fold the WAL into the
// main file so the copy is self-contained), then copy .db + -wal. Copies go
// through copyFileSync (kernel-side clone/stream — no whole-file buffer).
const KB = join(HOME, ".cache", "claude-governor", "knowledge.db");
if (existsSync(KB)) {
	const kdb = new Database(KB);
	const ck = kdb.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
		busy: number;
	};
	kdb.close();
	const kout = join(DEST, `knowledge-${stamp}.db`);
	copyFileSync(KB, kout);
	const kbWal = `${KB}-wal`;
	if (existsSync(kbWal)) copyFileSync(kbWal, `${kout}-wal`);
	const kcheck = new Database(kout, { readonly: true });
	const kint =
		(
			kcheck.query("PRAGMA integrity_check").get() as
				| { integrity_check?: string }
				| undefined
		)?.integrity_check ?? "missing";
	const krows = (
		kcheck.query("SELECT COUNT(*) AS n FROM knowledge").get() as { n: number }
	).n;
	kcheck.close();
	console.log(
		`db-backup: ${kout} (checkpoint busy=${ck?.busy ?? "?"}, integrity ${kint}, ${krows} knowledge rows)`,
	);
	if (kint !== "ok")
		console.error(
			`db-backup: knowledge SNAPSHOT FAILED INTEGRITY — investigate`,
		);
}

// ---- W178: the hub identity secrets ride along — signing key, rotation ring
// and issued token files, 0600 into identity-<stamp>/ (dir 0700). governor.db
// snapshots already carry api_keys/auth_events; without THESE files a restore
// means whole-fleet re-enrollment. Two generations kept — restoring yesterday's
// key beats re-minting every lane's trust after a same-day loss.
const ID_SRC =
	process.env.BUCKLE_SECRETS_HOME ?? join(HOME, ".claude", "local-llm");
const idDir = join(DEST, `identity-${stamp}`);
const idFiles = existsSync(ID_SRC)
	? readdirSync(ID_SRC).filter((f) =>
			/^buckle-(jwt\.key|jwt-ring\.json|[\w.-]+\.token|[\w.-]+\.refresh)$/.test(
				f,
			),
		)
	: [];
if (idFiles.length) {
	mkdirSync(idDir, { recursive: true, mode: 0o700 });
	chmodSync(idDir, 0o700);
	for (const f of idFiles) {
		copyFileSync(join(ID_SRC, f), join(idDir, f));
		chmodSync(join(idDir, f), 0o600);
	}
	console.log(`db-backup: ${idDir} (${idFiles.length} identity file(s), 0600)`);
}

// ---- GFS rotation: generation slots in days, newest per slot wins ----
type Snap = { ts: number; file: string; ageD: number };
const snaps: Snap[] = readdirSync(DEST)
	.filter((f) => /^governor-\d+\.db$/.test(f))
	.map((f) => ({
		ts: Number(f.slice(9, -3)),
		file: f,
		ageD: (stamp - Number(f.slice(9, -3))) / DAY,
	}))
	.sort((a, b) => b.ts - a.ts);
const slots: [number, number][] = [
	[0, 1], // today — kept until tomorrow's snapshot exists
	[1, 2],
	[2, 3],
	[3, 4],
	[4, 5],
	[5, 6],
	[6, 7], // daily 1-7
	[7, 15], // the 14-day generation
	[15, 31], // the 1-month generation
	[31, 93], // the 3-month generation
];
const keep = new Set<number>();
for (const [lo, hi] of slots) {
	const s = snaps.find((x) => x.ageD >= lo && x.ageD < hi);
	if (s) keep.add(s.ts);
}
let removed = 0;
for (const s of snaps) {
	if (!keep.has(s.ts)) {
		unlinkSync(join(DEST, s.file));
		removed++;
	}
}
// W166 — knowledge snapshots rotate on the SAME slots (newest per slot
// wins); a -wal companion rides its .db out.
const ksnaps: Snap[] = readdirSync(DEST)
	.filter((f) => /^knowledge-\d+\.db$/.test(f))
	.map((f) => ({
		ts: Number(f.slice(10, -3)),
		file: f,
		ageD: (stamp - Number(f.slice(10, -3))) / DAY,
	}));
const kkeep = new Set<number>();
for (const [lo, hi] of slots) {
	const s = ksnaps.find((x) => x.ageD >= lo && x.ageD < hi);
	if (s) kkeep.add(s.ts);
}
for (const s of ksnaps) {
	if (!kkeep.has(s.ts)) {
		unlinkSync(join(DEST, s.file));
		if (existsSync(join(DEST, `${s.file}-wal`)))
			unlinkSync(join(DEST, `${s.file}-wal`));
		removed++;
	}
}
// W178 — identity generations: newest TWO survive (yesterday's key is the
// fallback when today's backup captured a just-corrupted key).
const idDirs = readdirSync(DEST)
	.filter((f) => /^identity-\d+$/.test(f))
	.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
for (const d of idDirs.slice(2)) rmSync(join(DEST, d), { recursive: true });
writeFileSync(join(DEST, "last-backup.txt"), `${stamp}\n`);
if (removed)
	console.log(
		`db-backup: rotated out ${removed} snapshot(s), ${snaps.length - removed} kept`,
	);
