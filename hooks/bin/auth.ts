#!/usr/bin/env bun
// hooks/bin/auth.ts — W149 CLI issuance against the v8 identity tables.
//
//   auth.ts issue --actor A --class app-role|delegated [--team T]
//                 [--scopes s1,s2] [--name N] [--access-ttl-days N]
//                 [--refresh-ttl-days N] [--save BASE]
//   auth.ts revoke --jti J | --actor A | --team T
//   auth.ts list [--actor A]
//   auth.ts whoami --url URL --token-file BASE
//
// TTLs: explicit 0 = forever (expires_at NULL, the owner escape). Default
// with NO ttl flags: access 30d (the W194 bounded default — the lib also
// clamps any TTL at 365d, and rotation inherits the family's remaining
// refresh budget), refresh NULL (rotate-until-infinity) — the user
// convention.
// Raw tokens NEVER print to stdout unless --show is passed; --save BASE
// writes ~/.claude/local-llm/buckle-<BASE>.token + .refresh (mode 600) and
// output shows fingerprints only.
import { fingerprint, issueTokens, revoke } from "../lib/auth.ts";
import { saveTokenFiles } from "../lib/auth-client.ts";
import { openStore } from "../lib/govdb.ts";

const get = (flag: string): string | undefined => {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

const USAGE = `usage:
  auth.ts issue --actor A --class app-role|delegated [--team T] [--scopes s1,s2] [--name N] [--access-ttl-days N] [--refresh-ttl-days N] [--save BASE] [--show]
  auth.ts revoke --jti J | --actor A | --team T
  auth.ts list [--actor A]
  auth.ts whoami --url URL --token-file BASE`;
const days = (flag: string): number | null | undefined => {
	const v = get(flag);
	if (v === undefined) return undefined; // flag absent
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n * 86400_000 : null;
};
function cmdIssue(): number {
	const actor = get("--actor");
	const cls = get("--class") ?? "app-role";
	if (!actor) {
		console.error("--actor is required");
		return 2;
	}
	if (!["app-role", "delegated"].includes(cls)) {
		console.error("--class must be app-role or delegated");
		return 2;
	}
	const scopes = (get("--scopes") ?? "buckle:admin")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const aTtl = days("--access-ttl-days");
	const rTtl = days("--refresh-ttl-days");
	const pair = issueTokens(openStore(), {
		actor,
		team: get("--team") ?? null,
		token_class: cls as "app-role" | "delegated",
		scopes,
		name: get("--name") ?? null,
		accessTtlMs: aTtl === undefined ? 30 * 86400_000 : aTtl,
		refreshTtlMs: rTtl === undefined ? null : rTtl,
		via: "cli:auth.ts",
	});
	const save = get("--save");
	if (save)
		saveTokenFiles(save, { access: pair.access, refresh: pair.refresh });
	console.log(`issued pair for ${actor} (${cls})`);
	console.log(
		`  access  jti ${pair.jti}  exp ${pair.expires_at ?? "forever"}  ${fingerprint(pair.access)}`,
	);
	console.log(
		`  refresh jti ${pair.refresh_jti}  exp ${pair.refresh_expires_at ?? "forever"}  ${fingerprint(pair.refresh)}`,
	);
	if (save)
		console.log(
			`  saved   buckle-${save}.token + .refresh in the local-llm secrets home (0600)`,
		);
	if (get("--show")) {
		console.log(`ACCESS:\n${pair.access}`);
		console.log(`REFRESH:\n${pair.refresh}`);
	}
	return 0;
}
function cmdRevoke(): number {
	const sel = { jti: get("--jti"), actor: get("--actor"), team: get("--team") };
	if (!sel.jti && !sel.actor && !sel.team) {
		console.error("revoke needs --jti, --actor, or --team");
		return 2;
	}
	const out = revoke(openStore(), sel, "cli:auth.ts");
	console.log(
		`revoked ${out.changes} token row(s) (${sel.jti ? `jti=${sel.jti}` : sel.actor ? `actor=${sel.actor}` : `team=${sel.team}`})`,
	);
	return 0;
}

function cmdList(): number {
	const store = openStore();
	const actor = get("--actor");
	const where = actor ? "WHERE actor = ?" : "";
	const rows = store
		.query(
			`SELECT key_id, actor, team, token_type, parent_key_id, scopes, expires_at, rotated_at, revoked_at, created_at FROM api_keys ${where} ORDER BY created_at DESC LIMIT 100`,
		)
		.all(...(actor ? [actor] : [])) as {
		key_id: string;
		actor: string | null;
		team: string | null;
		token_type: string;
		parent_key_id: string | null;
		scopes: string | null;
		expires_at: number | null;
		rotated_at: number | null;
		revoked_at: number | null;
		created_at: number;
	}[];
	console.log(
		["key_id", "actor", "type", "expires", "state", "scopes"].join("\t"),
	);
	for (const r of rows) {
		const state = r.revoked_at
			? "revoked"
			: r.rotated_at
				? "rotated"
				: "active";
		console.log(
			[
				r.key_id.slice(0, 8),
				r.actor,
				r.token_type,
				r.expires_at ? new Date(r.expires_at).toISOString() : "forever",
				state,
				r.scopes ?? "",
			].join("\t"),
		);
	}
	return 0;
}
async function cmdWhoami(): Promise<number> {
	const url = get("--url");
	const base = get("--token-file");
	if (!url || !base) {
		console.error("whoami needs --url and --token-file");
		return 2;
	}
	const { loadTokenFiles } = await import("../lib/auth-client.ts");
	const pair = loadTokenFiles(base);
	if (!pair) {
		console.error(
			`no buckle-${base}.token/.refresh in the local-llm secrets home`,
		);
		return 2;
	}
	const r = await fetch(`${url}/auth/whoami`, {
		headers: { authorization: `Bearer ${pair.access}` },
	});
	const b = (await r.json()) as Record<string, unknown>;
	console.log(JSON.stringify(b, null, 2));
	return r.ok ? 0 : 1;
}

const cmd = process.argv[2];
const commands: Record<string, () => number | Promise<number>> = {
	issue: cmdIssue,
	revoke: cmdRevoke,
	list: cmdList,
	whoami: cmdWhoami,
};
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
	console.error(USAGE);
	process.exit(2);
}
process.exit(await fn());
