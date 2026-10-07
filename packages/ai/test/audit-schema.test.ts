import { describe, expect, it } from "vitest";
import { stream } from "../src/api/pi-messages.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Defensive acceptance probes for smarty-dev#5822. Synthetic data, fake fetch, no listener or cleanup.
const canary = "SYNTHETIC_AUDIT_DIAGNOSTIC_5822";
const model: Model<"pi-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://mock.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function message(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage,
		timestamp: 0,
		stopReason: "stop",
	};
}
describe.each([undefined, false, true])("auditor closed schema policy=%s", (oauthDiagnostics) => {
	it.each(["done", "error"] as const)("drops unknown nested tool-call diagnostic on %s", async (terminal) => {
		const wire = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "probe" },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call",
					name: "probe",
					arguments: {},
					credentialDiagnostic: canary,
				},
			},
			{ type: terminal, reason: terminal === "error" ? "error" : "stop", usage },
		];
		const s = stream(model, normalizeContext({ messages: [] }), {
			apiKey: "synthetic",
			oauthDiagnostics,
			fetch: async () => new Response(wire.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")),
		});
		const events = [];
		for await (const e of s) events.push(e);
		const result = await s.result();
		expect(result.content[0]).toMatchObject({ type: "toolCall", id: "call", name: "probe", arguments: {} });
		expect(JSON.stringify({ events, result })).not.toContain(canary);
	});
	it("drops nonboolean thinking redacted metadata", async () => {
		const wire = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_end", contentIndex: 0, content: "generated", redacted: canary },
			{ type: "error", reason: "error", usage },
		];
		const s = stream(model, normalizeContext({ messages: [] }), {
			apiKey: "synthetic",
			oauthDiagnostics,
			fetch: async () => new Response(wire.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")),
		});
		const events = [];
		for await (const e of s) events.push(e);
		const result = await s.result();
		expect(JSON.stringify({ events, result })).not.toContain(canary);
	});
	it("rejects unowned model-less recovery fields", async () => {
		const m = {
			...message(),
			stopReason: "error",
			errorMessage: "service unavailable",
			oauthRecovery: { retryable: true, recovery: canary, credentialDiagnostic: canary },
		} as unknown as AssistantMessage;
		const s = createAssistantMessageEventStream();
		s.push({ type: "error", reason: "error", error: m });
		const events = [];
		for await (const e of s) events.push(e);
		const result = await s.result();
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify({ events, result })).not.toContain(canary);
	});
});
it.each(["responseModel", "endTurn", "diagnosticHint", "unknownDiagnostic"])(
	"drops non-owned successful %s",
	async (field) => {
		const m = { ...message(), [field]: canary } as AssistantMessage;
		const s = createAssistantMessageEventStream();
		s.push({ type: "done", reason: "stop", message: m });
		const result = await s.result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.stringify(result)).not.toContain(canary);
	},
);
it("does not publish provider deferred diagnostic data", async () => {
	const m = {
		...message(),
		stopReason: "deferred",
		deferred: {
			id: canary,
			provider: model.provider,
			api: model.api,
			modelId: model.id,
			data: { credentialDiagnostic: canary },
			expiresAt: canary,
			pollAfterMs: 2 ** 40,
		},
	} as unknown as AssistantMessage;
	const s = createAssistantMessageEventStream();
	s.push({ type: "done", reason: "deferred", message: m });
	const result = await s.result();
	expect(JSON.stringify(result)).not.toContain(canary);
});
