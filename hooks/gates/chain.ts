// hooks/gates/chain.ts — the pre-files gate sequence (W14: one bun process
// per Edit/Write; gates chain in-process, each exits on deny/ask, allow
// closes). Extracted for the codex adapter (W73): gate.ts and gates/codex.ts
// run the SAME chain — one sequence, two dialects.
import { allow, type HookInput } from "../lib/hookio.ts";
import { contentGate } from "./content.ts";
import { governorGate } from "./governor.ts";
import { mutationSizeGate } from "./mutation-size.ts";
import { ledgerGate } from "./ledger.ts";
import { configGate } from "./config.ts";

export function preFilesChain(hook: HookInput): never {
	contentGate(hook); // payload parse — deny corrupted content BEFORE it lands (2026-09-29)
	governorGate(hook); // leases + area claims
	mutationSizeGate(hook); // W5 payload cap (SUSPENDERS_MAX_MUTATION)
	ledgerGate(hook); // W8: no NEW markers in ledgers
	configGate(hook); // config-guard
	allow(); // closes
}
