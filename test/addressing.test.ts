import { describe, expect, test } from "bun:test";
import {
	formatSessionLabel,
	llmShorthand,
	parseSessionTags,
} from "../hooks/lib/addressing.ts";

describe("formatSessionLabel", () => {
	test("renders the canonical hub/tool/name/model format", () => {
		expect(
			formatSessionLabel({
				sid: "sess-12345678",
				hub: "nas",
				tool: "copilot",
				sessionName: "ikea opus",
				model: "gpt-5.4",
			}),
		).toBe("[nas][copilot]-ikea-opus (gpt)");
	});

	test("falls back cleanly and never prints undefined", () => {
		expect(
			formatSessionLabel({
				sid: "abc12345deadbeef",
				worktree: null,
				tags: null,
			}),
		).toBe("[local][claude]-abc12345");
	});

	test("reads hub, tool, name, and model from tags when present", () => {
		expect(
			formatSessionLabel({
				sid: "sess-2222",
				tags: JSON.stringify({
					hub: "IKEA-NAS",
					cli: "grok-cli",
					name: "Model Name Bug",
					model: "grok-4.7",
				}),
			}),
		).toBe("[ikea-nas][grok]-model-name-bug (grok)");
	});

	test("omits the parenthetical when no model is known", () => {
		expect(
			formatSessionLabel({
				sid: "sess-3333",
				hub: "local",
				tool: "claude",
				sessionName: "w296 adapter",
			}),
		).toBe("[local][claude]-w296-adapter");
	});
});

describe("helpers", () => {
	test("parseSessionTags tolerates invalid JSON", () => {
		expect(parseSessionTags("not json")).toEqual({});
	});

	test("llmShorthand normalizes known model families", () => {
		expect(llmShorthand("anthropic/claude-opus-5.5")).toBe("opus");
		expect(llmShorthand("claude-sonnet-5")).toBe("sonnet");
		expect(llmShorthand("gpt-5.6-sol")).toBe("gpt");
		expect(llmShorthand("grok-4.7")).toBe("grok");
		expect(llmShorthand("local-swarm")).toBe("local");
		expect(llmShorthand("")).toBeNull();
	});
});
