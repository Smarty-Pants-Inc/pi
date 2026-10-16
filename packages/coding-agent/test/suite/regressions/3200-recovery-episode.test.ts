import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
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
			settings: { retry: { baseDelayMs: 0 } },
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
});
