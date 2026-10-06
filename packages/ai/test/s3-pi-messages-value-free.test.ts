import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const canary = "SYNTHETIC_PI_MESSAGES_5822";
const model: Model<"pi-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://mock.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [] });
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
	extra: canary,
};
function response(events: unknown[]) {
	return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream", "x-wire": canary },
	});
}
async function collect(s: ReturnType<typeof stream>) {
	const seen: AssistantMessageEvent[] = [];
	for await (const e of s) {
		expect(JSON.stringify(e)).not.toContain(canary);
		seen.push(e);
	}
	const out = await s.result();
	expect(JSON.stringify(out)).not.toContain(canary);
	return { seen, out };
}
// smarty-dev#5822 T-R2-06: every credential policy, partial, terminal and end uses the universal schema.
describe.each([undefined, false, true])("pi-messages publication policy=%s", (oauthDiagnostics) => {
	it.each(["done", "error"] as const)(
		"drops terminal %s wire metadata, usage extras and rewrite details",
		async (type) => {
			const events = [
				{ type: "start" },
				{
					type,
					reason: type === "done" ? "stop" : "error",
					usage,
					responseId: canary,
					providerThinkingLevel: canary,
					rewrite: {
						policyId: canary,
						policyVersion: 2,
						changed: true,
						tokenCountChange: 1,
						messageCountChange: 1,
						systemPromptChanged: true,
					},
					...(type === "error" ? { errorMessage: canary } : {}),
				},
			];
			const { out } = await collect(
				stream(model, context, { apiKey: "synthetic", oauthDiagnostics, fetch: async () => response(events) }),
			);
			expect(out.responseId).toBeUndefined();
			expect(out.providerThinkingLevel).toBeUndefined();
			expect(out.usage.cost.total).toBe(0);
			expect(out.usage).not.toHaveProperty("extra");
			expect(out.diagnostics).toEqual([{ type: "pi_messages_rewrite", timestamp: expect.any(Number) }]);
		},
	);
	it("reconstructs partial envelopes immediately and snapshots before later mutation", async () => {
		const events = [
			{ type: "start", extra: canary },
			{ type: "text_start", contentIndex: 0, extra: canary },
			{ type: "text_delta", contentIndex: 0, delta: "generated", extra: canary },
			{ type: "text_end", contentIndex: 0, content: "generated", extra: canary },
			{ type: "error", reason: "error", usage, errorMessage: canary, responseId: canary },
		];
		const callbacks: unknown[] = [];
		const { seen, out } = await collect(
			streamSimple(model, context, {
				apiKey: "synthetic",
				oauthDiagnostics,
				fetch: async () => response(events),
				onResponse: (...args) => {
					callbacks.push(args);
				},
				onProviderStreamEvent: (...args) => {
					callbacks.push(args);
				},
			}),
		);
		expect(callbacks).toEqual([[{ status: 200 }], ...events.map(() => [{ type: "provider_stream_event" }])]);
		const first = seen[1];
		expect(first.type).toBe("text_start");
		if (!("partial" in first)) throw new Error("missing partial");
		expect(first.partial.content).toEqual([{ type: "text", text: "" }]);
		expect(out.content).toEqual([{ type: "text", text: "generated", textSignature: undefined }]);
	});
	it.each(["json", "text", "parser", "transport", "eof", "no-body"])(
		"owns %s failure including recovery",
		async (kind) => {
			const request = async () => {
				if (kind === "transport") throw new Error(`service unavailable ${canary}`);
				if (kind === "json")
					return Response.json(
						{ error: { message: `service unavailable ${canary}`, code: canary, details: { value: canary } } },
						{ status: 503, statusText: canary, headers: { "x-wire": canary } },
					);
				if (kind === "text")
					return new Response(`service unavailable ${canary}`, { status: 503, statusText: canary });
				if (kind === "parser") return new Response(`data: invalid-${canary}\n\n`);
				if (kind === "no-body") return new Response(null);
				return response([{ type: "start" }]);
			};
			const { out } = await collect(
				stream(model, context, { apiKey: "synthetic", oauthDiagnostics, fetch: request }),
			);
			expect(out.stopReason).toBe("error");
			expect(out.errorMessage).toMatch(/^(oauth|provider)_\w+ \(HTTP (unknown|503)\)$/);
			if (kind === "json" || kind === "text" || kind === "transport")
				expect(out.oauthRecovery?.retryable).toBe(true);
			if (kind === "json" || kind === "text")
				expect(out.diagnostics?.[0]?.type).toBe("pi_messages_response_failure");
		},
	);
	it.each(["onPayload", "onResponse", "onProviderStreamEvent"] as const)(
		"keeps rejecting %s observer nonretryable",
		async (callback) => {
			const callbacks = {
				[callback]: async () => {
					throw Object.assign(new Error(`service unavailable ${canary}`), { status: 503 });
				},
			};
			const { out } = await collect(
				stream(model, context, {
					apiKey: "synthetic",
					oauthDiagnostics,
					fetch: async () => response([{ type: "start" }, { type: "done", reason: "stop", usage }]),
					...callbacks,
				}),
			);
			expect(out.oauthRecovery?.retryable).toBe(false);
			expect(isRetryableAssistantError(out)).toBe(false);
			expect(out.diagnostics?.[0]?.type).toBe("provider_stream_observer_error");
			expect(out.errorMessage).not.toContain("503");
		},
	);
	it.each(["maximum context length exceeded", "service unavailable", "insufficient quota"])(
		"classifies original %s before discarding wire authority",
		async (text) => {
			const { out } = await collect(
				stream(model, context, {
					apiKey: "synthetic",
					oauthDiagnostics,
					fetch: async () =>
						response([
							{
								type: "error",
								reason: "error",
								usage: { ...usage, output: 0 },
								errorMessage: `${text} ${canary}`,
								oauthRecovery: { recovery: canary, retryable: true },
							},
						]),
				}),
			);
			expect(out.oauthRecovery?.retryable).toBe(text === "service unavailable");
			expect(isContextOverflow(out)).toBe(text === "maximum context length exceeded");
		},
	);
});
// smarty-dev#5822 T-R2-06: bounded usage and closed effort controls, never arbitrary strings.
it.each(["low", "medium", "high", "xhigh", "max"])("keeps owned successful effort %s", async (effort) => {
	const { out } = await collect(
		stream(model, context, {
			apiKey: "synthetic",
			fetch: async () => response([{ type: "done", reason: "stop", usage, providerThinkingLevel: effort }]),
		}),
	);
	expect(out.providerThinkingLevel).toBe(effort);
});
it("keeps model-declared effort", async () => {
	const { out } = await collect(
		stream({ ...model, thinkingLevelMap: { high: "declared-effort" } }, context, {
			apiKey: "synthetic",
			fetch: async () =>
				response([{ type: "done", reason: "stop", usage, providerThinkingLevel: "declared-effort" }]),
		}),
	);
	expect(out.providerThinkingLevel).toBe("declared-effort");
});
it("rebuilds bounded usage and computes total from components", async () => {
	const dirty = {
		input: 2 ** 40,
		output: 1.5,
		cacheRead: -3,
		cacheWrite: "7",
		totalTokens: 12,
		reasoning: null,
		extra: canary,
		cost: { input: 1e12, output: 0.25, cacheRead: "x", cacheWrite: 0, total: 999 },
	};
	const { out } = await collect(
		stream(model, context, {
			apiKey: "synthetic",
			fetch: async () => response([{ type: "done", reason: "stop", usage: dirty }]),
		}),
	);
	expect(out.usage).toEqual({
		input: 1e9,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 1e6, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 1e6 + 0.25 },
	});
});
it.each(["length", "toolUse", "deferred", "unrecognized"])(
	"derives outer envelope for wire stop %s",
	async (reason) => {
		const { seen, out } = await collect(
			stream(model, context, {
				apiKey: "synthetic",
				fetch: async () => response([{ type: "done", reason, usage }]),
			}),
		);
		const last = seen.at(-1);
		expect(last?.type).toBe(reason === "length" || reason === "toolUse" ? "done" : "error");
		expect(last).toHaveProperty("reason", out.stopReason);
	},
);
it.each(["stop", "toolUse", "aborted", "unknown"])("preserves error kind with wire reason %s", async (reason) => {
	const { seen, out } = await collect(
		stream(model, context, { apiKey: "synthetic", fetch: async () => response([{ type: "error", reason, usage }]) }),
	);
	expect(seen.at(-1)?.type).toBe("error");
	expect(out.stopReason).toBe(reason === "aborted" ? "aborted" : "error");
});
it.each(["pending", "stop", "error", "aborted"] as const)("projects model-less end %s", async (stopReason) => {
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		timestamp: 0,
		usage,
		stopReason,
		responseId: canary,
		providerThinkingLevel: canary,
	};
	const s = createAssistantMessageEventStream();
	s.end(message);
	const out = await s.result();
	expect(JSON.stringify(out)).not.toContain(canary);
	expect(message.responseId).toBe(canary);
	expect(out.usage.cost.total).toBe(0);
});

// smarty-dev#5822 T-R2-06: content/replay values are generated content, not diagnostic authority.
it("keeps complete text, thinking and tool-call phases without wire envelope extras", async () => {
	const events = [
		{ type: "start", extra: canary },
		{ type: "text_start", contentIndex: 0, extra: canary },
		{ type: "text_delta", contentIndex: 0, delta: "hello", extra: canary },
		{ type: "text_end", contentIndex: 0, content: "hello", contentSignature: "text-replay", extra: canary },
		{ type: "thinking_start", contentIndex: 1, extra: canary },
		{ type: "thinking_delta", contentIndex: 1, delta: "reason", extra: canary },
		{
			type: "thinking_end",
			contentIndex: 1,
			content: "reason",
			contentSignature: "thinking-replay",
			redacted: false,
			extra: canary,
		},
		{ type: "toolcall_start", contentIndex: 2, id: "call", toolName: "probe", extra: canary },
		{ type: "toolcall_delta", contentIndex: 2, delta: '{"value":1}', extra: canary },
		{
			type: "toolcall_end",
			contentIndex: 2,
			toolCall: { type: "toolCall", id: "call", name: "probe", arguments: { value: 1 } },
			extra: canary,
		},
		{
			type: "done",
			reason: "toolUse",
			usage: { ...usage, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 99 } },
			responseId: canary,
			extra: canary,
		},
	];
	const { seen, out } = await collect(
		stream(model, context, { apiKey: "synthetic", fetch: async () => response(events) }),
	);
	expect(seen.map((event) => event.type)).toEqual(events.map((event) => event.type));
	expect(out.content).toEqual([
		{ type: "text", text: "hello", textSignature: "text-replay" },
		{ type: "thinking", thinking: "reason", thinkingSignature: "thinking-replay", redacted: false },
		{ type: "toolCall", id: "call", name: "probe", arguments: { value: 1 } },
	]);
	expect(out.usage.cost.total).toBe(0.1 + 0.2);
});
it.each(["eof", "parser", "observer"] as const)("retains generated partial after %s failure", async (kind) => {
	const body = response([
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: "generated" },
		...(kind === "observer" ? [{ type: "text_end", contentIndex: 0, content: "generated" }] : []),
	]);
	const raw = await body.text();
	let observed = 0;
	const { out } = await collect(
		stream(model, context, {
			apiKey: "synthetic",
			fetch: async () => new Response(raw + (kind === "parser" ? `data: invalid-${canary}\n\n` : "")),
			onProviderStreamEvent: () => {
				if (kind === "observer" && ++observed === 4) throw new Error(canary);
			},
		}),
	);
	expect(out.content).toEqual([{ type: "text", text: "generated" }]);
	expect(isRetryableAssistantError(out)).toBe(false);
});
it("keeps caller abort as an aborted result", async () => {
	const controller = new AbortController();
	controller.abort();
	const { out } = await collect(
		stream(model, context, {
			apiKey: "synthetic",
			signal: controller.signal,
			fetch: async () => {
				throw new Error(canary);
			},
		}),
	);
	expect(out.stopReason).toBe("aborted");
	expect(isRetryableAssistantError(out)).toBe(false);
});
