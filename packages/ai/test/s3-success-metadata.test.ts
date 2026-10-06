import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, StopReason } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";

const reasons = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred", "synthetic"] as const;
function message(reason: string): AssistantMessage {
	return {
		role: "assistant",
		api: "faux",
		provider: "faux",
		model: "test",
		content: [],
		timestamp: 0,
		stopReason: reason as StopReason,
		errorMessage: "synthetic failure",
		responseId: "synthetic receipt",
		responseModel: "synthetic model",
		providerThinkingLevel: "synthetic effort",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...(reason === "deferred"
			? { deferred: { id: "synthetic handle", provider: "faux", modelId: "test", api: "faux" } }
			: {}),
	};
}

// smarty-dev#5822 / R5 N1: a producer error cannot authorize successful completion.
describe("T-F6-error-kind model-less", () => {
	it.each(reasons)("preserves error kind with stop reason %s", async (reason) => {
		const original = message(reason);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "error", reason: "error", error: original });
		stream.end();
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(events).toHaveLength(1);
		const terminal = events[0];
		expect(terminal.type).toBe("error");
		if (terminal.type !== "error") throw new Error("expected error event");
		const expected = reason === "aborted" ? "aborted" : "error";
		expect(terminal.reason).toBe(expected);
		expect(terminal.error.stopReason).toBe(expected);
		expect((await stream.result()).stopReason).toBe(expected);
		expect(terminal.error.errorMessage).toContain("provider_request_failed");
		expect(terminal.error).not.toHaveProperty("deferred");
		expect(JSON.stringify(terminal)).not.toContain("synthetic");
		expect(original.stopReason).toBe(reason);
		expect(original.responseId).toBe("synthetic receipt");
	});

	it("ignores an inconsistent outer success reason on a producer error", async () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "error", reason: "stop", error: message("stop") } as unknown as AssistantMessageEvent);
		stream.end();
		const terminal = (await stream[Symbol.asyncIterator]().next()).value;
		expect(terminal).toMatchObject({ type: "error", reason: "error", error: { stopReason: "error" } });
		expect((await stream.result()).stopReason).toBe("error");
	});
});
