import { describe, expect, it, vi } from "vitest";
import { postClassifierRequest } from "../src/api/classifier-shared.ts";
import type { ClassifierModel } from "../src/types.ts";

const model: ClassifierModel<"openai-decisions"> = {
	type: "classifier",
	id: "gpt-6-luna",
	name: "Luna",
	api: "openai-decisions",
	provider: "openai",
	baseUrl: "https://classifier.test/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 922000,
};
const url = new URL("https://classifier.test/v1/decisions");

// pi#173 security review: bound success/error bodies and deadlines, not just response headers.
describe("classifier response body limits", () => {
	it.each([200, 503])("refuses an oversized %i body without consuming it all or retrying", async (status) => {
		let pulls = 0;
		const cancel = vi.fn();
		const chunk = new Uint8Array(1024 * 1024).fill(65);
		let signal: AbortSignal | null | undefined;
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			signal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							pulls++;
							if (pulls <= 1000) controller.enqueue(chunk);
							else controller.close();
						},
						cancel,
					},
					{ highWaterMark: 0 },
				),
				{ status },
			);
		});
		await expect(postClassifierRequest("Classifier", url, model, {}, { apiKey: "synthetic", fetch })).rejects.toThrow(
			"response body exceeds 4194304 byte limit",
		);
		expect(pulls).toBe(5);
		expect(cancel).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([200, 503])("times out a stalled %i body with the default deadline", async (status) => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status }));
		try {
			const request = postClassifierRequest(
				"Classifier",
				url,
				model,
				{},
				{ apiKey: "synthetic", fetch, maxRetries: 0 },
			);
			const rejected = expect(request).rejects.toMatchObject({
				name: "TimeoutError",
				message: "Request timed out after 60000ms",
			});
			await vi.advanceTimersByTimeAsync(60_000);
			await rejected;
			expect(cancel).toHaveBeenCalledOnce();
			expect(fetch).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses a caller-supplied deadline for stalled bodies", async () => {
		const cancel = vi.fn();
		await expect(
			postClassifierRequest(
				"Classifier",
				url,
				model,
				{},
				{
					apiKey: "synthetic",
					maxRetries: 0,
					timeoutMs: 10,
					fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel })),
				},
			),
		).rejects.toMatchObject({ name: "TimeoutError", message: "Request timed out after 10ms" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("honors caller cancellation while a body read is pending", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const request = postClassifierRequest(
			"Classifier",
			url,
			model,
			{},
			{
				apiKey: "synthetic",
				signal: controller.signal,
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>(
							{
								pull() {
									controller.abort();
								},
								cancel,
							},
							{ highWaterMark: 0 },
						),
					),
			},
		);
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("parses normal JSON across UTF-8 chunk boundaries and retains response hooks", async () => {
		const bytes = new TextEncoder().encode('{"answer":"café"}');
		const onResponse = vi.fn();
		const result = await postClassifierRequest(
			"Classifier",
			url,
			model,
			{},
			{
				apiKey: "synthetic",
				onResponse,
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
								controller.close();
							},
						}),
						{ headers: { "x-receipt": "normal" } },
					),
			},
		);
		expect(result).toEqual({ answer: "café" });
		expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: { "x-receipt": "normal" } }, model);
	});
});
