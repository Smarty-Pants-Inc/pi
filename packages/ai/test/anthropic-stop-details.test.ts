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

async function recordRefusal(details?: unknown): Promise<AssistantMessage> {
	return streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
		apiKey: "synthetic-test-key",
		maxRetries: 0,
		fetch: async () =>
			sseResponse({ stop_reason: "refusal", ...(details === undefined ? {} : { stop_details: details }) }),
	}).result();
}

// Record-only diagnostic regression. Keep: untrusted-provider and outbound-context trust boundaries.
describe("Anthropic stop details through the provider SSE adapter", () => {
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
			state: "truncated",
			raw: `"${"x".repeat(4084)}[truncated]`,
		},
	])("records $name without changing refusal behavior", async ({ details, state, raw }) => {
		const baseline = await recordRefusal();
		const result = await recordRefusal(details);
		expect(result.errorMessage).toBe("The model refused to complete the request");
		expect(result.stopDetailsState).toBe(state);
		expect(result.rawStopDetails).toBe(raw);
		if (state === "absent") expect(result).not.toHaveProperty("rawStopDetails");
		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("refusal");
		for (const key of ["recovery", "errorHint", "diagnostics", "content", "usage"] as const) {
			expect(result[key]).toEqual(baseline[key]);
		}
	});

	it("caps multibyte details at 4096 UTF-8 bytes including the marker without splitting a character", async () => {
		const result = await recordRefusal({ explanation: "😀é".repeat(2000) });
		expect(result.stopDetailsState).toBe("truncated");
		expect(result.rawStopDetails).toMatch(/\[truncated\]$/);
		expect(new TextEncoder().encode(result.rawStopDetails).length).toBeLessThanOrEqual(4096);
		expect(result.rawStopDetails).not.toContain("�");
		expect(result.errorMessage).toBe("The model refused to complete the request");
	});

	it("masks reflected live credentials in the record-only field", async () => {
		const result = await recordRefusal({ explanation: "synthetic-test-key" });
		expect(result.stopDetailsState).toBe("retained");
		expect(result.rawStopDetails).toBe(JSON.stringify({ explanation: "***" }));
	});

	it("masks live credentials before a size cap can cut across them", async () => {
		const prefix = "x".repeat(4080);
		const result = await recordRefusal(`${prefix}synthetic-test-key tail`);
		expect(result.stopDetailsState).toBe("retained");
		expect(result.rawStopDetails).toBe(JSON.stringify(`${prefix}*** tail`));
	});

	it.each(["error", "stop"] as const)(
		"never sends stored details upstream from a %s assistant message",
		async (stopReason) => {
			const sentinel = "UNTRUSTED_STOP_DETAILS_NOT_CONTEXT";
			const recorded = await recordRefusal({ explanation: sentinel, fallback_credit_token: sentinel });
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
			expect(stored.rawStopDetails).toContain(sentinel);
		},
	);
});
