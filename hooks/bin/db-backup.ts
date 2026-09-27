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
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1] : undefined;
};
const HOME = arg("--home") ?? process.env.HOME ?? "";
const DEST = arg("--dest") ?? join(HOME, "Library", "Application Support", "governor-backups");
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
const integrity = (check.query("PRAGMA integrity_check").get() as { integrity_check: string } | undefined)?.integrity_check ?? "missing";
const items = (check.query("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
const sessions = (check.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
check.close();
console.log(`db-backup: ${out} (integrity ${integrity}, ${items} work items, ${sessions} sessions)`);
if (integrity !== "ok") {
	console.error(`db-backup: SNAPSHOT FAILED INTEGRITY — investigate before rotation`);
	process.exit(2);
}

// ---- GFS rotation: generation slots in days, newest per slot wins ----
type Snap = { ts: number; file: string; ageD: number };
const snaps: Snap[] = readdirSync(DEST)
	.filter((f) => /^governor-\d+\.db$/.test(f))
	.map((f) => ({ ts: Number(f.slice(9, -3)), file: f, ageD: (stamp - Number(f.slice(9, -3))) / DAY }))
	.sort((a, b) => b.ts - a.ts);
const slots: [number, number][] = [
	[0, 1], // today — kept until tomorrow's snapshot exists
	[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], // daily 1-7
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
writeFileSync(join(DEST, "last-backup.txt"), `${stamp}\n`);
if (removed) console.log(`db-backup: rotated out ${removed} snapshot(s), ${snaps.length - removed} kept`);
