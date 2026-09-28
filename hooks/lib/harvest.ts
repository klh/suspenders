// hooks/lib/harvest.ts — transcript harvester: turns lane mistakes into fleet
// curriculum candidates. Parses claude lane transcripts (~/.claude/projects)
// and codex rollouts (~/.codex/sessions) that belong to THIS repo's worktrees,
// extracts typed mistake signals, clusters them into cross-lane patterns.
// W77 doctrine: the harvest is MECHANICAL — signals are quotes from real
// transcripts, never LLM retellings; lesson.* facts stay hand-curated (the
// report surfaces candidates; a human promotes), consult_kb takes harvest
// rows directly (owner 2026-09-28: harvest worker logs -> kb).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SignalKind =
	| "permission-denial"
	| "gate-denial"
	| "command-fail"
	| "tool-error";

export type Signal = {
	kind: SignalKind;
	subject: string; // coarse cluster identity (normalized)
	detail: string; // evidence — a quote, capped
	backend: "claude" | "codex";
	item: string; // worktree item id, e.g. "W76"
	ts: number;
};

export type Cluster = {
	key: string; // "<kind>|<subject>"
	kind: SignalKind;
	subject: string;
	detail: string; // longest evidence quote in the cluster
	items: string[]; // distinct worktrees that hit it
	count: number;
	lastTs: number;
};

export type TranscriptRef = {
	backend: "claude" | "codex";
	path: string;
	item: string;
};

// claude project-dir naming: every non-alphanumeric becomes "-"
export function mungePath(p: string): string {
	return p.replaceAll(/[^A-Za-z0-9]/g, "-");
}

// ---- classification (markers anchored on real gate/harness strings) ----

const RE_PERMISSION =
	/requested permissions|haven'?t granted|was blocked\. For security|requires approval|require approval/i;
const RE_GATE = /STOP-GATE|edit-enforce|denied by policy|governor denies/i;
const RE_CMDFAIL = /Exit code [1-9]|command not found|ENOENT/i;

// collapse volatile ids so two lanes hitting the same mistake share a subject
function shape(path: string): string {
	const seg = path.split("/").filter(Boolean);
	const tail = seg.slice(-2).join("/");
	return tail.replaceAll(/\d+/g, "#");
}

function firstLine(text: string, cap = 80): string {
	const line = (text.split("\n").find((l) => l.trim()) ?? "")
		.trim()
		.replace(/[.:;,!?]+$/, ""); // trailing punctuation breaks term overlap
	return line.length > cap ? line.slice(0, cap) : line;
}

export function classify(text: string): { kind: SignalKind; subject: string } {
	const t = text.slice(0, 800); // classification reads the head only
	if (RE_PERMISSION.test(t)) {
		// "requested permissions to read from <path>" / "use <Tool>" /
		// "<tool> in '<path>' was blocked" — each branch extracts its own shape
		const read = t.match(/requested permissions to read from (\S+?),/i);
		const use = read
			? null
			: t.match(/requested permissions to use (\S+?)[,.]/i);
		const blocked =
			read || use ? null : t.match(/([a-z]+) in '([^']+)' was blocked/i);
		const m = read ?? use ?? blocked;
		if (!m) return { kind: "permission-denial", subject: firstLine(t, 48) };
		const subject = read
			? `Read ${shape(m[1])}`
			: use
				? `use ${m[1]}`
				: `${m[1]} ${shape(m[2] ?? "")}`.trim();
		return { kind: "permission-denial", subject };
	}
	if (RE_GATE.test(t)) {
		const marker =
			t.match(
				/STOP-GATE|edit-enforce|denied by policy|governor denies/i,
			)?.[0] ?? "gate";
		return { kind: "gate-denial", subject: `${marker} ${firstLine(t, 40)}` };
	}
	if (RE_CMDFAIL.test(t)) {
		return { kind: "command-fail", subject: firstLine(t) };
	}
	return { kind: "tool-error", subject: firstLine(t) };
}

const cap = (s: string, n: number): string =>
	s.length > n ? s.slice(0, n) : s;

// ---- claude transcript parsing ----
// Assistant rows carry tool_use (id -> command); the NEXT user row's
// tool_result answers by id. A stateful parser joins them so failures carry
// the failing command, not just opaque output.

export type ClaudeState = { pending: Map<string, string> };

export function newClaudeState(): ClaudeState {
	return { pending: new Map() };
}

type Content = {
	type?: string;
	id?: string;
	input?: { command?: string };
	tool_use_id?: string;
	is_error?: boolean;
	content?: unknown;
};

type ClaudeRow = {
	type?: string;
	timestamp?: string;
	cwd?: string;
	message?: { content?: Content[] };
};

export function parseClaudeRow(
	state: ClaudeState,
	row: ClaudeRow,
): Signal | null {
	const ts = Date.parse(row?.timestamp ?? "") || 0;
	if (row?.type === "assistant" && Array.isArray(row.message?.content)) {
		for (const c of row.message.content) {
			if (c.type === "tool_use" && typeof c.input?.command === "string")
				state.pending.set(c.id ?? "", c.input.command);
		}
		return null;
	}
	if (row?.type !== "user" || !Array.isArray(row.message?.content)) return null;
	for (const c of row.message.content) {
		if (c.type !== "tool_result" || c.is_error !== true) continue;
		const text =
			typeof c.content === "string" ? c.content : JSON.stringify(c.content);
		if (!text) continue;
		const { kind, subject } = classify(text);
		const cmd = state.pending.get(c.tool_use_id ?? "");
		const flat = cmd ? cmd.replace(/\s+/g, " ") : "";
		const detail = cmd
			? `cmd: ${cap(flat, 90)} ⇒ ${cap(firstLine(text, 120), 120)}`
			: cap(text, 200);
		return {
			kind,
			subject:
				kind === "command-fail" && cmd ? `cmd: ${cap(flat, 60)}` : subject,
			detail,
			backend: "claude",
			item: itemFromRow(row) ?? "?",
			ts,
		};
	}
	return null;
}

function itemFromRow(row: ClaudeRow): string | null {
	const m = String(row?.cwd ?? "").match(/\.worktrees\/(W[\w.]+)\/?$/);
	return m ? m[1] : null;
}

// ---- codex rollout parsing ----
// exec outputs wrap as "Script completed\nWall time…\n{…\"exit_code\":N…}" —
// the exit code lives inside the JSON payload text.

type CodexPayload = {
	type?: string;
	call_id?: string;
	input?: unknown;
	output?: { text?: unknown }[];
};

type CodexRow = { timestamp?: string; payload?: CodexPayload };

export function parseCodexRow(row: CodexRow, item: string): Signal | null {
	const p = row?.payload;
	if (p?.type === "custom_tool_call" && typeof p.call_id === "string")
		codexCalls.set(p.call_id, cap(String(p.input ?? ""), 120));
	if (p?.type !== "custom_tool_call_output" || typeof p.call_id !== "string")
		return null;
	const out = Array.isArray(p.output)
		? p.output.map((o) => String(o?.text ?? "")).join("\n")
		: String(p.output ?? "");
	const code = Number(out.match(/"exit_code":\s*(\d+)/)?.[1] ?? "0");
	if (code === 0) return null;
	const cmd = codexCalls.get(p.call_id)?.replace(/\s+/g, " ") ?? "";
	return {
		kind: "command-fail",
		subject: cmd
			? `cmd: ${cap(cmd, 60)}`
			: `exit:${code} ${cap(firstLine(out), 48)}`,
		detail: cmd
			? `cmd: ${cap(cmd, 90)} ⇒ exit:${code} ${cap(firstLine(out, 100), 100)}`
			: cap(out, 200),
		backend: "codex",
		item,
		ts: Date.parse(row?.timestamp ?? "") || 0,
	};
}

const codexCalls = new Map<string, string>(); // call_id -> cmd head (per file)

export function resetCodexCalls(): void {
	codexCalls.clear();
}

// ---- clustering ----

export function clusterSignals(signals: Signal[]): Cluster[] {
	const byKey = new Map<string, Cluster>();
	for (const s of signals) {
		const key = `${s.kind}|${s.subject}`;
		const c = byKey.get(key);
		if (c) {
			c.count++;
			if (s.detail.length > c.detail.length) c.detail = s.detail;
			if (!c.items.includes(s.item)) c.items.push(s.item);
			if (s.ts > c.lastTs) c.lastTs = s.ts;
		} else {
			byKey.set(key, {
				key,
				kind: s.kind,
				subject: s.subject,
				detail: s.detail,
				items: [s.item],
				count: 1,
				lastTs: s.ts,
			});
		}
	}
	return [...byKey.values()].sort(
		(a, b) => b.count - a.count || b.lastTs - a.lastTs,
	);
}

// ---- transcript discovery + append-cursor reading ----

export async function discoverTranscripts(
	repo: string,
	home: string,
	days = 7,
): Promise<TranscriptRef[]> {
	const refs: TranscriptRef[] = [];
	const floor = Date.now() - days * 86_400_000;
	const projDir = join(home, ".claude", "projects");
	const prefix = `${mungePath(repo)}--worktrees-`;
	try {
		for (const d of readdirSync(projDir)) {
			if (!d.startsWith(prefix)) continue;
			const item = d.slice(prefix.length);
			if (!/^W[\w.]*$/.test(item)) continue;
			for (const f of readdirSync(join(projDir, d))) {
				if (!f.endsWith(".jsonl")) continue;
				const path = join(projDir, d, f);
				try {
					if (statSync(path).mtimeMs < floor) continue; // idle window
					if (statSync(path).size > 64 * 1024 * 1024) continue; // guard
					refs.push({ backend: "claude", path, item });
				} catch {}
			}
		}
	} catch {}
	// codex rollouts: session_meta's cwd names the lane worktree — keep only
	// this repo's worktrees (the desktop app writes here too; unscoped
	// harvesting would drag personal sessions into the fleet curriculum)
	try {
		const sessions = join(home, ".codex", "sessions");
		if (existsSync(sessions)) {
			for (const day of readdirSync(sessions).sort()) {
				const dayDir = join(sessions, day);
				let months: string[] = [];
				try {
					months = readdirSync(dayDir);
				} catch {
					continue;
				}
				for (const month of months) {
					const monthDir = join(dayDir, month);
					let days: string[] = [];
					try {
						days = readdirSync(monthDir);
					} catch {
						continue;
					}
					for (const d of days) {
						const dir = join(monthDir, d);
						let files: string[] = [];
						try {
							files = readdirSync(dir);
						} catch {
							continue;
						}
						for (const f of files) {
							if (!f.endsWith(".jsonl")) continue;
							const path = join(dir, f);
							try {
								if (statSync(path).mtimeMs < floor) continue;
								if (statSync(path).size > 64 * 1024 * 1024) continue;
							} catch {
								continue;
							}
							const item = await codexItem(path, repo);
							if (item) refs.push({ backend: "codex", path, item });
						}
					}
				}
			}
		}
	} catch {}
	return refs;
}

// codex rollouts identify their lane by session_meta cwd (first row); a
// non-worktree or other-repo cwd returns null — never harvested
export async function codexItem(
	path: string,
	repo: string,
): Promise<string | null> {
	let head = "";
	try {
		head = await Bun.file(path).slice(0, 8192).text();
	} catch {
		return null;
	}
	const meta = head.split("\n").find((l) => l.includes("session_meta"));
	if (!meta) return null;
	try {
		const cwd = String(JSON.parse(meta)?.payload?.cwd ?? "");
		const m = cwd.match(/\.worktrees\/(W[\w.]+)\/?$/);
		if (cwd.startsWith(repo) && m) return m[1];
	} catch {}
	return null;
}
