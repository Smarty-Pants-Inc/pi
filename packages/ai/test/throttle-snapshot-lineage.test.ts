import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "../src/types.ts";
import { snapshotAssistantMessage, snapshotAssistantMessageEvent } from "../src/utils/assistant-message-snapshot.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { recordedThrottledLimitWait } from "../src/utils/recovery.ts";
import {
	isRetryableAssistantError,
	recordThrottledLimitWait,
	retryAssistantCall,
	THROTTLED_LIMIT_WAIT_MESSAGE,
	throttledLimitWait,
} from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "snapshot-fixture",
	name: "Snapshot fixture",
	api: "openai-completions",
	provider: "snapshot-fixture",
	baseUrl: "https://throttle-snapshot.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const secret = "synthetic-snapshot-secret";
const headerSecret = "synthetic-snapshot-header";

async function throttleResponse(retryAfter: string | undefined): Promise<AssistantMessage> {
	const fetch = vi.fn(async () =>
		Response.json(
			{ error: { code: "smarty_limit", throttled: true, message: `${secret} ${headerSecret}` } },
			{ status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
		),
	);
	const beforeProviderRequest = vi.fn();
	const stream = streamOpenAICompletions(model, context, {
		apiKey: secret,
		headers: { "x-custom-token": headerSecret },
		fetch,
		beforeProviderRequest,
		maxRetries: 0,
		timeoutMs: 1000,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	const terminal = events.at(-1);
	if (terminal?.type !== "error") throw new Error("missing throttle error");
	expect(result).toBe(terminal.error);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe(THROTTLED_LIMIT_WAIT_MESSAGE);
	expect(result.diagnostics?.map(({ type }) => type)).toEqual(["provider_limit"]);
	expect(result.provider).toBe(model.provider);
	expect(result.model).toBe(model.id);
	expect(result.api).toBe(model.api);
	expect(fetch).toHaveBeenCalledOnce();
	expect(beforeProviderRequest).toHaveBeenCalledOnce();
	expect(JSON.stringify(events)).not.toContain(secret);
	expect(JSON.stringify(events)).not.toContain(headerSecret);
	return result;
}

describe("private throttle snapshot lineage", () => {
	// #3155 F4: validated producer waits must survive the consumer's isolation boundary.
	it.each([0, 2, 30])("preserves a %s-second wait through snapshots and the retry consumer", async (seconds) => {
		const published = await throttleResponse(String(seconds));
		const direct = snapshotAssistantMessage(published);
		const event = snapshotAssistantMessageEvent({ type: "error", reason: "error", error: direct });
		if (event.type !== "error") throw new Error("missing copied error");
		const produce = vi.fn(async () => event.error);
		const retried = await retryAssistantCall(produce, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined);
		const expected = { delayMs: seconds * 1000, waitMessage: THROTTLED_LIMIT_WAIT_MESSAGE };
		for (const copy of [published, direct, event.error, retried]) {
			expect(throttledLimitWait(copy)).toEqual(expected);
			expect(isRetryableAssistantError(copy)).toBe(false);
			expect(Reflect.ownKeys(copy).map(String).sort()).toEqual(Reflect.ownKeys(published).map(String).sort());
			expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
			expect({ ...copy, diagnostics: undefined }).toEqual({ ...published, diagnostics: undefined });
			expect(copy.diagnostics?.map(({ type }) => type)).toEqual(["provider_limit"]);
			for (const diagnostic of copy.diagnostics ?? []) {
				expect(Object.keys(diagnostic).sort()).toEqual(["timestamp", "type"]);
			}
			expect(copy).not.toHaveProperty("retryAfterSeconds");
			expect(copy).not.toHaveProperty("throttledLimitWait");
		}
		expect(direct).not.toBe(published);
		expect(event.error).not.toBe(direct);
		// Diagnostics normalization makes another copy on the normal retry-helper path.
		expect(retried).not.toBe(event.error);
		expect(produce).toHaveBeenCalledOnce();
	});

	// #3155 F4: partial events use the same atomic snapshot-plus-lineage operation.
	it("retains private lineage in a partial event copy", () => {
		const live = fauxAssistantMessage("", { stopReason: "pending" });
		recordThrottledLimitWait(live, 2);
		const event = snapshotAssistantMessageEvent({ type: "start", partial: live });
		if (event.type !== "start") throw new Error("missing copied start");
		expect(event.partial).not.toBe(live);
		expect(recordedThrottledLimitWait(event.partial)).toBe(2);
		expect(throttledLimitWait(event.partial)).toBeUndefined();
	});

	// #3155 F4: copying never turns an invalid provider header into private wait metadata.
	it.each([undefined, "-1", "1.5", "31", "Infinity", "NaN", "2s", "Wed, 21 Oct 2015 07:28:00 GMT"])(
		"does not carry an invalid Retry-After (%s)",
		async (retryAfter) => {
			const direct = snapshotAssistantMessage(await throttleResponse(retryAfter));
			const event = snapshotAssistantMessageEvent({ type: "error", reason: "error", error: direct });
			if (event.type !== "error") throw new Error("missing copied error");
			const retried = await retryAssistantCall(async () => event.error, undefined, undefined);
			for (const copy of [direct, event.error, retried]) expect(throttledLimitWait(copy)).toBeUndefined();
		},
	);

	// #3155 F4: the existing recorder's integer 0..30 validation remains the only authority.
	it.each([-1, 0.5, 31, Number.NaN, Number.POSITIVE_INFINITY])(
		"does not copy an invalid recorded wait (%s)",
		(seconds) => {
			const live = fauxAssistantMessage("", { stopReason: "error", errorMessage: THROTTLED_LIMIT_WAIT_MESSAGE });
			recordThrottledLimitWait(live, seconds);
			const copy = snapshotAssistantMessage(live);
			expect(recordedThrottledLimitWait(live)).toBeUndefined();
			expect(throttledLimitWait(copy)).toBeUndefined();
		},
	);

	// #3155 F4: private identity must not weaken final masking, copy isolation or native view semantics.
	it("keeps final masking and detached native buffers intact", async () => {
		const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
		const args = {
			buffer,
			tracking: new Uint8Array(buffer),
			fixed: new Uint8Array(buffer, 2, 4),
			view: new DataView(buffer),
		};
		args.tracking[0] = 17;
		const live = fauxAssistantMessage(
			[{ type: "toolCall", id: "call_1", name: "fixture", arguments: args as unknown as ToolCall["arguments"] }],
			{ stopReason: "error", errorMessage: `Authorization: Bearer ${secret}` },
		);
		live.deferred = { api: live.api, provider: live.provider, modelId: live.model, id: `batch_${secret}` };
		recordThrottledLimitWait(live, 2);
		const stream = new AssistantMessageEventStream([secret]);
		stream.push({ type: "error", reason: "error", error: live });
		const published = await stream.result();
		const first = snapshotAssistantMessage(published);
		const event = snapshotAssistantMessageEvent({ type: "error", reason: "error", error: first });
		if (event.type !== "error") throw new Error("missing copied error");
		for (const copy of [first, event.error]) {
			expect(throttledLimitWait(copy)?.delayMs).toBe(2000);
			expect(copy.usage).not.toBe(live.usage);
			expect(copy.usage.cost).not.toBe(live.usage.cost);
			expect(copy.deferred).not.toBe(live.deferred);
			expect(JSON.stringify(copy)).not.toContain(secret);
			const block = copy.content[0];
			if (block?.type !== "toolCall") throw new Error("missing copied tool call");
			const cloned = block.arguments as unknown as typeof args;
			expect(cloned.buffer).not.toBe(buffer);
			expect(cloned.buffer.resizable).toBe(true);
			for (const view of [cloned.tracking, cloned.fixed, cloned.view]) expect(view.buffer).toBe(cloned.buffer);
			expect(cloned.tracking[0]).toBe(17);
			cloned.buffer.resize(12);
			expect(cloned.tracking.length).toBe(12);
			expect(cloned.fixed.length).toBe(4);
			expect(cloned.view.byteLength).toBe(12);
			cloned.tracking[0] = 99;
			copy.usage.cost.total = 9;
		}
		expect(buffer.byteLength).toBe(8);
		expect(args.tracking[0]).toBe(17);
		expect(live.usage.cost.total).toBe(0);
		expect(published.usage.cost.total).toBe(0);
		expect(live.errorMessage).toContain(secret);
		expect(live.deferred.id).toContain(secret);
	});

	// #3155 F4: event copies retain private lineage, but abort/success remain terminal for retry.
	it.each(["aborted", "stop"] as const)("does not make a %s event eligible for throttle retry", async (stopReason) => {
		const live = fauxAssistantMessage("", { stopReason, errorMessage: THROTTLED_LIMIT_WAIT_MESSAGE });
		recordThrottledLimitWait(live, 2);
		const event = snapshotAssistantMessageEvent(
			stopReason === "aborted"
				? { type: "error", reason: "aborted", error: live }
				: { type: "done", reason: "stop", message: live },
		);
		const copy = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
		expect(recordedThrottledLimitWait(copy)).toBe(2);
		expect(throttledLimitWait(copy)).toBeUndefined();
		expect(isRetryableAssistantError(copy)).toBe(false);
		const produce = vi.fn(async () => copy);
		const result = await retryAssistantCall(produce, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined);
		expect(result.stopReason).toBe(stopReason);
		expect(produce).toHaveBeenCalledOnce();
	});
});
