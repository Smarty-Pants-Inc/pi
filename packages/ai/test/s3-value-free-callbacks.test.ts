import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const state = vi.hoisted(() => ({ status: 200, chunks: [] as unknown[] }));
vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => {
					const data = {
						async *[Symbol.asyncIterator]() {
							yield* state.chunks;
						},
					};
					return {
						withResponse: async () => ({
							data,
							response: { status: state.status, headers: new Headers({ "x-synthetic": "synthetic-private" }) },
						}),
					};
				},
			},
		};
	},
}));
const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://provider.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
beforeEach(() => {
	state.status = 200;
	state.chunks = [
		{
			id: "synthetic-private",
			model: "synthetic-private",
			choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		},
	];
});
// smarty-dev#5822 / T-C1: callback captures precede normalization and serialize every argument.
describe("T-C1 value-free direct callbacks", () => {
	it.each([100, 200, 599, 99, 600, 200.5, Number.NaN])("publishes only a validated HTTP status %s", async (status) => {
		state.status = status;
		const responseArgs: unknown[][] = [];
		const eventArgs: unknown[][] = [];
		const result = await streamCompletions(model, context, {
			apiKey: "fake",
			onResponse: (...args) => {
				responseArgs.push(JSON.parse(JSON.stringify(args)));
			},
			onProviderStreamEvent: (...args) => {
				eventArgs.push(JSON.parse(JSON.stringify(args)));
			},
		}).result();
		expect(responseArgs).toEqual([[Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}]]);
		expect(eventArgs).toEqual([[{ type: "provider_stream_event" }]]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.usage.input).toBe(2);
		expect(result.usage.output).toBe(1);
	});
	it("retains pi-messages observer timing, order and terminal rejection", async () => {
		const callbacks: unknown[][] = [];
		const wire = [
			{ type: "start", extra: "synthetic-private" },
			{ type: "error", reason: "error", errorMessage: "synthetic-private" },
		];
		let requests = 0;
		const result = await streamPiMessages({ ...model, api: "pi-messages", compat: undefined }, context, {
			apiKey: "fake",
			fetch: async () => {
				requests++;
				return new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					status: 200,
					headers: { "x-synthetic": "synthetic-private" },
				});
			},
			onResponse: (...args) => {
				callbacks.push(args);
			},
			onProviderStreamEvent: (...args) => {
				callbacks.push(args);
				throw new Error("synthetic-private");
			},
		}).result();
		expect(JSON.parse(JSON.stringify(callbacks))).toEqual([[{ status: 200 }], [{ type: "provider_stream_event" }]]);
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.oauthRecovery?.retryable).toBe(false);
		expect(result.diagnostics?.some((d) => d.type === "provider_stream_observer_error")).toBe(true);
	});
});
