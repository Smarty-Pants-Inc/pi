import type { AssistantMessageEvent, Message, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { streamProxy } from "../src/proxy.ts";
import type { AgentEvent } from "../src/types.ts";

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
	it("does not execute a failed request's tool calls", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "not executed" }], details: {} }));
		let calls = 0;
		const failed = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "probe" },
			{ type: "toolcall_delta", contentIndex: 0, delta: "{}" },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "call", name: "probe", arguments: {} },
			},
			{ type: "error", reason: "toolUse", errorMessage: "synthetic failure", usage },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const wire = calls === 1 ? failed : [{ type: "start" }, { type: "done", reason: "stop", usage }];
				return new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
			}),
		);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[{ role: "user", content: "probe", timestamp: 0 }],
			{
				messages: [],
				tools: [{ name: "probe", label: "probe", description: "probe", parameters: Type.Object({}), execute }],
			},
			{ model, convertToLlm: (messages) => messages as Message[] },
			undefined,
			(requestModel, requestContext) => {
				calls++;
				return streamProxy(requestModel, requestContext, { authToken: "fake", proxyUrl: "https://proxy.invalid" });
			},
		);
		for await (const event of stream) events.push(event);
		expect(execute).not.toHaveBeenCalled();
		expect(calls).toBe(1);
		const turn = events.find((event) => event.type === "turn_end");
		expect(turn).toMatchObject({ type: "turn_end", message: { stopReason: "error" } });
		expect(events.at(-1)?.type).toBe("agent_end");
	});
	it("fails clean EOF without a terminal event closed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('data: {"type":"start"}\n\n')),
		);
		const stream = streamProxy(model, normalizeContext({ messages: [] }), {
			authToken: "fake",
			proxyUrl: "https://proxy.invalid",
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect((await stream.result()).stopReason).toBe("error");
	});
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
