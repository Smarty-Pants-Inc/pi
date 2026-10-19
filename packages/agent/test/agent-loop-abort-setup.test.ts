import type { Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
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

		// pi#298 / smarty-dev#14950: caller cancellation must settle without cooperation from setup.
		it.each(["resolve", "reject"] as const)("ignores an uncooperative late %s after abort", async (settlement) => {
			const controller = new AbortController();
			const added = vi.spyOn(controller.signal, "addEventListener");
			const removed = vi.spyOn(controller.signal, "removeEventListener");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let pending: Promise<unknown> | undefined;
			const blocked = <T>(value: T): Promise<T> => {
				entered.resolve();
				const result = release.promise.then(() => value);
				pending = result;
				return result;
			};
			const config: AgentLoopConfig = {
				model,
				prepareRequest: boundary === "prepareRequest" ? () => blocked(undefined) : undefined,
				transformContext: boundary === "transformContext" ? (messages) => blocked(messages) : undefined,
				convertToLlm: (messages) =>
					boundary === "convertToLlm" ? blocked(messages as Message[]) : (messages as Message[]),
				getApiKey: boundary === "getApiKey" ? () => blocked(undefined) : undefined,
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
			controller.abort();
			const messages = await run;
			expect(messages.at(-1)).toMatchObject({ stopReason: "aborted", errorMessage: "Operation aborted" });
			const abortListeners = added.mock.calls.filter(([type]) => type === "abort");
			expect(abortListeners.length).toBeGreaterThan(0);
			for (const [, listener] of abortListeners) expect(removed).toHaveBeenCalledWith("abort", listener);

			const failure = new Error("late setup rejection");
			if (settlement === "resolve") release.resolve();
			else release.reject(failure);
			if (settlement === "resolve") await pending;
			else await expect(pending).rejects.toBe(failure);
			expect(dispatches).toBe(0);
			expect(
				events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
			).toHaveLength(1);
			expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
			added.mockRestore();
			removed.mockRestore();
		});
	},
);
