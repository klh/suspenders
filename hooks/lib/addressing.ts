import { basename } from "node:path";

export interface SessionLabelInput {
	sid: string;
	project?: string | null;
	role?: string | null;
	worktree?: string | null;
	actor?: string | null;
	tags?: string | Record<string, unknown> | null;
	capabilities?: string | null;
	parent_sid?: string | null;
	transcript_path?: string | null;
	hub?: string | null;
	tool?: string | null;
	sessionName?: string | null;
	model?: string | null;
}

type TagMap = Record<string, unknown>;

const tagString = (tags: TagMap, keys: string[]): string | null => {
	for (const key of keys) {
		const value = tags[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
};

export function parseSessionTags(
	tags: SessionLabelInput["tags"],
): Record<string, unknown> {
	if (!tags) return {};
	if (typeof tags === "string") {
		try {
			const parsed = JSON.parse(tags) as unknown;
			return typeof parsed === "object" && parsed !== null
				? (parsed as TagMap)
				: {};
		} catch {
			return {};
		}
	}
	return typeof tags === "object" && tags !== null ? tags : {};
}

export function slugifyLabelPart(
	value: string | null | undefined,
	fallback = "session",
): string {
	const cleaned = (value ?? "")
		.toLowerCase()
		.trim()
		.replace(/["']/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return cleaned || fallback;
}

export function llmShorthand(model: string | null | undefined): string | null {
	const raw = model?.trim();
	if (!raw) return null;
	const normalized = raw.toLowerCase().replace(/^[a-z0-9_.-]+\//, "");
	if (normalized.includes("opus")) return "opus";
	if (normalized.includes("sonnet")) return "sonnet";
	if (normalized.includes("haiku")) return "haiku";
	if (normalized.includes("grok")) return "grok";
	if (normalized.includes("gemini")) return "gemini";
	if (normalized.includes("luna")) return "luna";
	if (normalized.includes("flash")) return "flash";
	if (/(local|swarm|ollama|llama|gguf|hermes)/.test(normalized)) return "local";
	if (/^(gpt|o\d)/.test(normalized) || normalized.includes("chatgpt"))
		return "gpt";
	if (normalized.includes("claude")) return "claude";
	const first = normalized.split(/[^a-z0-9]+/).find(Boolean);
	return first ? slugifyLabelPart(first, "model") : null;
}

export function normalizeTool(value: string | null | undefined): string | null {
	const raw = value?.trim();
	if (!raw) return null;
	const normalized = raw.toLowerCase();
	if (normalized.startsWith("llm:")) return "llm";
	if (normalized.includes("copilot")) return "copilot";
	if (normalized.includes("codex")) return "codex";
	if (normalized.includes("grok")) return "grok";
	if (normalized.includes("claude")) return "claude";
	return slugifyLabelPart(normalized, "tool");
}

export function inferTool(session: SessionLabelInput): string {
	const tags = parseSessionTags(session.tags);
	const explicit =
		session.tool ??
		tagString(tags, ["tool", "cli", "dialect", "executor", "agent"]);
	const normalized = normalizeTool(explicit);
	if (normalized) return normalized;
	const pathish = `${session.transcript_path ?? ""} ${session.worktree ?? ""}`
		.toLowerCase()
		.trim();
	if (pathish.includes("copilot")) return "copilot";
	if (pathish.includes("/.codex/") || pathish.includes("codex")) return "codex";
	if (pathish.includes("grok")) return "grok";
	if (pathish.includes("/.claude/") || pathish.includes("claude"))
		return "claude";
	return "claude";
}

export function inferHub(session: SessionLabelInput): string {
	const tags = parseSessionTags(session.tags);
	const explicit =
		session.hub ??
		tagString(tags, ["hub", "hub_id", "hubId", "host", "host_id", "hostId"]);
	return slugifyLabelPart(explicit ?? "local", "local");
}

export function inferModel(session: SessionLabelInput): string | null {
	const tags = parseSessionTags(session.tags);
	return (
		session.model ??
		tagString(tags, ["model", "llm", "model_name", "modelName"])
	);
}

export function inferSessionName(session: SessionLabelInput): string {
	const tags = parseSessionTags(session.tags);
	const explicit =
		session.sessionName ??
		tagString(tags, [
			"session_name",
			"sessionName",
			"name",
			"work_item",
			"workItem",
		]);
	if (explicit)
		return slugifyLabelPart(explicit, slugifyLabelPart(session.sid));
	const worktreeBase = basename(session.worktree ?? "").trim();
	if (worktreeBase)
		return slugifyLabelPart(worktreeBase, slugifyLabelPart(session.sid));
	return slugifyLabelPart(session.sid.slice(0, 8), "session");
}

export function formatSessionLabel(session: SessionLabelInput): string {
	const hub = inferHub(session);
	const tool = inferTool(session);
	const sessionName = inferSessionName(session);
	const shorthand = llmShorthand(inferModel(session));
	return `[${hub}][${tool}]-${sessionName}${shorthand ? ` (${shorthand})` : ""}`;
}
