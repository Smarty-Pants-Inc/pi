import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

const disconnect = "stream error: stream disconnected before completion: stream closed before response.completed";
const partialText = "discard this partial answer";
const partialThinking = "discard this partial reasoning";
const partialToolInput = "discard this partial tool call";

describe("AgentSession Codex stream-disconnect retry", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	const failedPartial = () =>
		fauxAssistantMessage(
			[
				fauxThinking(partialThinking),
				{ type: "text", text: partialText },
				fauxToolCall("write", { content: partialToolInput }),
			],
			{ stopReason: "error", errorMessage: disconnect },
		);

	// smarty-dev#11900: retry an interrupted Codex response, but never send its partial output back as context.
	it("retries once and removes partial text, thinking, and unexecuted tool calls", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(h);
		const requests: string[] = [];
		h.setResponses([
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return failedPartial();
			},
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("recovered answer");
			},
		]);

		await h.session.prompt("test request");

		expect(h.faux.state.callCount).toBe(2);
		expect(requests).toHaveLength(2);
		for (const marker of [partialText, partialThinking, partialToolInput]) {
			expect(requests[1]).not.toContain(marker);
			expect(JSON.stringify(h.session.messages)).not.toContain(marker);
		}
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
	});

	// smarty-dev#11900: the one-shot notice includes earlier ordinary retries in the same recovery episode.
	it("reports cumulative retry attempts after an ordinary error followed by an exact partial disconnect", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" }),
			failedPartial(),
			fauxAssistantMessage("recovered after ordinary retry and disconnect"),
		]);

		await h.session.prompt("test request");

		expect(h.faux.state.callCount).toBe(3);
		expect(h.eventsOfType("auto_retry_start").map(({ attempt, maxAttempts }) => ({ attempt, maxAttempts }))).toEqual([
			{ attempt: 1, maxAttempts: 10 },
			{ attempt: 2, maxAttempts: 2 },
		]);
		expect(h.session.getLastAssistantText()).toBe("recovered after ordinary retry and disconnect");
	});

	// smarty-dev#11900: a Codex disconnect has one fresh-response retry, not an unbounded policy loop or fallback.
	it("caps repeated disconnects at one retry despite larger retry and fallback settings", async () => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { maxRetries: 10, baseDelayMs: 1, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses([failedPartial(), failedPartial(), fauxAssistantMessage("must not be requested")]);

		await h.session.prompt("test request");

		expect(h.faux.state.callCount).toBe(2);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1 }]);
	});

	// smarty-dev#11900: one combined regression proves an unexecuted partial call is retryable, while a real
	// started effect blocks replay. The negative half alone is a pre-existing safety rule and is not a regression.
	it("retries unexecuted partial calls but never replays a started tool effect", async () => {
		const recoveryTool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Test tool",
			parameters: Type.Object({ content: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "written" }], details: undefined }),
		};
		const recoverable = await createHarness({
			settings: { retry: { maxRetries: 10, baseDelayMs: 1 } },
			tools: [recoveryTool],
		});
		harnesses.push(recoverable);
		recoverable.setResponses([failedPartial(), fauxAssistantMessage("recovered without replaying the partial call")]);
		await recoverable.session.prompt("test request");
		expect(recoverable.faux.state.callCount).toBe(2);
		expect(recoverable.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(recoverable.eventsOfType("tool_execution_start")).toEqual([]);

		let effects = 0;
		const tool: AgentTool = {
			...recoveryTool,
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "written" }], details: undefined };
			},
		};
		const h = await createHarness({
			settings: { retry: { maxRetries: 10, baseDelayMs: 1 } },
			tools: [tool],
		});
		harnesses.push(h);
		const receiver = h.session as unknown as { _handleAgentEvent(event: AgentEvent): Promise<void> };
		let injected = false;
		const unsubscribe = h.session.agent.subscribe(async (event) => {
			if (injected || event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
			injected = true;
			await receiver._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "partial-response-tool",
				toolName: "write",
				args: { content: partialToolInput },
			} as unknown as AgentEvent);
			// A new assistant message in the same turn must not erase execution evidence.
			await receiver._handleAgentEvent({
				type: "message_start",
				message: fauxAssistantMessage(""),
			} as unknown as AgentEvent);
			await tool.execute("partial-response-tool", { content: partialToolInput });
		});
		h.setResponses([failedPartial(), fauxAssistantMessage("must not be requested")]);
		try {
			await h.session.prompt("test request");
		} finally {
			unsubscribe();
		}
		expect(injected).toBe(true);
		expect(effects).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	// smarty-dev#11900: the exact empty disconnect retries once, then terminates even with a larger configured budget.
	it("retries an empty exact disconnect once and stops after the second drop", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("must not be requested"),
		]);
		await h.session.prompt("test request");
		expect(h.faux.state.callCount).toBe(2);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1 }]);
	});

	it.each([
		{ name: "disabled retries", retry: { enabled: false, maxRetries: 10, baseDelayMs: 1 } },
		{ name: "zero retry budget", retry: { maxRetries: 0, baseDelayMs: 1 } },
	])("does not retry with $name", async ({ retry }) => {
		const h = await createHarness({ settings: { retry } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect })]);
		await h.session.prompt("test request");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("allows a new prompt to retry after the prior prompt exhausted its one-shot allowance", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("fresh prompt recovered"),
		]);
		await h.session.prompt("first prompt");
		expect(h.faux.state.callCount).toBe(2);
		await h.session.prompt("second prompt");
		expect(h.faux.state.callCount).toBe(4);
		expect(h.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 1]);
		expect(h.session.getLastAssistantText()).toBe("fresh prompt recovered");
	});

	it("resets the one-shot allowance for a queued user message", async () => {
		let queued = false;
		const h = await createHarness({
			settings: { retry: { maxRetries: 10, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (
							!queued &&
							event.message.role === "assistant" &&
							event.message.stopReason === "error" &&
							h.faux.state.callCount === 2
						) {
							queued = true;
							await pi.sendUserMessage("queued fresh request", { deliverAs: "followUp" });
						}
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: disconnect }),
			fauxAssistantMessage("queued request recovered"),
		]);
		await h.session.prompt("first prompt");
		expect(queued).toBe(true);
		expect(h.faux.state.callCount).toBe(4);
		expect(h.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 1]);
		expect(h.session.getLastAssistantText()).toBe("queued request recovered");
	});

	it("does not apply the special retry to other errors with partial text", async () => {
		const h = await createHarness({ settings: { retry: { maxRetries: 10, baseDelayMs: 1 } } });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(partialText, {
				stopReason: "error",
				errorMessage: "stream disconnected before completion",
			}),
		]);
		await h.session.prompt("test request");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.session.getLastAssistantText()).toBe(partialText);
	});

	// smarty-dev#11900: a completed earlier tool call belongs to the previous assistant response, not this retry decision.
	it("allows a fresh-response retry after a tool executed in the previous response", async () => {
		let effects = 0;
		const tool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Test tool",
			parameters: Type.Object({ content: Type.String() }),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "written" }], details: undefined };
			},
		};
		const h = await createHarness({ settings: { retry: { maxRetries: 1, baseDelayMs: 1 } }, tools: [tool] });
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { content: "previous response tool" })], {
				stopReason: "toolUse",
			}),
			failedPartial(),
			fauxAssistantMessage("recovered after tool response"),
		]);

		await h.session.prompt("test request");

		expect(h.faux.state.callCount).toBe(3);
		expect(h.eventsOfType("tool_execution_start")).toHaveLength(1);
		expect(effects).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.session.getLastAssistantText()).toBe("recovered after tool response");
	});
});
