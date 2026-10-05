import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestLimitError, retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	// Regression for Smarty-Pants-Inc/smarty-dev#2751: count physical attempts, not streams.
	it("stops a provider retry at exactly N physical requests", async () => {
		let count = 0;
		const request = vi.fn(async () => {
			throw providerError(429, { "retry-after-ms": "0" });
		});
		const options = {
			maxRetries: 4,
			beforeProviderRequest: () => {
				if (count === 2) throw new Error("Provider request limit reached (2/2)");
				count++;
			},
		};
		await expect(retryProviderRequest(request, options)).rejects.toThrow("Provider request limit reached (2/2)");
		expect(request).toHaveBeenCalledTimes(2);
		expect(count).toBe(2);
	});
	// PR #139 / smarty-dev#2751: ordinary cancellation must not consume admission or dispatch.
	it.each([false, true])("normalizes pre-abort with admission %s", async (guarded) => {
		const controller = new AbortController();
		controller.abort();
		const request = vi.fn(async () => "unexpected");
		const beforeProviderRequest = guarded ? vi.fn() : undefined;
		await expect(
			retryProviderRequest(request, { signal: controller.signal, beforeProviderRequest }),
		).rejects.toMatchObject({
			name: "AbortError",
			message: "Request aborted",
		});
		expect(request).not.toHaveBeenCalled();
		if (beforeProviderRequest) expect(beforeProviderRequest).not.toHaveBeenCalled();
	});

	it.each([false, true])("normalizes retry-time cancellation with admission %s", async (guarded) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn(async () => {
			throw providerError(503, { "retry-after-ms": "1000" });
		});
		const beforeProviderRequest = guarded ? vi.fn() : undefined;
		const running = retryProviderRequest(request, {
			signal: controller.signal,
			beforeProviderRequest,
			maxRetries: 3,
		});
		const assertion = expect(running).rejects.toMatchObject({ name: "AbortError", message: "Request aborted" });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await assertion;
		expect(request).toHaveBeenCalledTimes(1);
		if (beforeProviderRequest) expect(beforeProviderRequest).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	// PR #139: cap refusals remain body-free in every shared cancellation path.
	it.each(["pre-abort", "in-flight", "backoff"] as const)("retains a cap refusal during %s", async (phase) => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const refusal = new ProviderRequestLimitError(1, 1);
		const beforeProviderRequest = vi.fn();
		const request = vi.fn(async () => {
			if (phase === "in-flight") controller.abort(refusal);
			throw Object.assign(providerError(503, { "retry-after-ms": "1000" }), { body: "must not leak provider body" });
		});
		if (phase === "pre-abort") controller.abort(refusal);
		const running = retryProviderRequest(request, {
			signal: controller.signal,
			beforeProviderRequest,
			maxRetries: 2,
		});
		const assertion = expect(running).rejects.toBe(refusal);
		if (phase === "backoff") {
			await vi.advanceTimersByTimeAsync(0);
			controller.abort(refusal);
		}
		await assertion;
		expect(request).toHaveBeenCalledTimes(phase === "pre-abort" ? 0 : 1);
		expect(beforeProviderRequest).toHaveBeenCalledTimes(phase === "pre-abort" ? 0 : 1);
		expect(refusal.message).toBe("Provider request limit reached (1/1); no further requests allowed");
		expect(vi.getTimerCount()).toBe(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
