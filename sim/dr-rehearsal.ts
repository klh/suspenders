#!/usr/bin/env bun
// sim/dr-rehearsal.ts — W178: the hub identity backup/DR + key-rotation
// REHEARSAL. A live drill on throwaway state: sandboxed HOME + secrets home,
// a real db-backup run, a real destroy, a real restore, real rotations with
// grace windows. Reds exit non-zero; greens print evidence lines.
//
//   bun sim/dr-rehearsal.ts
//
// Scenarios:
//   1. backup → destroy → restore → verify (the DR loop)
//   2. rotation with grace: old tokens live until retire_at, then 401
//   3. emergency grace-0 kill + opaque-refresh self-heal
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let red = 0;
const ok = (cond: boolean, label: string): void => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		red++;
		console.log(`  ✗ RED ${label}`);
	}
};

// env BEFORE any repo import — govdb binds the registry dir at module load
const HOME = mkdtempSync(join(tmpdir(), "w178-dr-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");
process.env.GOVERNOR_STORE_URL = "local";
const DEST = join(HOME, "backups");

// ---- seed: a real identity in the sandbox ----------------------------------
const { openStore } = await import("../hooks/lib/govdb.ts");
const auth = await import("../hooks/lib/auth.ts");
const { saveTokenFiles } = await import("../hooks/lib/auth-client.ts");
const store = openStore();
const req = (tok: string) => ({
	headers: {
		get: (n: string) =>
			n.toLowerCase() === "authorization" ? `Bearer ${tok}` : null,
	},
});
const pair = auth.issueTokens(store, {
	actor: "lane:dr-rehearsal",
	token_class: "app-role",
	scopes: ["buckle:admin"],
	accessTtlMs: 3_600_000,
	refreshTtlMs: null,
});
saveTokenFiles("dr-rehearsal", { access: pair.access, refresh: pair.refresh });
console.log(`[1] seeded sandbox ${HOME} — pair for lane:dr-rehearsal issued`);

// ---- [2] real db-backup run against the sandbox -----------------------------
console.log("\n[2] db-backup (governor.db + knowledge ride-along + identity)");
const p = Bun.spawnSync(
	[
		"bun",
		join(import.meta.dir, "..", "hooks", "bin", "db-backup.ts"),
		"--home",
		HOME,
		"--dest",
		DEST,
	],
	{ env: process.env, stdout: "pipe", stderr: "pipe" },
);
const backupOut = p.stdout.toString() + p.stderr.toString();
console.log(
	backupOut
		.trim()
		.split("\n")
		.map((l) => `    ${l}`)
		.join("\n"),
);
ok(p.exitCode === 0, "db-backup exited 0");
ok(backupOut.includes("integrity ok"), "governor snapshot integrity ok");
ok(backupOut.includes("identity file(s)"), "identity secrets rode along");

const idDirs = readdirSync(DEST)
	.filter((f) => /^identity-\d+$/.test(f))
	.sort();
ok(idDirs.length === 1, `one identity generation (${idDirs.join(", ")})`);
const idDir = join(DEST, idDirs[0] ?? "x");
const idFiles = readdirSync(idDir).sort();
ok(idFiles.includes("buckle-jwt.key"), "signing key captured");
ok(idFiles.includes("buckle-dr-rehearsal.token"), "token file captured");
ok(
	(statSync(join(idDir, "buckle-jwt.key")).mode & 0o777) === 0o600,
	"captured key at mode 0600",
);

// ---- [3] destroy: the disaster ----------------------------------------------
console.log("\n[3] destroy — secrets home AND governor.db, gone");
rmSync(join(HOME, "secrets"), { recursive: true });
for (const f of ["governor.db", "governor.db-wal", "governor.db-shm"])
	rmSync(join(HOME, ".cache", "claude-governor", f), { force: true });
ok(!existsSync(join(HOME, "secrets")), "secrets home gone");
ok(
	!existsSync(join(HOME, ".cache", "claude-governor", "governor.db")),
	"governor.db gone",
);

// ---- [4] restore from the backup --------------------------------------------
console.log("\n[4] restore — identity files + db snapshot copied back");
mkdirSync(join(HOME, "secrets"), { recursive: true, mode: 0o700 });
cpSync(idDir, join(HOME, "secrets"), { recursive: true });
const govSnap = readdirSync(DEST).find((f) => /^governor-\d+\.db$/.test(f));
ok(govSnap !== undefined, "governor snapshot present for restore");
cpSync(
	join(DEST, govSnap ?? "x"),
	join(HOME, ".cache", "claude-governor", "governor.db"),
);
auth.resetAuthCache(); // next key read comes from the RESTORED files
const restored = openStore(); // fresh handle on the restored db
const restoredCount = (
	restored.query("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }
).n;
ok(restoredCount > 0, `restored db holds identity rows (${restoredCount})`);
ok(
	(
		await auth.verifyJwt(req(pair.access), undefined, {
			store: restored,
		})
	).ok,
	"pre-loss access token verifies against RESTORED key + db",
);

// ---- [5] rotation with a grace window ---------------------------------------
console.log("\n[5] rotate-key --grace-hours 2 (drilled at 2s) — zero downtime");
const gracePair = auth.issueTokens(restored, {
	actor: "lane:post-restore",
	token_class: "app-role",
	scopes: ["buckle:admin"],
	accessTtlMs: 3_600_000,
	refreshTtlMs: null,
});
const rot = auth.rotateSigningKey(2000); // 2s grace — the drill shortens it
ok(
	rot.graceUntil !== null,
	`rotated to ${rot.kid}, grace until ${new Date(rot.graceUntil ?? 0).toISOString()}`,
);
ok(
	(await auth.verifyJwt(req(gracePair.access), undefined, { store: restored }))
		.ok,
	"token signed by the now-retired key verifies DURING grace",
);
const post = await auth.verifyJwt(req(gracePair.access), undefined, {
	store: restored,
	now: () => Date.now() + 5000,
});
ok(
	!post.ok && post.code === "bad_signature",
	"after retire_at: 401 bad_signature",
);
const afterPair = auth.issueTokens(restored, {
	actor: "lane:post-rotation",
	token_class: "app-role",
	scopes: ["buckle:admin"],
	accessTtlMs: 3_600_000,
	refreshTtlMs: null,
});
ok(
	(await auth.verifyJwt(req(afterPair.access), undefined, { store: restored }))
		.ok,
	"fresh token after rotation verifies (signed by the new key)",
);

// ---- [6] emergency kill (grace 0) + opaque-refresh self-heal ----------------
console.log("\n[6] rotate-key --grace-hours 0 — old tokens die at once");
const killPair = auth.issueTokens(restored, {
	actor: "lane:kill",
	token_class: "app-role",
	scopes: ["buckle:admin"],
	accessTtlMs: 3_600_000,
	refreshTtlMs: null,
});
auth.rotateSigningKey(0);
const dead = await auth.verifyJwt(req(killPair.access), undefined, {
	store: restored,
});
ok(
	!dead.ok && dead.code === "bad_signature",
	"grace 0: old token dead immediately",
);
const healed = auth.rotateRefresh(restored, killPair.refresh);
ok(healed.ok, "opaque refresh token survives the key kill — client self-heals");
if (healed.ok)
	ok(
		(await auth.verifyJwt(req(healed.access), undefined, { store: restored }))
			.ok,
		"refreshed access token verifies under the new key",
	);

// ---- summary -----------------------------------------------------------------
console.log(`\nsummary: ${pass} pass, ${red} red — exit ${red ? 1 : 0}`);
process.exit(red ? 1 : 0);
