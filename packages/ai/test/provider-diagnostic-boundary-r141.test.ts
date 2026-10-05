import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream as azureStream } from "../src/api/azure-openai-responses.ts";
import { stream as mistralStream } from "../src/api/mistral-conversations.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const key = "SYNTHETIC_R141_CREDENTIAL";
const header = "SYNTHETIC_R141_HEADER";
const canary = "UNTRUSTED_R141_DIAGNOSTIC";
function model<T extends Api>(api: T): Model<T> {
	return {
		id: "synthetic",
		name: "Synthetic",
		api,
		provider: "audit",
		baseUrl: "https://mock.invalid/v1",
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 128,
		headers: { "x-api-key": header },
	};
}

// pi#141 / smarty-dev#4703: every direct provider stream must bind the common publication policy.
it("enumerates all provider stream receivers, rejecting an unbound new receiver", () => {
	const directory = new URL("../src/api/", import.meta.url);
	const receivers: string[] = [];
	for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts") && name !== "lazy.ts")) {
		const source = readFileSync(new URL(file, directory), "utf8");
		if (!/export (?:const|function) stream\b/.test(source) && !/new AssistantMessageEventStream\(/.test(source))
			continue;
		receivers.push(file);
		expect(source.includes("new AssistantMessageEventStream()"), file).toBe(false);
		expect(source.includes("new AssistantMessageEventStream(model, options)"), file).toBe(true);
	}
	expect(receivers).toContain("azure-openai-responses.ts");
	expect(receivers).toContain("mistral-conversations.ts");
	expect(receivers).toContain("anthropic-messages.ts");
	expect(receivers).toContain("pi-messages.ts");
});

// pi#141: use only synthetic request values, in-process HTTP responses, and ordinary public events.
describe.each([false, true])("request-bound diagnostics; OAuth=$0", (oauthDiagnostics) => {
	it.each(["azure", "mistral"])(
		"protects %s errors, SDK logs, events and persisted-message data",
		async (provider) => {
			vi.stubEnv("OPENAI_LOG", "debug");
			const records: unknown[] = [];
			const spies = ["debug", "info", "warn", "error"].map((level) =>
				vi.spyOn(console, level as "debug" | "info" | "warn" | "error").mockImplementation((...args: unknown[]) => {
					records.push(args);
				}),
			);
			const events: unknown[] = [];
			try {
				const options = {
					apiKey: key,
					oauthDiagnostics,
					env: { OPENAI_LOG: "debug" },
					maxRetries: 0,
					fetch: async () => Response.json({ error: { message: `${key} ${header} ${canary}` } }, { status: 403 }),
				};
				const context = normalizeContext({ messages: [] });
				const eventStream =
					provider === "azure"
						? azureStream(model("azure-openai-responses"), context, options)
						: mistralStream(model("mistral-conversations"), context, options);
				for await (const event of eventStream) events.push(event);
				const output = await eventStream.result();
				expect(output.stopReason).toBe("error");
				const sinks = JSON.stringify({ records, events, sessionRow: { type: "message", message: output } });
				expect(sinks).not.toContain(key);
				expect(sinks).not.toContain(header);
				if (oauthDiagnostics) expect(sinks).not.toContain(canary);
			} finally {
				for (const spy of spies) spy.mockRestore();
				vi.unstubAllEnvs();
			}
		},
	);

	it("protects successful Anthropic transformation diagnostics without erasing content or accounting", async () => {
		const events: unknown[] = [];
		const sse = [
			{
				type: "message_start",
				message: {
					id: "msg_synthetic",
					model: "synthetic",
					content: [],
					usage: { input_tokens: 7, output_tokens: 0 },
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 2 },
				input_transformations: [{ type: key, path: header, reason: canary }],
			},
			{ type: "message_stop" },
		]
			.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join("");
		const eventStream = anthropicStream(model("anthropic-messages"), normalizeContext({ messages: [] }), {
			apiKey: key,
			oauthDiagnostics,
			maxRetries: 0,
			fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
		});
		for await (const event of eventStream) events.push(event);
		const output = await eventStream.result();
		expect(output.stopReason).toBe("stop");
		expect(output.usage.input).toBe(7);
		expect(output.usage.output).toBe(2);
		const sinks = JSON.stringify({ events, sessionRow: { type: "message", message: output } });
		expect(sinks).not.toContain(key);
		expect(sinks).not.toContain(header);
		if (oauthDiagnostics) expect(sinks).not.toContain(canary);
	});
});
