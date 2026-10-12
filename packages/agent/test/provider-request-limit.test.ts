// Regression for Smarty-Pants-Inc/smarty-dev#2751: unknown-tool turns share physical attempt admission.
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentLoopConfig } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	provider: "synthetic",
	api: "openai-completions",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
afterEach(() => vi.unstubAllGlobals());

describe("agent loop physical request admission", () => {
	it.each([undefined, 2])("forwards admission through unavailable-tool continuations (cap %s)", async (cap) => {
		let physical = 0;
		const fetch = vi.fn(async () => {
			physical++;
			const tool = cap !== undefined || physical < 3;
			const chunk = {
				id: "test",
				choices: [
					{
						index: 0,
						delta: tool
							? {
									tool_calls: [
										{
											index: 0,
											id: `unknown-${physical}`,
											type: "function",
											function: { name: "unavailable", arguments: "{}" },
										},
									],
								}
							: { content: "OK" },
						finish_reason: null,
					},
				],
			};
			const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetch);
		let admitted = 0;
		const config: AgentLoopConfig = {
			model,
			apiKey: "synthetic",
			maxRetries: 0,
			convertToLlm: (messages) => messages as Message[],
			beforeProviderRequest:
				cap === undefined
					? undefined
					: () => {
							if (admitted === cap) throw new Error(`Provider request limit reached (${cap}/${cap})`);
							admitted++;
						},
		};
		const result = await runAgentLoop(
			[{ role: "user", content: "test", timestamp: 0 }],
			{ messages: [], tools: [] },
			config,
			() => {},
			undefined,
			(requestModel, context, options) =>
				streamSimple(requestModel as Model<"openai-completions">, context, options),
		);
		expect(physical).toBe(cap ?? 3);
		expect(admitted).toBe(cap ?? 0);
		const last = result.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe(cap === undefined ? "stop" : "error");
		if (cap !== undefined) expect(last.errorMessage).toBe("Provider request limit reached (2/2)");
	});
});
