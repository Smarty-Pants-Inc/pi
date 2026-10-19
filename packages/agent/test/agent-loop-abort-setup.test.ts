import type { Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

// pi#298 / smarty-dev#14950: each setup boundary must preserve causal settlement,
// even when the caller later aborts with the very same failure object.
describe.each(["prepareRequest", "transformContext", "convertToLlm", "getApiKey"] as const)(
	"%s causal abort outcome",
	(boundary) => {
		it.each(["failure-first", "abort-first"] as const)("preserves %s settlement", async (order) => {
			const controller = new AbortController();
			const entered = Promise.withResolvers<void>();
			const setup = Promise.withResolvers<never>();
			const failure = new Error(`real ${boundary} failure`);
			const config: AgentLoopConfig = { model, convertToLlm: (messages) => messages as Message[] };
			config[boundary] = () => {
				entered.resolve();
				return setup.promise;
			};
			const events: AgentEvent[] = [];
			let dispatches = 0;
			const run = runAgentLoop(
				[{ role: "user", content: "run", timestamp: 1 }],
				{ messages: [] },
				config,
				(event) => {
					events.push(event);
				},
				controller.signal,
				() => {
					dispatches++;
					throw new Error("unexpected dispatch");
				},
			);
			await entered.promise;
			if (order === "failure-first") {
				setup.reject(failure);
				// No await: abort runs before the rejected promise's continuation.
				controller.abort(failure);
				await expect(run).rejects.toBe(failure);
				expect(events.some((event) => event.type === "message_end" && event.message.role === "assistant")).toBe(
					false,
				);
			} else {
				controller.abort();
				// An abort-caused rejection need not equal signal.reason.
				setup.reject(failure);
				const messages = await run;
				expect(messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "aborted",
					errorMessage: "Operation aborted",
				});
				expect(events.at(-2)).toMatchObject({ type: "turn_end", message: { stopReason: "aborted" } });
				expect(events.at(-1)).toMatchObject({ type: "agent_end", messages });
			}
			expect(dispatches).toBe(0);
		});
	},
);
