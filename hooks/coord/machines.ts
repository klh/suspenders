// hooks/coord/machines.ts — W176 `coord machine` verb group: the machine
// capability registry CLI. Handlers mirror the coord/*.ts layout; the pure
// read/rank logic they share with fleet-loop dispatch lives in
// lib/machines.ts (ONE source of truth for routing).
import { hostname } from "node:os";
import { CAPABILITIES } from "../lib/govdb.ts";
import {
	pickMachine,
	machineFresh,
	beefyScore,
	parseRoles,
	type MachineRow,
} from "../lib/machines.ts";
import { arg, db, die, dim, projectIdentity } from "./shared.ts";

const CAPS = new Set(CAPABILITIES);

const ev = (kind: string, scope: string, payload: string): void => {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload) VALUES (?, ?, ?, ?, ?)",
	).run(Date.now(), "coord:machine", kind, scope, payload);
};

const getMachine = (name: string): MachineRow | null =>
	db
		.query("SELECT * FROM machines WHERE name = ?")
		.get(name) as MachineRow | null;

const now = (): number => Date.now();

const upsert = (
	name: string,
	host: string,
	roles: string | null,
	cpu: number | null,
	ram: number | null,
	gpu: string | null,
	storeUrl: string | null,
	sid: string | null,
): void => {
	const t = now();
	db.query(
		"INSERT INTO machines (name, host, roles, cpu_cores, ram_gb, gpu, store_url, state, last_hb, origin_sid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET host = excluded.host, roles = excluded.roles, cpu_cores = excluded.cpu_cores, ram_gb = excluded.ram_gb, gpu = excluded.gpu, store_url = excluded.store_url, state = 'active', last_hb = excluded.last_hb, origin_sid = excluded.origin_sid, updated_at = excluded.updated_at",
	).run(name, host, roles, cpu, ram, gpu, storeUrl, t, sid, t, t);
};

export async function cmdMachine(rest: string[]): Promise<void> {
	const verb = rest[0] ?? "list";
	if (verb === "register") return cmdMachineRegister(rest.slice(1));
	if (verb === "list") return cmdMachineList(rest.slice(1));
	if (verb === "remove") return cmdMachineRemove(rest.slice(1));
	if (verb === "heartbeat") return cmdMachineHeartbeat(rest.slice(1));
	if (verb === "route") return cmdMachineRoute(rest.slice(1));
	die(
		"machine: unknown verb — try register | list | remove | heartbeat | route",
	);
}

const usage = (): never =>
	die(
		"usage: machine register <name> [--host h] [--roles a,b] [--cpu n] [--ram n] [--gpu s] [--store-url u] [--as sid]\n" +
			"       machine list [--json]\n" +
			"       machine remove <name>\n" +
			"       machine heartbeat <name>\n" +
			"       machine route [--item Wn] [--need a,b] [--json]",
	);

const cmdMachineRegister = (rest: string[]): void => {
	const name = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
	if (!name) usage();
	const rolesArg = arg("--roles");
	if (rolesArg) {
		const bad = rolesArg
			.split(",")
			.filter(Boolean)
			.filter((r) => !CAPS.has(r.trim()));
		if (bad.length)
			die(
				`unknown role: ${bad.join(",")} — vocabulary: ${[...CAPS].join(",")}`,
			);
	}
	const roles = rolesArg
		? rolesArg
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean)
				.join(",")
		: null;
	upsert(
		name,
		arg("--host") ?? hostname(),
		roles,
		arg("--cpu") ? Number(arg("--cpu")) : null,
		arg("--ram") ? Number(arg("--ram")) : null,
		arg("--gpu"),
		arg("--store-url"),
		arg("--as"),
	);
	ev("machine.registered", name, JSON.stringify({ roles }));
	console.log(
		`✓ machine ${name} registered (${arg("--host") ?? hostname()}${roles ? `, roles: ${roles}` : ""})`,
	);
};

const cmdMachineHeartbeat = (rest: string[]): void => {
	const name = rest[0];
	if (!name) usage();
	if (!getMachine(name))
		die(`machine ${name} not registered — machine register ${name} first`);
	const t = now();
	db.query(
		"UPDATE machines SET last_hb = ?, updated_at = ? WHERE name = ?",
	).run(t, t, name);
	console.log(`♥ ${name} hb ${t}`);
};

const cmdMachineRemove = (rest: string[]): void => {
	const name = rest[0];
	if (!name) usage();
	if (!getMachine(name)) die(`machine ${name} not registered`);
	db.query(
		"UPDATE machines SET state = 'retired', updated_at = ? WHERE name = ?",
	).run(now(), name);
	ev("machine.retired", name, "");
	console.log(`✓ machine ${name} retired`);
};

const cmdMachineList = (rest: string[]): void => {
	const wantJson = rest.includes("--json");
	const rows = db
		.query("SELECT * FROM machines ORDER BY name")
		.all() as MachineRow[];
	if (wantJson) {
		console.log(JSON.stringify(rows));
		return;
	}
	for (const m of rows) {
		const fresh = machineFresh(m.last_hb, now());
		const score =
			m.cpu_cores != null && m.ram_gb != null
				? String(m.cpu_cores * m.ram_gb)
				: "?";
		const dimMarker = m.state === "retired" || !fresh ? dim : (s: string) => s;
		console.log(
			`${m.state === "retired" ? "○" : fresh ? "●" : "◌"} ${m.name} ${dimMarker(`[${m.roles ?? "no-roles"}] cpu:${m.cpu_cores ?? "?"} ram:${m.ram_gb ?? "?"} score:${score} ${m.state} hb:${fresh ? "fresh" : "stale"}`)}`,
		);
	}
	if (rows.length === 0)
		console.log(
			"(no machines registered — machine register <name> --roles a,b --cpu n --ram n)",
		);
};

const cmdMachineRoute = (rest: string[]): void => {
	const item = arg("--item");
	const needArg = arg("--need");
	const wantJson = rest.includes("--json");
	let need: string[] = [];
	if (needArg) {
		const bad = needArg
			.split(",")
			.filter(Boolean)
			.filter((r) => !CAPS.has(r.trim()));
		if (bad.length)
			die(
				`unknown capability: ${bad.join(",")} — vocabulary: ${[...CAPS].join(",")}`,
			);
		need = needArg
			.split(",")
			.map((r) => r.trim())
			.filter(Boolean);
	} else if (item) {
		const it = db
			.query("SELECT requires FROM work_items WHERE id = ? AND project = ?")
			.get(item, projectIdentity()) as { requires: string | null } | null;
		if (!it) die(`work item ${item} not found in ${projectIdentity()}`);
		need = parseRoles(it.requires);
	}
	const pick = pickMachine(db, need, now());
	if (!pick.machine) die(`no capable machine: ${pick.reason}`);
	const m = pick.machine;
	if (wantJson) {
		console.log(
			JSON.stringify({
				machine: m.name,
				host: m.host,
				need,
				score: beefyScore(m),
			}),
		);
		return;
	}
	ev(
		"machine.routed",
		item ?? m.name,
		JSON.stringify({ item, machine: m.name, need }),
	);
	console.log(
		`→ ${m.name} (${m.host}) score:${beefyScore(m)} need:[${need.join(",") || "any"}]`,
	);
};
