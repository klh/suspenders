// hooks/lib/admin-audit.ts — W174: the who/when trail for admin mutations.
// The deltas log mirrors every row write but cannot attribute intent — a
// settings apply, policy edit, or key revocation lands here with the ACTOR
// that drove it (JWT sub on /auth/revoke, console actor on settings applies)
// and the selector/target. Reader feeds /api/console/audit + the settings
// page's audit section. Schema: hooks/lib/govdb.ts (deltas triggers cover it).
import type { Database } from "bun:sqlite";
import type { GovernorStore } from "./govdb.ts";

export interface AdminAction {
	// the driver of the action, not its subject: on a revoke this is the
	// admin's JWT sub, the subject rides detail
	actor: string | null;
	action: string; // settings.apply | policy.apply | keys.revoke
	target: string | null;
	detail: string | null;
}

export interface AdminAuditRow {
	id: number;
	ts: number;
	actor: string | null;
	action: string;
	target: string | null;
	detail: string | null;
}

export function adminAudit(store: GovernorStore, a: AdminAction): void {
	store
		.query(
			"INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
		)
		.run(Date.now(), a.actor, a.action, a.target, a.detail);
}

// recent trail for the console (rows are small; LIMIT bounds the read)
export function recentAdminAudit(db: Database, limit = 25): AdminAuditRow[] {
	return db
		.query(
			"SELECT id, ts, actor, action, target, detail FROM admin_audit ORDER BY id DESC LIMIT ?",
		)
		.all(limit) as AdminAuditRow[];
}
