import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { die, arg, db, dim, cyan, green } from "./shared.ts";
import {
	formatSessionLabel,
	normalizeTool,
	parseSessionTags,
	slugifyLabelPart,
	llmShorthand,
} from "../lib/addressing.ts";
import { emitEvent, broadcastNote, isLiveSession } from "./bus.ts";

interface SessionRow {
	sid: string;
	project: string | null;
	role: string | null;
	parent_sid: string | null;
	worktree: string | null;
	hb: number;
	state: string;
	capabilities: string | null;
	transcript_path: string | null;
	actor: string | null;
	tags: string | null;
}

const DIRECT_MESSAGE_KIND = ["NO", "TE"].join("");

export interface SessionTarget {
	sid: string;
	label: string;
	hub: string;
	tool: string;
	sessionName: string;
	model: string | null;
	modelShorthand: string | null;
	project: string | null;
	role: string | null;
	parent_sid: string | null;
	worktree: string | null;
	actor: string | null;
	tags: Record<string, unknown>;
	capabilities: string[];
	hb: number;
}

const NAME_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"adding",
	"build",
	"building",
	"bug",
	"by",
	"cli",
	"create",
	"creating",
	"feature",
	"fix",
	"fixing",
	"for",
	"from",
	"implement",
	"implementing",
	"in",
	"item",
	"lane",
	"of",
	"on",
	"session",
	"task",
	"the",
	"to",
	"update",
	"updating",
	"with",
	"work",
]);

const safeText = (value: string | null | undefined): string =>
	value?.trim() ?? "";

const factValue = (key: string): string | null =>
	(
		db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string;
		} | null
	)?.value ?? null;

const targetRows = (now = Date.now()): SessionRow[] =>
	(
		db
			.query(
				"SELECT sid, project, role, parent_sid, worktree, hb, state, capabilities, transcript_path, actor, tags FROM sessions WHERE state = 'RUNNING' ORDER BY hb DESC, sid",
			)
			.all() as SessionRow[]
	).filter((row) => isLiveSession(row, now));

function readTranscriptModel(path: string | null | undefined): string | null {
	if (!path || !existsSync(path)) return null;
	let fd: number | null = null;
	try {
		const size = statSync(path).size;
		if (!size) return null;
		fd = openSync(path, "r");
		const take = Math.min(size, 64 * 1024);
		const start = size - take;
		const buf = Buffer.allocUnsafe(take);
		readSync(fd, buf, 0, take, start);
		for (const line of buf.toString("utf8").split("\n").reverse()) {
			if (!line.includes('"model"')) continue;
			try {
				const parsed = JSON.parse(line) as {
					message?: { model?: string };
					model?: string;
				};
				const model =
					typeof parsed.message?.model === "string"
						? parsed.message.model
						: typeof parsed.model === "string"
							? parsed.model
							: null;
				if (safeText(model)) return model;
			} catch {}
		}
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function latestWorkItemName(sid: string): string | null {
	const row = db
		.query(
			"SELECT id, title FROM work_items WHERE owner_sid = ? AND state NOT IN ('DONE','SUPERSEDED','FAILED') ORDER BY updated_at DESC LIMIT 1",
		)
		.get(sid) as { id: string; title: string | null } | null;
	if (!row) return null;
	const id = slugifyLabelPart(row.id, row.id.toLowerCase());
	const words = safeText(row.title)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter((word) => !NAME_STOPWORDS.has(word))
		.filter((word) => word !== id);
	const suffix = words.slice(-2).join("-");
	return suffix ? `${id}-${suffix}` : id;
}

function latestClaimName(sid: string): string | null {
	const rows = db
		.query(
			"SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4",
		)
		.all(sid) as { intent: string | null }[];
	const claim = rows.find(
		(row) =>
			safeText(row.intent) &&
			!String(row.intent).startsWith("restored by monitor") &&
			String(row.intent) !== "work-graph",
	);
	return claim?.intent ? slugifyLabelPart(claim.intent, sid.slice(0, 8)) : null;
}

function sessionNameFor(row: SessionRow): string {
	const tags = parseSessionTags(row.tags);
	for (const name of [
		tags.session_name,
		tags.sessionName,
		tags.name,
		latestWorkItemName(row.sid),
		latestClaimName(row.sid),
	]) {
		if (typeof name === "string" && safeText(name))
			return slugifyLabelPart(name, row.sid.slice(0, 8));
	}
	const worktreeName = safeText(row.worktree).split("/").pop();
	if (worktreeName) return slugifyLabelPart(worktreeName, row.sid.slice(0, 8));
	return slugifyLabelPart(row.sid.slice(0, 8), "session");
}

function hubFor(row: SessionRow, tags: Record<string, unknown>): string {
	const tagged = [
		tags.hub,
		tags.hub_id,
		tags.hubId,
		tags.host,
		tags.host_id,
		tags.hostId,
	].find((value) => typeof value === "string" && safeText(value));
	if (typeof tagged === "string") return slugifyLabelPart(tagged, "local");
	const exec = factValue(`lane.${row.sid}.executor`);
	if (exec?.startsWith("llm:")) {
		const parts = exec.split(":");
		if (parts[1]) return slugifyLabelPart(parts[1], "local");
	}
	return "local";
}

function toolFor(row: SessionRow, tags: Record<string, unknown>): string {
	const explicit = [
		tags.tool,
		tags.cli,
		tags.dialect,
		tags.executor,
		tags.agent,
	].find((value) => typeof value === "string" && safeText(value));
	if (typeof explicit === "string") {
		const normalized = normalizeTool(explicit);
		if (normalized) return normalized;
	}
	const exec = factValue(`lane.${row.sid}.executor`);
	if (exec) {
		const normalized = normalizeTool(exec);
		if (normalized) return normalized;
	}
	const pathish =
		`${row.transcript_path ?? ""} ${row.worktree ?? ""}`.toLowerCase();
	if (pathish.includes("copilot")) return "copilot";
	if (pathish.includes("/.codex/") || pathish.includes("codex")) return "codex";
	if (pathish.includes("grok")) return "grok";
	return "claude";
}

function modelFor(
	row: SessionRow,
	tags: Record<string, unknown>,
): string | null {
	const tagged = [tags.model, tags.llm, tags.model_name, tags.modelName].find(
		(value) => typeof value === "string" && safeText(value),
	);
	if (typeof tagged === "string") return tagged;
	const fromFact = factValue(`lane.${row.sid}.model`);
	if (fromFact) return fromFact;
	return readTranscriptModel(row.transcript_path);
}

function toTarget(row: SessionRow): SessionTarget {
	const tags = parseSessionTags(row.tags);
	const hub = hubFor(row, tags);
	const tool = toolFor(row, tags);
	const sessionName = sessionNameFor(row);
	const model = modelFor(row, tags);
	return {
		sid: row.sid,
		label: formatSessionLabel({
			sid: row.sid,
			project: row.project,
			role: row.role,
			worktree: row.worktree,
			actor: row.actor,
			tags,
			capabilities: row.capabilities,
			parent_sid: row.parent_sid,
			transcript_path: row.transcript_path,
			hub,
			tool,
			sessionName,
			model,
		}),
		hub,
		tool,
		sessionName,
		model,
		modelShorthand: llmShorthand(model),
		project: row.project,
		role: row.role,
		parent_sid: row.parent_sid,
		worktree: row.worktree,
		actor: row.actor,
		tags,
		capabilities: safeText(row.capabilities)
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
		hb: row.hb,
	};
}

export function listLiveTargets(now = Date.now()): SessionTarget[] {
	return targetRows(now).map(toTarget);
}

function matchesNeedle(target: SessionTarget, needle: string): boolean {
	const q = needle.toLowerCase();
	return (
		target.label.toLowerCase().includes(q) ||
		target.sid.toLowerCase().includes(q)
	);
}

function resolveTarget(needle: string): SessionTarget {
	const live = listLiveTargets();
	const q = needle.toLowerCase();
	const exact = live.filter(
		(target) =>
			target.sid.toLowerCase() === q || target.label.toLowerCase() === q,
	);
	if (exact.length === 1) return exact[0];
	const prefix = live.filter((target) =>
		target.sid.toLowerCase().startsWith(q),
	);
	if (exact.length === 0 && prefix.length === 1) return prefix[0];
	const matches = live.filter((target) => matchesNeedle(target, needle));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0)
		die(`no live session target matching ${JSON.stringify(needle)}`);
	die(
		`ambiguous target ${JSON.stringify(needle)} — ${matches
			.map((target) => `${target.label} ${target.sid}`)
			.join(" | ")}`,
	);
}

export async function cmdTargets(rest: string[]): Promise<void> {
	const filter = arg("--filter")?.toLowerCase() ?? null;
	const wantJson = rest.includes("--json");
	let targets = listLiveTargets();
	if (filter)
		targets = targets.filter(
			(target) =>
				target.label.toLowerCase().includes(filter) ||
				target.sid.toLowerCase().includes(filter),
		);
	if (wantJson) {
		console.log(JSON.stringify(targets, null, 2));
		return;
	}
	if (!targets.length) {
		console.log(dim("(no live targets)"));
		return;
	}
	const width = Math.max(...targets.map((target) => target.label.length));
	console.log(`${"LABEL".padEnd(width)}  SID`);
	for (const target of targets)
		console.log(`${cyan(target.label.padEnd(width))}  ${target.sid}`);
}

export async function cmdMessage(rest: string[]): Promise<void> {
	const source = arg("--as") ?? "unknown";
	const all = rest[0] === "--all";
	if (all) {
		const text = rest[1];
		if (!text) die('usage: message --all "text" [--as sid]');
		const sent = broadcastNote(text, source);
		console.log(
			`${green("✓")} ${dim(`message broadcast ${sent.id} → ${sent.targets} live session(s)`)}`,
		);
		return;
	}
	const needle = rest[0];
	const text = rest[1];
	if (!needle || !text)
		die('usage: message <target-label-or-sid-or-substring> "text" [--as sid]');
	const target = resolveTarget(needle);
	const id = emitEvent({
		kind: DIRECT_MESSAGE_KIND,
		note: text,
		source,
		to: target.sid,
	});
	console.log(
		`${green("✓")} ${dim(`message queued #${id} → ${target.label} @${target.sid.slice(0, 8)}`)}`,
	);
}
