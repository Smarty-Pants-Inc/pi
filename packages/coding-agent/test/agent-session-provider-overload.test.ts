import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimple as streamOpenAICompletions } from "../../ai/src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../../ai/src/api/openai-responses.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

type Adapter = "responses" | "completions";
type Shape = "sibling" | "nested";
type ProviderEvent = { type?: string; [key: string]: unknown };
type ErrorFixture = { code?: string; type?: string; message: string; status?: number };
type Fixture =
	| { events: ProviderEvent[]; streamError?: string }
	| { status: number; body: unknown }
	| { fetchError: string };
type Request = { model: string; provider: string; api: string; thinking: string; context: string };

const requestedModel = "gpt-5.5";
const partialText = "discard this partial overload answer";
const privateErrorText = "private cliproxy upstream payload must not be exposed";
const overloadCode = "server_is_overloaded";
const statusOnlyError = { code: "upstream_failure", message: "upstream request failed" };
const rateLimitErrors = [
	{ name: "generic rate limit", error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" } },
	{
		name: "requests-per-minute limit",
		error: { code: "requests_per_minute_exceeded", message: "Requests per minute exceeded" },
	},
	{ name: "request-rate limit", error: { code: "request_rate_exceeded", message: "Request rate exceeded" } },
	{ name: "tokens-per-minute limit", error: { code: statusOnlyError.code, message: "Tokens per minute exceeded" } },
	{ name: "plain server failure", error: statusOnlyError },
];

// smarty-dev#16938: post-output replay is a positive allowlist, vetoed by any rate/quota signal.
const eligibleFailures: { name: string; error: ErrorFixture }[] = [
	{ name: "server_is_overloaded with 502", error: { code: overloadCode, message: privateErrorText, status: 502 } },
	{ name: "overloaded_error type without a status", error: { type: "overloaded_error", message: "Overloaded" } },
	{ name: "HTTP 529 with a generic code", error: { ...statusOnlyError, status: 529 } },
];
const ineligibleFailures: { name: string; error: ErrorFixture }[] = [
	...[
		"request_rate_exceeded",
		"requests_per_minute_exceeded",
		"rate_limit_exceeded",
		"tokens_per_minute_exceeded",
	].map((code) => ({ name: `${code} with 502`, error: { code, message: statusOnlyError.message, status: 502 } })),
	...[
		"Request rate exceeded",
		"Tokens per minute exceeded",
		"Requests per minute exceeded",
		"Rate limit exceeded",
	].flatMap((message) => [
		{ name: `'${message}' with 502`, error: { code: statusOnlyError.code, message, status: 502 } },
		{
			name: `'${message}' beside server_is_overloaded with 502`,
			error: { code: overloadCode, message, status: 502 },
		},
	]),
	{
		name: "request_rate_exceeded beside overloaded_error with 529",
		error: { code: "request_rate_exceeded", type: "overloaded_error", message: privateErrorText, status: 529 },
	},
	{ name: "429 with a generic code", error: { ...statusOnlyError, status: 429 } },
	{ name: "429 beside server_is_overloaded", error: { code: overloadCode, message: privateErrorText, status: 429 } },
	{ name: "plain 502 without an overload marker", error: { ...statusOnlyError, status: 502 } },
	{ name: "plain 503 without an overload marker", error: { ...statusOnlyError, status: 503 } },
];

function fixtureEvents(fixture: Fixture): string {
	if ("fetchError" in fixture) throw new Error("A fetch failure has no response events");
	if (!("events" in fixture)) return JSON.stringify(fixture.body);
	return fixture.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function textEvents(text: string): ProviderEvent[] {
	return [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: "response-overloaded" },
		},
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "message", id: "message-overloaded", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			delta: text,
		},
	];
}

/**
 * A real streamed failure after partial text. `sibling` puts the status beside the error object (the Completions
 * envelope, or the Responses event); `nested` puts it inside the error object of response.failed or Completions.
 */
function failureAfterText(adapter: Adapter, shape: Shape, { status, ...error }: ErrorFixture, text = partialText) {
	const statusField = status === undefined ? {} : { status };
	if (adapter === "completions") {
		return shape === "sibling"
			? completionsAfterText(text, error, statusField)
			: completionsAfterText(text, { ...error, ...statusField }, {});
	}
	const failed = (envelope: Record<string, unknown>, nested: Record<string, unknown>): Fixture => ({
		events: [
			...textEvents(text),
			{
				...envelope,
				type: "response.failed",
				sequence_number: 3,
				response: { id: "response-overloaded", status: "failed", error: nested },
			},
		],
	});
	if (shape === "nested") return failed({}, { ...error, ...statusField });
	// A Responses error event reserves `type` for its lifecycle; an error type travels in response.failed instead.
	return error.type === undefined
		? { events: [...textEvents(text), { type: "error", sequence_number: 3, ...statusField, ...error }] }
		: failed(statusField, error);
}

function overloadAfterText(
	text = partialText,
	code = overloadCode,
	message = privateErrorText,
	status: number | undefined = 502,
): Fixture {
	return {
		events: [
			{
				type: "response.created",
				sequence_number: 0,
				response: { id: "response-overloaded" },
			},
			{
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: { type: "message", id: "message-overloaded", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.output_text.delta",
				sequence_number: 2,
				output_index: 0,
				content_index: 0,
				delta: text,
			},
			{
				type: "error",
				sequence_number: 3,
				...(status === undefined ? {} : { status }),
				code,
				message,
			},
		],
	};
}

function completionsAfterText(
	text = partialText,
	error: Record<string, unknown> = { code: overloadCode, message: privateErrorText },
	envelope: Record<string, unknown> = { status: 502 },
): Fixture {
	return {
		events: [
			{
				id: "chatcmpl-overloaded",
				model: requestedModel,
				choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
			},
			{ ...envelope, error },
		],
	};
}

function successfulText(text: string, adapter: Adapter = "responses"): Fixture {
	if (adapter === "completions") {
		return {
			events: [
				{
					id: "chatcmpl-success",
					model: requestedModel,
					choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
				},
				{
					id: "chatcmpl-success",
					model: requestedModel,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			],
		};
	}
	return {
		events: [
			{
				type: "response.created",
				sequence_number: 0,
				response: { id: "response-success" },
			},
			{
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: { type: "message", id: "message-success", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.output_text.delta",
				sequence_number: 2,
				output_index: 0,
				content_index: 0,
				delta: text,
			},
			{
				type: "response.output_item.done",
				sequence_number: 3,
				output_index: 0,
				item: {
					type: "message",
					id: "message-success",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text, annotations: [] }],
				},
			},
			{
				type: "response.completed",
				sequence_number: 4,
				response: { id: "response-success", status: "completed" },
			},
		],
	};
}

function successfulTool(callId: string): Fixture {
	const argumentsText = JSON.stringify({ content: `effect ${callId}` });
	return {
		events: [
			{
				type: "response.created",
				sequence_number: 0,
				response: { id: `response-${callId}` },
			},
			{
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: {
					type: "function_call",
					id: `fc_${callId}`,
					call_id: callId,
					name: "record",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				sequence_number: 2,
				output_index: 0,
				item_id: `fc_${callId}`,
				delta: argumentsText,
			},
			{
				type: "response.output_item.done",
				sequence_number: 3,
				output_index: 0,
				item: {
					type: "function_call",
					id: `fc_${callId}`,
					call_id: callId,
					name: "record",
					arguments: argumentsText,
				},
			},
			{
				type: "response.completed",
				sequence_number: 4,
				response: { id: `response-${callId}`, status: "completed" },
			},
		],
	};
}

function httpOverload(): Fixture {
	return {
		status: 502,
		body: { error: { code: overloadCode, message: privateErrorText } },
	};
}

function transportFailure(message: string): Fixture {
	const fixture = overloadAfterText();
	if (!("events" in fixture)) throw new Error("Expected a streaming fixture");
	return { events: fixture.events.slice(0, 3), streamError: message };
}

function assistantHistory(h: Harness): AssistantMessage[] {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
}

describe("AgentSession midstream provider overload replay", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function setup(fixtures: Fixture[], options: HarnessOptions = {}, adapter: Adapter = "responses") {
		const h = await createHarness({
			models: [
				{ id: requestedModel, reasoning: true },
				{ id: "alternate", reasoning: true },
			],
			settings: { compaction: { enabled: false }, retry: { maxRetries: 20, baseDelayMs: 1 } },
			...options,
		});
		harnesses.push(h);
		h.session.agent.state.model = {
			...h.getModel(),
			id: requestedModel,
			api: adapter === "completions" ? "openai-completions" : "openai-responses",
			reasoning: true,
			thinkingLevelMap: { high: "high", xhigh: "xhigh" },
		};

		const requests: Request[] = [];
		const payloads: string[] = [];
		const requestUrls: string[] = [];
		let fetchCalls = 0;
		h.session.agent.streamFunction = (model, context, requestOptions) => {
			const fixture = fixtures[requests.length];
			requests.push({
				model: model.id,
				provider: model.provider,
				api: model.api,
				thinking: requestOptions?.reasoning ?? "off",
				context: JSON.stringify(context.messages),
			});
			if (!fixture) throw new Error("Unexpected fixture request");

			const fetch: typeof globalThis.fetch = async (input, _init) => {
				fetchCalls++;
				requestUrls.push(String(input));
				if ("fetchError" in fixture) throw new Error(fixture.fetchError);
				if (!("events" in fixture)) {
					return new Response(JSON.stringify(fixture.body), {
						status: fixture.status,
						headers: { "content-type": "application/json" },
					});
				}
				const bytes = new TextEncoder().encode(fixtureEvents(fixture));
				let sent = false;
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (!sent) {
							sent = true;
							controller.enqueue(bytes);
						} else if (fixture.streamError) {
							controller.error(new Error(fixture.streamError));
						} else {
							controller.close();
						}
					},
				});
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			};

			const adapterModel = {
				...model,
				api: "openai-responses",
				baseUrl: "https://cliproxyapi.invalid/v1",
			} as Model<"openai-responses">;
			const adapterOptions: Parameters<typeof streamOpenAIResponses>[2] = {
				...requestOptions,
				apiKey: "fixture-key",
				maxRetries: 0,
				fetch,
				onPayload: async (payload, payloadModel) => {
					payloads.push(JSON.stringify(payload));
					return requestOptions?.onPayload?.(payload, payloadModel);
				},
			};
			return adapter === "completions"
				? streamOpenAICompletions(
						{ ...adapterModel, api: "openai-completions" },
						context as TranscriptContext,
						adapterOptions,
					)
				: streamOpenAIResponses(adapterModel, context as TranscriptContext, adapterOptions);
		};
		return { h, requests, payloads, requestUrls, getFetchCalls: () => fetchCalls };
	}

	// smarty-dev#16938: the response adapter must tag an overloaded stream so the agent discards and replays it once.
	it("replays partial output on the same physical model and thinking level, omitting the failed response", async () => {
		const { h, requests, payloads, getFetchCalls } = await setup(
			[overloadAfterText(), successfulText("recovered answer")],
			{
				persistSession: true,
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
		);
		h.session.setThinkingLevel("high");

		await h.session.prompt("original user request");

		expect(requests).toHaveLength(2);
		expect(requests.map(({ provider, model, thinking }) => ({ provider, model, thinking }))).toEqual([
			{ provider: "faux", model: requestedModel, thinking: "high" },
			{ provider: "faux", model: requestedModel, thinking: "high" },
		]);
		expect(payloads).toHaveLength(2);
		expect(JSON.parse(payloads[0])).toMatchObject({
			model: requestedModel,
			reasoning: { effort: "high" },
		});
		expect(payloads[1]).toBe(payloads[0]);
		expect(requests[1].context).toBe(requests[0].context);
		expect(getFetchCalls()).toBe(2);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(h.session.getLastAssistantText()).toBe("recovered answer");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);

		const failed = assistantHistory(h).find((message) => message.stopReason === "error");
		expect(failed).toBeDefined();
		expect(failed?.content).toContainEqual({ type: "text", text: partialText });
		expect(failed?.recovery?.midstream).toBe("overload");
		expect(failed?.retry).toBeUndefined();
		expect(failed?.errorMessage ?? "").not.toContain(privateErrorText);
		expect(failed?.errorMessage ?? "").not.toContain(overloadCode);
		const replay = assistantHistory(h).find((message) => message.stopReason === "stop");
		expect(replay?.retry).toEqual({ count: 1, reason: "midstream_overload" });
		expect(JSON.stringify(replay?.retry)).not.toContain(partialText);
		expect(JSON.stringify(replay?.retry)).not.toContain(privateErrorText);
		expect(payloads[1]).not.toContain("midstream_overload");
		expect(payloads[1]).not.toContain('"retry"');
		const entries = h.sessionManager.getEntries();
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry"),
		).toMatchObject([
			{
				data: {
					requestedProvider: "faux",
					requestedModel,
					attempt: 1,
					retries: 1,
					reason: "midstream_overload",
				},
			},
		]);
		const failedEntry = entries.find((entry) => entry.type === "message" && entry.message === failed);
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: failedEntry?.id, replacement: null }),
		);
		const reopened = SessionManager.open(h.session.sessionFile!);
		const persistedFailures = reopened
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
					? [entry.message]
					: [],
			);
		expect(persistedFailures).toHaveLength(1);
		expect(persistedFailures[0].content).toContainEqual({ type: "text", text: partialText });
		expect(persistedFailures[0].recovery?.midstream).toBe("overload");
		expect(persistedFailures[0].retry).toBeUndefined();
		const persistedReplay = reopened
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop"
					? [entry.message]
					: [],
			)
			.at(-1);
		expect(persistedReplay?.retry).toEqual({ count: 1, reason: "midstream_overload" });
		expect(reopened.buildSessionProjection().messages).not.toContainEqual(persistedFailures[0]);
		for (const published of [
			payloads[1],
			requests[1].context,
			JSON.stringify(reopened.buildSessionProjection().messages),
		]) {
			expect(published).not.toContain(partialText);
			expect(published).not.toContain(privateErrorText);
		}
	});

	// smarty-dev#16938: the real adapter must propagate a numeric 529 without overload text to the one-shot replay.
	it.each([
		{ name: "a successful replay", replay: successfulText("status-only recovered answer"), success: true },
		{
			name: "a second status-only failure",
			replay: overloadAfterText(
				"second status-only partial answer",
				statusOnlyError.code,
				statusOnlyError.message,
				529,
			),
			success: false,
		},
	])("replays status-only streamed 529 only once with $name", async ({ replay: replayFixture, success }) => {
		const { h, requests, payloads, getFetchCalls } = await setup(
			[
				overloadAfterText(partialText, statusOnlyError.code, statusOnlyError.message, 529),
				replayFixture,
				successfulText("must not be requested"),
			],
			{
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
		);
		h.session.setThinkingLevel("high");

		await h.session.prompt("original user request");

		// RED on the pre-repair candidate: partial output is observed, but the lost status leaves one request.
		expect(requests).toHaveLength(2);
		expect(getFetchCalls()).toBe(2);
		expect(requests.map(({ provider, model, thinking }) => ({ provider, model, thinking }))).toEqual([
			{ provider: "faux", model: requestedModel, thinking: "high" },
			{ provider: "faux", model: requestedModel, thinking: "high" },
		]);
		expect(payloads).toHaveLength(2);
		expect(payloads[1]).toBe(payloads[0]);
		expect(requests[1].context).toBe(requests[0].context);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(
			h
				.eventsOfType("message_update")
				.some(
					(event) =>
						event.assistantMessageEvent.type === "text_delta" &&
						event.assistantMessageEvent.delta === partialText,
				),
		).toBe(true);

		const history = assistantHistory(h);
		expect(history).toHaveLength(2);
		const [failed, replay] = history;
		expect(failed.stopReason).toBe("error");
		expect(failed.content).toContainEqual({ type: "text", text: partialText });
		expect(failed.recovery?.midstream).toBe("overload");
		expect(failed.retry).toBeUndefined();
		expect(failed.errorMessage).toContain("(529)");
		expect(failed.errorMessage ?? "").not.toContain(statusOnlyError.code);
		expect(failed.errorMessage ?? "").not.toContain(statusOnlyError.message);
		expect(replay.stopReason).toBe(success ? "stop" : "error");
		expect(replay.retry).toEqual({ count: 1, reason: "midstream_overload" });
		expect(history.filter((message) => message.stopReason === "error")).toHaveLength(success ? 1 : 2);
		if (success) expect(h.session.getLastAssistantText()).toBe("status-only recovered answer");
		else expect(replay.recovery?.midstream).toBe("overload");
		const entries = h.sessionManager.getEntries();
		const failedEntry = entries.find((entry) => entry.type === "message" && entry.message === failed);
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: failedEntry?.id, replacement: null }),
		);
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry"),
		).toMatchObject([
			{
				data: { requestedProvider: "faux", requestedModel, attempt: 1, retries: 1, reason: "midstream_overload" },
			},
		]);
		for (const published of [payloads[1], requests[1].context]) {
			expect(published).not.toContain(partialText);
			expect(published).not.toContain(statusOnlyError.code);
			expect(published).not.toContain(statusOnlyError.message);
			expect(published).not.toContain("midstream_overload");
			expect(published).not.toContain('"retry"');
		}
	});

	// smarty-dev#16938: exercise the real Completions SDK, which unwraps error and discards its sibling status.
	// The exact server_is_overloaded code qualifies; the sibling 502 must still survive for the 429/4xx vetoes.
	it.each([
		{
			name: "a successful replay",
			replay: successfulText("Completions recovered answer", "completions"),
			success: true,
		},
		{
			name: "a terminal second failure",
			replay: completionsAfterText("second Completions partial answer"),
			success: false,
		},
	])("replays Completions sibling-status 502 once with $name and no fallback", async ({ replay, success }) => {
		const { h, requests, payloads, requestUrls, getFetchCalls } = await setup(
			[completionsAfterText(), replay, successfulText("must not be requested", "completions")],
			{
				persistSession: true,
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
			"completions",
		);
		h.session.setThinkingLevel("high");

		await h.session.prompt("original Completions user request");

		// The sibling-status regression leaves only one request despite a real text_delta reaching AgentSession.
		expect(requests).toHaveLength(2);
		expect(getFetchCalls()).toBe(2);
		expect(requestUrls).toEqual([
			"https://cliproxyapi.invalid/v1/chat/completions",
			"https://cliproxyapi.invalid/v1/chat/completions",
		]);
		expect(requests.map(({ provider, model, api, thinking }) => ({ provider, model, api, thinking }))).toEqual([
			{ provider: "faux", model: requestedModel, api: "openai-completions", thinking: "high" },
			{ provider: "faux", model: requestedModel, api: "openai-completions", thinking: "high" },
		]);
		expect(payloads).toHaveLength(2);
		expect(JSON.parse(payloads[0])).toMatchObject({ model: requestedModel, reasoning_effort: "high" });
		expect(payloads[1]).toBe(payloads[0]);
		expect(requests[1].context).toBe(requests[0].context);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(h.session.model?.api).toBe("openai-completions");
		expect(h.session.thinkingLevel).toBe("high");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(
			h
				.eventsOfType("message_update")
				.some(
					(event) =>
						event.assistantMessageEvent.type === "text_delta" &&
						event.assistantMessageEvent.delta === partialText,
				),
		).toBe(true);

		const history = assistantHistory(h);
		expect(history).toHaveLength(2);
		const [failed, terminal] = history;
		expect(failed.api).toBe("openai-completions");
		expect(failed.stopReason).toBe("error");
		expect(failed.content).toContainEqual({ type: "text", text: partialText });
		expect(failed.recovery?.midstream).toBe("overload");
		expect(failed.retry).toBeUndefined();
		expect(failed.errorMessage).toContain("(502)");
		expect(terminal.api).toBe("openai-completions");
		expect(terminal.stopReason).toBe(success ? "stop" : "error");
		expect(terminal.retry).toEqual({ count: 1, reason: "midstream_overload" });
		if (success) {
			expect(h.session.getLastAssistantText()).toBe("Completions recovered answer");
		} else {
			expect(terminal.content).toContainEqual({ type: "text", text: "second Completions partial answer" });
			expect(terminal.recovery?.midstream).toBe("overload");
			expect(terminal.errorMessage).toContain("(502)");
		}
		for (const message of history) {
			expect(JSON.stringify(message)).not.toContain(overloadCode);
			expect(JSON.stringify(message)).not.toContain(privateErrorText);
		}

		const reopened = SessionManager.open(h.session.sessionFile!);
		const entries = reopened.getEntries();
		const persistedFailures = entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
				? [entry.message]
				: [],
		);
		expect(persistedFailures).toHaveLength(success ? 1 : 2);
		expect(persistedFailures[0]).toEqual(failed);
		expect(persistedFailures[0].content).toContainEqual({ type: "text", text: partialText });
		const failedEntry = entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "text" && block.text === partialText),
		);
		expect(failedEntry).toBeDefined();
		expect(entries.filter((entry) => entry.type === "context_edit")).toEqual([
			expect.objectContaining({ targetId: failedEntry?.id, replacement: null }),
		]);
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry"),
		).toMatchObject([
			{
				data: { requestedProvider: "faux", requestedModel, attempt: 1, retries: 1, reason: "midstream_overload" },
			},
		]);
		const persistedTerminal = entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" && entry.message.retry ? [entry.message] : [],
		);
		expect(persistedTerminal).toEqual([terminal]);
		const projection = reopened.buildSessionProjection().messages;
		expect(projection).not.toContainEqual(failed);
		for (const published of [payloads[1], requests[1].context, JSON.stringify(projection)]) {
			expect(published).not.toContain(partialText);
			expect(published).not.toContain(overloadCode);
			expect(published).not.toContain(privateErrorText);
		}
		for (const providerInput of [payloads[1], requests[1].context]) {
			expect(providerInput).not.toContain("midstream_overload");
			expect(providerInput).not.toContain('"retry"');
		}
	});

	// smarty-dev#16938: cancellation during real Completions output must not replay a pending sibling-status 502.
	it("does not replay Completions sibling-status after the user aborts during partial text", async () => {
		const { h, requests, getFetchCalls } = await setup(
			[completionsAfterText(), successfulText("must not be requested", "completions")],
			{
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
			"completions",
		);
		let abort: Promise<void> | undefined;
		h.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				abort ??= h.session.abort();
			}
		});

		await h.session.prompt("abort during Completions output");
		await abort;

		expect(abort).toBeDefined();
		expect(requests).toHaveLength(1);
		expect(getFetchCalls()).toBe(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "aborted", aborted: true }]);
	});

	// smarty-dev#16938: a failed replay is terminal even when ordinary retries and model fallback remain available.
	it("does not retry a second overload or switch to a configured fallback model", async () => {
		const { h, requests } = await setup(
			[overloadAfterText(), overloadAfterText("second partial output"), successfulText("unused")],
			{
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 50, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
		);

		await h.session.prompt("request with terminal second overload");

		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.model === requestedModel)).toBe(true);
		expect(h.session.model?.id).toBe(requestedModel);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		const failedMessages = assistantHistory(h).filter((message) => message.stopReason === "error");
		expect(failedMessages).toHaveLength(2);
		expect(failedMessages[0].retry).toBeUndefined();
		expect(failedMessages[1].retry).toEqual({ count: 1, reason: "midstream_overload" });
	});

	// smarty-dev#16938: request preparation may select another model, but an overload replay is pinned to its source.
	it("keeps the source model and thinking level when prepareRequest changes its next selection", async () => {
		let prepared = 0;
		const { h, requests } = await setup([overloadAfterText(), successfulText("recovered")], {
			prepareRequest: (request) => ({
				model: { ...request.model, id: ++prepared === 1 ? requestedModel : "alternate" },
			}),
		});
		h.session.setThinkingLevel("high");

		await h.session.prompt("prepared model request");

		expect(prepared).toBe(2);
		expect(requests.map((request) => request.model)).toEqual([requestedModel, requestedModel]);
		expect(requests.map((request) => request.thinking)).toEqual(["high", "high"]);
		expect(h.session.model?.id).toBe(requestedModel);
	});

	// smarty-dev#16938: virtual routing is resolved once; replay keeps the selected physical model and effort.
	it("retains a virtual route's physical model and non-default thinking level", async () => {
		const { h, requests } = await setup([overloadAfterText(), successfulText("recovered")]);
		h.modelRuntime.registerProvider("faux", {
			api: h.faux.api,
			apiKey: "faux-key",
			baseUrl: h.getModel().baseUrl,
			models: h.models.map((model) => ({
				...model,
				thinkingLevelMap: { xhigh: "xhigh" },
			})),
		});
		let routes = 0;
		h.modelRuntime.registerVirtualModel({
			provider: "faux",
			id: "router",
			name: "Router",
			route: () => ({
				model: h.getModel(++routes === 1 ? requestedModel : "alternate")!,
				thinkingLevel: "xhigh",
			}),
		});
		await h.modelRuntime.refresh({ allowNetwork: false });
		h.session.agent.state.model = h.modelRuntime.getModel("faux", "router")!;

		await h.session.prompt("virtual route request");

		expect(routes).toBe(1);
		expect(requests.map((request) => request.model)).toEqual([requestedModel, requestedModel]);
		expect(requests.map((request) => request.thinking)).toEqual(["xhigh", "xhigh"]);
		expect(h.session.model?.id).toBe("router");
	});

	// smarty-dev#16938: a successful tool response renews the per-response replay, but not the prompt-wide limit.
	// smarty-dev#4605 F1: a custom continuation is not a new user prompt; only genuine input resets the cap.
	it.each([
		{ name: "without a custom continuation", customContinuation: false },
		{ name: "with a custom continuation", customContinuation: true },
	])("caps retries at three for one user prompt $name, then resets on fresh input", async ({ customContinuation }) => {
		const effects: string[] = [];
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Count an in-memory test effect",
			parameters: Type.Object({ content: Type.String() }),
			execute: async (toolCallId) => {
				effects.push(toolCallId);
				return { content: [{ type: "text", text: "recorded" }], details: undefined };
			},
		};
		const cappedText = "fourth marker remains terminal";
		const fixtures = [
			overloadAfterText("partial one"),
			successfulTool("tool-1"),
			overloadAfterText("partial two"),
			successfulTool("tool-2"),
			overloadAfterText("partial three"),
			successfulTool("tool-3"),
			overloadAfterText(cappedText),
			...(customContinuation ? [overloadAfterText("custom continuation remains capped")] : []),
			overloadAfterText("fresh prompt can retry"),
			successfulText("fresh prompt recovered"),
		];
		const { h, requests, payloads } = await setup(fixtures, {
			tools: [tool],
			persistSession: true,
			settings: {
				compaction: { enabled: false },
				retry: { maxRetries: 50, baseDelayMs: 1, fallbackModel: "faux/alternate" },
			},
		});
		let customAcceptance: Promise<void> | undefined;
		let customScheduled = false;
		if (customContinuation) {
			h.session.subscribe((event) => {
				if (event.type !== "agent_settled" || customScheduled) return;
				customScheduled = true;
				customAcceptance = h.session.sendCustomMessage(
					{ customType: "overload-continuation", content: "continue this activity", display: false },
					{ triggerTurn: true },
				);
			});
		}

		await h.session.prompt("one user prompt with repeated tool responses");
		if (customAcceptance) await customAcceptance;

		expect(requests).toHaveLength(customContinuation ? 8 : 7);
		expect(requests.every((request) => request.model === requestedModel)).toBe(true);
		expect(effects).toEqual(["tool-1|fc_tool-1", "tool-2|fc_tool-2", "tool-3|fc_tool-3"]);
		expect(h.eventsOfType("tool_execution_start").map((event) => event.toolCallId)).toEqual(effects);
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([
			{ attempt: 1, maxAttempts: 1 },
			{ attempt: 1, maxAttempts: 1 },
			{ attempt: 1, maxAttempts: 1 },
		]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		expect(h.eventsOfType("message_start").filter((event) => event.message.role === "user")).toHaveLength(1);
		const retryEntries = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry");
		expect(retryEntries.map((entry) => entry.type === "custom" && entry.data)).toEqual(
			[1, 2, 3].map((retries) => ({
				requestedProvider: "faux",
				requestedModel,
				attempt: 1,
				retries,
				reason: "midstream_overload",
			})),
		);
		const capEntries = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry_cap_hit");
		expect(capEntries).toHaveLength(customContinuation ? 2 : 1);
		expect(capEntries.map((entry) => entry.type === "custom" && entry.data)).toEqual(
			Array.from({ length: customContinuation ? 2 : 1 }, () => ({
				requestedProvider: "faux",
				requestedModel,
				retries: 3,
				limit: 3,
				reason: "midstream_overload",
			})),
		);
		const replayTerminals = assistantHistory(h).filter((message) => message.retry !== undefined);
		expect(replayTerminals).toHaveLength(3);
		for (const message of replayTerminals) {
			expect(message.retry).toEqual({ count: 1, reason: "midstream_overload" });
			expect(JSON.stringify(message.retry)).not.toContain("partial");
		}
		if (customContinuation) {
			expect(customScheduled).toBe(true);
			expect(customAcceptance).toBeDefined();
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "overload-continuation"),
			).toHaveLength(1);
		}

		const failedMessages = assistantHistory(h).filter((message) => message.stopReason === "error");
		expect(failedMessages).toHaveLength(customContinuation ? 5 : 4);
		const retriedText = ["partial one", "partial two", "partial three"];
		for (const text of retriedText) {
			expect(payloads.some((payload) => payload.includes(text))).toBe(false);
		}
		const entries = SessionManager.open(h.session.sessionFile!).getEntries();
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "context_edit")).toHaveLength(3);
		expect(JSON.stringify(entries)).toContain(cappedText);
		expect(JSON.stringify(entries.filter((entry) => entry.type === "custom_message"))).not.toContain(cappedText);

		// Do not let the deliberately large budget or the custom continuation carry this prompt's cap into new input.
		h.session.setAutoCompactionEnabled(false);
		await h.session.prompt("a genuinely fresh user prompt");
		expect(requests).toHaveLength(customContinuation ? 10 : 9);
		expect(h.eventsOfType("message_start").filter((event) => event.message.role === "user")).toHaveLength(2);
		expect(effects).toEqual(["tool-1|fc_tool-1", "tool-2|fc_tool-2", "tool-3|fc_tool-3"]);
		expect(h.eventsOfType("auto_retry_start")).toHaveLength(4);
		expect(h.session.getLastAssistantText()).toBe("fresh prompt recovered");
		const lastRetry = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry")
			.at(-1);
		expect(lastRetry).toHaveProperty("data", {
			requestedProvider: "faux",
			requestedModel,
			attempt: 1,
			retries: 1,
			reason: "midstream_overload",
		});
		expect(assistantHistory(h).filter((message) => message.retry !== undefined)).toHaveLength(4);
	});

	// smarty-dev#16938: a started tool effect is sticky for this response and cannot be cleared by message_start.
	it("retries a partial unexecuted tool call but refuses replay after execution starts", async () => {
		let effects = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Count an in-memory test effect",
			parameters: Type.Object({ content: Type.String() }),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "recorded" }], details: undefined };
			},
		};
		const partialInput = "partial call that was never executed";
		const partialCall: Fixture = {
			events: [
				{
					type: "response.output_item.added",
					sequence_number: 0,
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_partial",
						call_id: "partial-call",
						name: "record",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					sequence_number: 1,
					output_index: 0,
					item_id: "fc_partial",
					delta: JSON.stringify({ content: partialInput }).slice(0, 24),
				},
				{ type: "error", sequence_number: 2, code: overloadCode, message: privateErrorText },
			],
		};
		const recoverable = await setup([partialCall, successfulText("recovered without executing partial tool")], {
			tools: [tool],
		});
		await recoverable.h.session.prompt("partial tool request");
		expect(recoverable.requests).toHaveLength(2);
		expect(effects).toBe(0);
		expect(recoverable.h.eventsOfType("tool_execution_start")).toEqual([]);
		expect(recoverable.payloads[1]).not.toContain(partialInput);

		const started = await setup([overloadAfterText(), successfulText("must not be requested")], { tools: [tool] });
		const receiver = started.h.session as unknown as {
			_handleAgentEvent(event: AgentEvent): Promise<void>;
		};
		let injected = false;
		started.h.session.agent.subscribe(async (event) => {
			if (
				injected ||
				event.type !== "message_update" ||
				event.message.role !== "assistant" ||
				event.assistantMessageEvent.type !== "text_delta"
			)
				return;
			injected = true;
			await receiver._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "started-tool",
				toolName: "record",
				args: { content: "effect started in this response" },
			});
			await receiver._handleAgentEvent({
				type: "message_start",
				message: { ...event.message, content: [] },
			});
			await tool.execute("started-tool", { content: "effect started in this response" });
		});
		await started.h.session.prompt("tool effect has started");
		expect(injected).toBe(true);
		expect(effects).toBe(1);
		expect(started.requests).toHaveLength(1);
		expect(started.h.eventsOfType("auto_retry_start")).toEqual([]);
	});

	// smarty-dev#16938: every allowlisted overload signal still refuses replay once a tool from the response started.
	it.each(
		(["responses", "completions"] as const).flatMap((adapter) =>
			eligibleFailures.map((fixture) => ({ adapter, ...fixture })),
		),
	)("allowlist: $adapter $name refuses replay after a tool started", async ({ adapter, error }) => {
		let effects = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Count an in-memory test effect",
			parameters: Type.Object({ content: Type.String() }),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "recorded" }], details: undefined };
			},
		};
		const started = await setup(
			[failureAfterText(adapter, "sibling", error), successfulText("must not be requested", adapter)],
			{
				tools: [tool],
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
			adapter,
		);
		const receiver = started.h.session as unknown as {
			_handleAgentEvent(event: AgentEvent): Promise<void>;
		};
		let injected = false;
		started.h.session.agent.subscribe(async (event) => {
			if (
				injected ||
				event.type !== "message_update" ||
				event.message.role !== "assistant" ||
				event.assistantMessageEvent.type !== "text_delta"
			)
				return;
			injected = true;
			await receiver._handleAgentEvent({
				type: "tool_execution_start",
				toolCallId: "started-tool",
				toolName: "record",
				args: { content: "effect started in this response" },
			});
			await tool.execute("started-tool", { content: "effect started in this response" });
		});

		await started.h.session.prompt("tool effect has started");

		expect(injected).toBe(true);
		expect(effects).toBe(1);
		expect(started.requests).toHaveLength(1);
		expect(started.getFetchCalls()).toBe(1);
		expect(started.h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(started.h.eventsOfType("auto_retry_fallback")).toEqual([]);
		const [failure] = assistantHistory(started.h);
		// The marker is present; only the started tool refuses the replay.
		expect(failure.recovery?.midstream).toBe("overload");
		expect(failure.retry).toBeUndefined();
	});

	// smarty-dev#16938: each allowlisted overload signal replays once through the real adapter and session.
	it.each(
		(["responses", "completions"] as const).flatMap((adapter) =>
			(["sibling", "nested"] as const).flatMap((shape) =>
				eligibleFailures.map((fixture) => ({ adapter, shape, ...fixture })),
			),
		),
	)("allowlist: $adapter $name with $shape status replays once", async ({ adapter, shape, error }) => {
		const { h, requests, payloads, getFetchCalls } = await setup(
			[
				failureAfterText(adapter, shape, error),
				successfulText("allowlisted overload recovered", adapter),
				successfulText("must not be requested", adapter),
			],
			{
				settings: {
					compaction: { enabled: false },
					retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
				},
			},
			adapter,
		);
		h.session.setThinkingLevel("high");

		await h.session.prompt("partial answer followed by an allowlisted overload");

		expect(requests).toHaveLength(2);
		expect(getFetchCalls()).toBe(2);
		expect(requests.map(({ provider, model, thinking }) => ({ provider, model, thinking }))).toEqual([
			{ provider: "faux", model: requestedModel, thinking: "high" },
			{ provider: "faux", model: requestedModel, thinking: "high" },
		]);
		expect(payloads[1]).toBe(payloads[0]);
		expect(h.session.getLastAssistantText()).toBe("allowlisted overload recovered");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		const [failed, replay] = assistantHistory(h);
		expect(failed.content).toContainEqual({ type: "text", text: partialText });
		expect(failed.recovery?.midstream).toBe("overload");
		expect(replay.retry).toEqual({ count: 1, reason: "midstream_overload" });
		for (const value of [error.code, error.type, error.message]) {
			if (value !== undefined) expect(JSON.stringify(assistantHistory(h))).not.toContain(value);
		}
		const entries = h.sessionManager.getEntries();
		const failedEntry = entries.find((entry) => entry.type === "message" && entry.message === failed);
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: failedEntry?.id, replacement: null }),
		);
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry"),
		).toHaveLength(1);
		expect(payloads[1]).not.toContain(partialText);
	});

	// smarty-dev#16938: no rate/quota spelling, 429 or plain 5xx after text may spend the replay or fallback budget.
	it.each(
		(["responses", "completions"] as const).flatMap((adapter) =>
			(["sibling", "nested"] as const).flatMap((shape) =>
				ineligibleFailures.map((fixture) => ({ adapter, shape, ...fixture })),
			),
		),
	)(
		"allowlist: $adapter $name with $shape status gets no replay or fallback with an ordinary budget of 20",
		async ({ adapter, shape, error: rateLimitError }) => {
			const fixture = failureAfterText(adapter, shape, rateLimitError);
			const { h, requests, payloads, requestUrls, getFetchCalls } = await setup(
				[fixture, successfulText("must not be requested", adapter)],
				{
					settings: {
						compaction: { enabled: false },
						retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
					},
				},
				adapter,
			);
			h.session.setThinkingLevel("high");

			await h.session.prompt("partial answer followed by a rate limit");

			expect(requests).toHaveLength(1);
			expect(getFetchCalls()).toBe(1);
			expect(requestUrls).toEqual([
				`https://cliproxyapi.invalid/v1/${adapter === "completions" ? "chat/completions" : "responses"}`,
			]);
			expect(payloads).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				provider: "faux",
				model: requestedModel,
				api: adapter === "completions" ? "openai-completions" : "openai-responses",
				thinking: "high",
			});
			expect(h.session.model?.id).toBe(requestedModel);
			expect(h.session.thinkingLevel).toBe("high");
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
			expect(h.eventsOfType("auto_retry_end")).toEqual([]);
			expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
			expect(
				h
					.eventsOfType("message_update")
					.some(
						(event) =>
							event.assistantMessageEvent.type === "text_delta" &&
							event.assistantMessageEvent.delta === partialText,
					),
			).toBe(true);

			const history = assistantHistory(h);
			expect(history).toHaveLength(1);
			const [failure] = history;
			expect(failure.stopReason).toBe("error");
			expect(failure.content).toContainEqual({ type: "text", text: partialText });
			expect(failure.errorMessage).toContain(`(${rateLimitError.status})`);
			// The ordinary decision stays retryable; only observed output blocks the ordinary retry.
			expect(failure.recovery?.recovery).toBe("retryable");
			expect(failure.recovery?.retryable).toBe(true);
			expect(failure.recovery?.midstream).toBeUndefined();
			expect(failure.retry).toBeUndefined();
			for (const value of [rateLimitError.code, rateLimitError.type, rateLimitError.message]) {
				if (value !== undefined) expect(JSON.stringify(failure)).not.toContain(value);
			}
			const entries = h.sessionManager.getEntries();
			expect(entries.filter((entry) => entry.type === "context_edit")).toEqual([]);
			expect(
				entries.filter(
					(entry) => entry.type === "custom" && entry.customType.startsWith("midstream_overload_retry"),
				),
			).toEqual([]);
		},
	);

	// smarty-dev#16938: excluding special replay must not turn transient pre-output rate limits into final refusals.
	it.each(
		(["responses", "completions"] as const).flatMap((adapter) =>
			[429, 502, 503].flatMap((status) => rateLimitErrors.map((fixture) => ({ adapter, status, ...fixture }))),
		),
	)(
		"rate-limit exclusion: $adapter $name pre-output HTTP $status still succeeds via ordinary retry",
		async ({ adapter, status, error: rateLimitError }) => {
			const { h, requests, getFetchCalls } = await setup(
				[
					{ status, body: { error: rateLimitError } },
					successfulText("ordinary rate-limit retry succeeded", adapter),
				],
				{
					settings: {
						compaction: { enabled: false },
						retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
					},
				},
				adapter,
			);

			await h.session.prompt("rate limit before output");

			expect(requests).toHaveLength(2);
			expect(getFetchCalls()).toBe(2);
			expect(requests.every((request) => request.provider === "faux" && request.model === requestedModel)).toBe(
				true,
			);
			expect(h.session.model?.id).toBe(requestedModel);
			expect(h.session.getLastAssistantText()).toBe("ordinary rate-limit retry succeeded");
			expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 20 }]);
			expect(h.eventsOfType("auto_retry_start")).toHaveLength(1);
			expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
			expect(h.eventsOfType("auto_retry_end")).toHaveLength(1);
			expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
			const history = assistantHistory(h);
			expect(history).toHaveLength(2);
			const [failure, success] = history;
			expect(failure.stopReason).toBe("error");
			expect(failure.content).toEqual([]);
			expect(failure.errorMessage).toContain(`(${status})`);
			expect(failure.recovery?.recovery).toBe("retryable");
			expect(failure.recovery?.retryable).toBe(true);
			expect(failure.recovery?.midstream).toBeUndefined();
			expect(failure.retry).toBeUndefined();
			expect(JSON.stringify(failure)).not.toContain(rateLimitError.code);
			expect(JSON.stringify(failure)).not.toContain(rateLimitError.message);
			expect(success.stopReason).toBe("stop");
			expect(success.retry).toBeUndefined();
			expect(
				h.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType.startsWith("midstream_overload_retry")),
			).toEqual([]);
		},
	);

	// smarty-dev#16938: overloads before output remain on the ordinary configured retry path.
	it("keeps ordinary pre-output overloads on the existing retry budget", async () => {
		const { h, requests } = await setup([httpOverload(), successfulText("ordinary retry succeeded")]);

		await h.session.prompt("request failed before generation began");

		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.model === requestedModel)).toBe(true);
		expect(h.session.getLastAssistantText()).toBe("ordinary retry succeeded");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 20 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		const firstFailure = assistantHistory(h).find((message) => message.stopReason === "error");
		expect(firstFailure?.recovery?.midstream).toBe("overload");
		expect(firstFailure?.retry).toBeUndefined();
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry"),
		).toEqual([]);
	});

	// smarty-dev#16938: transport failures keep their ordinary classification but stay final after output.
	it.each([
		{ message: "ETIMEDOUT", retryable: false },
		{ message: "ECONNRESET", retryable: true },
		{ message: "fetch failed", retryable: true },
	])("does not replay partial output on $message alone", async ({ message, retryable }) => {
		const { h, requests } = await setup([transportFailure(message), successfulText("must not be requested")], {
			settings: {
				compaction: { enabled: false },
				retry: { maxRetries: 20, baseDelayMs: 1, fallbackModel: "faux/alternate" },
			},
		});

		await h.session.prompt("partial response followed by a transport error");

		expect(requests).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
		const failure = assistantHistory(h).find((entry) => entry.stopReason === "error");
		expect(failure?.content).toContainEqual({ type: "text", text: partialText });
		expect(failure?.recovery?.retryable).toBe(retryable);
		expect(failure?.recovery?.midstream).toBeUndefined();
		expect(failure?.retry).toBeUndefined();
	});

	// smarty-dev#16938: a pre-output transport failure retains the normal retry budget.
	it("keeps pre-output fetch failures on the ordinary retry path", async () => {
		const { h, requests } = await setup([{ fetchError: "fetch failed" }, successfulText("ordinary retry succeeded")]);

		await h.session.prompt("request failed before streaming began");

		expect(requests).toHaveLength(2);
		expect(h.session.getLastAssistantText()).toBe("ordinary retry succeeded");
		expect(h.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 20 }]);
		expect(h.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		const firstFailure = assistantHistory(h).find((message) => message.stopReason === "error");
		expect(firstFailure?.recovery?.retryable).toBe(true);
		expect(firstFailure?.recovery?.midstream).toBeUndefined();
		expect(firstFailure?.retry).toBeUndefined();
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "midstream_overload_retry"),
		).toEqual([]);
	});

	// smarty-dev#16938: the special replay remains subject to retry settings and user cancellation.
	it.each([
		{ name: "disabled retries", retry: { enabled: false, maxRetries: 20, baseDelayMs: 1 } },
		{ name: "zero retries", retry: { maxRetries: 0, baseDelayMs: 1, fallbackModel: "faux/alternate" } },
	])("honors $name for a midstream overload", async ({ retry }) => {
		const { h, requests } = await setup([overloadAfterText(), successfulText("must not be requested")], {
			settings: { compaction: { enabled: false }, retry },
		});

		await h.session.prompt("retry policy boundary");

		expect(requests).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("auto_retry_fallback")).toEqual([]);
	});

	// smarty-dev#16938: an abort observed while partial output is arriving must not trigger replay.
	it("does not replay after the user aborts during the overloaded stream", async () => {
		const { h, requests } = await setup([overloadAfterText(), successfulText("must not be requested")]);
		let abort: Promise<void> | undefined;
		h.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				abort ??= h.session.abort();
			}
		});

		await h.session.prompt("abort during output");
		await abort;

		expect(abort).toBeDefined();
		expect(requests).toHaveLength(1);
		expect(h.eventsOfType("auto_retry_start")).toEqual([]);
		expect(h.eventsOfType("agent_settled")).toMatchObject([{ outcome: "aborted", aborted: true }]);
	});
});
