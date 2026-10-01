// hooks/board/routes-usage.ts — usage surfaces: /usage /api/usage (W157 route module).
// The fetch fragment moved verbatim (route order preserved by the
// entry's handler list); returns null when nothing matches.
import { db } from "./context.ts";
import { json } from "./helpers.ts";
import { maybeHarvest } from "../bin/usage-harvest.ts";
import { buildUsageReport } from "../lib/usage.ts";
import { buildUsageCsv } from "../lib/usage-export.ts";
import { usagePage } from "../bin/usage-page-html.ts";

export async function handleUsage(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/usage") {
		// W127 phase 3: the server-rendered analytics page (same data path
		// as /api/usage: TTL-gated harvest then buildUsageReport)
		maybeHarvest(db);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		const team = url.searchParams.get("team") ?? "";
		const dept = url.searchParams.get("dept") ?? "";
		return new Response(
			usagePage(
				buildUsageReport(db, {
					days: Math.min(90, Math.max(1, d)),
					team,
					dept,
				}),
				{
					days: Math.min(90, Math.max(1, d)),
					team,
					dept,
				},
			),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (url.pathname === "/api/usage") {
		// W127: Copilot-style usage analytics — TTL-gated transcript harvest
		// (usage-harvest.ts, never a daemon) then the pure report builder
		// (lib/usage.ts). ?days=N clamps to 1..90.
		maybeHarvest(db);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		return json({
			ok: true,
			report: buildUsageReport(db, {
				days: Math.min(90, Math.max(1, d)),
				team: url.searchParams.get("team") ?? "",
				dept: url.searchParams.get("dept") ?? "",
			}),
		});
	}
	if (url.pathname === "/api/usage/export.csv") {
		// W179.1: the per-actor/license billing export — same data path as
		// /api/usage (TTL-gated harvest, then the pure CSV builder), same
		// query params (?days ?team ?dept), served as a download so the
		// dashboard view and its export never disagree.
		maybeHarvest(db);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		const days = Math.min(90, Math.max(1, d));
		const csv = buildUsageCsv(db, {
			days,
			team: url.searchParams.get("team") ?? "",
			dept: url.searchParams.get("dept") ?? "",
		});
		return new Response(csv, {
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="usage-${days}d.csv"`,
				"cache-control": "no-store",
			},
		});
	}
	return null;
}
