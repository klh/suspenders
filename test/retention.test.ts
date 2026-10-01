// test/retention.test.ts — W174: archive-before-delete retention + the
// admin_audit trail helpers + revoke initiator attribution. HOME is a temp
// dir set BEFORE the dynamic imports (the auth.test.ts pattern — govdb binds
// REG at module load).
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	utimesSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const HOME = mkdtempSync(join(process.cwd(), ".w174-home-"));
process.env.HOME = HOME;

afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

// ?home= cache-busts the module (the govdb-migration.test.ts pattern): bun
// shares module instances across test files, so the plain specifier can be
// bound to another suite's HOME — this keeps a PRIVATE governor.db here
const govdb = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const retention = await import("../hooks/lib/retention.ts");
const auditMod = await import("../hooks/lib/admin-audit.ts");
const auth = await import("../hooks/lib/auth.ts");

const DAY = 86_400_000;
const now = Date.now();
const db = govdb.openGovernorDb();
// pinned archive target — HOME races between bun test files must not move it
const ARCHIVE = join(HOME, ".cache", "claude-governor", "archive");

describe("retention", () => {
	test("events: old rows archived to NDJSON, fresh stay", () => {
		db.query("INSERT INTO events (ts, source, kind) VALUES (?, ?, ?)").run(
			now - 40 * DAY,
			"t",
			"old.event",
		);
		db.query("INSERT INTO events (ts, source, kind) VALUES (?, ?, ?)").run(
			now,
			"t",
			"new.event",
		);
		const n = retention.archiveAndPrune(db, {
			table: "events",
			tsCol: "ts",
			cut: now - 30 * DAY,
			dir: ARCHIVE,
			cols: ["id", "ts", "source", "kind", "scope", "payload", "target"],
		});
		expect(n).toBe(1);
		const cnt = (q: string): number => (db.query(q).get() as { n: number }).n;
		expect(
			cnt("SELECT COUNT(*) AS n FROM events WHERE kind = 'old.event'"),
		).toBe(0);
		expect(
			cnt("SELECT COUNT(*) AS n FROM events WHERE kind = 'new.event'"),
		).toBe(1);
		expect(readdirSync(ARCHIVE).some((f) => f.startsWith("events-"))).toBe(
			true,
		);
	});
});

describe("retention: NDJSON fidelity + idempotence", () => {
	test("archived lines carry the row verbatim; rerun archives nothing", () => {
		const files = readdirSync(ARCHIVE);
		const evFile = join(
			ARCHIVE,
			files.find((f) => f.startsWith("events-")) as string,
		);
		const lines = readFileSync(evFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		const row = lines.find((r) => r.kind === "old.event");
		expect(row).toBeDefined();
		expect(row?.source).toBe("t");
		const n = retention.archiveAndPrune(db, {
			table: "events",
			tsCol: "ts",
			cut: now - 30 * DAY,
			dir: ARCHIVE,
			cols: ["id", "ts", "source", "kind", "scope", "payload", "target"],
		});
		expect(n).toBe(0);
	});
});

describe("retention: per-table windows", () => {
	test("route_audit ages out at its cut; fresh row stays", () => {
		db.query(
			"INSERT INTO route_audit (rid, ts, actor, decision) VALUES (?, ?, ?, ?)",
		).run("r1", now - 100 * DAY, "a", "routed");
		db.query(
			"INSERT INTO route_audit (rid, ts, actor, decision) VALUES (?, ?, ?, ?)",
		).run("r2", now, "a", "routed");
		const n = retention.archiveAndPrune(db, {
			table: "route_audit",
			tsCol: "ts",
			cut: now - 90 * DAY,
			dir: ARCHIVE,
			cols: [
				"rid",
				"ts",
				"actor",
				"dialect",
				"hint",
				"candidates",
				"resolved_target",
				"decision",
				"latency_class",
				"error_code",
			],
		});
		expect(n).toBe(1);
		expect(
			(db.query("SELECT COUNT(*) AS n FROM route_audit").get() as { n: number })
				.n,
		).toBe(1);
		expect(readdirSync(ARCHIVE).some((f) => f.startsWith("route_audit-"))).toBe(
			true,
		);
	});

	test("usage_rollup, auth_events, admin_audit each age on their own cut", () => {
		db.query(
			"INSERT INTO usage_rollup (hour_bucket, actor, model, model_group) VALUES (?, ?, ?, ?)",
		).run(now - 200 * DAY, "u", "m", "g");
		db.query("INSERT INTO auth_events (ts, actor, event) VALUES (?, ?, ?)").run(
			now - 200 * DAY,
			"v",
			"issued",
		);
		db.query(
			"INSERT INTO admin_audit (ts, actor, action) VALUES (?, ?, ?)",
		).run(now - 400 * DAY, "x", "settings.apply");
		const ur = retention.archiveAndPrune(db, {
			table: "usage_rollup",
			tsCol: "hour_bucket",
			cut: now - 180 * DAY,
			dir: ARCHIVE,
			cols: [
				"hour_bucket",
				"actor",
				"model",
				"model_group",
				"in_tok",
				"out_tok",
				"cache_r",
				"cache_c",
				"requests",
			],
		});
		expect(ur).toBe(1);
		expect(
			(
				db.query("SELECT COUNT(*) AS n FROM usage_rollup").get() as {
					n: number;
				}
			).n,
		).toBe(0);
		const ae = retention.archiveAndPrune(db, {
			table: "auth_events",
			tsCol: "ts",
			cut: now - 180 * DAY,
			dir: ARCHIVE,
			cols: ["id", "ts", "actor", "event", "jti", "via"],
		});
		expect(ae).toBe(1);
		const aa = retention.archiveAndPrune(db, {
			table: "admin_audit",
			tsCol: "ts",
			cut: now - 365 * DAY,
			dir: ARCHIVE,
			cols: ["id", "ts", "actor", "action", "target", "detail"],
		});
		expect(aa).toBe(1);
	});
});

describe("admin audit trail", () => {
	test("adminAudit insert + recentAdminAudit read-back", () => {
		auditMod.adminAudit(db, {
			actor: "klh",
			action: "policy.apply",
			target: "/tmp/policy.yaml",
			detail: "{}",
		});
		const rows = auditMod.recentAdminAudit(db, 5);
		const hit = rows.find((r) => r.action === "policy.apply");
		expect(hit?.actor).toBe("klh");
		expect(hit?.ts).toBeGreaterThan(now - 60_000);
	});
	test("revoke records the driver, not just the subject", () => {
		db.query(
			"INSERT INTO api_keys (key_id, key_hash, jti, actor, token_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("k1", "h1", "jti-w", "victim", "access", now);
		const out = auth.revoke(db, { actor: "victim" }, "test", "admin1");
		// changes double-counts via the deltas trigger (bun sqlite counts
		// trigger effects) — the honest check is the row state itself
		expect(out.changes).toBeGreaterThanOrEqual(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM api_keys WHERE actor = 'victim' AND revoked_at IS NOT NULL",
					)
					.get() as { n: number }
			).n,
		).toBe(1);
		const via = (
			db
				.query(
					"SELECT via FROM auth_events WHERE event = 'revoked' ORDER BY id DESC LIMIT 1",
				)
				.get() as { via: string }
		).via;
		expect(via).toContain("by=admin1");
		const row = auditMod
			.recentAdminAudit(db, 5)
			.find((r) => r.action === "keys.revoke");
		expect(row?.actor).toBe("admin1");
		expect(row?.target).toBe("actor=victim");
	});
});

describe("retention: the archive itself ages", () => {
	test("pruneArchiveFiles removes stale files, keeps fresh ones", () => {
		const dir = ARCHIVE;
		const stale = join(dir, "route_audit-stale.ndjson");
		const fresh = join(dir, "route_audit-fresh.ndjson");
		writeFileSync(stale, "{}\n");
		writeFileSync(fresh, "{}\n");
		utimesSync(
			stale,
			new Date(Date.now() - 400 * DAY),
			new Date(Date.now() - 400 * DAY),
		);
		const n = retention.pruneArchiveFiles(365, ARCHIVE);
		expect(n).toBeGreaterThanOrEqual(1);
		expect(readdirSync(dir).includes("route_audit-stale.ndjson")).toBe(false);
		expect(readdirSync(dir).includes("route_audit-fresh.ndjson")).toBe(true);
	});
});
