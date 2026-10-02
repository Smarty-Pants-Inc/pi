import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const disconnect = "stream closed before response.completed";
const emptyError = (errorMessage = disconnect) => fauxAssistantMessage([], { stopReason: "error", errorMessage });

// smarty-dev#3200: recovery state belongs to a request, not synthetic messages or the whole run.
describe("stream recovery episode boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([
		{ content: [{ type: "text" as const, text: "partial" }], updateType: "text_delta" },
		{ content: [fauxThinking("partial")], updateType: "thinking_delta" },
		{ content: [fauxToolCall("echo", {})], updateType: "toolcall_start" },
	])("preserves the output barrier during a synthetic failure: $updateType", async ({ content, updateType }) => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage(content), fauxAssistantMessage("must not replay")]);
		let threw = false;
		h.session.subscribe((event) => {
			if (!threw && event.type === "message_update" && event.assistantMessageEvent.type === updateType) {
				threw = true;
				throw new Error("fetch failed");
			}
		});
		await h.session.prompt("test");
		expect(threw).toBe(true);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "fetch failed",
			usage: { output: 0 },
		});
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("agent_end")).toMatchObject([{ willRetry: false }]);
		expect(h.eventsOfType("tool_execution_start")).toEqual([]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "error" }]);
		// A genuinely new request must not inherit the previous request's barrier.
		h.setResponses([emptyError(), fauxAssistantMessage("new request recovered")]);
		await h.session.prompt("next request");
		expect(h.faux.state.callCount).toBe(3);
		expect(h.session.getLastAssistantText()).toBe("new request recovered");
	});

	it("retains terminal-only output tokens when a message_end subscriber throws", async () => {
		const h = await createHarness({ settings: { retry: { baseDelayMs: 0 } } });
		harnesses.push(h);
		const original = h.session.agent.streamFunction;
		h.session.agent.streamFunction = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const source = await original(model, context, options);
				for await (const event of source) {
					stream.push(
						event.type === "error"
							? { ...event, error: { ...event.error, usage: { ...event.error.usage, output: 1 } } }
							: event,
					);
				}
				stream.end();
			});
			return stream;
		};
		h.setResponses([emptyError("503 overloaded"), fauxAssistantMessage("must not replay")]);
		let threw = false;
		h.session.subscribe((event) => {
			if (!threw && event.type === "message_end" && event.message.role === "assistant") {
				threw = true;
				throw new Error("fetch failed");
			}
		});
		await h.session.prompt("test");
		expect(threw).toBe(true);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "error" }]);
	});

	it.each([
		{ errorMessage: disconnect, retries: 2 },
		{ errorMessage: "503 overloaded", retries: 3 },
	])(
		"restores the normal later-request budget after successful fallback: $errorMessage",
		async ({ errorMessage, retries }) => {
			let toolCalls = 0;
			const h = await createHarness({
				models: [{ id: "primary" }, { id: "alternate" }],
				settings: { retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" } },
				tools: [
					{
						name: "echo",
						label: "Echo",
						description: "Deterministic test tool",
						parameters: Type.Object({}),
						execute: async () => {
							toolCalls++;
							return { content: [{ type: "text", text: "tool result" }], details: {} };
						},
					},
				],
			});
			harnesses.push(h);
			const requests: string[] = [];
			h.setResponses(
				[
					...Array.from({ length: 3 }, () => emptyError()),
					fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
					...Array.from({ length: retries }, () => emptyError(errorMessage)),
					fauxAssistantMessage("later request recovered"),
				].map((response) => (_context, _options, _state, model) => {
					requests.push(model.id);
					return response;
				}),
			);
			await h.session.prompt("test");
			expect(requests).toEqual([
				"primary",
				"primary",
				"primary",
				...Array.from({ length: retries + 2 }, () => "alternate"),
			]);
			expect(toolCalls).toBe(1);
			expect(h.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([
				1,
				2,
				...Array.from({ length: retries }, (_, i) => i + 1),
			]);
			expect(h.eventsOfType("auto_retry_fallback")).toHaveLength(1);
			expect(h.eventsOfType("auto_retry_end")).toMatchObject([
				{ success: true, attempt: 2 },
				{ success: true, attempt: retries },
			]);
			expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "completed" }]);
			expect(h.session.getLastAssistantText()).toBe("later request recovered");
		},
	);

	it.each([0, 2])("never throttle-retries the one-shot alternate (maxRetries: %s)", async (maxRetries) => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { maxRetries, baseDelayMs: 0, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		const throttled = emptyError("one request at a time");
		throttled.diagnostics = [
			{
				type: "provider_limit",
				timestamp: Date.now(),
				details: { code: "smarty_limit", retryAfterSeconds: 0.001, waitMessage: "Wait for capacity" },
			},
		];
		h.setResponses([
			...Array.from({ length: maxRetries + 1 }, () => emptyError()),
			throttled,
			fauxAssistantMessage("must not retry alternate"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(maxRetries + 2);
		expect(h.eventsOfType("auto_retry_start")).toHaveLength(maxRetries);
		expect(h.eventsOfType("auto_retry_fallback")).toHaveLength(1);
		expect(h.eventsOfType("agent_end").at(-1)).toMatchObject({ willRetry: false });
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: maxRetries, finalError: "one request at a time" },
		]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "error" }]);
	});

	it("never compacts and retries an overflowing one-shot alternate", async () => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: {
				retry: { baseDelayMs: 0, fallbackModel: "faux/alternate" },
				compaction: { enabled: true, keepRecentTokens: 1 },
			},
		});
		harnesses.push(h);
		// Retained history makes overflow compaction possible; a tiny empty session would not exercise it.
		h.sessionManager.appendMessage({ role: "user", content: "prior context", timestamp: 1 });
		h.sessionManager.appendMessage(fauxAssistantMessage("previous completed response"));
		h.session.refreshContext();
		h.setResponses([
			...Array.from({ length: 3 }, () => emptyError()),
			(_context, _options, _state, model) => ({
				...emptyError("prompt is too long"),
				provider: model.provider,
				model: model.id,
			}),
			fauxAssistantMessage("must not compact alternate"),
		]);
		await h.session.prompt("test");
		expect(h.faux.state.callCount).toBe(4);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		expect(h.eventsOfType("agent_end").at(-1)).toMatchObject({ willRetry: false });
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 2 }]);
	});

	it.each(["success", "failure", "cancel"] as const)("closes a zero-retry fallback episode on %s", async (outcome) => {
		const h = await createHarness({
			models: [{ id: "primary" }, { id: "alternate" }],
			settings: { retry: { maxRetries: 0, baseDelayMs: 0, fallbackModel: "faux/alternate" } },
		});
		harnesses.push(h);
		h.setResponses([
			emptyError(),
			outcome === "failure" ? emptyError("503 overloaded") : fauxAssistantMessage("recovered"),
		]);
		let aborting: Promise<void> | undefined;
		if (outcome === "cancel")
			h.session.subscribe((event) => {
				if (event.type === "auto_retry_fallback") aborting = h.session.abort();
			});
		await h.session.prompt("test");
		await aborting;
		expect(h.faux.state.callCount).toBe(outcome === "cancel" ? 1 : 2);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: outcome === "success", attempt: 0 }]);
		expect(h.session.retryAttempt).toBe(0);
		expect(h.eventsOfType("agent_settled")).toMatchObject([
			{ outcome: outcome === "success" ? "completed" : outcome === "cancel" ? "aborted" : "error" },
		]);
	});
});
