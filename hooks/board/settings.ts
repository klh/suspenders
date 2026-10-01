// hooks/board/settings.ts — W147 settings previews/apply + policy preview handlers (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { json } from "./helpers.ts";
import { formToPatch, valuesToPatch, policyBaseline } from "./console-view.ts";
import { scrub } from "../lib/servicemon.ts";
import {
	ConfigError,
	patchPolicyText,
	policyWritePath,
	readBoardSettings,
	applyBoardSettings,
	formToBoardSettings,
	boardSettingsPath,
	diffLines,
	atomicWrite,
} from "../lib/board-config.ts";
import type { BoardSettings } from "../lib/board-config.ts";
import { ConsoleMe, Feature, previewPage } from "../bin/console-html.ts";

export const htmlHdr = (): Record<string, string> => ({
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
});

// suspenders settings preview: validate the form patch, diff JSON-to-JSON
export const suspPreview = (f: URLSearchParams, me: ConsoleMe): Response => {
	const bad = (msg: string): Response => {
		const ea = {
			feature: "suspenders" as const,
			diff: [] as string[],
			valuesJson: "",
			mtimeMs: "0",
			target: readBoardSettings().path,
			error: msg,
		};
		return new Response(previewPage(ea, me), { headers: htmlHdr() });
	};
	try {
		const p = formToBoardSettings({
			status_refresh_s: f.get("status_refresh_s") ?? "",
			harvest_ttl_s: f.get("harvest_ttl_s") ?? "",
			default_actor: f.get("default_actor") ?? "",
		});
		return suspPreviewOk(p, me);
	} catch (e) {
		return bad(e instanceof Error ? e.message : String(e));
	}
};

// the OK path: merge patch over current settings, diff, render confirm page
export const suspPreviewOk = (p: BoardSettings, me: ConsoleMe): Response => {
	const cur = readBoardSettings();
	const merged = { ...cur.settings, ...p };
	for (const k of Object.keys(merged) as (keyof BoardSettings)[])
		if (merged[k] === undefined) delete merged[k];
	const curText = cur.exists
		? `${JSON.stringify(cur.settings, null, "\t")}\n`
		: "{}\n";
	const nextText = `${JSON.stringify(merged, null, "\t")}\n`;
	const a = {
		feature: "suspenders" as const,
		diff: diffLines(curText, nextText),
		valuesJson: JSON.stringify(p),
		mtimeMs: String(cur.mtimeMs),
		target: cur.path,
	};
	return new Response(previewPage(a, me), { headers: htmlHdr() });
};

// belt/buckle policy preview: line-patch the baseline, validate, diff
export const policyPreview = (
	feat: Feature,
	f: URLSearchParams,
	me: ConsoleMe,
): Response => {
	const bad = (msg: string): Response => {
		const ea = {
			feature: feat,
			diff: [] as string[],
			valuesJson: "",
			mtimeMs: "0",
			target: scrub(policyWritePath()),
			error: msg,
		};
		return new Response(previewPage(ea, me), { headers: htmlHdr() });
	};
	const base = policyBaseline();
	const patch = formToPatch(feat, f);
	try {
		const next = patchPolicyText(base.text, patch);
		const a = {
			feature: feat,
			diff: diffLines(base.text, next),
			valuesJson: JSON.stringify(patch),
			mtimeMs: String(base.mtimeMs),
			target: scrub(policyWritePath()),
		};
		return new Response(previewPage(a, me), { headers: htmlHdr() });
	} catch (e) {
		return bad(e instanceof Error ? e.message : String(e));
	}
};

// APPLY — the confirm step. feature + base64 values + preview mtime from the
// confirm form; VALIDATE FIRST (a bad config surfaces its parse error, not a
// guard conflict), then the mtime guard, then the atomic write.
export const settingsApply = (f: URLSearchParams): Response => {
	const feat = f.get("feature") ?? "";
	const mtime = Number(f.get("mtime") ?? "0");
	const values = Buffer.from(f.get("values") ?? "", "base64").toString("utf8");
	if (feat !== "belt" && feat !== "buckle" && feat !== "suspenders")
		return json({ ok: false, error: "unknown feature" }, 400);
	if (feat === "suspenders") {
		const patch = formToBoardSettings(
			JSON.parse(values) as Record<string, string>,
		);
		applyBoardSettings(boardSettingsPath(), patch, mtime);
	} else {
		const patch = valuesToPatch(values);
		const base = policyBaseline();
		if (Math.abs(base.mtimeMs - mtime) > 1)
			throw new ConfigError(
				"config changed since the preview — review the fresh diff and confirm again",
			);
		const next = patchPolicyText(base.text, patch);
		atomicWrite(policyWritePath(), next);
	}
	return new Response(null, {
		status: 303,
		headers: { location: "/console/settings" },
	});
};
