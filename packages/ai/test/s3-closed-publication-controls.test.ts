import { expect, it, vi } from "vitest";
import {
	OAuthDiagnosticError,
	oauthRecoveryDecision,
	resolveDeferredHandle,
} from "../src/auth/oauth/credential-response.ts";
import { createModels, createProvider } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { createFauxCore, fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessage, AssistantMessageEvent, DeferredHandle, ToolCall } from "../src/types.ts";
import { AssistantMessageFrameEncoder, reduceAssistantMessageFrames } from "../src/utils/assistant-message-frame.ts";
import { MAX_DEFERRED_POLL_AFTER_MS, projectAssistantMessageDiagnostics } from "../src/utils/diagnostics.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { AssistantMessageEventStream, createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function message(): AssistantMessage {
	return {
		role: "assistant",
		api: "faux",
		provider: "faux",
		model: "test",
		content: [],
		usage,
		timestamp: 0,
		stopReason: "stop",
	};
}
function deferred(pollAfterMs?: number): AssistantMessage {
	return {
		...message(),
		stopReason: "deferred",
		deferred: {
			provider: "faux",
			modelId: "test",
			api: "faux",
			id: `synthetic-provider-${pollAfterMs}`,
			pollAfterMs,
			expiresAt: 123,
			data: { conversion: "private" },
		},
	};
}

// smarty-dev#5822 F1: explicit replay schema is shared by every publication surface.
it("rebuilds all blocks and outer toolCall without changing generated arguments or replay values", async () => {
	const tool: ToolCall = {
		type: "toolCall",
		id: "call",
		name: "probe",
		arguments: { credentialDiagnostic: "generated argument" },
		namespace: "ns",
		thoughtSignature: "tool-replay",
	};
	const dirty = {
		...message(),
		content: [
			{ type: "text", text: "generated", textSignature: "text-replay", unknownDiagnostic: 1 },
			{
				type: "thinking",
				thinking: "generated thought",
				thinkingSignature: "thinking-replay",
				redacted: false,
				unknownDiagnostic: 1,
			},
			{ ...tool, unknownDiagnostic: 1 },
		],
	} as unknown as AssistantMessage;
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: dirty.content[2] as ToolCall, partial: dirty });
	stream.end(dirty);
	const event = (await stream[Symbol.asyncIterator]().next()).value as Extract<
		AssistantMessageEvent,
		{ type: "toolcall_end" }
	>;
	const result = await stream.result();
	expect(result.content).toEqual([
		{ type: "text", text: "generated", textSignature: "text-replay" },
		{ type: "thinking", thinking: "generated thought", thinkingSignature: "thinking-replay", redacted: false },
		tool,
	]);
	expect(event.toolCall).toEqual(tool);
	expect(result.content).not.toBe(dirty.content);
	expect(event.toolCall.arguments).not.toBe(tool.arguments);
	expect(dirty.content[2]).toHaveProperty("unknownDiagnostic", 1);
});
it("drops invalid replay types and unknown block fields from direct projection and frames", () => {
	const dirty = {
		...message(),
		content: [
			{ type: "text", text: "generated", textSignature: 123, unknown: "diagnostic" },
			{ type: "thinking", thinking: "thought", thinkingSignature: {}, redacted: "diagnostic" },
			{ type: "toolCall", id: "call", name: "probe", arguments: {}, namespace: {}, thoughtSignature: 123 },
		],
	} as unknown as AssistantMessage;
	expect(projectAssistantMessageDiagnostics(dirty).content).toEqual([
		{ type: "text", text: "generated" },
		{ type: "thinking", thinking: "thought" },
		{ type: "toolCall", id: "call", name: "probe", arguments: {} },
	]);
	const encoder = new AssistantMessageFrameEncoder();
	const start = encoder.encode({
		type: "start",
		partial: { ...dirty, unknownDiagnostic: "diagnostic" },
	} as AssistantMessageEvent);
	expect(JSON.stringify(start)).not.toContain("diagnostic");
	const frame = encoder.encode({ type: "thinking_start", contentIndex: 1, partial: dirty });
	expect(frame).toEqual({
		type: "thinking_start",
		contentIndex: 1,
		content: { type: "thinking", thinking: "thought" },
	});
});

// smarty-dev#5822 F2: enum-shaped producer objects are not classifier receipts.
it.each([undefined, "service unavailable", "insufficient quota"])(
	"ignores forged recovery even without original error text: %s",
	(errorMessage) => {
		const dirty = {
			...message(),
			stopReason: "error",
			errorMessage,
			oauthRecovery: { retryable: true, recovery: "context_length_exceeded", unknown: "diagnostic" },
		} as AssistantMessage;
		const result = projectAssistantMessageDiagnostics(dirty);
		expect(result.oauthRecovery?.retryable).toBe(errorMessage === "service unavailable");
		expect(result.oauthRecovery?.recovery).toBe(errorMessage === "service unavailable" ? "retryable" : undefined);
		expect(JSON.stringify(result)).not.toContain("diagnostic");
	},
);
it("preserves a constructor-validated receipt, not later object mutations, through repeated copies", () => {
	const decision = oauthRecoveryDecision(
		new OAuthDiagnosticError("oauth_request_failed", 503, undefined, "premature_stream", true),
	);
	const dirty = {
		...message(),
		stopReason: "error",
		errorMessage: "provider_request_failed (HTTP 503)",
		oauthRecovery: decision,
	} as AssistantMessage;
	decision.retryable = false;
	decision.recovery = "context_length_exceeded";
	const first = projectAssistantMessageDiagnostics(dirty);
	const second = projectAssistantMessageDiagnostics(first);
	expect(first.oauthRecovery).toEqual({ retryable: true, recovery: "premature_stream" });
	expect(second.oauthRecovery).toEqual(first.oauthRecovery);
	expect(first.oauthRecovery).not.toBe(second.oauthRecovery);
});
it.each([400, 413])("keeps trusted provider-context classification for Cerebras HTTP %s", (status) => {
	const normalized = normalizeProviderError({ status }, [], false, "cerebras");
	const result = projectAssistantMessageDiagnostics({
		...message(),
		provider: "cerebras",
		stopReason: "error",
		errorMessage: normalized.message,
		oauthRecovery: normalized.oauthRecovery,
	});
	expect(result.oauthRecovery?.recovery).toBe("context_length_exceeded");
});

// smarty-dev#5822 F3: successful metadata is closed, not a provider diagnostic container.
it("retains only loaded catalog or bound fallback model membership", async () => {
	const provider = anthropicProvider();
	const model = provider.getModels()[0];
	if (!model) throw new Error("Expected a local Anthropic catalog");
	const source = {
		...message(),
		provider: model.provider,
		api: model.api,
		model: model.id,
		responseModel: model.id,
		endTurn: false,
	};
	const stream = new AssistantMessageEventStream(model);
	stream.end(source);
	expect((await stream.result()).responseModel).toBe(model.id);
	expect((await stream.result()).endTurn).toBe(false);
	const bound = {
		...model,
		compat: {
			allowedFallbackModels: [{ model: "request-declared-fallback", provider: model.provider, cost: model.cost }],
		},
	};
	const fallback = new AssistantMessageEventStream(bound);
	fallback.end({ ...source, responseModel: "request-declared-fallback" });
	expect((await fallback.result()).responseModel).toBe("request-declared-fallback");
	expect(projectAssistantMessageDiagnostics({ ...source, responseModel: "unknown" })).not.toHaveProperty(
		"responseModel",
	);
});
it.each([0, 25, MAX_DEFERRED_POLL_AFTER_MS, MAX_DEFERRED_POLL_AFTER_MS + 1, 2 ** 40])(
	"bounds deferred poll delay %s and keeps provider conversion private",
	(delay) => {
		const original = deferred(delay);
		const publicMessage = projectAssistantMessageDiagnostics(original);
		const handle = publicMessage.deferred!;
		expect(handle.id).toMatch(/^pi-deferred-/);
		expect(handle.id).not.toBe(original.deferred!.id);
		expect(Object.keys(handle).sort()).toEqual(["api", "id", "modelId", "pollAfterMs", "provider"]);
		expect(handle.pollAfterMs).toBe(Math.min(delay, MAX_DEFERRED_POLL_AFTER_MS));
		expect(resolveDeferredHandle({ provider: "faux", id: "test", api: "faux" }, handle)).toEqual(original.deferred);
		expect(projectAssistantMessageDiagnostics(publicMessage).deferred).toEqual(handle);
		expect(projectAssistantMessageDiagnostics(original).deferred).toEqual(handle);
	},
);
it.each([-1, 1.5, NaN, Infinity])("omits invalid deferred poll delay %s", (delay) => {
	expect(projectAssistantMessageDiagnostics(deferred(delay)).deferred).not.toHaveProperty("pollAfterMs");
});
it("rejects unknown receipts and cross-model bindings without calling a provider", async () => {
	const handle = projectAssistantMessageDiagnostics(deferred()).deferred!;
	expect(() => resolveDeferredHandle({ provider: "faux", id: "other", api: "faux" }, handle)).toThrow(
		"oauth_invalid_response",
	);
	const unknown = { ...deferred(), deferred: { ...handle, id: "pi-deferred-unknown" } };
	const stream = createAssistantMessageEventStream();
	stream.end(unknown);
	expect(await stream.result()).toMatchObject({ stopReason: "error" });
	expect((await stream.result()).errorMessage).toContain("provider_request_failed");
});
it("does not register a handle from a producer error", async () => {
	const original = deferred();
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error: original });
	expect(await stream.result()).not.toHaveProperty("deferred");
	expect(await stream.result()).toHaveProperty("stopReason", "error");
});
it("round-trips same-process reopened Models, polling and cancellation using the original provider handle", async () => {
	const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: 25 } });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	faux.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("cancelled")]);
	const first = await models.completeSimple(model, { messages: [] }, { deferred: true });
	if (!first.deferred) throw new Error("Missing deferred handle");
	const restored = JSON.parse(JSON.stringify(first.deferred)) as DeferredHandle;
	const reopened = createModels();
	reopened.setProvider(faux.provider);
	const pending = await reopened.fetchDeferred(model, restored);
	expect(pending.deferred).toEqual(first.deferred);
	expect((await reopened.fetchDeferred(model, restored)).content).toEqual([{ type: "text", text: "ready" }]);
	const second = await models.completeSimple(model, { messages: [] }, { deferred: true });
	if (!second.deferred) throw new Error("Missing deferred handle");
	await models.cancelDeferred(model, second.deferred);
	expect(faux.state.cancelledDeferred).toEqual([resolveDeferredHandle(model, second.deferred)]);
	expect((await models.fetchDeferred(model, second.deferred)).stopReason).toBe("error");
	const before = faux.state.deferredFetchCount;
	expect((await models.fetchDeferred(model, { ...first.deferred, modelId: "wrong" })).stopReason).toBe("error");
	expect(faux.state.deferredFetchCount).toBe(before);
});
it("preserves direct faux deferred lifecycle without a Models wrapper", async () => {
	const core = createFauxCore({ deferred: { pendingFetches: 1, pollAfterMs: 25 } });
	const model = core.getModel();
	const context = normalizeContext({ messages: [] });
	core.setResponses([fauxAssistantMessage("ready")]);
	const first = await core.streamSimple(model, context, { deferred: true }).result();
	const handle = first.deferred as DeferredHandle;
	expect((await core.fetchDeferred(model, handle).result()).deferred).toEqual(handle);
	expect((await core.fetchDeferred(model, handle).result()).content).toEqual([{ type: "text", text: "ready" }]);
});

// smarty-dev#5822 F3: a refused public handle must not prepare auth or dispatch provider work.
it("refuses unknown deferred handles before request auth and dispatch", async () => {
	let authPreparations = 0;
	let providerCalls = 0;
	const model = { ...createFauxCore({}).getModel(), provider: "synthetic-deferred" };
	const provider = createProvider({
		id: model.provider,
		models: [model],
		auth: {
			apiKey: {
				name: "Synthetic",
				resolve: async () => {
					authPreparations++;
					return { auth: {} };
				},
			},
		},
		api: {
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
			fetchDeferred: () => {
				providerCalls++;
				return createAssistantMessageEventStream();
			},
			cancelDeferred: async () => {
				providerCalls++;
			},
		},
	});
	const models = createModels();
	models.setProvider(provider);
	const handle: DeferredHandle = {
		provider: model.provider,
		modelId: model.id,
		api: model.api,
		id: "pi-deferred-unknown",
	};
	expect((await models.fetchDeferred(model, handle)).stopReason).toBe("error");
	await expect(models.cancelDeferred(model, handle)).rejects.toThrow("oauth_invalid_response");
	expect(authPreparations).toBe(0);
	expect(providerCalls).toBe(0);
});

// smarty-dev#5822 F1: replay frames cannot bypass content type checks.
it("applies the same schema to thinking-end frames and reconstructed progress", () => {
	const dirty = {
		...message(),
		content: [{ type: "thinking", thinking: "generated", redacted: "diagnostic", thinkingSignature: 123 }],
	} as unknown as AssistantMessage;
	const encoder = new AssistantMessageFrameEncoder();
	const start = encoder.encode({ type: "start", partial: dirty });
	const block = encoder.encode({ type: "thinking_start", contentIndex: 0, partial: dirty });
	const end = encoder.encode({ type: "thinking_end", contentIndex: 0, content: "generated", partial: dirty });
	expect(end).toEqual({ type: "thinking_end", contentIndex: 0, content: "generated" });
	if (!start || !block || !end) throw new Error("Missing frame");
	expect(reduceAssistantMessageFrames([start, block, end])?.content).toEqual([
		{ type: "thinking", thinking: "generated" },
	]);
});

// smarty-dev#5822 F1: a tool-call envelope cannot publish a different block kind.
it("fails an invalid outer tool-call discriminator closed", async () => {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "toolcall_end",
		contentIndex: 0,
		toolCall: { type: "text", text: "diagnostic" },
		partial: message(),
	} as unknown as AssistantMessageEvent);
	stream.end(message());
	const result = await stream.result();
	expect(result).toMatchObject({ stopReason: "error", oauthRecovery: { retryable: false } });
	expect(result.errorMessage).toContain("provider_invalid_response");
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	expect(events).toHaveLength(1);
	expect(events[0].type).toBe("error");
	expect(JSON.stringify(events)).not.toContain("diagnostic");
});

// smarty-dev#5822 F3 / design 9.5: terminal settlement stops both publication and receipt minting.
it("does not reproject or mint deferred handles after terminal settlement", async () => {
	const stream = createAssistantMessageEventStream();
	const failed = { ...message(), stopReason: "error", errorMessage: "synthetic failure" } as AssistantMessage;
	stream.push({ type: "error", reason: "error", error: failed });
	const before = await stream.result();
	const mint = vi.spyOn(globalThis.crypto, "randomUUID");
	try {
		stream.push({ type: "done", reason: "deferred", message: deferred(999) });
		stream.end(deferred(998));
		expect(mint).not.toHaveBeenCalled();
		expect(await stream.result()).toBe(before);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
	} finally {
		mint.mockRestore();
	}
});
