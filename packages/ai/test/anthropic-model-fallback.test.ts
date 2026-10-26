import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import { createAssistantMessageDiagnostic, projectAssistantMessage } from "../src/utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import {
	isRetryableAnthropicMidOutputFallback,
	isRetryableAssistantError,
	retryAssistantCall,
} from "../src/utils/retry.ts";

const model = getModel("anthropic", "claude-opus-5");
const initialMessages = [{ role: "user" as const, content: "Hello", timestamp: 1 }];
const marker = {
	type: "fallback",
	from: { model: model.id },
	to: { model: "claude-opus-4-8" },
	trigger: { type: "refusal", category: "general_harms" },
};
const messageStart = {
	type: "message_start",
	message: { id: "msg_fallback", model: model.id, usage: { input_tokens: 12, output_tokens: 0 } },
};
const messageEnd = [
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
];

function sseResponse(events: Record<string, unknown>[]): Response {
	const bytes = new TextEncoder().encode(
		events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
	);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += 17)
					controller.enqueue(bytes.slice(offset, offset + 17));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function record(events: Record<string, unknown>[]) {
	const stream = streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
		apiKey: "synthetic-test-key",
		maxRetries: 0,
		fetch: async () => sseResponse(events),
	});
	const published: AssistantMessageEvent[] = [];
	for await (const event of stream) published.push(event);
	return { events: published, result: await stream.result() };
}

function fallbackCount(message: AssistantMessage): number {
	return (message.diagnostics ?? []).reduce(
		(count, diagnostic) =>
			count + (diagnostic.type === "anthropic_model_fallback" ? (diagnostic.fallbackCount ?? 0) : 0),
		0,
	);
}

// smarty-dev#2890: keep for the provider-publication and outbound-replay trust boundaries, without paid APIs.
describe("Anthropic model fallback records through the SSE adapter", () => {
	it("records and counts a start marker without changing content or the requested model", async () => {
		const { events, result } = await record([
			messageStart,
			{ type: "content_block_start", index: 3, content_block: marker },
			{ type: "content_block_stop", index: 3 },
			{ type: "content_block_start", index: 4, content_block: { type: "text", text: "Unchanged reply" } },
			{ type: "content_block_stop", index: 4 },
			...messageEnd,
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe(model.id);
		expect(result.content).toEqual([{ type: "text", text: "Unchanged reply" }]);
		expect(result.fallback).toEqual([
			{ position: "start", blockIndex: 3, blockState: "retained", rawBlock: JSON.stringify(marker) },
		]);
		expect(result.diagnostics).toEqual([
			{ type: "anthropic_model_fallback", timestamp: expect.any(Number), fallbackCount: 1 },
		]);
		expect(fallbackCount(result)).toBe(1);
		expect(isRetryableAnthropicMidOutputFallback(result)).toBe(false);
		for (const event of events) {
			if ("partial" in event) expect(event.partial).not.toHaveProperty("fallback");
			if (event.type === "done") expect(event.message.fallback).toEqual(result.fallback);
		}
	});

	it("retains every start marker and counts each one, without mistaking markers for output", async () => {
		const second = { ...marker, from: marker.to, to: { model: "claude-sonnet-4-6" } };
		const { result } = await record([
			messageStart,
			{ type: "content_block_start", index: 0, content_block: marker },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: second },
			{ type: "content_block_stop", index: 1 },
			...messageEnd,
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
		expect(result.fallback).toEqual([
			{ position: "start", blockIndex: 0, blockState: "retained", rawBlock: JSON.stringify(marker) },
			{ position: "start", blockIndex: 1, blockState: "retained", rawBlock: JSON.stringify(second) },
		]);
		expect(fallbackCount(result)).toBe(2);
		expect(result.diagnostics).toHaveLength(2);
	});

	it.each([
		{ type: "thinking", thinking: "partial reasoning", signature: "partial signature" },
		{ type: "text", text: "partial answer" },
		{ type: "tool_use", id: "tool_partial", name: "read", input: {} },
		{ type: "thinking", thinking: "", signature: "" },
		{ type: "text", text: "" },
	])("records a retryable error after a $type block has started", async (block) => {
		const { events, result } = await record([
			messageStart,
			{ type: "content_block_start", index: 0, content_block: marker },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: block },
			...(block.type === "tool_use"
				? [
						{
							type: "content_block_delta",
							index: 1,
							delta: { type: "input_json_delta", partial_json: '{"path":"a' },
						},
					]
				: []),
			{ type: "content_block_start", index: 7, content_block: marker },
		]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic performed a mid-output model fallback");
		expect(result.recovery).toEqual({ recovery: "anthropic_mid_output_fallback", retryable: true });
		// smarty-dev#2890: full MID raw capture is phase2; READY-1 records only its location and discarded state.
		expect(result.fallback).toEqual([
			{ position: "start", blockIndex: 0, blockState: "retained", rawBlock: JSON.stringify(marker) },
			{ position: "mid-output", blockIndex: 7, blockState: "discarded" },
		]);
		expect(fallbackCount(result)).toBe(2);
		expect(isRetryableAnthropicMidOutputFallback(result)).toBe(true);
		// Generic retries must not bypass the session's one-shot/no-started-tool guard, even for empty starts.
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).not.toHaveProperty("index");
		expect(result.content[0]).not.toHaveProperty("partialJson");
		expect(events.at(-1)?.type).toBe("error");
		const terminal = events.at(-1);
		if (terminal?.type === "error") expect(terminal.error.fallback).toEqual(result.fallback);
		for (const event of events) if ("partial" in event) expect(event.partial).not.toHaveProperty("fallback");
	});

	it.each(["thinking", "text"] as const)(
		"never generically retries a fallback after empty %s starts",
		async (type) => {
			let attempts = 0;
			const result = await retryAssistantCall(
				async () => {
					attempts++;
					return (
						await record([
							messageStart,
							{
								type: "content_block_start",
								index: 0,
								content_block: type === "thinking" ? { type, thinking: "", signature: "" } : { type, text: "" },
							},
							{ type: "content_block_start", index: 1, content_block: marker },
						])
					).result;
				},
				{ enabled: true, maxRetries: 10, baseDelayMs: 0 },
				undefined,
			);
			expect(attempts).toBe(1);
			expect(result.recovery).toEqual({ recovery: "anthropic_mid_output_fallback", retryable: true });
			expect(isRetryableAnthropicMidOutputFallback(result)).toBe(true);
		},
	);

	it("masks all known request credentials and removes content recursively before recording", async () => {
		const secrets = ["synthetic-test-key", "model-header-secret", "request-header-secret", "additional-secret"];
		const block = {
			...marker,
			content: [{ type: "text", text: "PRIVATE_CONTENT" }],
			extra: { content: "NESTED_PRIVATE_CONTENT", echo: secrets.join(" ") },
			encoded: [encodeURIComponent(secrets[1]), Buffer.from(secrets[2]).toString("base64")],
		};
		const result = await streamAnthropic(
			{ ...model, headers: { "X-Client-Token": secrets[1] } },
			normalizeContext({ messages: initialMessages }),
			{
				apiKey: secrets[0],
				headers: { Authorization: `Bearer ${secrets[2]}` },
				diagnosticSecrets: [secrets[3]],
				maxRetries: 0,
				fetch: async () =>
					sseResponse([
						messageStart,
						{ type: "content_block_start", index: 0, content_block: block },
						...messageEnd,
					]),
			},
		).result();
		expect(result.fallback?.[0].blockState).toBe("retained");
		expect(JSON.parse(result.fallback![0].rawBlock!)).toEqual({
			...marker,
			extra: { echo: "*** *** *** ***" },
			encoded: ["***", "***"],
		});
		for (const forbidden of [...secrets, "PRIVATE_CONTENT", "NESTED_PRIVATE_CONTENT"])
			expect(JSON.stringify(result)).not.toContain(forbidden);
		expect(result.content).toEqual([]);
		expect(JSON.stringify(result.diagnostics)).not.toContain("claude-opus-4-8");
		expect(result.errorMessage).toBeUndefined();
	});

	// smarty-dev#4605: configured federation must not discard known key/header records when auth bypasses it.
	it.each(["api-key", "header"] as const)(
		"retains a known %s START credential with federation configured",
		async (auth) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-fallback-known-auth-"));
			try {
				const identityTokenFile = join(tempDir, "identity.jwt");
				writeFileSync(identityTokenFile, "synthetic.unused.identity");
				const credential = "synthetic-known-fallback-credential";
				const paths: string[] = [];
				const result = await streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
					...(auth === "api-key"
						? { apiKey: credential }
						: { headers: { Authorization: `Bearer ${credential}` } }),
					env: {
						ANTHROPIC_FEDERATION_RULE_ID: "fdrl_unused",
						ANTHROPIC_ORGANIZATION_ID: "org-unused",
						ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
						ANTHROPIC_WORKSPACE_ID: "wrkspc-unused",
						ANTHROPIC_SERVICE_ACCOUNT_ID: "svcacct-unused",
					},
					maxRetries: 0,
					fetch: async (input, init) => {
						const request = new Request(input, init);
						paths.push(new URL(request.url).pathname);
						expect(request.headers.get(auth === "api-key" ? "x-api-key" : "authorization")).toBe(
							auth === "api-key" ? credential : `Bearer ${credential}`,
						);
						return sseResponse([
							messageStart,
							{ type: "content_block_start", index: 0, content_block: { type: "fallback", echo: credential } },
							...messageEnd,
						]);
					},
				}).result();
				expect(paths).toEqual(["/v1/messages"]);
				expect(result.stopReason).toBe("stop");
				expect(result.fallback).toEqual([
					{
						position: "start",
						blockIndex: 0,
						blockState: "retained",
						rawBlock: '{"type":"fallback","echo":"***"}',
					},
				]);
				expect(fallbackCount(result)).toBe(1);
				expect(JSON.stringify(result)).not.toContain(credential);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it.each([
		{ name: "exact cap", padding: "x".repeat(4064), retained: true },
		{ name: "over cap", padding: "x".repeat(4065), retained: false },
		{ name: "multibyte cap", padding: "é".repeat(2050), retained: false },
	])("bounds the masked, content-free block at $name without retaining a prefix", async ({ padding, retained }) => {
		const block = { type: "fallback", padding, content: "EXCLUDED_CONTENT" };
		const serialized = JSON.stringify({ type: "fallback", padding });
		const { result } = await record([
			messageStart,
			{ type: "content_block_start", index: 0, content_block: block },
			...messageEnd,
		]);
		const item = result.fallback![0];
		expect(item.blockState).toBe(retained ? "retained" : "discarded");
		if (retained) {
			expect(Buffer.byteLength(serialized)).toBe(4096);
			expect(item.rawBlock).toBe(serialized);
			expect(item).not.toHaveProperty("blockBytes");
		} else {
			expect(item).not.toHaveProperty("rawBlock");
			expect(item.blockBytes).toBe(Buffer.byteLength(serialized));
			expect(item.blockSha256).toBe(createHash("sha256").update(serialized).digest("hex"));
			expect(JSON.stringify(item)).not.toContain(padding.slice(0, 100));
		}
		expect(JSON.stringify(result)).not.toContain("EXCLUDED_CONTENT");
		expect(fallbackCount(result)).toBe(1);
	});

	it("measures and fingerprints only masked fields after removing content", async () => {
		const block = { ...marker, content: "PRIVATE_CONTENT", padding: `${"x".repeat(5000)} synthetic-test-key` };
		const serialized = JSON.stringify({ ...marker, padding: `${"x".repeat(5000)} ***` });
		const { result } = await record([
			messageStart,
			{ type: "content_block_start", index: 0, content_block: block },
			...messageEnd,
		]);
		expect(result.fallback![0]).toEqual({
			position: "start",
			blockIndex: 0,
			blockState: "discarded",
			blockBytes: Buffer.byteLength(serialized),
			blockSha256: createHash("sha256").update(serialized).digest("hex"),
		});
	});

	it("discards raw markers from an injected client whose credentials are unknown", async () => {
		const credential = "unknown-client-credential";
		const block = { ...marker, echo: credential, content: "PRIVATE_CONTENT" };
		const client = new Anthropic({
			apiKey: credential,
			authToken: null,
			maxRetries: 0,
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("x-api-key")).toBe(credential);
				return sseResponse([
					messageStart,
					{ type: "content_block_start", index: 0, content_block: block },
					...messageEnd,
				]);
			},
		});
		const result = await streamAnthropic(model, normalizeContext({ messages: initialMessages }), { client }).result();
		expect(result.fallback![0].blockState).toBe("discarded");
		expect(result.fallback![0]).not.toHaveProperty("rawBlock");
		expect(result.fallback![0].blockBytes).toBe(Buffer.byteLength(JSON.stringify({ ...marker, echo: credential })));
		expect(JSON.stringify(result)).not.toContain(credential);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTENT");
		expect(fallbackCount(result)).toBe(1);
	});

	// smarty-dev#4605 (F2): the real SDK exchanges a credential Pi never receives in its diagnostic secret list.
	it.each(["start", "mid-output"] as const)(
		"discards a %s marker reflecting an SDK-managed federated credential",
		async (position) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-fallback-federation-"));
			try {
				const identityTokenFile = join(tempDir, "identity.jwt");
				writeFileSync(identityTokenFile, "synthetic.identity.signature");
				const credential = "synthetic-federation-fallback-token";
				const block = { type: "fallback", echo: credential, content: "PRIVATE_CONTENT" };
				const serialized = JSON.stringify({ type: "fallback", echo: credential });
				const paths: string[] = [];
				const stream = streamAnthropic(
					{ ...model, baseUrl: "https://federation-fallback.invalid" },
					normalizeContext({ messages: initialMessages }),
					{
						env: {
							ANTHROPIC_FEDERATION_RULE_ID: "fdrl_synthetic",
							ANTHROPIC_ORGANIZATION_ID: "org-synthetic",
							ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
							ANTHROPIC_WORKSPACE_ID: "wrkspc-synthetic",
							ANTHROPIC_SERVICE_ACCOUNT_ID: "svcacct-synthetic",
						},
						maxRetries: 0,
						fetch: async (input, init) => {
							const request = new Request(input, init);
							const path = new URL(request.url).pathname;
							paths.push(path);
							if (path === "/v1/oauth/token") {
								expect(await request.json()).toMatchObject({
									grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
									assertion: "synthetic.identity.signature",
									federation_rule_id: "fdrl_synthetic",
									organization_id: "org-synthetic",
								});
								return Response.json({ access_token: credential, expires_in: 3600 });
							}
							expect(path).toBe("/v1/messages");
							expect(request.headers.get("authorization")).toBe(`Bearer ${credential}`);
							expect(request.headers.has("x-api-key")).toBe(false);
							return sseResponse([
								messageStart,
								...(position === "start"
									? []
									: [
											{
												type: "content_block_start",
												index: 0,
												content_block: { type: "text", text: "safe output" },
											},
										]),
								{ type: "content_block_start", index: 1, content_block: block },
								...(position === "start"
									? [
											{ type: "content_block_stop", index: 1 },
											{
												type: "content_block_start",
												index: 2,
												content_block: { type: "text", text: "safe output" },
											},
											{ type: "content_block_stop", index: 2 },
											...messageEnd,
										]
									: []),
							]);
						},
					},
				);
				const events: AssistantMessageEvent[] = [];
				for await (const event of stream) events.push(event);
				const result = await stream.result();
				expect(paths).toEqual(["/v1/oauth/token", "/v1/messages"]);
				expect(result.stopReason).toBe(position === "start" ? "stop" : "error");
				expect(result.content).toEqual([{ type: "text", text: "safe output" }]);
				expect(fallbackCount(result)).toBe(1);
				expect(isRetryableAnthropicMidOutputFallback(result)).toBe(position === "mid-output");
				expect.soft(JSON.stringify(result)).not.toContain(credential);
				expect.soft(JSON.stringify(events)).not.toContain(credential);
				expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTENT");
				expect(result.fallback).toEqual([
					{
						position,
						blockIndex: 1,
						blockState: "discarded",
						...(position === "start"
							? {
									blockBytes: Buffer.byteLength(serialized),
									blockSha256: createHash("sha256").update(serialized).digest("hex"),
								}
							: {}),
					},
				]);
				for (const event of events) if ("partial" in event) expect(event.partial).not.toHaveProperty("fallback");
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it("keeps a marker/count on observer failure without making the observer error retryable", async () => {
		let observed = 0;
		const result = await streamAnthropic(model, normalizeContext({ messages: initialMessages }), {
			apiKey: "synthetic-test-key",
			maxRetries: 0,
			fetch: async () =>
				sseResponse([
					messageStart,
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
					{ type: "content_block_start", index: 1, content_block: marker },
				]),
			onProviderStreamEvent: () => {
				if (++observed === 3) throw new Error("503 observer failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.fallback).toEqual([{ position: "mid-output", blockIndex: 1, blockState: "discarded" }]);
		expect(fallbackCount(result)).toBe(1);
		expect(result.diagnostics?.some(({ type }) => type === "provider_stream_observer_error")).toBe(true);
		expect(isRetryableAnthropicMidOutputFallback(result)).toBe(false);
	});

	it("publishes detached records through projection, forwarding, and late secret protection", async () => {
		const { result } = await record([
			messageStart,
			{ type: "content_block_start", index: 0, content_block: { ...marker, echo: "late-secret" } },
			...messageEnd,
		]);
		expect(projectAssistantMessage(result, "partial")).not.toHaveProperty("fallback");
		const forwarded = new AssistantMessageEventStream(["late-secret"]);
		forwarded.push({ type: "done", reason: "stop", message: result });
		const published = await forwarded.result();
		const recordedRaw = published.fallback![0].rawBlock;
		result.fallback![0].rawBlock = "mutated source";
		result.fallback!.push({ position: "mid-output", blockIndex: 9, blockState: "discarded" });
		expect(published.fallback).toHaveLength(1);
		expect(published.fallback![0].rawBlock).toBe(recordedRaw);
		expect(recordedRaw).not.toContain("late-secret");
		const copy = projectAssistantMessage(published, "success");
		copy.fallback![0].rawBlock = "mutated copy";
		expect(published.fallback![0].rawBlock).toBe(recordedRaw);
		expect(fallbackCount(copy)).toBe(1);
	});

	it.each(["stop", "error"] as const)("never replays stored marker metadata from a %s message", async (stopReason) => {
		const sentinel = "UNTRUSTED_FALLBACK_NOT_CONTEXT";
		const { result } = await record([
			messageStart,
			{ type: "content_block_start", index: 0, content_block: { ...marker, extra: sentinel } },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "Unchanged reply" } },
			{ type: "content_block_stop", index: 1 },
			...messageEnd,
		]);
		const stored = JSON.parse(JSON.stringify(result)) as AssistantMessage;
		expect(stored.fallback?.[0].rawBlock).toContain(sentinel);
		stored.stopReason = stopReason;
		let request: Record<string, unknown> | undefined;
		await streamAnthropic(
			model,
			normalizeContext({
				messages: [...initialMessages, stored, { role: "user", content: "Continue", timestamp: 2 }],
			}),
			{
				apiKey: "synthetic-test-key",
				cacheRetention: "none",
				maxRetries: 0,
				fetch: async (_url, init) => {
					request = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return sseResponse([messageStart, ...messageEnd]);
				},
			},
		).result();
		expect(request).toBeDefined();
		const wire = JSON.stringify(request);
		for (const forbidden of [
			"fallback",
			"rawBlock",
			"blockIndex",
			"blockState",
			"blockBytes",
			"blockSha256",
			sentinel,
		])
			expect(wire).not.toContain(forbidden);
		const assistants = (request!.messages as Array<{ role: string; content: unknown }>).filter(
			(message) => message.role === "assistant",
		);
		expect(assistants).toEqual(
			stopReason === "error" ? [] : [{ role: "assistant", content: [{ type: "text", text: "Unchanged reply" }] }],
		);
	});
});

// smarty-dev#2890: this helper authorizes a bounded session restart, never general transient-text retries.
describe("isRetryableAnthropicMidOutputFallback", () => {
	const failure: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		content: [{ type: "thinking", thinking: "partial" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "Anthropic performed a mid-output model fallback",
		recovery: { recovery: "anthropic_mid_output_fallback", retryable: true },
		timestamp: 1,
	};

	it("uses only the owned recovery, even after persistence or error-text replacement", () => {
		expect(isRetryableAnthropicMidOutputFallback(JSON.parse(JSON.stringify(failure)) as AssistantMessage)).toBe(true);
		expect(isRetryableAnthropicMidOutputFallback({ ...failure, errorMessage: "Request failed" })).toBe(true);
	});

	it.each([
		{ recovery: undefined },
		{ recovery: { recovery: "retryable", retryable: true } },
		{ recovery: { recovery: "premature_stream", retryable: true } },
		{ recovery: { recovery: "context_length_exceeded", retryable: false } },
		{ recovery: { recovery: "anthropic_mid_output_fallback", retryable: false } },
		{ stopReason: "aborted" },
		{ stopReason: "stop" },
		{ api: "openai-responses" },
		{ diagnostics: [{ type: "provider_stream_observer_error", timestamp: 1 }] },
		{ diagnostics: [{ type: "provider_limit", timestamp: 1 }] },
	] satisfies Partial<AssistantMessage>[])("rejects non-owned recovery or terminal exclusions: %j", (overrides) => {
		expect(isRetryableAnthropicMidOutputFallback({ ...failure, ...overrides })).toBe(false);
	});

	it("does not infer retry permission from raw markers or arbitrary transient text", () => {
		expect(
			isRetryableAnthropicMidOutputFallback({
				...failure,
				recovery: undefined,
				errorMessage: "503 overloaded: Anthropic performed a mid-output model fallback",
				fallback: [
					{ position: "mid-output", blockIndex: 1, blockState: "retained", rawBlock: JSON.stringify(marker) },
				],
			}),
		).toBe(false);
	});

	it("leaves ordinary transient classification unchanged", () => {
		const transient = { ...failure, content: [], recovery: undefined, errorMessage: "503 overloaded" };
		expect(isRetryableAssistantError(transient)).toBe(true);
		expect(isRetryableAnthropicMidOutputFallback(transient)).toBe(false);
	});

	it("drops producer numeric values/extras but preserves a bounded Pi-owned count on re-projection", () => {
		const owned = createAssistantMessageDiagnostic("anthropic_model_fallback");
		owned.fallbackCount = 1_000_000;
		const projected = projectAssistantMessage(
			{
				...failure,
				diagnostics: [owned, { type: "anthropic_model_fallback", timestamp: 123, fallbackCount: 123456789 }],
			},
			"failure",
		);
		expect(projected.diagnostics?.[0].fallbackCount).toBe(100_000);
		expect(projected.diagnostics?.[1]).not.toHaveProperty("fallbackCount");
		expect(projectAssistantMessage(projected, "failure").diagnostics?.[0].fallbackCount).toBe(100_000);
	});
});
