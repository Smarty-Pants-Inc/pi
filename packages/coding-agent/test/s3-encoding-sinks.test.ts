import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createModels, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const key = "SYNTHETIC_GATEWAY_TOKEN_5822";
const variants = [key, Buffer.from(JSON.stringify({ unrelated: key })).toString("hex")];
const model: Model<"openai-responses"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://mock.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(errorMessage: string, stopReason: "error" | "stop" = "error"): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		timestamp: 0,
		stopReason,
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function journal(output: AssistantMessage): string {
	const dir = mkdtempSync(join(tmpdir(), "s3-encoding-journal-"));
	const session = SessionManager.create(dir, dir);
	session.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
	session.appendMessage(output);
	const file = session.getSessionFile();
	if (!file) throw new Error("Missing session journal");
	return readFileSync(file, "utf8");
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// smarty-dev#5822 / T-4403-1/2: direct retry producers must pass the same boundary as adapter streams.
describe.each(variants)("retry publication representation=%s", (representation) => {
	it.each(["scheduled", "finished", "result"] as const)(
		"projects the %s sink before callbacks or persistence",
		async (sink) => {
			const captures: unknown[] = [];
			const original = message(`503 receipt=${representation}`);
			const output = await retryAssistantCall(
				async () => original,
				{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
				undefined,
				{
					onRetryScheduled: (_attempt, _max, _delay, text) => {
						if (sink === "scheduled") captures.push(text);
					},
					onRetryFinished: (_success, _attempt, text) => {
						if (sink === "finished") captures.push(text);
					},
				},
			);
			expect(JSON.stringify({ captures, output, jsonl: journal(output) })).not.toContain(representation);
			expect(output.errorMessage).toBe("provider_request_failed (HTTP 503)");
			expect(output.oauthRecovery?.retryable).toBe(true);
			expect(original.errorMessage).toContain(representation);
		},
	);
});

// smarty-dev#5822: cap failures preserve outer retry authority without appending any SDK diagnostic.
it.each(variants)("owns retry-cap diagnostics for %s", async (representation) => {
	const error = Object.assign(new Error(`503 receipt=${representation}`), {
		status: 503,
		headers: new Headers({ "retry-after": "60" }),
	});
	const thrown = await retryProviderRequest(
		async () => {
			throw error;
		},
		{ maxRetries: 1, maxRetryDelayMs: 1 },
	).catch((value: unknown) => value);
	expect(thrown).toMatchObject({
		message: "oauth_retry_delay_exceeded (HTTP unknown)",
		retryable: true,
		recovery: "retryable",
	});
	expect(JSON.stringify(thrown)).not.toContain(representation);
});

// smarty-dev#5822 / T-4403-1: transformed non-allowlisted headers need no secret collector.
it.each(["Authorization", "X-Gateway-Token"])(
	"projects transformed %s errors and SDK console before JSONL",
	async (header) => {
		vi.stubEnv("OPENAI_LOG", "debug");
		const records: unknown[] = [];
		for (const level of ["debug", "info", "warn", "error"] as const)
			vi.spyOn(console, level).mockImplementation((...args) => {
				records.push(args);
			});
		const models = createModels();
		models.setProvider(openaiProvider());
		const events: unknown[] = [];
		let sent: Headers | undefined;
		const stream = models.stream(
			model,
			{ messages: [] },
			{
				apiKey: "synthetic-old",
				maxRetries: 0,
				transformHeaders: async (headers) => ({
					...headers,
					[header]: header === "Authorization" ? `Bearer ${key}` : key,
				}),
				fetch: async (_input, init) => {
					sent = new Headers(init?.headers);
					return Response.json({ error: { message: `receipt=${key}` } }, { status: 503 });
				},
			},
		);
		for await (const event of stream) events.push(event);
		const output = await stream.result();
		expect(sent?.get(header)).toBe(header === "Authorization" ? `Bearer ${key}` : key);
		expect(JSON.stringify({ records, events, output, jsonl: journal(output) })).not.toContain(key);
		expect(output.oauthRecovery?.retryable).toBe(true);
	},
);

// smarty-dev#5822 / T-4403-2: a second encoding is data, never an expanded masking algorithm.
it.each(variants)("projects observer and terminal failures for %s", async (representation) => {
	const models = createModels();
	models.setProvider(openaiProvider());
	const observations: unknown[] = [];
	const wire = `data: ${JSON.stringify({ type: "error", code: "synthetic", message: `503 receipt=${representation}` })}\n\n`;
	const stream = models.stream(
		model,
		{ messages: [] },
		{
			apiKey: "synthetic-old",
			maxRetries: 0,
			fetch: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
			onProviderStreamEvent: (event) => {
				observations.push(event);
			},
		},
	);
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	const output = await stream.result();
	expect(observations).toEqual([{ type: "provider_stream_event" }]);
	expect(JSON.stringify({ observations, events, output, jsonl: journal(output) })).not.toContain(representation);
	expect(output.stopReason).toBe("error");
});
