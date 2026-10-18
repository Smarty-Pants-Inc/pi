import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";

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

// Record-only diagnostic regression. Keep: untrusted-provider and outbound-context trust boundaries.
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

	it("masks reflected live credentials in the record-only field", async () => {
		const result = await recordRefusal({ explanation: "synthetic-test-key" });
		expect(result.stopDetailsState).toBe("retained");
		expect(result.rawStopDetails).toBe(JSON.stringify({ explanation: "***" }));
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
