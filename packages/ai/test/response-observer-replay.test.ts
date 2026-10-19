// #3155 F5: observer-owned failures after HTTP 200 must not replay a billable request.
// Keep: failure attribution and secret suppression across the callback/recovery boundary.
import { describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import {
	notifyProviderResponse,
	PROVIDER_RESPONSE_OBSERVER_FAILED,
	PROVIDER_STREAM_OBSERVER_FAILED,
} from "../src/utils/provider-observation.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "synthetic-response-observer-secret-3155";
const model: Model<"openai-completions"> = {
	id: "synthetic-model",
	name: "Synthetic model",
	api: "openai-completions",
	provider: "synthetic-observer-3155",
	baseUrl: "https://response-observer.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

function sse(events: unknown[]): Response {
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream", "x-request-id": SECRET, "set-cookie": SECRET },
	});
}

function success(): Response {
	return sse([
		{ id: "synthetic-id", choices: [{ index: 0, delta: { content: "ok" } }] },
		{ id: "synthetic-id", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
	]);
}

describe("response observer replay safety (#3155 F5)", () => {
	it.each(["throw", "reject"])("owns an onResponse %s after HTTP 200 and never retries it", async (mode) => {
		let cancellations = 0;
		const signals: (AbortSignal | null | undefined)[] = [];
		const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			signals.push(init?.signal);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: SECRET })}\n\n`));
					},
					cancel() {
						cancellations++;
						return Promise.reject(new Error(`cleanup overloaded ${SECRET}`));
					},
				}),
				{ headers: { "content-type": "text/event-stream", "x-request-id": SECRET, "set-cookie": SECRET } },
			);
		});
		const failure = Object.assign(new Error(`upstream overloaded ${SECRET}`), {
			status: 503,
			error: { message: SECRET },
			cause: SECRET,
		});
		const onResponse = vi.fn((...args: unknown[]) => {
			expect(args).toEqual([{ status: 200 }]);
			if (mode === "reject") return Promise.reject(failure);
			throw failure;
		});
		const onProviderStreamEvent = vi.fn();
		const events: AssistantMessageEvent[] = [];
		const onRetryScheduled = vi.fn();
		const result = await retryAssistantCall(
			async () => {
				const stream = streamCompletions(model, context, {
					apiKey: "synthetic-key",
					diagnosticSecrets: [SECRET],
					fetch,
					maxRetries: 2,
					onResponse,
					onProviderStreamEvent,
				});
				for await (const event of stream) events.push(event);
				return stream.result();
			},
			policy,
			undefined,
			{ onRetryScheduled },
		);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(onProviderStreamEvent).not.toHaveBeenCalled();
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(PROVIDER_RESPONSE_OBSERVER_FAILED);
		expect(result.recovery).toEqual({ retryable: false });
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(["provider_stream_observer_error"]);
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.responseId).toBeUndefined();
		expect(cancellations).toBe(1);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(JSON.stringify({ events, result, responses: onResponse.mock.calls })).not.toContain(SECRET);
	});

	it("does not wait for unconsumed-body cancellation to settle", async () => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const result = await streamCompletions(model, context, {
			apiKey: "synthetic-key",
			fetch: async () =>
				new Response(new ReadableStream<Uint8Array>({ cancel }), {
					headers: { "content-type": "text/event-stream" },
				}),
			onResponse: () => {
				throw new Error(`upstream overloaded ${SECRET}`);
			},
		}).result();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(result.errorMessage).toBe(PROVIDER_RESPONSE_OBSERVER_FAILED);
		expect(result.recovery).toEqual({ retryable: false });
	}, 1000);

	it("does not replace the observer failure with synchronous transport cleanup failure", async () => {
		const response = success();
		const cancel = vi.spyOn(response.body!, "cancel").mockImplementation(() => {
			throw new Error(`cleanup overloaded ${SECRET}`);
		});
		const result = await streamCompletions(model, context, {
			apiKey: "synthetic-key",
			fetch: async () => response,
			onResponse: () => {
				throw new Error(`upstream overloaded ${SECRET}`);
			},
		}).result();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(result.errorMessage).toBe(PROVIDER_RESPONSE_OBSERVER_FAILED);
		expect(result.recovery).toEqual({ retryable: false });
	});

	it("preserves successful response observation, usage and physical provider retries", async () => {
		let requests = 0;
		const fetch = vi.fn(async () => {
			requests++;
			if (requests === 1) {
				return new Response(JSON.stringify({ error: { message: `upstream overloaded ${SECRET}` } }), {
					status: 503,
					headers: { "content-type": "application/json", "retry-after-ms": "0" },
				});
			}
			return success();
		});
		const beforeProviderRequest = vi.fn();
		const onResponse = vi.fn(async (...args: unknown[]) => {
			expect(args).toEqual([{ status: 200 }]);
		});
		const result = await streamCompletions(model, context, {
			apiKey: "synthetic-key",
			fetch,
			maxRetries: 1,
			maxRetryDelayMs: 1,
			beforeProviderRequest,
			onResponse,
		}).result();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(beforeProviderRequest).toHaveBeenCalledTimes(2);
		expect(onResponse.mock.calls).toEqual([[{ status: 200 }]]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
		expect(result.diagnostics).toBeUndefined();
	});

	it("still retries a provider-owned error received inside HTTP 200", async () => {
		let requests = 0;
		const terminals: AssistantMessage[] = [];
		const onResponse = vi.fn();
		const result = await retryAssistantCall(
			async () => {
				const terminal = await streamCompletions(model, context, {
					apiKey: "synthetic-key",
					diagnosticSecrets: [SECRET],
					maxRetries: 0,
					fetch: async () => {
						requests++;
						return requests === 1
							? sse([{ error: { message: `upstream overloaded ${SECRET}`, type: "server_error" } }])
							: success();
					},
					onResponse,
				}).result();
				terminals.push(terminal);
				return terminal;
			},
			policy,
			undefined,
		);
		expect(requests).toBe(2);
		expect(onResponse.mock.calls).toEqual([[{ status: 200 }], [{ status: 200 }]]);
		expect(terminals[0].stopReason).toBe("error");
		expect(terminals[0].recovery).toEqual({ recovery: "retryable", retryable: true });
		expect(isRetryableAssistantError(terminals[0])).toBe(true);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(10);
		expect(JSON.stringify(terminals)).not.toContain(SECRET);
	});

	it("keeps existing stream-observer failure behavior and already-received usage", async () => {
		let notifications = 0;
		const result = await streamCompletions(model, context, {
			apiKey: "synthetic-key",
			fetch: async () => sse([{ choices: [], usage }, { choices: [{ delta: {}, finish_reason: "stop" }] }]),
			onProviderStreamEvent: () => {
				if (++notifications === 2) throw new Error(`upstream overloaded ${SECRET}`);
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(PROVIDER_STREAM_OBSERVER_FAILED);
		expect(result.recovery).toEqual({ retryable: false });
		expect(result.usage).toMatchObject({ input: 7, output: 3, totalTokens: 10 });
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("preserves caller cancellation when the response observer also rejects", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => success());
		const result = await retryAssistantCall(
			() =>
				streamCompletions(model, context, {
					apiKey: "synthetic-key",
					fetch,
					signal: controller.signal,
					onResponse: () => {
						controller.abort();
						throw new Error(`upstream overloaded ${SECRET}`);
					},
				}).result(),
			policy,
			controller.signal,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe(PROVIDER_RESPONSE_OBSERVER_FAILED);
		expect(result.recovery).toEqual({ retryable: false });
	});

	it.each([200, 99, "200"])("passes only a validated status (%s) without changing existing usage", async (status) => {
		const output: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			stopReason: "pending",
			timestamp: 0,
			usage: {
				input: 7,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			recovery: { retryable: true },
		};
		const existingUsage = output.usage;
		const onResponse = vi.fn(() => {
			throw new Error(`upstream overloaded ${SECRET}`);
		});
		const failure = await notifyProviderResponse({ onResponse }, output, status).catch((error: unknown) => error);
		expect(onResponse.mock.calls).toEqual([[status === 200 ? { status: 200 } : {}]]);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(PROVIDER_RESPONSE_OBSERVER_FAILED);
		expect((failure as Error).cause).toBeUndefined();
		expect(output.recovery).toEqual({ retryable: false });
		expect(output.usage).toBe(existingUsage);
		expect(JSON.stringify(output)).not.toContain(SECRET);
	});
});
