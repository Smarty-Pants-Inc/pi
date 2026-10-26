import { describe, expect, it, vi } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { classifyProviderFailure } from "../src/utils/recovery.ts";
import { isRetryableAssistantError, isRetryableMidstreamOverload } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Adapter = "completions" | "responses" | "azure" | "codex";
type Shape = "sibling" | "nested";
type ProviderEvent = { type?: string; [key: string]: unknown };
type ErrorFixture = { code?: unknown; type?: string; message: string; status?: unknown };
type FailureCase = { name: string; error: ErrorFixture; overload: boolean; retryable: boolean };

const adapters = ["completions", "responses", "azure", "codex"] as const;
const shapes = ["sibling", "nested"] as const;
const partialText = "partial response must be discarded by the session";
const privateErrorText = "private cliproxy response body must not be published";
const overloadCode = "server_is_overloaded";
const genericError = { code: "upstream_failure", message: "upstream request failed" };
const statusOnlyError = { status: 529, ...genericError };
const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: "retry this request", timestamp: 1 }],
});

const completionsModel: Model<"openai-completions"> = {
	id: "fixture-model",
	name: "Fixture Model",
	api: "openai-completions",
	provider: "cliproxyapi",
	baseUrl: "https://cliproxyapi.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const responsesModel: Model<"openai-responses"> = {
	...completionsModel,
	api: "openai-responses",
};

const azureModel: Model<"azure-openai-responses"> = {
	...responsesModel,
	api: "azure-openai-responses",
	provider: "azure-openai",
	baseUrl: "https://azure.invalid/openai/v1",
};

const codexModel: Model<"openai-codex-responses"> = {
	...completionsModel,
	api: "openai-codex-responses",
	baseUrl: "https://cliproxyapi.invalid/backend-api",
};

function sse(events: ProviderEvent[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function midstreamEvents(
	code: unknown = overloadCode,
	message = privateErrorText,
	status: unknown = 502,
): ProviderEvent[] {
	return [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: "response-fixture" },
		},
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "message", id: "message-fixture", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			delta: partialText,
		},
		{ type: "error", sequence_number: 3, status, code, message },
	];
}

function failedResponseEvents(error: Record<string, unknown>, envelope: Record<string, unknown> = {}): ProviderEvent[] {
	return [
		...midstreamEvents().slice(0, -1),
		{
			...envelope,
			type: "response.failed",
			sequence_number: 3,
			response: { id: "response-fixture", status: "failed", error },
		},
	];
}

function completionsSse(
	error: Record<string, unknown> = {
		status: 502,
		code: overloadCode,
		type: "server_error",
		message: privateErrorText,
	},
	envelope: Record<string, unknown> = {},
): string {
	return sse([
		{
			id: "chatcmpl-fixture",
			model: completionsModel.id,
			choices: [{ index: 0, delta: { content: partialText } }],
		},
		{ ...envelope, error },
	]);
}

/**
 * One streamed failure after partial text. `sibling` puts the status beside the error object (the Completions
 * envelope, or the Responses event); `nested` puts it inside the error object.
 */
function streamedFailure(adapter: Adapter, shape: Shape, { status, ...error }: ErrorFixture): string {
	const statusField = status === undefined ? {} : { status };
	if (adapter === "completions") {
		return shape === "sibling" ? completionsSse(error, statusField) : completionsSse({ ...error, ...statusField });
	}
	if (shape === "nested") return sse(failedResponseEvents({ ...error, ...statusField }));
	// A Responses error event reserves `type` for its lifecycle; an error type travels in response.failed instead.
	return sse(
		error.type === undefined
			? [...midstreamEvents().slice(0, -1), { type: "error", sequence_number: 3, ...statusField, ...error }]
			: failedResponseEvents(error, statusField),
	);
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
		"utf8",
	).toString("base64");
	return `header.${payload}.signature`;
}

async function runAdapter(adapter: Adapter, body: string, onProviderStreamEvent?: () => void) {
	const fetchCalls: string[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		fetchCalls.push(`${String(input)} ${String(init?.method ?? "GET")}`);
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const options = {
		apiKey: adapter === "codex" ? codexToken() : "fixture-key",
		maxRetries: 0,
		fetch,
		...(onProviderStreamEvent ? { onProviderStreamEvent } : {}),
	};
	const stream =
		adapter === "completions"
			? streamOpenAICompletions(completionsModel, context, options)
			: adapter === "responses"
				? streamOpenAIResponses(responsesModel, context, options)
				: adapter === "azure"
					? streamAzureOpenAIResponses(azureModel, context, {
							...options,
							azureBaseUrl: azureModel.baseUrl,
							azureDeploymentName: azureModel.id,
							azureApiVersion: "v1",
						})
					: streamOpenAICodexResponses(codexModel, context, { ...options, transport: "sse" });
	const events: string[] = [];
	const textDeltas: string[] = [];
	for await (const event of stream) {
		events.push(event.type);
		if (event.type === "text_delta") textDeltas.push(event.delta);
	}
	return { result: await stream.result(), events, textDeltas, fetchCalls };
}

async function runCodexWebSocket(providerEvents: ProviderEvent[]) {
	const requestBodies: unknown[] = [];
	let connections = 0;
	let closes = 0;
	let fetchCalls = 0;
	class FixtureWebSocket {
		private listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor() {
			connections++;
			queueMicrotask(() => this.dispatch("open", {}));
		}

		addEventListener(type: string, listener: (event: unknown) => void): void {
			const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
			listeners.add(listener);
			this.listeners.set(type, listeners);
		}

		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(data: string): void {
			requestBodies.push(JSON.parse(data));
			queueMicrotask(() => {
				for (const event of providerEvents) this.dispatch("message", { data: JSON.stringify(event) });
			});
		}

		close(): void {
			closes++;
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	vi.stubGlobal("WebSocket", FixtureWebSocket);
	try {
		const stream = streamOpenAICodexResponses(codexModel, context, {
			apiKey: codexToken(),
			maxRetries: 0,
			transport: "websocket",
			// Bypass any constructor cached by another test; no session connection is retained.
			env: {},
			fetch: async () => {
				fetchCalls++;
				throw new Error("Unexpected SSE fallback");
			},
		});
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		return { result: await stream.result(), events, requestBodies, connections, closes, fetchCalls };
	} finally {
		vi.unstubAllGlobals();
	}
}

function overloadMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: partialText }],
		api: "openai-responses",
		provider: "cliproxyapi",
		model: "fixture-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "Provider request failed (502)",
		recovery: { recovery: "retryable", retryable: true, midstream: "overload" },
		timestamp: 1,
		...overrides,
	};
}

// smarty-dev#16938: post-output replay is a positive allowlist. Only an exact overload code/type or HTTP 529 grants it.
const eligibleFailures: FailureCase[] = [
	{
		name: "server_is_overloaded code with 502",
		error: { code: overloadCode, message: privateErrorText, status: 502 },
		overload: true,
		retryable: true,
	},
	{
		name: "overloaded_error type without a status",
		error: { type: "overloaded_error", message: "Overloaded" },
		overload: true,
		retryable: true,
	},
	{
		name: "overloaded_error code with 503",
		error: { code: "overloaded_error", message: privateErrorText, status: 503 },
		overload: true,
		retryable: true,
	},
	{
		name: "upstream overloaded code with 502",
		error: { code: "upstream overloaded", message: privateErrorText, status: 502 },
		overload: true,
		retryable: true,
	},
	{
		name: "HTTP 529 with a generic code",
		error: { ...genericError, status: 529 },
		overload: true,
		// 529 is not an ordinary retry status; the ordinary policy is deliberately unchanged.
		retryable: false,
	},
	{
		name: "overloaded_error type with 529",
		error: { code: genericError.code, type: "overloaded_error", message: "Overloaded", status: 529 },
		overload: true,
		retryable: true,
	},
];

// Every rate/quota spelling the five candidate audits found. Final quota refusals stay final.
const rateSpellings: { spelling: string; final?: boolean }[] = [
	{ spelling: "request_rate_exceeded" },
	{ spelling: "Request rate exceeded" },
	{ spelling: "requests_per_minute_exceeded" },
	{ spelling: "Requests per minute exceeded" },
	{ spelling: "rate_limit_exceeded" },
	{ spelling: "Rate limit exceeded" },
	{ spelling: "tokens_per_minute_exceeded" },
	{ spelling: "Tokens per minute exceeded" },
	{ spelling: "requests_per_day_exceeded" },
	{ spelling: "RequestsPerMinuteExceeded" },
	{ spelling: "RPM_limit_exceeded" },
	{ spelling: "TPM exceeded" },
	{ spelling: "concurrent_requests_limit_exceeded" },
	{ spelling: "TooManyRequests" },
	{ spelling: "too_many_requests" },
	{ spelling: "Too many requests" },
	{ spelling: "throttled" },
	{ spelling: "ThrottlingException" },
	{ spelling: "slow_down" },
	{ spelling: "RESOURCE_EXHAUSTED" },
	{ spelling: "insufficient_quota", final: true },
	{ spelling: "quota_exceeded", final: true },
];

// Alone, beside an exact overload code, and as the code beside an overload type with 529: none may replay.
const rateFailures: FailureCase[] = rateSpellings.flatMap(({ spelling, final }) => [
	{
		name: `${spelling} alone with 502`,
		error: { code: spelling, message: genericError.message, status: 502 },
		overload: false,
		retryable: !final,
	},
	{
		name: `${spelling} beside server_is_overloaded with 502`,
		error: { code: overloadCode, message: spelling, status: 502 },
		overload: false,
		retryable: !final,
	},
	{
		name: `${spelling} code beside overloaded_error type with 529`,
		error: { code: spelling, type: "overloaded_error", message: privateErrorText, status: 529 },
		overload: false,
		retryable: !final,
	},
]);

const otherIneligibleFailures: FailureCase[] = [
	{
		name: "plain 502 without an overload marker",
		error: { ...genericError, status: 502 },
		overload: false,
		retryable: true,
	},
	{
		name: "plain 503 without an overload marker",
		error: { ...genericError, status: 503 },
		overload: false,
		retryable: true,
	},
	{
		name: "server_error type with 500",
		error: { code: genericError.code, type: "server_error", message: genericError.message, status: 500 },
		overload: false,
		retryable: true,
	},
	{
		name: "overload wording without an exact code or type with 502",
		error: { code: genericError.code, message: "The server is overloaded", status: 502 },
		overload: false,
		retryable: true,
	},
	{
		name: "a near-miss overload code with 502",
		error: { code: "server_overloaded", message: genericError.message, status: 502 },
		overload: false,
		retryable: true,
	},
	{
		name: "dedicated 429 with a generic code",
		error: { ...genericError, status: 429 },
		overload: false,
		retryable: true,
	},
	{
		name: "dedicated 429 beside server_is_overloaded",
		error: { code: overloadCode, message: privateErrorText, status: 429 },
		overload: false,
		retryable: true,
	},
	{
		name: "a client error beside server_is_overloaded",
		error: { code: overloadCode, message: privateErrorText, status: 400 },
		overload: false,
		retryable: true,
	},
];

describe("OpenAI-compatible midstream overload classification", () => {
	// smarty-dev#16938: a positive allowlist with a rate/quota veto, through every real adapter and both status shapes.
	it.each(
		adapters.flatMap((adapter) =>
			shapes.flatMap((shape) =>
				[...eligibleFailures, ...rateFailures, ...otherIneligibleFailures].map((fixture) => ({
					adapter,
					shape,
					...fixture,
				})),
			),
		),
	)(
		"allowlist: $name in $adapter SSE with $shape status after partial text",
		async ({ adapter, shape, error, overload, retryable }) => {
			const { result, events, textDeltas, fetchCalls } = await runAdapter(
				adapter,
				streamedFailure(adapter, shape, error),
			);

			expect(fetchCalls).toHaveLength(1);
			expect(textDeltas).toEqual([partialText]);
			expect(events.at(-1)).toBe("error");
			expect(result.stopReason).toBe("error");
			expect(result.content).toContainEqual({ type: "text", text: partialText });
			if (typeof error.status === "number") expect(result.errorMessage).toContain(`(${error.status})`);
			// The ordinary decision is unchanged; output already blocks the ordinary retry.
			expect(result.recovery?.retryable).toBe(retryable);
			expect(result.recovery?.recovery).toBe(retryable ? "retryable" : undefined);
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(result.recovery?.midstream).toBe(overload ? "overload" : undefined);
			expect(isRetryableMidstreamOverload(result)).toBe(overload);
			for (const value of [error.code, error.type, error.message]) {
				if (typeof value === "string") expect(JSON.stringify(result)).not.toContain(value);
			}
		},
	);

	// smarty-dev#16938: preserving a sibling or nested status must not infer 529 from strings, text or codes.
	it.each(
		adapters.flatMap((adapter) =>
			[
				{ name: "a string status", error: { ...genericError, status: "529" } },
				{ name: "a fractional status", error: { ...genericError, status: 529.5 } },
				{ name: "a status below the HTTP range", error: { ...genericError, status: 99 } },
				{ name: "a status above the HTTP range", error: { ...genericError, status: 600 } },
				{ name: "a status-like code", error: { code: "upstream_529", message: genericError.message } },
				{ name: "a string numeric code", error: { code: "529", message: genericError.message } },
				{ name: "a numeric code", error: { code: 529, message: genericError.message } },
				{ name: "status-like text", error: { code: genericError.code, message: "HTTP 529 upstream overloaded" } },
			].flatMap((fixture) => shapes.map((shape) => ({ adapter, shape, ...fixture }))),
		),
	)("does not grant a streamed allowance for $name in $adapter ($shape)", async ({ adapter, shape, error }) => {
		const { result, events, fetchCalls } = await runAdapter(adapter, streamedFailure(adapter, shape, error));

		expect(fetchCalls).toHaveLength(1);
		expect(events).toContain("text_delta");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	// smarty-dev#16938: a valid outer SSE 4xx must win over a contradictory nested 529 on the real SDK path.
	it.each([400, 429])("keeps Completions sibling-status %s ahead of nested error.status 529", async (status) => {
		const { result, events, fetchCalls } = await runAdapter(
			"completions",
			completionsSse(statusOnlyError, { status }),
		);

		expect(fetchCalls).toHaveLength(1);
		expect(events).toContain("text_delta");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.errorMessage).toContain(`(${status})`);
		expect(result.errorMessage).not.toContain("(529)");
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	// smarty-dev#16938: a sibling 529 must not override final quota or plan/usage refusals.
	it.each(
		["insufficient_quota", "smarty_limit", "usage_limit_reached", "usage_not_included", "quota_exceeded"].flatMap(
			(refusal) => (["code", "type"] as const).map((field) => ({ refusal, field })),
		),
	)("keeps Completions sibling-status 529 terminal for $refusal in $field", async ({ refusal, field }) => {
		const { result, events, fetchCalls } = await runAdapter(
			"completions",
			completionsSse({ ...genericError, [field]: refusal }, { status: 529 }),
		);

		expect(fetchCalls).toHaveLength(1);
		expect(events).toContain("text_delta");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.recovery?.retryable).toBe(false);
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
		expect(isRetryableAssistantError(result)).toBe(false);
		if (refusal === "smarty_limit") {
			expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "provider_limit" }));
		}
		expect(JSON.stringify(result)).not.toContain(refusal);
		expect(JSON.stringify(result)).not.toContain(genericError.message);
	});

	// smarty-dev#16938: observer failure after output stays terminal with an otherwise eligible 529 queued next.
	it("keeps Completions sibling-status observer failure terminal after partial text", async () => {
		let observed = 0;
		const { result, events, fetchCalls } = await runAdapter(
			"completions",
			sse([
				{
					id: "chatcmpl-observer",
					model: completionsModel.id,
					choices: [{ index: 0, delta: { content: partialText } }],
				},
				{ id: "chatcmpl-observer", model: completionsModel.id, choices: [] },
				{ status: 529, error: { code: overloadCode, message: genericError.message } },
			]),
			() => {
				if (++observed === 2) throw new Error("observer must not authorize replay");
			},
		);

		expect(fetchCalls).toHaveLength(1);
		expect(observed).toBe(2);
		expect(events).toContain("text_delta");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "provider_stream_observer_error" }));
		expect(result.recovery?.retryable).toBe(false);
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(JSON.stringify(result)).not.toContain("observer must not authorize replay");
	});

	// smarty-dev#16938: malformed SSE JSON is provider data, not a publishable local error or overload signal.
	it("keeps Completions sibling-status decoder failures private without an overload allowance", async () => {
		const privateFrame = "overloaded-private-sse-frame-must-stay-private";
		const partialBody = sse([
			{
				id: "chatcmpl-malformed",
				model: completionsModel.id,
				choices: [{ index: 0, delta: { content: partialText } }],
			},
		]);
		const { result, events, fetchCalls } = await runAdapter("completions", `${partialBody}data: ${privateFrame}\n\n`);

		expect(fetchCalls).toHaveLength(1);
		expect(events).toContain("text_delta");
		expect(events.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(JSON.stringify(result)).not.toContain(privateFrame);
		// A SyntaxError can quote only a prefix of the raw frame; that prefix is private too.
		expect(JSON.stringify(result)).not.toContain("overloaded");
		expect(JSON.stringify(result)).not.toContain("private-sse-frame");
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	// smarty-dev#16938: real WS parsing and Codex normalization apply the same allowlist, including nested errors.
	it.each(
		[
			{ name: "529 status only", error: statusOnlyError, overload: true },
			{
				name: "server_is_overloaded with 502",
				error: { ...statusOnlyError, code: overloadCode, status: 502 },
				overload: true,
			},
			{ name: "plain 502", error: { ...statusOnlyError, status: 502 }, overload: false },
			{
				name: "Request rate exceeded beside server_is_overloaded",
				error: { code: overloadCode, message: "Request rate exceeded", status: 502 },
				overload: false,
			},
		].flatMap((fixture) =>
			[
				{
					frame: "error",
					events: midstreamEvents(fixture.error.code, fixture.error.message, fixture.error.status),
				},
				{
					frame: "nested error",
					events: [...midstreamEvents().slice(0, -1), { type: "error", sequence_number: 3, error: fixture.error }],
				},
				{ frame: "response.failed", events: failedResponseEvents(fixture.error) },
			].map((variant) => ({ ...fixture, ...variant })),
		),
	)("classifies $name in a Codex WebSocket $frame without SSE fallback", async ({ events, error, overload }) => {
		const observed = await runCodexWebSocket(events);

		expect(observed.connections).toBe(1);
		expect(observed.closes).toBe(1);
		expect(observed.requestBodies).toMatchObject([{ type: "response.create", model: codexModel.id }]);
		expect(observed.fetchCalls).toBe(0);
		expect(observed.events).toContain("text_delta");
		expect(observed.result.stopReason).toBe("error");
		expect(observed.result.content).toContainEqual({ type: "text", text: partialText });
		expect(observed.result.recovery?.midstream).toBe(overload ? "overload" : undefined);
		expect(isRetryableMidstreamOverload(observed.result)).toBe(overload);
		expect(isRetryableAssistantError(observed.result)).toBe(false);
		expect(observed.result.errorMessage).toContain(`(${error.status})`);
		expect(observed.result.errorMessage ?? "").not.toContain(error.code);
		expect(observed.result.errorMessage ?? "").not.toContain(error.message);
	});

	// smarty-dev#16938: failed lifecycle state and a nested code cannot substitute for a numeric status field.
	it.each(["responses", "azure", "codex"] as const)(
		"does not infer an HTTP status from %s response.failed text or a string error status",
		async (adapter) => {
			const { result, events } = await runAdapter(
				adapter,
				sse(
					failedResponseEvents({
						status: "529",
						code: "upstream_529",
						message: "HTTP 529 upstream request failed",
					}),
				),
			);

			expect(events).toContain("text_delta");
			expect(result.stopReason).toBe("error");
			expect(result.rawStopReason).toBe("failed");
			expect(result.content).toContainEqual({ type: "text", text: partialText });
			expect(result.recovery?.midstream).toBeUndefined();
			expect(isRetryableMidstreamOverload(result)).toBe(false);
		},
	);

	// smarty-dev#16938: the SDK's genuine HTTP status wins over a contradictory retained SSE error body.
	it("does not promote a nested 529 over an outer SDK client status", () => {
		const error = Object.assign(new Error(statusOnlyError.message), { status: 400, error: statusOnlyError });
		const normalized = normalizeProviderError(error, "cliproxyapi");

		expect(normalized.status).toBe(400);
		expect(normalized.recovery.midstream).toBeUndefined();
	});

	// smarty-dev#16938: the classifier reads exact code/type values, never overload wording in free text.
	it.each([
		{ name: "server_is_overloaded code with 502", input: { status: 502, codes: [overloadCode] }, overload: true },
		{ name: "overloaded_error type", input: { codes: ["overloaded_error"] }, overload: true },
		{ name: "upstream overloaded code", input: { codes: ["upstream overloaded"] }, overload: true },
		{ name: "HTTP 529 with masked text", input: { status: 529, text: "Provider request failed" }, overload: true },
		{ name: "a plain 502", input: { status: 502, text: "Provider request failed" }, overload: false },
		{ name: "a plain 503", input: { status: 503, text: "Provider request failed" }, overload: false },
		{ name: "a plain 599", input: { status: 599, text: "Provider request failed" }, overload: false },
		{ name: "server_is_overloaded only in text", input: { status: 502, text: overloadCode }, overload: false },
		{ name: "upstream overloaded only in text", input: { text: "upstream overloaded" }, overload: false },
		{
			name: "the fixed network/server class",
			input: { text: "Provider request failed: network or server error" },
			overload: false,
		},
		{ name: "a differently cased code", input: { codes: ["Server_Is_Overloaded"] }, overload: false },
		{ name: "a code containing the overload code", input: { codes: ["not_server_is_overloaded"] }, overload: false },
		{ name: "a 429 beside the overload code", input: { status: 429, codes: [overloadCode] }, overload: false },
		{ name: "a 4xx beside the overload code", input: { status: 400, codes: [overloadCode] }, overload: false },
		{
			name: "request-rate text beside the overload code",
			input: { status: 502, codes: [overloadCode], text: "Request rate exceeded" },
			overload: false,
		},
		{
			name: "a rate code beside the overload type",
			input: { status: 529, codes: ["request_rate_exceeded", "overloaded_error"] },
			overload: false,
		},
		{
			name: "a quota code beside 529",
			input: { status: 529, codes: ["quota_exhausted"] },
			overload: false,
		},
		// Generic veto families beyond the audited spellings, each beside an exact overload code.
		...["requests_exceeded", "usage cap reached", "insufficient_credits", "QPS", "RPS", "429 upstream"].map(
			(text) => ({
				name: `generic rate/quota wording '${text}' beside the overload code`,
				input: { status: 502, codes: [overloadCode], text },
				overload: false,
			}),
		),
		{
			name: "a 4291-like request id does not count as 429",
			input: { status: 502, codes: [overloadCode], text: "request 14291 failed" },
			overload: true,
		},
	])("classifies $name", ({ input, overload }) => {
		expect(classifyProviderFailure(input).midstream).toBe(overload ? "overload" : undefined);
	});

	// smarty-dev#16938: the normalizer reads exact code/type fields from the SDK error and its parsed body.
	it.each([
		{ name: "an SDK code", fields: { status: 502, code: overloadCode }, overload: true },
		{
			name: "a parsed body type",
			fields: { error: { type: "overloaded_error", message: "Overloaded" } },
			overload: true,
		},
		{ name: "a parsed body code with 503", fields: { status: 503, error: { code: overloadCode } }, overload: true },
		{ name: "a numeric code", fields: { status: 502, code: 529 }, overload: false },
		{
			name: "a plain 503 body",
			fields: { status: 503, error: { code: "busy", message: "try later" } },
			overload: false,
		},
		{
			name: "a rate message beside the parsed overload code",
			fields: { status: 502, error: { code: overloadCode, message: "Request rate exceeded" } },
			overload: false,
		},
	])("normalizes $name", ({ fields, overload }) => {
		const error = Object.assign(new Error("Provider request failed"), fields);
		expect(normalizeProviderError(error, "cliproxyapi").recovery.midstream).toBe(overload ? "overload" : undefined);
	});

	// smarty-dev#16938: transport errors keep their ordinary classification without gaining midstream allowances.
	it.each([
		{ text: "ETIMEDOUT", retryable: false },
		{ text: "timeout", retryable: true },
		{ text: "ECONNRESET", retryable: true },
		{ text: "fetch failed", retryable: true },
	])("does not grant a midstream allowance for $text alone", ({ text, retryable }) => {
		const recovery = classifyProviderFailure({ text });
		expect(recovery.midstream).toBeUndefined();
		expect(recovery.retryable).toBe(retryable);
	});

	// smarty-dev#16938: the common classifier admits the owned allowance only on supported APIs and clean failures.
	it.each([
		{
			name: "observer failure",
			message: overloadMessage({
				diagnostics: [{ type: "provider_stream_observer_error", timestamp: 1 }],
			}),
		},
		{
			name: "provider limit",
			message: overloadMessage({
				diagnostics: [{ type: "provider_limit", timestamp: 1 }],
			}),
		},
		{
			name: "quota refusal",
			message: overloadMessage({
				errorMessage: "insufficient_quota",
				recovery: { retryable: false },
			}),
		},
		{
			name: "context overflow",
			message: overloadMessage({
				recovery: { recovery: "context_length_exceeded", retryable: false, midstream: "overload" },
			}),
		},
		{
			name: "an unsupported API",
			message: overloadMessage({ api: "anthropic-messages" }),
		},
		{
			name: "a successful response",
			message: overloadMessage({ stopReason: "stop" }),
		},
		{
			name: "text that looks overloaded but has no owned marker",
			message: overloadMessage({
				errorMessage: "server_is_overloaded",
				recovery: { retryable: true },
			}),
		},
		{
			name: "a message without an owned decision",
			message: overloadMessage({ errorMessage: "server_is_overloaded (529)", recovery: undefined }),
		},
	])("does not grant a replay for $name", ({ message }) => {
		expect(isRetryableMidstreamOverload(message)).toBe(false);
	});

	// smarty-dev#16938: Azure Responses uses the same overload allowance; similar API names do not grant it.
	it("allows the Azure Responses API but rejects unrelated provider APIs", () => {
		expect(isRetryableMidstreamOverload(overloadMessage({ api: "azure-openai-responses" }))).toBe(true);
		expect(isRetryableMidstreamOverload(overloadMessage({ api: "pi-messages" }))).toBe(false);
	});

	// smarty-dev#16938: ordinary transient errors before generation remain normally retryable, marker or not.
	it.each([
		{ name: "server_is_overloaded with 502", status: 502, error: { code: overloadCode }, overload: true },
		{ name: "a plain 502", status: 502, error: genericError, overload: false },
		{ name: "a plain 503", status: 503, error: genericError, overload: false },
		{
			name: "request_rate_exceeded with 502",
			status: 502,
			error: { code: "request_rate_exceeded", message: "Request rate exceeded" },
			overload: false,
		},
		{
			name: "rate_limit_exceeded with 429",
			status: 429,
			error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" },
			overload: false,
		},
	])("preserves ordinary retryability for $name before output", async ({ status, error, overload }) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: { message: privateErrorText, ...error } }), {
				status,
				headers: { "content-type": "application/json" },
			});
		const stream = streamOpenAIResponses(responsesModel, context, {
			apiKey: "fixture-key",
			maxRetries: 0,
			fetch,
		});
		for await (const _event of stream) void _event;
		const result = await stream.result();

		expect(result.content).toEqual([]);
		expect(result.recovery).toMatchObject({ recovery: "retryable", retryable: true });
		expect(isRetryableAssistantError(result)).toBe(true);
		// The marker classifies the failure; only AgentSession's observed-output gate allows the special replay.
		expect(result.recovery?.midstream).toBe(overload ? "overload" : undefined);
		expect(isRetryableMidstreamOverload(result)).toBe(overload);
	});

	// smarty-dev#16938: an observer rejection on the error frame cannot become a retryable overload.
	it("keeps observer failures terminal after partial output", async () => {
		let observed = 0;
		const { result } = await runAdapter("responses", sse(midstreamEvents()), () => {
			if (++observed === 4) throw new Error("observer must not authorize replay");
		});

		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "provider_stream_observer_error" }));
		expect(isRetryableMidstreamOverload(result)).toBe(false);
	});

	// smarty-dev#16938: even an otherwise eligible 529 cannot override the origin of an observer rejection.
	it.each(["responses", "azure", "codex"] as const)(
		"keeps %s observer failures terminal alongside a 529",
		async (adapter) => {
			let observed = 0;
			const { result, events } = await runAdapter(
				adapter,
				sse(midstreamEvents(statusOnlyError.code, statusOnlyError.message, 529)),
				() => {
					if (++observed === 4) throw new Error("observer must not authorize replay");
				},
			);

			expect(observed).toBe(4);
			expect(events).toContain("text_delta");
			expect(result.stopReason).toBe("error");
			expect(result.content).toContainEqual({ type: "text", text: partialText });
			expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "provider_stream_observer_error" }));
			expect(isRetryableMidstreamOverload(result)).toBe(false);
		},
	);

	// smarty-dev#16938: promoting a streamed status must not bypass Completions' provider-limit handling.
	it("keeps a streamed provider limit terminal alongside a numeric 529", async () => {
		const { result, events } = await runAdapter(
			"completions",
			completionsSse({
				status: 529,
				code: "smarty_limit",
				type: "smarty_limit",
				message: privateErrorText,
				throttled: false,
				window: "5h",
			}),
		);

		expect(events).toContain("text_delta");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "provider_limit" }));
		expect(result.recovery?.retryable).toBe(false);
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
	});

	// smarty-dev#16938: known final codes/types win without a provider_limit diagnostic in Responses/Codex.
	it.each(
		(["responses", "azure", "codex"] as const).flatMap((adapter) =>
			["smarty_limit", "usage_limit_reached", "usage_not_included", "quota_exceeded"].flatMap((refusal) =>
				(["code", "type"] as const).map((field) => ({ adapter, refusal, field })),
			),
		),
	)("keeps $refusal in $field terminal alongside numeric 529 in $adapter", async ({ adapter, refusal, field }) => {
		const { result, events } = await runAdapter(
			adapter,
			sse(failedResponseEvents({ ...statusOnlyError, [field]: refusal })),
		);

		expect(events).toContain("text_delta");
		expect(result.stopReason).toBe("error");
		expect(result.content).toContainEqual({ type: "text", text: partialText });
		expect(result.recovery?.retryable).toBe(false);
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
		expect(JSON.stringify(result)).not.toContain(refusal);
	});

	// smarty-dev#16938: Completions recognizes parsed smarty_limit refusals and marks them terminal.
	it("does not grant an overload allowance for a provider limit", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					error: {
						code: "smarty_limit",
						type: "smarty_limit",
						message: privateErrorText,
						throttled: false,
						window: "5h",
					},
				}),
				{ status: 429, headers: { "content-type": "application/json" } },
			);
		const stream = streamOpenAICompletions(completionsModel, context, {
			apiKey: "fixture-key",
			maxRetries: 0,
			fetch,
		});
		for await (const _event of stream) void _event;
		const result = await stream.result();

		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "provider_limit" }));
		expect(result.recovery?.midstream).toBeUndefined();
		expect(isRetryableMidstreamOverload(result)).toBe(false);
	});

	// smarty-dev#16938: quota and overflow precedence holds beside an otherwise eligible 529 in every adapter.
	it.each(
		adapters.flatMap((adapter) =>
			[
				{
					name: "quota refusal",
					code: "insufficient_quota",
					message: "subscription quota exhausted",
					recovery: undefined,
				},
				{
					name: "context overflow",
					code: "context_length_exceeded",
					message: "maximum context length exceeded",
					recovery: "context_length_exceeded",
				},
			].map((fixture) => ({ adapter, ...fixture })),
		),
	)(
		"keeps $name terminal alongside a streamed numeric 529 in $adapter",
		async ({ adapter, code, message, recovery }) => {
			const body =
				adapter === "completions"
					? completionsSse({ status: 529, code, message })
					: sse(midstreamEvents(code, message, 529));
			const { result, events } = await runAdapter(adapter, body);

			expect(events).toContain("text_delta");
			expect(result.stopReason).toBe("error");
			expect(result.content).toContainEqual({ type: "text", text: partialText });
			expect(result.recovery?.recovery).toBe(recovery);
			expect(result.recovery?.retryable).toBe(false);
			expect(result.recovery?.midstream).toBeUndefined();
			expect(isRetryableMidstreamOverload(result)).toBe(false);
		},
	);
});
