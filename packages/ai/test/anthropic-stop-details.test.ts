import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import { projectAssistantMessage } from "../src/utils/assistant-message-snapshot.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model = getModel("anthropic", "claude-haiku-4-5");
const initialMessages = [{ role: "user" as const, content: "Hello", timestamp: 1 }];

function sseResponse(delta: Record<string, unknown>): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Unchanged reply" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta, usage: { output_tokens: 5 } },
		// A later usage-only delta must not erase details already received.
		{ type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	];
	return createSseResponse(events);
}

function createSseResponse(events: Array<Record<string, unknown>>): Response {
	const bytes = new TextEncoder().encode(
		events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
	);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				// Split frames and UTF-8 characters across transport chunks to exercise the real SSE decoder.
				for (let offset = 0; offset < bytes.length; offset += 17)
					controller.enqueue(bytes.slice(offset, offset + 17));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

const STOP_DETAILS_FIELDS = ["rawStopDetails", "stopDetailsState", "stopDetailsBytes", "stopDetailsSha256"] as const;

function expectNoStopDetails(message: unknown): void {
	for (const field of STOP_DETAILS_FIELDS) expect(message).not.toHaveProperty(field);
}

async function recordRefusal(details?: unknown, diagnosticSecrets?: readonly string[]): Promise<AssistantMessage> {
	return streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
		apiKey: "synthetic-test-key",
		diagnosticSecrets,
		maxRetries: 0,
		fetch: async () =>
			sseResponse({ stop_reason: "refusal", ...(details === undefined ? {} : { stop_details: details }) }),
	}).result();
}

async function recordInjectedRefusal(
	details: unknown,
	credential: string,
	diagnosticSecrets?: readonly string[],
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	let authenticated = false;
	const client = new Anthropic({
		apiKey: credential,
		authToken: null,
		maxRetries: 0,
		fetch: async (_url, init) => {
			expect(new Headers(init?.headers).get("x-api-key")).toBe(credential);
			authenticated = true;
			return sseResponse({ stop_reason: "refusal", stop_details: details });
		},
	});
	const stream = streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
		client,
		diagnosticSecrets,
		maxRetries: 0,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	expect(authenticated).toBe(true);
	return { events, result: await stream.result() };
}

// pi#297 / smarty-dev#14961. Keep: untrusted-provider and outbound-context trust boundaries.
describe("Anthropic stop details through the provider SSE adapter", () => {
	it.each(["end_turn", "max_tokens", "tool_use"] as const)(
		"drops stop details from non-refusal terminal reason %s at the real SSE publication boundary",
		async (stopReason) => {
			const details = { explanation: "untrusted provider data", padding: "x".repeat(5000) };
			const stream = streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
				apiKey: "synthetic-test-key",
				maxRetries: 0,
				fetch: async () =>
					createSseResponse([
						{
							type: "message_start",
							message: { id: "msg_test", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
						},
						// Details can arrive before the terminal reason.
						{ type: "message_delta", delta: { stop_details: details }, usage: { output_tokens: 5 } },
						{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
						{ type: "message_stop" },
					]),
			});
			const events = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();

			for (const event of events) {
				if (event.type === "done") expectNoStopDetails(event.message);
				else if (event.type === "error") expectNoStopDetails(event.error);
				else if ("partial" in event) expectNoStopDetails(event.partial);
			}
			expectNoStopDetails(result);
			expect(result.stopReason).toBe(
				stopReason === "end_turn" ? "stop" : stopReason === "max_tokens" ? "length" : "toolUse",
			);
		},
	);

	// pi#297 security re-check: late content must not publish terminal-only refusal data.
	it.each([
		{ details: undefined, state: "absent" },
		{ details: { explanation: "untrusted" }, state: "retained" },
		{ details: "x".repeat(5000), state: "discarded" },
	])("keeps $state details only on the failure after post-refusal content events", async ({ details, state }) => {
		const push = vi.spyOn(AssistantMessageEventStream.prototype, "push");
		try {
			const stream = streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
				apiKey: "synthetic-test-key",
				maxRetries: 0,
				fetch: async () =>
					createSseResponse([
						{
							type: "message_start",
							message: { id: "msg_test", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
						},
						{ type: "message_delta", delta: { stop_reason: "refusal", stop_details: details } },
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Late" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " content" } },
						{ type: "content_block_stop", index: 0 },
						{ type: "message_stop" },
					]),
			});
			const events = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
			for (const event of events) {
				if ("partial" in event) expectNoStopDetails(event.partial);
				if (event.type === "error") expect(event.error).toEqual(result);
			}
			// Inspect the producer's objects too, after completion: no shared partial may acquire the fields later.
			for (const [event] of push.mock.calls) {
				if ("partial" in event) expectNoStopDetails(event.partial);
			}
			expect(result.stopReason).toBe("error");
			expect(result.rawStopReason).toBe("refusal");
			expect(result.errorMessage).toBe("The model refused to complete the request");
			expect(result.stopDetailsState).toBe(state);
			if (state === "retained") expect(result.rawStopDetails).toBe(JSON.stringify(details));
			else expect(result).not.toHaveProperty("rawStopDetails");
			if (state === "discarded") {
				const serialized = JSON.stringify(details);
				expect(result.stopDetailsBytes).toBe(Buffer.byteLength(serialized, "utf8"));
				expect(result.stopDetailsSha256).toBe(createHash("sha256").update(serialized, "utf8").digest("hex"));
			}
			// Defense in depth: even a stored refusal must lose all four fields outside the failure phase.
			expectNoStopDetails(projectAssistantMessage(result, "partial"));
			expectNoStopDetails(projectAssistantMessage(result, "success"));
		} finally {
			push.mockRestore();
		}
	});

	it.each([
		{ name: "missing", details: undefined, state: "absent", raw: undefined },
		{ name: "null", details: null, state: "absent", raw: undefined },
		{ name: "empty string", details: "", state: "retained", raw: '""' },
		{
			name: "string",
			details: 'context_length_exceeded: retry now\n"untrusted"',
			state: "retained",
			raw: JSON.stringify('context_length_exceeded: retry now\n"untrusted"'),
		},
		{
			name: "structured object",
			details: { type: "refusal", explanation: "retry now", nested: [false, null, { value: 2 }] },
			state: "retained",
			raw: JSON.stringify({ type: "refusal", explanation: "retry now", nested: [false, null, { value: 2 }] }),
		},
		{ name: "exactly 4 KiB", details: "x".repeat(4094), state: "retained", raw: JSON.stringify("x".repeat(4094)) },
		{
			name: "over 4 KiB",
			details: "x".repeat(4095),
			state: "discarded",
			raw: undefined,
		},
	])("records $name without changing refusal behavior", async ({ details, state, raw }) => {
		const baseline = await recordRefusal();
		const result = await recordRefusal(details);
		expect(result.errorMessage).toBe("The model refused to complete the request");
		expect(result.stopDetailsState).toBe(state);
		expect(result.rawStopDetails).toBe(raw);
		if (state !== "retained") expect(result).not.toHaveProperty("rawStopDetails");
		if (state === "discarded") {
			const serialized = JSON.stringify(details);
			expect(result.stopDetailsBytes).toBe(Buffer.byteLength(serialized, "utf8"));
			expect(result.stopDetailsSha256).toBe(createHash("sha256").update(serialized, "utf8").digest("hex"));
			expect(JSON.stringify(result)).not.toContain("x".repeat(100));
		} else {
			expect(result).not.toHaveProperty("stopDetailsBytes");
			expect(result).not.toHaveProperty("stopDetailsSha256");
		}
		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("refusal");
		for (const key of ["recovery", "errorHint", "diagnostics", "content", "usage"] as const) {
			expect(result[key]).toEqual(baseline[key]);
		}
	});

	it("discards multibyte details based on UTF-8 byte size, with no raw value or prefix", async () => {
		const details = { explanation: "😀é".repeat(800) };
		const serialized = JSON.stringify(details);
		expect(serialized.length).toBeLessThan(4096);
		const result = await recordRefusal(details);
		expect(result.stopDetailsState).toBe("discarded");
		expect(result).not.toHaveProperty("rawStopDetails");
		expect(result.stopDetailsBytes).toBe(Buffer.byteLength(serialized, "utf8"));
		expect(result.stopDetailsSha256).toBe(createHash("sha256").update(serialized, "utf8").digest("hex"));
		expect(JSON.stringify(result)).not.toContain("😀");
		expect(result.errorMessage).toBe("The model refused to complete the request");
	});

	it("keeps the upstream responseId on the refusal error and result, but not on partials", async () => {
		const stream = streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
			apiKey: "synthetic-test-key",
			maxRetries: 0,
			fetch: async () => sseResponse({ stop_reason: "refusal", stop_details: { explanation: "untrusted" } }),
		});
		let sawError = false;
		for await (const event of stream) {
			if (event.type === "error") {
				sawError = true;
				expect(event.error.responseId).toBe("msg_test");
				expect(event.error.rawStopDetails).toBe(JSON.stringify({ explanation: "untrusted" }));
				expect(event.error.errorMessage).toBe("The model refused to complete the request");
			} else if ("partial" in event) {
				expect(event.partial).not.toHaveProperty("responseId");
			}
		}
		expect(sawError).toBe(true);
		expect((await stream.result()).responseId).toBe("msg_test");
	});

	// pi#297 / pi#280: preserving a refusal's response ID must not bypass live-value masking.
	it("masks live credentials reflected in a refusal response ID", async () => {
		const result = await streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
			apiKey: "synthetic-test-key",
			maxRetries: 0,
			fetch: async () =>
				createSseResponse([
					{
						type: "message_start",
						message: {
							id: "msg_synthetic-test-key",
							model: model.id,
							usage: { input_tokens: 12, output_tokens: 0 },
						},
					},
					{ type: "message_delta", delta: { stop_reason: "refusal" } },
					{ type: "message_stop" },
				]),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.responseId).toBe("msg_***");
		expect(JSON.stringify(result)).not.toContain("synthetic-test-key");
	});

	it("masks reflected live credentials in the record-only field", async () => {
		const result = await recordRefusal({ explanation: "synthetic-test-key" });
		expect(result.stopDetailsState).toBe("retained");
		expect(result.rawStopDetails).toBe(JSON.stringify({ explanation: "***" }));
	});

	// pi#297 security round 3: credentials held only by an injected authenticated SDK client are unknowable here.
	it("discards injected-client refusal details and hashes the masked bytes everywhere", async () => {
		const credential = "live-client-credential";
		const details = { explanation: credential, context: "diagnostic-secret" };
		const masked = JSON.stringify({ explanation: credential, context: "***" });
		const { events, result } = await recordInjectedRefusal(details, credential, ["diagnostic-secret"]);
		// pi#280: the candidate's narrow exception lives at the stream boundary, after its closed snapshot.
		const projectedStream = new AssistantMessageEventStream();
		projectedStream.end(result);
		const projected = await projectedStream.result();
		const errorEvent = events.find((event) => event.type === "error");

		expect(result.stopDetailsState).toBe("discarded");
		expect(result).not.toHaveProperty("rawStopDetails");
		expect(result.stopDetailsBytes).toBe(Buffer.byteLength(masked, "utf8"));
		expect(result.stopDetailsSha256).toBe(createHash("sha256").update(masked, "utf8").digest("hex"));
		expect(JSON.stringify(result)).not.toContain(credential);
		expect(errorEvent?.error.stopDetailsState).toBe("discarded");
		expect(errorEvent?.error.stopDetailsBytes).toBe(Buffer.byteLength(masked, "utf8"));
		expect(errorEvent?.error.stopDetailsSha256).toBe(createHash("sha256").update(masked, "utf8").digest("hex"));
		expect(JSON.stringify(events)).not.toContain(credential);
		expect(projected.stopDetailsState).toBe("discarded");
		expect(projected.stopDetailsBytes).toBe(Buffer.byteLength(masked, "utf8"));
		expect(projected.stopDetailsSha256).toBe(createHash("sha256").update(masked, "utf8").digest("hex"));
		expect(projected).not.toHaveProperty("rawStopDetails");
		expect(JSON.stringify(projected)).not.toContain(credential);
	});

	it("discards even small credential-free refusal details from an injected client", async () => {
		const details = { explanation: "credential-free refusal" };
		const serialized = JSON.stringify(details);
		const { result } = await recordInjectedRefusal(details, "live-client-credential");

		expect(result.stopDetailsState).toBe("discarded");
		expect(result).not.toHaveProperty("rawStopDetails");
		expect(result.stopDetailsBytes).toBe(Buffer.byteLength(serialized, "utf8"));
		expect(result.stopDetailsSha256).toBe(createHash("sha256").update(serialized, "utf8").digest("hex"));
	});

	it("retains data that fits the cap after live credential masking", async () => {
		const prefix = "x".repeat(4080);
		const details = `${prefix}synthetic-test-key tail`;
		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeGreaterThan(4096);
		const result = await recordRefusal(details);
		expect(result.stopDetailsState).toBe("retained");
		expect(result.rawStopDetails).toBe(JSON.stringify(`${prefix}*** tail`));
		expect(result).not.toHaveProperty("stopDetailsBytes");
		expect(result).not.toHaveProperty("stopDetailsSha256");
	});

	it("sizes and hashes the masked serialization when it remains over the cap", async () => {
		const prefix = "x".repeat(5000);
		const details = `${prefix}synthetic-test-key tail`;
		const masked = JSON.stringify(`${prefix}*** tail`);
		const result = await recordRefusal(details);
		expect(result.stopDetailsState).toBe("discarded");
		expect(result).not.toHaveProperty("rawStopDetails");
		expect(result.stopDetailsBytes).toBe(Buffer.byteLength(masked, "utf8"));
		expect(result.stopDetailsSha256).toBe(createHash("sha256").update(masked, "utf8").digest("hex"));
		expect(result.stopDetailsSha256).not.toBe(createHash("sha256").update(JSON.stringify(details)).digest("hex"));
	});

	it("discards data expanded beyond the cap by short-credential masking without retaining a prefix", async () => {
		const prefix = "x".repeat(4087);
		const details = `${prefix} a a`;
		const masked = JSON.stringify(`${prefix} *** ***`);
		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(4096);
		expect(Buffer.byteLength(masked, "utf8")).toBeGreaterThan(4096);
		const result = await recordRefusal(details, ["a"]);
		expect(result.stopDetailsState).toBe("discarded");
		expect(result).not.toHaveProperty("rawStopDetails");
		expect(result.stopDetailsBytes).toBe(Buffer.byteLength(masked, "utf8"));
		expect(result.stopDetailsSha256).toBe(createHash("sha256").update(masked, "utf8").digest("hex"));
	});

	// pi#297 / pi#280: details received before the reason survive null and usage-only deltas.
	it("keeps earlier details when a later null precedes the refusal reason", async () => {
		const details = { explanation: "earlier opaque data" };
		const result = await streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
			apiKey: "synthetic-test-key",
			maxRetries: 0,
			fetch: async () =>
				createSseResponse([
					{
						type: "message_start",
						message: { id: "msg_test", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
					},
					{ type: "message_delta", delta: { stop_details: details } },
					{ type: "message_delta", delta: { stop_details: null } },
					{ type: "message_delta", delta: { stop_reason: "refusal" } },
					{ type: "message_stop" },
				]),
		}).result();
		expect(result.stopDetailsState).toBe("retained");
		expect(result.rawStopDetails).toBe(JSON.stringify(details));
	});

	// pi#297 / pi#280: a later conflicting delta cannot convert a successful terminal reason into a refusal record.
	it("uses only the first terminal stop reason", async () => {
		const result = await streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
			apiKey: "synthetic-test-key",
			maxRetries: 0,
			fetch: async () =>
				createSseResponse([
					{
						type: "message_start",
						message: { id: "msg_test", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
					},
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_delta", delta: { stop_reason: "refusal", stop_details: "not a refusal" } },
					{ type: "message_stop" },
				]),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("end_turn");
		expectNoStopDetails(result);
	});

	// pi#297 / pi#280: abort after the refusal delta must not create a refusal record, even on the producer object.
	it("does not attach refusal details when the request aborts after the refusal delta", async () => {
		const controller = new AbortController();
		const push = vi.spyOn(AssistantMessageEventStream.prototype, "push");
		let notifications = 0;
		try {
			const stream = streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
				apiKey: "synthetic-test-key",
				maxRetries: 0,
				signal: controller.signal,
				onProviderStreamEvent: () => {
					if (++notifications === 5) controller.abort();
				},
				fetch: async () => sseResponse({ stop_reason: "refusal", stop_details: "untrusted" }),
			});
			for await (const event of stream) {
				if (event.type === "error") {
					expect(event.error.stopReason).toBe("aborted");
					expect(event.error).not.toHaveProperty("responseId");
					expectNoStopDetails(event.error);
				} else if ("partial" in event) expectNoStopDetails(event.partial);
			}
			const result = await stream.result();
			expect(result.stopReason).toBe("aborted");
			expectNoStopDetails(result);
			for (const [event] of push.mock.calls) {
				if (event.type === "error") expectNoStopDetails(event.error);
				else if ("partial" in event) expectNoStopDetails(event.partial);
			}
		} finally {
			push.mockRestore();
		}
	});

	// pi#297 / pi#280: exercise the candidate's real push/end boundary, not only the closed snapshot helper.
	it.each([
		{ api: "anthropic-messages", stopReason: "stop", rawStopReason: "refusal" },
		{ api: "anthropic-messages", stopReason: "aborted", rawStopReason: "refusal" },
		{ api: "anthropic-messages", stopReason: "error", rawStopReason: "sensitive" },
		{ api: "other-api", stopReason: "error", rawStopReason: "refusal" },
	] as const)("drops stored details outside an Anthropic refusal failure: %j", async (terminalFields) => {
		const recorded = await recordRefusal({ explanation: "untrusted" });
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "start", partial: recorded });
		stream.end({ ...recorded, ...terminalFields });
		for await (const event of stream) {
			if ("partial" in event) {
				expectNoStopDetails(event.partial);
				expect(event.partial).not.toHaveProperty("responseId");
			}
		}
		expectNoStopDetails(await stream.result());
	});

	it.each([
		{ stopReason: "error", oversized: false },
		{ stopReason: "stop", oversized: false },
		{ stopReason: "error", oversized: true },
		{ stopReason: "stop", oversized: true },
	] as const)(
		"never sends stored fields upstream from a $stopReason assistant message (oversized=$oversized)",
		async ({ stopReason, oversized }) => {
			const sentinel = "UNTRUSTED_STOP_DETAILS_NOT_CONTEXT";
			const recorded = await recordRefusal({
				explanation: sentinel,
				fallback_credit_token: sentinel,
				padding: oversized ? "x".repeat(4096) : "",
			});
			// Round-trip the stored message, not just a mapStopReason return value.
			const stored = JSON.parse(JSON.stringify(recorded)) as AssistantMessage;
			stored.stopReason = stopReason;
			const requests: Record<string, unknown>[] = [];
			const result = await streamAnthropic(
				model,
				normalizeContext({
					messages: [...initialMessages, stored, { role: "user", content: "Continue", timestamp: 2 }],
				}),
				{
					apiKey: "synthetic-test-key",
					cacheRetention: "none",
					maxRetries: 0,
					fetch: async (_url, init) => {
						requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
						return sseResponse({ stop_reason: "end_turn" });
					},
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(requests).toHaveLength(1);
			const wire = JSON.stringify(requests[0]);
			for (const forbidden of [
				"rawStopDetails",
				"stopDetailsState",
				"stopDetailsBytes",
				"stopDetailsSha256",
				"responseId",
				"msg_test",
				"stop_details",
				"fallback_credit_token",
				sentinel,
			]) {
				expect(wire).not.toContain(forbidden);
			}
			const assistantMessages = (requests[0].messages as Array<{ role: string; content: unknown }>).filter(
				(message) => message.role === "assistant",
			);
			// Refusals are dropped by transformMessages; a replayable message must exercise convertMessages too.
			expect(assistantMessages).toEqual(
				stopReason === "error" ? [] : [{ role: "assistant", content: [{ type: "text", text: "Unchanged reply" }] }],
			);
			expect(stored.responseId).toBe("msg_test");
			if (oversized) {
				expect(stored).not.toHaveProperty("rawStopDetails");
				expect(stored.stopDetailsState).toBe("discarded");
				expect(wire).not.toContain(stored.stopDetailsSha256);
			} else {
				expect(stored.rawStopDetails).toContain(sentinel);
			}
		},
	);
});
