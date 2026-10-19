import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type PiMessagesOptions, stream, streamSimple } from "../src/api/pi-messages.ts";
import { getApiProvider } from "../src/compat.ts";
import type { Api, AssistantMessageEvent, Context, Model, StopReason } from "../src/types.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type RecordedRequest = {
	url: string;
	headers: IncomingMessage["headers"];
	body: unknown;
};

type ResponderOptions = {
	status?: number;
	headers?: Record<string, string>;
	events?: unknown[];
	rawBody?: string;
};

let server: Server | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

async function startServer(options: ResponderOptions): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];

	server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			requests.push({
				url: request.url ?? "",
				headers: request.headers,
				body: raw ? JSON.parse(raw) : undefined,
			});

			if (options.status && options.status !== 200) {
				response.statusCode = options.status;
				response.setHeader("content-type", "application/json");
				response.end(options.rawBody ?? "{}");
				return;
			}

			response.statusCode = 200;
			response.setHeader("content-type", "text/event-stream");
			for (const [name, value] of Object.entries(options.headers ?? {})) {
				response.setHeader(name, value);
			}
			for (const event of options.events ?? []) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
		});
	});

	await new Promise<void>((resolve) => {
		server!.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server!.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function createModel(baseUrl: string): Model<"pi-messages"> {
	return {
		id: "auto",
		name: "Radius Auto",
		api: "pi-messages",
		provider: "radius",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("pi-messages", () => {
	it("streams text and tool calls and resolves the terminal message", async () => {
		const { baseUrl, requests } = await startServer({
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "Hel" },
				{ type: "text_delta", contentIndex: 0, delta: "lo" },
				{ type: "text_end", contentIndex: 0, content: "Hello" },
				{ type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "read" },
				{ type: "toolcall_delta", contentIndex: 1, delta: '{"path":' },
				{ type: "toolcall_delta", contentIndex: 1, delta: '"a.txt"}' },
				{
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
				},
				{
					type: "done",
					reason: "toolUse",
					usage,
					responseId: "resp_1",
					providerThinkingLevel: "high",
				},
			],
		});
		const model = createModel(baseUrl);

		const events: AssistantMessageEvent[] = [];
		const partialStopReasons: StopReason[] = [];
		const eventStream = stream(model, normalizeContext(context), {
			apiKey: "test-key",
			sessionId: "session-1",
			toolChoice: "auto",
			maxTokens: 100,
			headers: { "x-custom": "1" },
		});
		for await (const event of eventStream) {
			if ("partial" in event) {
				partialStopReasons.push(event.partial.stopReason);
			}
			events.push(event);
		}
		const message = await eventStream.result();

		expect(partialStopReasons[0]).toBe("pending");
		expect(message.stopReason).toBe("toolUse");
		expect(message.usage).toEqual(usage);
		expect(message.responseId).toBe("resp_1");
		expect(message.providerThinkingLevel).toBe("high");
		expect(message.model).toBe("auto");
		expect(message.provider).toBe("radius");
		expect(message.content).toEqual([
			{ type: "text", text: "Hello", textSignature: undefined },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
		]);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);

		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.url).toBe("/v1/messages");
		expect(request.headers.authorization).toBe("Bearer test-key");
		expect(request.headers["x-custom"]).toBe("1");
		expect(request.body).toEqual({
			model: "auto",
			context,
			options: { maxTokens: 100, sessionId: "session-1", toolChoice: "auto" },
		});
	});

	// smarty-dev#5822 C1: one owned notification per event, never provider data.
	it("notifies once per parsed wire event without provider data", async () => {
		const wireEvents = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello", gatewayField: "upstream-value" },
			{ type: "text_end", contentIndex: 0, content: "Hello" },
			{ type: "done", reason: "stop", usage, responseId: "resp_1" },
		];
		const { baseUrl } = await startServer({ events: wireEvents });
		const model = createModel(baseUrl);
		const calls: unknown[][] = [];
		const message = await streamSimple(model, normalizeContext(context), {
			apiKey: "test-key",
			onProviderStreamEvent: async (...args: unknown[]) => {
				await Promise.resolve();
				calls.push(args);
			},
		}).result();

		expect(calls).toEqual(wireEvents.map(() => [{ type: "provider_stream_event" }]));
		expect(message.stopReason).toBe("stop");
		expect(message.responseId).toBe("resp_1");
		expect(message.content).toEqual([{ type: "text", text: "Hello", textSignature: undefined }]);
	});

	// #3155 F3: rejected terminal observers retain normalized accounting, not private wire data or replayability.
	it.each([
		["done", true],
		["error", true],
		["done", false],
		["error", false],
	] as const)("retains %s usage (observer rejects: %s)", async (terminalType, rejectObserver) => {
		const privateValue = "synthetic-3155-private-provider-value";
		const wireUsage = {
			...usage,
			cacheRead: -1,
			cacheWrite: Number.MAX_SAFE_INTEGER + 1,
			reasoning: 2,
			cacheWrite1h: 3,
			cost: { ...usage.cost, cacheRead: "invalid", cacheWrite: -1, providerField: privateValue },
			providerField: privateValue,
		};
		const normalizedUsage = {
			...usage,
			cacheRead: 0,
			cacheWrite: Number.MAX_SAFE_INTEGER,
			reasoning: 2,
			cacheWrite1h: 3,
			cost: { ...usage.cost, cacheRead: 0, cacheWrite: 0 },
		};
		const wireEvents = [
			{ type: "start" },
			{
				type: terminalType,
				reason: terminalType === "done" ? "length" : "error",
				usage: wireUsage,
				errorMessage: `upstream overloaded ${privateValue}`,
				responseId: "resp_3155",
				gatewayField: privateValue,
			},
			// Neither terminal path may parse or observe a trailing event.
			{ type: "done", reason: "stop", usage: { ...usage, input: 999 } },
		];
		let fetchCalls = 0;
		const calls: unknown[][] = [];
		const events: AssistantMessageEvent[] = [];
		const produce = async () => {
			const eventStream = stream(createModel("https://synthetic.invalid/v1"), normalizeContext(context), {
				apiKey: "synthetic-3155-api-value",
				fetch: async () => {
					fetchCalls++;
					return new Response(wireEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
				},
				onProviderStreamEvent: async (...args: unknown[]) => {
					calls.push(args);
					if (rejectObserver && calls.length === 2) throw new Error(`upstream overloaded ${privateValue}`);
				},
			});
			for await (const event of eventStream) events.push(event);
			return eventStream.result();
		};
		const message = rejectObserver
			? await retryAssistantCall(produce, { enabled: true, maxRetries: 2, baseDelayMs: 0 }, undefined)
			: await produce();

		expect(fetchCalls).toBe(1);
		expect(calls).toEqual([[{ type: "provider_stream_event" }], [{ type: "provider_stream_event" }]]);
		expect(events.map((event) => event.type)).toEqual(["start", rejectObserver ? "error" : terminalType]);
		expect(message.usage).toEqual(normalizedUsage);
		expect(message.stopReason).toBe(rejectObserver ? "error" : terminalType === "done" ? "length" : "error");
		expect(events[1]).toMatchObject(
			rejectObserver || terminalType === "error"
				? { type: "error", reason: "error", error: { usage: normalizedUsage } }
				: { type: "done", reason: "length", message: { usage: normalizedUsage } },
		);
		expect(message).toMatchObject({ api: "pi-messages", model: "auto", provider: "radius" });
		if (rejectObserver) {
			expect(message.errorMessage).toBe("Provider stream observer failed");
			expect(message.recovery).toEqual({ retryable: false });
			expect(message.diagnostics).toEqual([
				{ type: "provider_stream_observer_error", timestamp: expect.any(Number) },
			]);
			expect(message.responseId).toBeUndefined();
			expect(isRetryableAssistantError(message)).toBe(false);
		} else if (terminalType === "done") {
			expect(message.responseId).toBe("resp_3155");
			expect(message.errorMessage).toBeUndefined();
			expect(message.recovery).toBeUndefined();
		} else {
			expect(message.errorMessage).toBe("Provider request failed: network or server error");
			expect(message.recovery).toEqual({ recovery: "retryable", retryable: true });
			expect(message.responseId).toBeUndefined();
		}
		expect(JSON.stringify({ message, events, calls })).not.toContain(privateValue);
	});

	// #3155 F3: usage on a rejected nonterminal event or an unread terminal is not billable evidence.
	it("does not fabricate usage or replay after a nonterminal observer rejection", async () => {
		const wireEvents = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0, usage },
			{ type: "done", reason: "stop", usage },
		];
		let fetchCalls = 0;
		let notifications = 0;
		const events: AssistantMessageEvent[] = [];
		const message = await retryAssistantCall(
			async () => {
				const eventStream = stream(createModel("https://synthetic.invalid/v1"), normalizeContext(context), {
					apiKey: "synthetic-3155-api-value",
					fetch: async () => {
						fetchCalls++;
						return new Response(wireEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
					},
					onProviderStreamEvent: async () => {
						if (++notifications === 2) throw new Error("upstream overloaded");
					},
				});
				for await (const event of eventStream) events.push(event);
				return eventStream.result();
			},
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
		);

		expect(fetchCalls).toBe(1);
		expect(notifications).toBe(2);
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(message.stopReason).toBe("error");
		expect(message.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(message.errorMessage).toBe("Provider stream observer failed");
		expect(message.recovery).toEqual({ retryable: false });
		expect(message.diagnostics).toEqual([{ type: "provider_stream_observer_error", timestamp: expect.any(Number) }]);
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("appends debug=1 and reports only the status via onResponse", async () => {
		const { baseUrl, requests } = await startServer({
			headers: { "x-pi-gateway-upstream-provider": "anthropic" },
			events: [{ type: "done", reason: "stop", usage }],
		});
		const model = createModel(baseUrl);

		const observed: unknown[][] = [];
		const options = {
			apiKey: "test-key",
			debug: true,
			onResponse: (...args: unknown[]) => {
				observed.push(args);
			},
		} satisfies PiMessagesOptions;
		const message = await streamSimple(model, normalizeContext(context), options).result();

		expect(message.stopReason).toBe("stop");
		expect(requests[0].url).toBe("/v1/messages?debug=1");
		expect(observed).toEqual([[{ status: 200 }]]);
	});

	it("surfaces backend error responses with diagnostics", async () => {
		const { baseUrl } = await startServer({
			status: 401,
			rawBody: JSON.stringify({ error: { message: "Token expired", code: "unauthorized" } }),
		});
		const model = createModel(baseUrl);

		const message = await stream(model, normalizeContext(context), { apiKey: "stale" }).result();

		expect(message.stopReason).toBe("error");
		// smarty-dev#5822: no backend text, URL, status or body in diagnostics.
		expect(message.errorMessage).toBe("Provider request failed (HTTP 401, unauthorized)");
		expect(message.diagnostics).toEqual([{ type: "pi_messages_response_failure", timestamp: expect.any(Number) }]);
	});

	it("propagates server-sent error events", async () => {
		const { baseUrl } = await startServer({
			events: [{ type: "start" }, { type: "error", reason: "error", usage, errorMessage: "Upstream failed" }],
		});
		const model = createModel(baseUrl);

		const message = await stream(model, normalizeContext(context), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		// smarty-dev#5822: wire text only classifies; published text is owned.
		expect(message.errorMessage).toBe("Provider request failed");
		expect(message.usage).toEqual(usage);
	});

	it("errors when no API key is provided", async () => {
		const model = createModel("http://127.0.0.1:1/v1");

		const message = await stream(model, normalizeContext(context)).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("No API key provided");
	});

	it("errors when the stream ends without a terminal event", async () => {
		const { baseUrl } = await startServer({
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "partial" },
			],
		});
		const model = createModel(baseUrl);

		const message = await stream(model, normalizeContext(context), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("stream ended without a terminal event");
	});
});

describe("pi-messages api registration", () => {
	it("is registered as a builtin api provider", async () => {
		expect(getApiProvider("pi-messages")).toBeDefined();
	});

	it("is a known api usable on models", () => {
		const api: Api = "pi-messages";
		expect(api).toBe("pi-messages");
	});
});
