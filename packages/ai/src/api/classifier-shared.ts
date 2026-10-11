import { calculateCost } from "../models.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions, ProviderHeaders, Usage } from "../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

// Classifier replies are small JSON records. 4 MiB leaves ample room for large answer sets while
// bounding both success and error bodies, including decompressed bytes. Each attempt, including
// body consumption, has a 60-second deadline unless the caller supplies timeoutMs.
const MAX_CLASSIFIER_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 60_000;

/** An HTTP failure in the shape `retryProviderRequest` and `normalizeProviderError` understand. */
export interface ClassifierHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function httpError(label: string, response: Response, body: string): ClassifierHttpError {
	const error = new Error(`${label} returned ${response.status}`) as ClassifierHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): ClassifierHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as ClassifierHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

async function readClassifierBody(label: string, response: Response, signal: AbortSignal): Promise<string> {
	if (!response.body) {
		signal.throwIfAborted();
		return "";
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let bytes = 0;
	// Custom fetch implementations may not propagate the request signal to their body stream.
	const onAbort = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		for (;;) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_CLASSIFIER_RESPONSE_BYTES) {
				// A plain Error is terminal: provider retries must not repeat an oversized response.
				throw new Error(`${label} response body exceeds ${MAX_CLASSIFIER_RESPONSE_BYTES} byte limit`);
			}
			parts.push(decoder.decode(value, { stream: true }));
		}
		parts.push(decoder.decode());
		return parts.join("");
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

/**
 * Posts one JSON classifier request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
 * timeout per attempt (60 seconds by default, including body reads), and provider retries. Bodies
 * above 4 MiB fail without retry. Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
export async function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	noRetryStatuses?: readonly number[],
): Promise<unknown> {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const apiKey = options.apiKey;
	let payload = body;
	const transformed = await options.onPayload?.(payload, model);
	if (transformed !== undefined) payload = transformed;
	const requestFetch = options.fetch ?? globalThis.fetch;
	const { response, json } = await retryProviderRequest(
		async () => {
			const controller = new AbortController();
			const timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
			const timeout = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
			const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
			try {
				const next = await requestFetch(url, {
					method: "POST",
					headers: requestHeaders(model, apiKey, options.headers),
					body: JSON.stringify(payload),
					signal,
				});
				const text = await readClassifierBody(label, next, signal);
				if (!next.ok) throw httpError(label, next, text);
				return { response: next, json: JSON.parse(text) as unknown };
			} catch (error) {
				const timedOut = controller.signal.aborted && !options.signal?.aborted;
				controller.abort(error);
				if (timedOut) throw controller.signal.reason;
				throw error;
			} finally {
				clearTimeout(timeout);
			}
		},
		{
			maxRetries: options.maxRetries ?? 2,
			maxRetryDelayMs: options.maxRetryDelayMs,
			beforeProviderRequest: options.beforeProviderRequest,
			signal: options.signal,
			noRetryStatuses,
		},
	);
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return json;
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage from a `{ input_tokens, output_tokens }` object, priced from the model catalog like chat
 * usage. A missing or malformed usage object leaves the result without usage instead of failing it.
 */
export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const input = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
