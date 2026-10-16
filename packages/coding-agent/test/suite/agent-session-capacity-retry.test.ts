import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// pi#3200: capacity retries share the consumed retry budget and preserve completed tools.
describe("capacity retry custody", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});
	describe.each(["Selected model is at capacity. Please try a different model.", "slow_down"])(
		"capacity response: %s",
		(errorMessage) => {
			it("recovers on the same model and retains the failed attempt in history", async () => {
				const harness = await createHarness({
					settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
				});
				harnesses.push(harness);
				const model = harness.session.model;
				harness.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage }),
					fauxAssistantMessage("recovered"),
				]);

				await harness.session.prompt("test");

				expect(harness.faux.state.callCount).toBe(2);
				expect(harness.session.model).toEqual(model);
				expect(harness.eventsOfType("auto_retry_start")).toMatchObject([
					{ attempt: 1, maxAttempts: 2, errorMessage },
				]);
				expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
				expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
				expect(
					harness.sessionManager
						.getBranch()
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message),
				).toMatchObject([
					{ role: "system" },
					{ role: "user" },
					{
						role: "assistant",
						stopReason: "error",
						errorMessage,
						recovery: { recovery: "retryable", retryable: true },
					},
					{ role: "assistant", stopReason: "stop" },
				]);
				expect(
					harness.session.messages.some(
						(message) => message.role === "assistant" && message.stopReason === "error",
					),
				).toBe(false);
				expect(harness.session.isRetrying).toBe(false);
			});

			it("exhausts exactly the existing retry allowance without a successor", async () => {
				const harness = await createHarness({
					settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
				});
				harnesses.push(harness);
				harness.setResponses(
					Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage })),
				);

				await harness.session.prompt("test");

				expect(harness.faux.state.callCount).toBe(3);
				expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
				expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
					{ success: false, attempt: 2, finalError: errorMessage },
				]);
				expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
				expect(harness.session.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "error",
					errorMessage,
				});
				expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
				expect(harness.session.isRetrying).toBe(false);
				expect(harness.session.pendingMessageCount).toBe(0);
			});

			it.each([
				{ enabled: false, maxRetries: 2, prefix: "" },
				{ enabled: true, maxRetries: 0, prefix: "" },
				{ enabled: true, maxRetries: 2, prefix: "insufficient_quota: " },
				{ enabled: true, maxRetries: 2, prefix: "billing: " },
			])("does not retry with $enabled/$maxRetries/$prefix", async ({ enabled, maxRetries, prefix }) => {
				const harness = await createHarness({ settings: { retry: { enabled, maxRetries, baseDelayMs: 1 } } });
				harnesses.push(harness);
				harness.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: prefix + errorMessage }),
				]);

				await harness.session.prompt("test");

				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
				expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
				expect(harness.session.messages.at(-1)).toMatchObject({
					stopReason: "error",
					errorMessage: prefix + errorMessage,
				});
			});

			// pi#280: an explicit owned refusal must beat transient-looking provider text.
			it("honors an owned non-retryable decision", async () => {
				const harness = await createHarness({
					settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
				});
				harnesses.push(harness);
				harness.setResponses([
					{
						...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
						recovery: { retryable: false },
					},
					fauxAssistantMessage("must not run"),
				]);

				await harness.session.prompt("test");

				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.getPendingResponseCount()).toBe(1);
				expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
				expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
				expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
				expect(harness.session.messages.at(-1)).toMatchObject({
					role: "assistant",
					stopReason: "error",
					errorMessage,
					recovery: { retryable: false },
				});
			});

			it("cancels held retry backoff without another attempt", async () => {
				const harness = await createHarness({
					settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } },
				});
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
				const sawRetryStart = new Promise<void>((resolve) => {
					const unsubscribe = harness.session.subscribe((event) => {
						if (event.type === "auto_retry_start") {
							unsubscribe();
							resolve();
						}
					});
				});

				const prompting = harness.session.prompt("test");
				await Promise.race([
					sawRetryStart,
					prompting.then(() => {
						throw new Error("Prompt settled before retry started");
					}),
				]);
				harness.session.abortRetry();
				await prompting;

				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
				expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
					{ success: false, attempt: 1, finalError: "Retry cancelled" },
				]);
				expect(harness.session.isRetrying).toBe(false);
			});

			it("retains a completed tool result and admits backoff steering exactly once", async () => {
				const toolRuns: string[] = [];
				const echoTool: AgentTool = {
					name: "echo",
					label: "Echo",
					description: "Echo text back",
					parameters: Type.Object({ text: Type.String() }),
					execute: async (toolCallId, params) => {
						const text =
							typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
						toolRuns.push(toolCallId);
						return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
					},
				};
				const harness = await createHarness({
					tools: [echoTool],
					settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } },
				});
				harnesses.push(harness);
				const requests: { modelId: string; messages: Message[] }[] = [];
				const responses = [
					fauxAssistantMessage([fauxToolCall("echo", { text: "once" }, { id: "capacity-tool" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("", { stopReason: "error", errorMessage }),
					fauxAssistantMessage("recovered"),
				];
				harness.setResponses(
					responses.map(
						(response): FauxResponseFactory =>
							(context, _options, _state, model) => {
								requests.push({ modelId: model.id, messages: structuredClone(context.messages) });
								return response;
							},
					),
				);
				const sawRetryStart = new Promise<void>((resolve) => {
					const unsubscribe = harness.session.subscribe((event) => {
						if (event.type === "auto_retry_start") {
							unsubscribe();
							resolve();
						}
					});
				});

				const prompting = harness.session.prompt("test");
				try {
					await Promise.race([
						sawRetryStart,
						prompting.then(() => {
							throw new Error("Prompt settled before retry started");
						}),
					]);
					await harness.session.steer("keep the completed tool result");
					expect(harness.session.getSteeringMessages()).toEqual(["keep the completed tool result"]);
				} finally {
					await prompting;
				}

				expect(harness.faux.state.callCount).toBe(3);
				expect(requests.map((request) => request.modelId)).toEqual(Array(3).fill(harness.getModel().id));
				expect(toolRuns).toEqual(["capacity-tool"]);
				for (const request of requests.slice(1)) {
					expect(request.messages.filter((message) => message.role === "toolResult")).toMatchObject([
						{
							toolCallId: "capacity-tool",
							toolName: "echo",
							content: [{ type: "text", text: "echo:once" }],
							isError: false,
						},
					]);
					expect(
						request.messages
							.filter((message) => message.role === "assistant")
							.flatMap((message) => message.content)
							.filter((part) => part.type === "toolCall"),
					).toEqual([fauxToolCall("echo", { text: "once" }, { id: "capacity-tool" })]);
				}
				expect(requests[1].messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"test",
				]);
				expect(requests[2].messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"test",
					"keep the completed tool result",
				]);
				expect(
					harness
						.eventsOfType("message_end")
						.filter((event) => event.message.role === "user")
						.map((event) => getMessageText(event.message)),
				).toEqual(["test", "keep the completed tool result"]);
				expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
				expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
				expect(harness.session.getSteeringMessages()).toEqual([]);
				expect(harness.session.isRetrying).toBe(false);
			});
		},
	);
});
