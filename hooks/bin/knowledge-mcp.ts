// knowledge-mcp.ts — W91 MCP stdio server exposing ONE tool: read_knowledge.
// Any MCP client (claude, codex, any harness) can read the fleet's knowledge
// layer. Newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
// transport); logs go to stderr only — stdout carries protocol traffic only.
//
// wire into ~/.claude.json mcpServers (or any MCP client config):
//   "fleet-knowledge": {
//     "command": "bun",
//     "args": ["~/.claude/hooks/suspenders/bin/knowledge-mcp.ts"]
//   }
import { makeStore } from "../lib/knowledge-ports.ts";
import { createInterface } from "node:readline";

const VERSION = "0.7.0";

const TOOL = {
	name: "read_knowledge",
	description:
		"Read the fleet's shared knowledge base (governor.db) BEFORE non-trivial work on a repo: past lessons, incidents, decisions, studies, and facts for the domain/area you are about to touch, so known gotchas are not re-learned. query is natural language; optional filters: domain (repo/product), area (subsystem), origin_kind (lesson|incident|decision|study|fact), origin_system (machine/site). Returns ranked matches (knowledge rows, facts, consult-kb entries).",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"natural-language search, e.g. 'launchd plist wiring' or 'gate race protocol'",
			},
			limit: {
				type: "number",
				description: "max ranked hits per source (default 10, max 50)",
			},
			domain: {
				type: "string",
				description: "repo/product filter, e.g. suspenders",
			},
			area: {
				type: "string",
				description: "subsystem filter, e.g. fleet-loop",
			},
			origin_kind: {
				type: "string",
				description: "lesson | incident | decision | study | fact",
			},
			origin_system: {
				type: "string",
				description: "machine/site filter, e.g. mac-m5max",
			},
		},
		required: ["query"],
	},
};

interface RpcMsg {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
}

// MCP stdio protocol version supported by this server
const PROTOCOL = "2024-11-05";

const writeMsg = (msg: unknown): void => {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const respond = (id: RpcMsg["id"], result: unknown): void =>
	writeMsg({ jsonrpc: "2.0", id, result });
const respondErr = (id: RpcMsg["id"], code: number, message: string): void =>
	writeMsg({ jsonrpc: "2.0", id, error: { code, message } });
const sOf = (v: unknown): string | null =>
	typeof v === "string" && v.trim() ? v.trim() : null;

// one JSON-RPC line in → zero or one response out (notifications never reply)
function onMessage(msg: RpcMsg): void {
	if (msg.id === undefined) return; // notification — no reply
	switch (msg.method) {
		case "initialize":
			respond(msg.id, {
				protocolVersion: sOf(msg.params?.protocolVersion) ?? PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: "suspenders-knowledge", version: VERSION },
			});
			return;
		case "tools/list":
			respond(msg.id, { tools: [TOOL] });
			return;
		case "tools/call":
			handleCall(msg.params ?? {})
				.then((result) => respond(msg.id, result))
				.catch((e: Error & { code?: number }) =>
					respondErr(msg.id ?? null, e.code ?? -32603, e.message),
				);
			return;
		default:
			respondErr(msg.id, -32601, `method not found: ${msg.method ?? "?"}`);
	}
}

async function handleCall(params: Record<string, unknown>): Promise<unknown> {
	const a = (params.arguments ?? {}) as Record<string, unknown>;
	const name = sOf(params.name);
	if (name !== "read_knowledge")
		throw Object.assign(new Error(`unknown tool: ${name ?? "(none)"}`), {
			code: -32602,
		});
	const query = sOf(a.query);
	if (!query)
		throw Object.assign(
			new Error("read_knowledge requires a non-empty string query"),
			{ code: -32602 },
		);
	// #9b: the MCP consumer reaches knowledge ONLY through the store port
	const hits = await makeStore().search({
		query,
		domain: sOf(a.domain),
		area: sOf(a.area),
		originKind: sOf(a.origin_kind),
		originSystem: sOf(a.origin_system),
		limit: typeof a.limit === "number" ? a.limit : undefined,
	});
	return {
		content: [{ type: "text", text: JSON.stringify({ query, hits }) }],
	};
}

// ─── stdio loop: newline-delimited JSON-RPC, protocol-only stdout ───
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg: RpcMsg;
	try {
		msg = JSON.parse(line) as RpcMsg;
	} catch {
		respondErr(null, -32700, "parse error");
		return;
	}
	try {
		onMessage(msg);
	} catch (e) {
		const err = e as Error & { code?: number };
		respondErr(msg.id ?? null, err.code ?? -32603, err.message);
	}
});
console.error("suspenders-knowledge MCP: read_knowledge ready on stdio");
