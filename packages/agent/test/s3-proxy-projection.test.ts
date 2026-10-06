import type { AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
afterEach(() => vi.unstubAllGlobals());

// smarty-dev#5822 / R5 N1: wire error reasons must not become successful agent results.
describe("T-F6-error-kind proxy", () => {
	it.each(["stop", "length", "toolUse", "deferred", "synthetic", "error", "aborted"])(
		"closes wire error reason %s",
		async (reason) => {
			const wire = [{ type: "start" }, { type: "error", reason, errorMessage: "synthetic failure", usage }];
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 }),
				),
			);
			const stream = streamProxy(model, normalizeContext({ systemPrompt: "", messages: [] }), {
				authToken: "fake",
				proxyUrl: "https://proxy.invalid",
			});
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			expect(events.map((event) => event.type)).toEqual(["start", "error"]);
			const terminal = events[1];
			if (terminal.type !== "error") throw new Error("expected error event");
			const expected = reason === "aborted" ? "aborted" : "error";
			expect(terminal.reason).toBe(expected);
			expect(terminal.error.stopReason).toBe(expected);
			expect((await stream.result()).stopReason).toBe(expected);
			expect(terminal.error.errorMessage).toContain("provider_request_failed");
			expect(JSON.stringify(terminal)).not.toContain("synthetic");
		},
	);
});
