// identity-split.test.ts — W156 test matrix (federation doc, Identity plane
// separation): the v10→v11 move against a REAL SQLite fixture (synthesized
// v10-shaped store with identity rows — the same objects the live hub
// carries), the port rebinding (openIdentity), the /identity statement route
// on the store server, the control-plane rejection, split-brain refusal,
// idempotency, and the backup anchor. Temp-HOME + ?query import busts bun's
// module cache so this file's govdb binds the temp HOME, never the real
// governor.db.
import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w156-"));
process.env.HOME = HOME;
const REGD = join(HOME, ".cache", "claude-governor");
mkdirSync(REGD, { recursive: true });

const gov = await import(
	`../hooks/lib/govdb.ts?w156=${encodeURIComponent(HOME)}`
);
const idbmod = await import(
	`../hooks/lib/identity-db.ts?w156=${encodeURIComponent(HOME)}`
);

const GOV = join(REGD, "governor.db");
const IDB = join(REGD, "identity.db");

// v8 schemas for the PRE-split fixture — derived from the migration's own
// IDENTITY_DDL (single source of truth), idb. prefixes stripped.
const V8 = Object.values(idbmod.IDENTITY_DDL)
	.flat()
	.map((s: string) => s.replaceAll("idb.", ""));
const CP_DDL =
	"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')";

function fixture(): void {
	for (const f of [
		"governor.db",
		"governor.db-wal",
		"identity.db",
		"identity.db-wal",
	]) {
		try {
			rmSync(join(REGD, f));
		} catch {}
	}
	const db = new Database(GOV);
	db.exec([...V8, CP_DDL].join("; "));
	db.run("PRAGMA user_version = 10");
	const now = 1_700_000_000_000;
	db.query(
		"INSERT INTO api_keys (key_id, key_hash, jti, name, team, actor, token_type, created_at) VALUES ('k-acc', 'sha256:aa', 'jti-acc', 'owner', 'platform', 'klh', 'access', ?)",
	).run(now);
	db.query(
		"INSERT INTO api_keys (key_id, key_hash, jti, name, team, actor, token_type, parent_key_id, created_at) VALUES ('k-ref', 'sha256:bb', 'jti-ref', 'owner', 'platform', 'klh', 'refresh', 'k-acc', ?)",
	).run(now);
	db.query(
		"INSERT INTO teams (team_id, name, department, created_at) VALUES ('platform', 'Platform', 'Infrastructure', ?)",
	).run(now);
	db.query(
		"INSERT INTO auth_events (ts, actor, event, jti, via) VALUES (?, 'klh', 'issued', 'jti-acc', 'test')",
	).run(now);
	db.query(
		"INSERT INTO auth_events (ts, actor, event, jti, via) VALUES (?, 'klh', 'issued', 'jti-ref', 'test')",
	).run(now);
	db.query(
		"INSERT INTO sessions (sid, project, role, started_at, hb) VALUES ('s1', 'proj', 'lane', ?, ?)",
	).run(now, now);
	db.close();
}

const countIn = (file: string, sql: string): number => {
	const db = new Database(file, { readonly: true });
	const n = Number((db.query(sql).get() as { n: number }).n);
	db.close();
	return n;
};
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const cnt = (file: string, tbl: string): number =>
	countIn(file, `SELECT COUNT(*) n FROM ${tbl}`);
const uvOf = (file: string): number => {
	const db = new Database(file, { readonly: true });
	const r = db.query("PRAGMA user_version").get() as { user_version: number };
	db.close();
	return r.user_version;
};

test("v10→v11 postconditions: uv, rows moved, governor clean, session intact, backup anchor", () => {
	fixture();
	gov.openGovernorDb().close(); // the migration run
	expect(uvOf(GOV)).toBe(11);
	expect(cnt(IDB, "api_keys")).toBe(2);
	expect(cnt(IDB, "teams")).toBe(1);
	expect(cnt(IDB, "auth_events")).toBe(2);
	// identity tables gone from governor.db
	const govdb = new Database(GOV, { readonly: true });
	const gone = govdb
		.query(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'teams', 'api_keys', 'auth_events', 'ceilings')",
		)
		.all();
	expect(gone).toEqual([]);
	govdb.close();
	// non-identity data stayed put
	expect(cnt(GOV, "sessions")).toBe(1);
	// the rollback anchor exists
	const baks = readdirSync(REGD).filter((f) =>
		f.startsWith("governor-pre-identity-split-"),
	);
	expect(baks.length).toBeGreaterThan(0);
});

test("idempotent re-open: uv stays 11, no re-copy, no duplicate backup", () => {
	const before = cnt(IDB, "api_keys");
	const baksBefore = readdirSync(REGD).filter((f) =>
		f.startsWith("governor-pre-identity-split-"),
	).length;
	gov.openGovernorDb().close();
	gov.openGovernorDb().close();
	expect(cnt(IDB, "api_keys")).toBe(before);
	expect(uvOf(GOV)).toBe(11);
	const baksAfter = readdirSync(REGD).filter((f) =>
		f.startsWith("governor-pre-identity-split-"),
	).length;
	expect(baksAfter).toBe(baksBefore);
});

test("split-brain refusal: rows on both sides refuse loudly, no silent guess", () => {
	// fixture + one migration pass leaves governor clean, identity populated —
	// now inject a row back into governor.db (as if a rogue writer re-created
	// the old tables) and the next open must refuse.
	const g = new Database(GOV);
	g.exec(V8.join("; "));
	g.query(
		"INSERT INTO api_keys (key_id, key_hash, jti, created_at) VALUES ('rogue', 'sha256:zz', 'jti-rogue', 1)",
	).run();
	// the refusal rides the MIGRATION — reset uv so the next open re-runs it
	g.run("PRAGMA user_version = 10");
	g.close();
	expect(() => gov.openGovernorDb()).toThrow(
		/governor\.db AND identity\.db both hold identity rows/,
	);
});

// one store-server per test — port-0 probe trick (auth.test pattern), caller
// kills the process. The server gets a CLEAN sub-HOME: the shared fixture
// HOME may hold a deliberately poisoned split-brain state at this point.
async function spawnStore(): Promise<{
	p: ReturnType<typeof Bun.spawn>;
	url: string;
}> {
	const home = join(
		HOME,
		`store-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(join(home, ".cache", "claude-governor"), { recursive: true });
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = s.port;
	s.stop(true);
	const p = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "..", "hooks", "bin", "store-server.ts"),
			"--port",
			String(port),
		],
		{
			env: { ...process.env, HOME: home },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) return { p, url };
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	p.kill();
	throw new Error("store server did not come up");
}

test("identitySqlViolation: identity words rejected on /rpc, word-in-string accepted", () => {
	const v = idbmod.identitySqlViolation;
	expect(v("SELECT * FROM api_keys")).toBe("api_keys");
	expect(v("UPDATE teams SET name = name")).toBe("teams");
	expect(v("DELETE FROM auth_events")).toBe("auth_events");
	expect(v("SELECT * FROM users")).toBe("users");
	expect(v("SELECT * FROM ceilings")).toBe("ceilings");
	// a word inside a string literal is legit control-plane SQL over the WORD
	expect(
		v("SELECT payload FROM events WHERE payload LIKE '%api_keys%'"),
	).toBeNull();
	expect(v("SELECT pk FROM deltas WHERE tbl = 'teams'")).toBeNull();
});

test("the /identity port rides the store server: statements flow over HTTP", async () => {
	const { p, url } = await spawnStore();
	try {
		process.env.IDENTITY_STORE_URL = url;
		const pstore = gov.openIdentity();
		pstore
			.query(
				"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('port', 'sha256:pp', 1)",
			)
			.run();
		const row = pstore
			.query("SELECT key_id FROM api_keys WHERE key_id = 'port'")
			.get() as { key_id: string };
		expect(row.key_id).toBe("port");
	} finally {
		p.kill();
		delete process.env.IDENTITY_STORE_URL;
	}
});

test("plane guards on the wire: /rpc refuses identity SQL, /identity refuses knowledge SQL", async () => {
	const { p, url } = await spawnStore();
	try {
		const post = async (path: string, sql: string): Promise<string> => {
			const r = await fetch(`${url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "get", sql, params: [] }),
			});
			const j = (await r.json()) as { err?: string };
			return j.err ?? "";
		};
		const idRej = await post("/rpc", "SELECT * FROM api_keys");
		expect(idRej).toContain("bind the identity port");
		const kbRej = await post("/identity", "SELECT * FROM knowledge");
		expect(kbRej).toContain("bind the knowledge port");
		// control-plane SQL still flows on /rpc (the W166 byte-compat case)
		const ok = await post("/rpc", "SELECT 1 AS n");
		expect(ok).toBe("");
	} finally {
		p.kill();
	}
});

test("auth lib rides the post-split identity store: issue + verify + revoke denylist", async () => {
	const auth = await import(`../hooks/lib/auth.ts?w156auth${process.pid}`);
	process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");
	const istore = gov.openIdentity();
	const pair = auth.issueTokens(istore, {
		actor: "w156-lane",
		team: "platform",
		token_class: "app-role",
		scopes: ["read_route"],
		name: null,
	});
	expect(pair.jti).toBeTruthy();
	const reqLike = {
		headers: {
			get: (n: string) =>
				n.toLowerCase() === "authorization" ? `Bearer ${pair.access}` : null,
		},
	};
	const v = await auth.verifyJwt(reqLike, "read_route", { store: istore });
	expect(v.ok).toBe(true);
	auth.revoke(istore, { jti: pair.jti }, "test");
	const v2 = await auth.verifyJwt(reqLike, "read_route", { store: istore });
	expect(v2.ok).toBe(false);
});
