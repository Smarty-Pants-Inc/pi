// smarty-dev#16938: 60 screenshots exceeded the gateway's 16 MiB JSON body limit.
// Keep reasons: recorded incident, attachment data safety, and the diagnostic publication trust boundary.
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import type { HttpRequest } from "@smithy/types";
import { describe, expect, it } from "vitest";
import type { Api, Context, ImageContent, Model, ToolResultMessage, UserMessage } from "../src/types.ts";
import {
	createAssistantMessageDiagnostic,
	createRequestImagesOmittedDiagnostic,
	projectAssistantMessageDiagnostics,
} from "../src/utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";
import { classifyProviderFailure } from "../src/utils/recovery.ts";
import {
	DEFAULT_MAX_REQUEST_BYTES,
	DEFAULT_REQUEST_IMAGE_BUDGET_BYTES,
	fitRequestImages,
	RequestTooLargeError,
	UnsupportedRequestPayloadError,
} from "../src/utils/request-size.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const KIB = 1024;
const MIB = KIB * KIB;

function model(api: Api = "anthropic-messages", maxRequestBytes?: number): Model<Api> {
	return {
		api,
		id: "test-model",
		name: "Test",
		provider: "test",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text", "image"],
		inputLimits: maxRequestBytes === undefined ? undefined : { maxRequestBytes },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function screenshot(index: number, bytes = 64 * KIB): string {
	return "A".repeat(bytes - 4) + index.toString(16).padStart(4, "0");
}

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function user(data: string): UserMessage {
	return { role: "user", content: [image(data)], timestamp: 0 };
}

function tool(data: string, id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "screenshot",
		content: [{ type: "text", text: `Screenshot ${id}` }, image(data)],
		isError: false,
		timestamp: 0,
	};
}

function anthropicImage(data: string) {
	return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function bytes(payload: unknown): number {
	return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/** Run the installed SDK serializer and signer, then stop at the handler without opening a socket. */
async function serializedBedrockRequest(input: ConverseStreamCommandInput): Promise<{ body: string; path: string }> {
	let captured: { body: string; path: string } | undefined;
	const stopped = new Error("Offline Bedrock request captured");
	const client = new BedrockRuntimeClient({
		region: "us-east-1",
		endpoint: "https://bedrock.invalid",
		credentials: { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" },
		maxAttempts: 1,
		requestHandler: {
			async handle(request: HttpRequest) {
				const body: unknown = request.body;
				if (typeof body !== "string" && !(body instanceof Uint8Array)) {
					throw new Error("Expected a serialized Bedrock JSON body");
				}
				captured = { body: typeof body === "string" ? body : new TextDecoder().decode(body), path: request.path };
				throw stopped;
			},
			updateHttpClientConfig: () => undefined,
			httpHandlerConfigs: () => ({}),
		},
	});
	try {
		await expect(client.send(new ConverseStreamCommand(input))).rejects.toBe(stopped);
		if (!captured) throw new Error("Bedrock SDK did not reach the offline handler");
		return captured;
	} finally {
		client.destroy();
	}
}

describe("fitRequestImages", () => {
	// smarty-dev#16938: exercise the default budgets on an assembled, realistic-sized request, not estimates.
	it("trims the oldest of 60 tool screenshots below 12 MiB without changing history or text", () => {
		const messages = Array.from({ length: 60 }, (_, index) => tool(screenshot(index, 320 * KIB), `call-${index}`));
		const context = normalizeContext({ messages });
		const payload = {
			model: "test-model",
			system: "Keep this system prompt",
			tools: [{ name: "screenshot", input_schema: { type: "object", properties: {} } }],
			messages: messages.map((message) => ({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: message.toolCallId,
						content: [
							{ type: "text", text: message.content[0].type === "text" ? message.content[0].text : "" },
							anthropicImage((message.content[1] as ImageContent).data),
						],
					},
				],
			})),
		};
		const originalBytes = bytes(payload);
		expect(originalBytes).toBeGreaterThan(DEFAULT_MAX_REQUEST_BYTES);
		const result = fitRequestImages(payload, model(), context);
		const fitted = result.payload as typeof payload;
		expect(result.requestBytes).toBeLessThanOrEqual(DEFAULT_REQUEST_IMAGE_BUDGET_BYTES);
		expect(result.requestBytes).toBe(bytes(fitted));
		expect(result.bytesSaved).toBe(originalBytes - result.requestBytes);
		expect(result.imagesOmitted).toBeGreaterThan(0);
		for (let index = 0; index < 60; index++) {
			const content = fitted.messages[index].content[0].content;
			expect(content[0]).toEqual({ type: "text", text: `Screenshot call-${index}` });
			if (index < result.imagesOmitted) {
				expect(content[1]).toEqual({
					type: "text",
					text: `[image omitted to fit request size: call-${index}, 320 KB]`,
				});
			} else expect(content[1]).toEqual(payload.messages[index].content[0].content[1]);
		}
		expect(fitted.system).toBe(payload.system);
		expect(fitted.tools).toEqual(payload.tools);
		expect(payload.messages[0].content[0].content[1]).toHaveProperty("source.data");
		expect(context.messages[0]).toBe(messages[0]);
		expect((messages[0].content[1] as ImageContent).data.length).toBe(320 * KIB);
	});

	it("retains latest user images ahead of newer tool screenshots, until omission is unavoidable", () => {
		const old = screenshot(1);
		const latestUser = screenshot(2);
		const newestTool = screenshot(3);
		const context: Context = { messages: [user(old), user(latestUser), tool(newestTool, "new-tool")] };
		const payload = { context };
		const result = fitRequestImages(payload, model("pi-messages"), context, 70 * KIB);
		expect(result.imagesOmitted).toBe(2);
		expect(JSON.stringify(result.payload)).not.toContain(old);
		expect(JSON.stringify(result.payload)).not.toContain(newestTool);
		expect(JSON.stringify(result.payload)).toContain(latestUser);
		const all = fitRequestImages(payload, model("pi-messages"), context, 2 * KIB);
		expect(all.imagesOmitted).toBe(3);
		expect(JSON.stringify(all.payload)).not.toContain(latestUser);
		expect(context.messages[0]).toEqual(user(old));
	});

	it("matches duplicate image occurrences separately, including aliased input blocks", () => {
		const repeated = screenshot(1);
		const newerTool = screenshot(2);
		const context: Context = { messages: [tool(repeated, "old-call"), user(repeated), tool(newerTool, "new-call")] };
		const shared = anthropicImage(repeated);
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: [shared] }] },
				{ role: "user", content: [shared] },
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "new-call", content: [anthropicImage(newerTool)] }],
				},
			],
		};
		const result = fitRequestImages(payload, model(), context, 70 * KIB);
		expect(result.imagesOmitted).toBe(2);
		const fitted = result.payload as typeof payload;
		expect(fitted.messages[1].content[0]).toEqual(shared);
		expect(JSON.stringify(fitted.messages[0])).toContain("old-call, 64 KB");
		expect(JSON.stringify(fitted.messages[2])).toContain("new-call, 64 KB");
		expect(shared.source.data).toBe(repeated);
	});

	it("uses original transcript order even when a caller reorders distinct images", () => {
		const old = screenshot(1);
		const latest = screenshot(2);
		const context: Context = { messages: [tool(old, "old"), tool(latest, "latest")] };
		const payload = { messages: [{ role: "user", content: [anthropicImage(latest), anthropicImage(old)] }] };
		const result = fitRequestImages(payload, model(), context, 70 * KIB);
		expect(result.imagesOmitted).toBe(1);
		expect(JSON.stringify(result.payload)).toContain(latest);
		expect(JSON.stringify(result.payload)).not.toContain(old);
	});

	it("returns the original object at or under budget, including custom payload shapes", () => {
		const payload = { custom: '😀\n"\\' };
		const result = fitRequestImages(payload, model("custom-api"), { messages: [] }, bytes(payload));
		expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: bytes(payload) });
		expect(result.payload).toBe(payload);
	});

	it("does not mutate or omit tiny images when the notice would increase size", () => {
		const payload = { messages: [{ role: "user", content: [{ type: "image", source: { data: "A" } }] }] };
		const result = fitRequestImages(payload, model(), { messages: [] }, 1);
		expect(result.payload).toBe(payload);
		expect(result.imagesOmitted).toBe(0);
		expect(result.bytesSaved).toBe(0);
	});

	it("measures UTF-8 JSON escaping after caller transforms, not source string lengths", async () => {
		const data = screenshot(1);
		const context: Context = { messages: [user(data)] };
		const payload = { messages: [{ role: "user", content: [anthropicImage(data)] }] };
		const budget = bytes(payload) + 1;
		expect(fitRequestImages(payload, model(), context, budget).imagesOmitted).toBe(0);
		const callerTransform = async () => ({ ...payload, metadata: { text: '😀\n"\\'.repeat(2000) } });
		const transformed = await callerTransform();
		expect(bytes(transformed)).toBeGreaterThan(JSON.stringify(transformed).length);
		const result = fitRequestImages(transformed, model(), context, budget);
		expect(result.imagesOmitted).toBe(1);
		expect(result.requestBytes).toBe(bytes(result.payload));
		expect(result.bytesSaved).toBe(bytes(transformed) - result.requestBytes);
		expect((result.payload as typeof transformed).metadata).toEqual(transformed.metadata);
	});

	it("does not search schemas, tool arguments, result JSON, or arbitrary image-like text", () => {
		const data = screenshot(1);
		const planted = anthropicImage(data);
		const payload = {
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "x", input: { content: [planted] } }] },
				{
					role: "user",
					content: [
						{ type: "text", text: JSON.stringify(planted) },
						{ type: "tool_result", content: { arbitrary: planted } },
					],
				},
			],
			tools: [{ input_schema: { content: [planted] } }],
		};
		const result = fitRequestImages(payload, model(), { messages: [] }, KIB);
		expect(result.payload).toBe(payload);
		expect(result.imagesOmitted).toBe(0);
		expect(result.requestBytes).toBe(bytes(payload));
	});

	it("allows nonimage requests above the soft target but never above the hard cap", () => {
		const payload = { messages: [{ role: "user", content: "text".repeat(KIB) }] };
		const result = fitRequestImages(payload, model(), { messages: [] }, KIB);
		expect(result.payload).toBe(payload);
		expect(result.requestBytes).toBe(bytes(payload));
		expect(() => fitRequestImages(payload, model("anthropic-messages", 2 * KIB), { messages: [] })).toThrow(
			RequestTooLargeError,
		);
	});

	// smarty-dev#16938: upstream catalog limits must not override a gateway's smaller admission limit.
	it("caps a 512 MiB upstream model at 16 MiB and returns an actionable error for oversized text", () => {
		const payload = { messages: [{ role: "user", content: "x".repeat(DEFAULT_MAX_REQUEST_BYTES) }] };
		try {
			fitRequestImages(payload, model("anthropic-messages", 512 * MIB), { messages: [] }, 512 * MIB);
			throw new Error("Expected local request-size refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(RequestTooLargeError);
			const failure = error as RequestTooLargeError;
			expect(failure.requestBytes).toBe(bytes(payload));
			expect(failure.maxRequestBytes).toBe(16 * MIB);
			expect(failure.message).toMatch(
				/^request too large: [\d.]+ MiB > 16 MiB; start a new session or reduce attachments$/,
			);
		}
	});

	it("omits all useful images before refusing an oversized schema and leaves the source unchanged", () => {
		const data = screenshot(1);
		const payload = {
			messages: [{ role: "user", content: [anthropicImage(data)] }],
			tools: [{ input_schema: { description: "x".repeat(32 * KIB), image: anthropicImage(data) } }],
		};
		try {
			fitRequestImages(payload, model("anthropic-messages", 10 * KIB), { messages: [user(data)] });
			throw new Error("Expected local request-size refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(RequestTooLargeError);
			const failure = error as RequestTooLargeError;
			expect(failure.maxRequestBytes).toBe(10 * KIB);
			expect(failure.requestBytes).toBeLessThan(bytes(payload));
			expect(failure.requestBytes).toBeGreaterThan(32 * KIB + data.length);
			expect(failure.imagesOmitted).toBe(1);
			expect(failure.bytesSaved).toBe(bytes(payload) - failure.requestBytes);
		}
		expect(payload.messages[0].content[0].source.data).toBe(data);
	});

	it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("ignores invalid model max %s", (max) => {
		const payload = { messages: [{ role: "user", content: "unchanged" }] };
		expect(fitRequestImages(payload, model("anthropic-messages", max), { messages: [] }).payload).toBe(payload);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid budgets %s", (budget) => {
		expect(() => fitRequestImages({}, model(), { messages: [] }, budget)).toThrow(RangeError);
	});

	it.each([
		["custom-api", { messages: [] }],
		["anthropic-messages", { wrapper: { messages: [] } }],
		[
			"openai-completions",
			{ messages: [{ role: "user", content: [{ type: "image_url", image_url: "unsupported" }] }] },
		],
	] as const)("skips unsupported %s shapes without changing the request", (api, payload) => {
		const result = fitRequestImages(payload, model(api), { messages: [] }, 1);
		expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: bytes(payload) });
		expect(result.payload).toBe(payload);
		const oversized = { ...payload, metadata: "x".repeat(2 * KIB) };
		expect(() => fitRequestImages(oversized, model(api, KIB), { messages: [] }, 1)).toThrow(RequestTooLargeError);
	});

	it("reports nonserializable payloads without leaking their contents", () => {
		const payload: { secret: string; cycle?: unknown } = { secret: "never-publish-me" };
		payload.cycle = payload;
		expect(() => fitRequestImages(payload, model(), { messages: [] })).toThrow(
			"unsupported request payload shape (serialization)",
		);
		expect(() => fitRequestImages(undefined, model(), { messages: [] })).toThrow(UnsupportedRequestPayloadError);
	});
});

const payloadShapes: Array<{ api: Api; payload(data: string): unknown }> = [
	{
		api: "anthropic-messages",
		payload: (data) => ({ messages: [{ role: "user", content: [anthropicImage(data)] }] }),
	},
	{
		api: "openai-completions",
		payload: (data) => ({
			messages: [
				{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] },
			],
		}),
	},
	{
		api: "mistral-conversations",
		payload: (data) => ({
			messages: [
				{
					role: "tool",
					toolCallId: "call-1",
					content: [{ type: "image_url", imageUrl: `data:image/png;base64,${data}` }],
				},
			],
		}),
	},
	...(["openai-responses", "azure-openai-responses", "openai-codex-responses"] as const).flatMap((api) => [
		{
			api,
			payload: (data: string) => ({
				input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] }],
			}),
		},
		{
			api,
			payload: (data: string) => ({
				input: [
					{
						type: "function_call_output",
						call_id: "call-1",
						output: [
							{ type: "input_text", text: "Keep result" },
							{ type: "input_image", image_url: `data:image/png;base64,${data}` },
						],
					},
				],
			}),
		},
		{
			api,
			payload: (data: string) => ({
				input: [
					{
						type: "custom_tool_call_output",
						call_id: "call-1",
						output: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }],
					},
				],
			}),
		},
	]),
	...(["google-generative-ai", "google-vertex"] as const).map((api) => ({
		api,
		payload: (data: string) => ({
			contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data } }] }],
		}),
	})),
	{ api: "pi-messages", payload: (data) => ({ context: { messages: [user(data)] } }) },
	{
		api: "bedrock-converse-stream",
		payload: (data) => ({
			messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes: data } } }] }],
		}),
	},
	{
		api: "bedrock-converse-stream",
		payload: (data) => ({
			messages: [
				{
					role: "user",
					content: [
						{
							toolResult: {
								toolUseId: "call-1",
								content: [{ text: "Keep result" }, { image: { format: "png", source: { bytes: data } } }],
							},
						},
					],
				},
			],
		}),
	},
];

describe("explicit provider conversation paths", () => {
	it.each(["google-generative-ai", "google-vertex"] as const)(
		"preserves %s signals, functions and nonimage options by identity while trimming",
		(api) => {
			const data = screenshot(1);
			const controller = new AbortController();
			const callback = () => undefined;
			const config = {
				abortSignal: controller.signal,
				callback,
				explicitUndefined: undefined,
				options: { retained: true },
			};
			const payload = {
				config,
				contents: [
					{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data } }, { text: "Keep this" }] },
				],
			};
			const result = fitRequestImages(payload, model(api), { messages: [user(data)] }, KIB);
			const fitted = result.payload as typeof payload;
			expect(result.imagesOmitted).toBe(1);
			expect(fitted.config).toBe(config);
			expect(fitted.config.abortSignal).toBe(controller.signal);
			expect(fitted.config.callback).toBe(callback);
			expect(Object.hasOwn(fitted.config, "explicitUndefined")).toBe(true);
			expect(fitted.contents[0].parts[1]).toBe(payload.contents[0].parts[1]);
			expect(payload.contents[0].parts[0].inlineData?.data).toBe(data);
			controller.abort();
			expect(fitted.config.abortSignal.aborted).toBe(true);
		},
	);

	// smarty-dev#16938: retained native bytes must survive trimming of either native or string sources.
	it("keeps tiny Bedrock Uint8Array sources typed and untouched when another image is trimmed", () => {
		const data = screenshot(1);
		const nativeBytes = new Uint8Array([1, 2, 3]);
		const payload = {
			messages: [
				{
					role: "user",
					content: [
						{ image: { format: "png", source: { bytes: nativeBytes } } },
						{ image: { format: "png", source: { bytes: data } } },
					],
				},
			],
		};
		const result = fitRequestImages(payload, model("bedrock-converse-stream"), { messages: [] }, KIB);
		const fitted = result.payload as typeof payload;
		expect(result.imagesOmitted).toBe(1);
		expect(fitted.messages[0].content[0].image.source.bytes).toBe(nativeBytes);
		expect(fitted.messages[0].content[0].image.source.bytes).toBeInstanceOf(Uint8Array);
		expect(payload.messages[0].content[1].image.source.bytes).toBe(data);
		expect(result.requestBytes).toBe(
			bytes({
				messages: [
					{
						...fitted.messages[0],
						content: [{ image: { format: "png", source: { bytes: "AQID" } } }, fitted.messages[0].content[1]],
					},
				],
			}),
		);
	});

	// smarty-dev#16938: JSON.stringify(Uint8Array) falsely exceeded 16 MiB for a 2 MiB SDK image.
	it("admits an under-budget native Bedrock image without changing the payload", async () => {
		const nativeBytes = new Uint8Array(2 * MIB).fill(255);
		const data = Buffer.from(nativeBytes).toString("base64");
		const payload = {
			modelId: "test-model",
			messages: [
				{ role: "user" as const, content: [{ image: { format: "png" as const, source: { bytes: nativeBytes } } }] },
			],
		};
		const wire = await serializedBedrockRequest(payload);
		const expectedBytes = Buffer.byteLength(wire.body);
		expect(bytes(payload)).toBeGreaterThan(DEFAULT_MAX_REQUEST_BYTES);
		expect(expectedBytes).toBeLessThan(DEFAULT_REQUEST_IMAGE_BUDGET_BYTES);
		const result = fitRequestImages(payload, model("bedrock-converse-stream"), { messages: [user(data)] });
		expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: expectedBytes });
		expect(result.payload).toBe(payload);
		expect(payload.messages[0].content[0].image.source.bytes).toBe(nativeBytes);
	});

	// smarty-dev#16938: ConverseStream's modelId is an HTTP label, not part of the gateway's JSON body.
	it.each([-1, 1])("measures Bedrock at 16 MiB offset %d without the path modelId", async (offset) => {
		const payload = {
			modelId: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test",
			messages: [{ role: "user" as const, content: [{ text: "" }] }],
			system: [{ text: 'Keep 😀\n"\\' }],
			inferenceConfig: { maxTokens: 1024, temperature: 0.5 },
			toolConfig: {
				tools: [{ toolSpec: { name: "test", inputSchema: { json: { modelId: "schema-model" } } } }],
			},
			additionalModelRequestFields: { modelId: "nested-model" },
			requestMetadata: { modelId: "metadata-model" },
		};
		const baseline = await serializedBedrockRequest(payload);
		payload.messages[0].content[0].text = "x".repeat(
			DEFAULT_MAX_REQUEST_BYTES + offset - Buffer.byteLength(baseline.body),
		);
		const wire = await serializedBedrockRequest(payload);
		const bodyBytes = Buffer.byteLength(wire.body);
		expect(bodyBytes).toBe(DEFAULT_MAX_REQUEST_BYTES + offset);
		expect(bytes(payload)).toBeGreaterThan(DEFAULT_MAX_REQUEST_BYTES);
		expect(wire.path).toBe(`/model/${encodeURIComponent(payload.modelId)}/converse-stream`);
		expect(JSON.parse(wire.body)).not.toHaveProperty("modelId");
		expect(JSON.parse(wire.body)).toMatchObject({
			toolConfig: payload.toolConfig,
			additionalModelRequestFields: payload.additionalModelRequestFields,
			requestMetadata: payload.requestMetadata,
		});
		if (offset < 0) {
			const result = fitRequestImages(payload, model("bedrock-converse-stream"), { messages: [] });
			expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: bodyBytes });
			expect(result.payload).toBe(payload);
		} else {
			try {
				fitRequestImages(payload, model("bedrock-converse-stream"), { messages: [] });
				throw new Error("Expected local request-size refusal");
			} catch (error) {
				expect(error).toBeInstanceOf(RequestTooLargeError);
				expect(error).toMatchObject({ requestBytes: bodyBytes, imagesOmitted: 0, bytesSaved: 0 });
			}
		}
		expect(payload.modelId).toBe("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test");
	});

	// smarty-dev#16938: path overhead alone must not omit the latest user's native image below the soft target.
	it("retains a native Bedrock image below the actual soft target but trims a genuinely oversized body", async () => {
		const nativeBytes = new Uint8Array(32 * KIB).fill(255);
		const data = Buffer.from(nativeBytes).toString("base64");
		const payload = {
			modelId: "test-model",
			messages: [
				{
					role: "user" as const,
					content: [{ text: "" }, { image: { format: "png" as const, source: { bytes: nativeBytes } } }],
				},
			],
		};
		const baseline = await serializedBedrockRequest(payload);
		payload.messages[0].content[0].text = "x".repeat(
			DEFAULT_REQUEST_IMAGE_BUDGET_BYTES - 1 - Buffer.byteLength(baseline.body),
		);
		const wire = await serializedBedrockRequest(payload);
		const bodyBytes = Buffer.byteLength(wire.body);
		expect(bodyBytes).toBe(DEFAULT_REQUEST_IMAGE_BUDGET_BYTES - 1);
		// Adding the path member to this SDK body reproduces the former projection's overcount.
		expect(bodyBytes + bytes({ modelId: payload.modelId }) - 1).toBeGreaterThan(DEFAULT_REQUEST_IMAGE_BUDGET_BYTES);
		const context: Context = { messages: [user(data)] };
		const result = fitRequestImages(payload, model("bedrock-converse-stream"), context);
		expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: bodyBytes });
		expect(result.payload).toBe(payload);
		expect(payload.messages[0].content[1].image?.source.bytes).toBe(nativeBytes);

		payload.messages[0].content[0].text += "x".repeat(DEFAULT_MAX_REQUEST_BYTES - bodyBytes + 1);
		const oversized = await serializedBedrockRequest(payload);
		expect(Buffer.byteLength(oversized.body)).toBe(DEFAULT_MAX_REQUEST_BYTES + 1);
		const trimmed = fitRequestImages(payload, model("bedrock-converse-stream"), context, DEFAULT_MAX_REQUEST_BYTES);
		const fitted = trimmed.payload as typeof payload;
		const fittedWire = await serializedBedrockRequest(fitted);
		expect(trimmed.imagesOmitted).toBe(1);
		expect(trimmed.requestBytes).toBe(Buffer.byteLength(fittedWire.body));
		expect(trimmed.requestBytes).toBeLessThan(DEFAULT_MAX_REQUEST_BYTES);
		expect(trimmed.bytesSaved).toBe(Buffer.byteLength(oversized.body) - trimmed.requestBytes);
		expect(fitted.modelId).toBe(payload.modelId);
		expect(fitted.messages[0].content[0]).toBe(payload.messages[0].content[0]);
		expect(payload.messages[0].content[1].image?.source.bytes).toBe(nativeBytes);
		expect(context.messages[0]).toEqual(user(data));
	});

	// smarty-dev#16938: real SDK history is bytes, but transcript ordering and labels are base64-based.
	it("trims old native Bedrock history in transcript order and retains the newest native user image", () => {
		const nativeBytes = Array.from({ length: 5 }, (_, index) => new Uint8Array(2 * MIB).fill(index + 1));
		const data = nativeBytes.map((value) => Buffer.from(value).toString("base64"));
		const context: Context = {
			messages: [...data.slice(0, 4).map((value, index) => tool(value, `call-${index}`)), user(data[4])],
		};
		const controller = new AbortController();
		const options = { signal: controller.signal, callback: () => undefined, explicitUndefined: undefined };
		const schema = { json: { type: "object", properties: {} } };
		const documentBytes = new Uint8Array([7, 8, 9]);
		const redactedBytes = new Uint8Array([10, 11, 12]);
		const untouched = { text: "Keep result" };
		const makeResult = (index: number) => ({
			toolResult: {
				toolUseId: `wire-call-${index}`,
				content: [untouched, { image: { format: "png", source: { bytes: nativeBytes[index] } } }] as const,
				status: "success",
			},
		});
		const payload = {
			modelId: "test-model",
			options,
			toolConfig: { tools: [{ toolSpec: { name: "screenshot", inputSchema: schema } }] },
			messages: [
				{ role: "assistant", content: [{ reasoningContent: { redactedContent: redactedBytes } }] },
				// Reorder distinct tool images: transcript order, not wire order, must decide the omission.
				{ role: "user", content: [makeResult(1), makeResult(0), makeResult(2), makeResult(3)] },
				{
					role: "user",
					content: [
						{ image: { format: "png", source: { bytes: nativeBytes[4] } } },
						{ document: { format: "pdf", name: "Keep document", source: { bytes: documentBytes } } },
					],
				},
			] as const,
		};
		const wireBytes = (value: typeof payload) =>
			new TextEncoder().encode(
				JSON.stringify({ ...value, modelId: undefined }, (_key, entry: unknown) =>
					entry instanceof Uint8Array ? Buffer.from(entry).toString("base64") : entry,
				),
			).length;
		expect(wireBytes(payload)).toBeGreaterThan(DEFAULT_REQUEST_IMAGE_BUDGET_BYTES);
		const result = fitRequestImages(payload, model("bedrock-converse-stream"), context);
		const fitted = result.payload as typeof payload;
		expect(result.imagesOmitted).toBe(1);
		expect(fitted.messages[1].content[1]).toEqual({
			toolResult: {
				toolUseId: "wire-call-0",
				content: [untouched, { text: "[image omitted to fit request size: call-0, 2731 KB]" }],
				status: "success",
			},
		});
		expect(result.requestBytes).toBe(wireBytes(fitted));
		expect(result.requestBytes).toBeLessThanOrEqual(DEFAULT_REQUEST_IMAGE_BUDGET_BYTES);
		expect(result.bytesSaved).toBe(wireBytes(payload) - result.requestBytes);
		expect(fitted.options).toBe(options);
		expect(fitted.toolConfig).toBe(payload.toolConfig);
		expect(fitted.messages[0].content[0]).toBe(payload.messages[0].content[0]);
		expect(fitted.messages[2].content[1]).toBe(payload.messages[2].content[1]);
		for (const [wireIndex, originalIndex] of [1, 0, 2, 3].entries()) {
			const original = payload.messages[1].content[wireIndex].toolResult!;
			expect(original.content[1].image?.source.bytes).toBe(nativeBytes[originalIndex]);
			if (originalIndex === 0) continue;
			const retained = fitted.messages[1].content[wireIndex].toolResult!;
			expect(retained.content[0]).toBe(untouched);
			expect(retained.content[1]).toBe(original.content[1]);
		}
		expect(fitted.messages[2].content[0].image?.source.bytes).toBe(nativeBytes[4]);
		expect(Object.hasOwn(fitted.options, "explicitUndefined")).toBe(true);
		controller.abort();
		expect(fitted.options.signal.aborted).toBe(true);
	});

	// smarty-dev#16938: nonimage SDK blobs must not trigger false refusals or become omission candidates.
	it("measures native Bedrock documents and redacted reasoning as base64 without altering them", () => {
		const nativeBytes = new Uint8Array(2 * MIB).fill(255);
		const data = Buffer.from(nativeBytes).toString("base64");
		const build = (bytes: Uint8Array | string) => ({
			messages: [
				{ role: "assistant", content: [{ reasoningContent: { redactedContent: bytes } }] },
				{ role: "user", content: [{ document: { format: "pdf", name: "Keep", source: { bytes } } }] },
				{
					role: "user",
					content: [{ toolResult: { toolUseId: "doc", content: [{ document: { source: { bytes } } }] } }],
				},
			],
		});
		const payload = build(nativeBytes);
		const result = fitRequestImages(payload, model("bedrock-converse-stream"), { messages: [] }, KIB);
		expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: bytes(build(data)) });
		expect(result.payload).toBe(payload);
	});

	// smarty-dev#16938: only modeled binary paths may change measurement, never schemas or tool JSON.
	it("does not reinterpret arbitrary Bedrock typed arrays as modeled binary fields", () => {
		const nativeBytes = new Uint8Array([1, 2, 3]);
		const planted = { modelId: "nested-model", image: { source: { bytes: nativeBytes } } };
		const payload = {
			modelId: "path-model",
			messages: [
				{ role: "assistant", content: [{ toolUse: { input: planted } }] },
				{ role: "user", content: [{ toolResult: { toolUseId: "x", content: [{ json: planted }] } }] },
			] as const,
			toolConfig: { tools: [{ toolSpec: { inputSchema: { json: planted } } }] },
			metadata: planted,
		};
		const result = fitRequestImages(payload, model("bedrock-converse-stream"), { messages: [] }, 1);
		expect(result).toEqual({
			payload,
			imagesOmitted: 0,
			bytesSaved: 0,
			requestBytes: bytes({ ...payload, modelId: undefined }),
		});
		expect(result.payload).toBe(payload);
		expect(payload.modelId).toBe("path-model");
		expect(payload.messages[0].content[0].toolUse?.input).toBe(planted);
		expect(payload.messages[1].content[0].toolResult?.content[0].json).toBe(planted);
	});

	it.each([
		"anthropic-messages",
		"openai-completions",
		"mistral-conversations",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"google-generative-ai",
		"google-vertex",
		"pi-messages",
		"custom-api",
	] as const)("keeps counting top-level and nested modelId for %s", (api) => {
		const payload = { modelId: "body-model".repeat(200), metadata: { modelId: "nested-model" }, messages: [] };
		const result = fitRequestImages(payload, model(api), { messages: [] }, 1);
		expect(result).toEqual({ payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: bytes(payload) });
		expect(result.payload).toBe(payload);
		expect(() => fitRequestImages(payload, model(api, bytes(payload) - 1), { messages: [] })).toThrow(
			RequestTooLargeError,
		);
	});

	it.each(payloadShapes)("fits $api image blocks", ({ api, payload: build }) => {
		const data = screenshot(1);
		const payload = build(data);
		const result = fitRequestImages(payload, model(api), normalizeContext({ messages: [tool(data, "call-1")] }), KIB);
		expect(result.imagesOmitted).toBe(1);
		expect(result.requestBytes).toBe(bytes(result.payload));
		expect(result.requestBytes).toBeLessThanOrEqual(KIB);
		expect(result.bytesSaved).toBe(bytes(payload) - result.requestBytes);
		expect(JSON.stringify(result.payload)).toContain("[image omitted to fit request size: call-1, 64 KB]");
		expect(JSON.stringify(result.payload)).not.toContain(data);
		expect(JSON.stringify(payload)).toContain(data);
	});

	it("places Gemini function-response notices in the outer parts without touching response JSON", () => {
		const data = screenshot(1);
		const payload = {
			contents: [
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								name: "screenshot",
								id: "call-1",
								response: { output: "Keep result", arbitrary: { inlineData: { mimeType: "image/png", data } } },
								parts: [
									{ inlineData: { mimeType: "image/png", data } },
									{ inlineData: { mimeType: "image/png", data } },
								],
							},
						},
					],
				},
			],
		};
		const result = fitRequestImages(
			payload,
			model("google-generative-ai"),
			{ messages: [tool(data, "call-1")] },
			70 * KIB,
		);
		expect(result.imagesOmitted).toBe(2);
		expect(result.requestBytes).toBe(bytes(result.payload));
		expect(result.bytesSaved).toBe(bytes(payload) - result.requestBytes);
		expect(result.payload).toEqual({
			contents: [
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								name: "screenshot",
								id: "call-1",
								response: payload.contents[0].parts[0].functionResponse.response,
							},
						},
						{ text: "[image omitted to fit request size: call-1, 64 KB]" },
						{ text: "[image omitted to fit request size: call-1, 64 KB]" },
					],
				},
			],
		});
	});

	it("preserves Anthropic cache directives and treats URL sources as images", () => {
		const payload = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "url", url: `https://example.invalid/${"x".repeat(2000)}` },
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};
		const result = fitRequestImages(payload, model(), { messages: [] }, KIB);
		expect(result.imagesOmitted).toBe(1);
		expect((result.payload as typeof payload).messages[0].content[0]).toMatchObject({
			type: "text",
			cache_control: { type: "ephemeral" },
		});
	});

	it("leaves Google nonimage media and function arguments untouched", () => {
		const data = screenshot(1);
		const payload = {
			contents: [
				{
					role: "user",
					parts: [
						{ inlineData: { mimeType: "audio/wav", data } },
						{ functionCall: { args: { inlineData: { mimeType: "image/png", data } } } },
					],
				},
			],
		};
		const result = fitRequestImages(payload, model("google-generative-ai"), { messages: [] }, KIB);
		expect(result.payload).toBe(payload);
		expect(result.imagesOmitted).toBe(0);
	});
});

describe("owned failure and diagnostic publication", () => {
	it("preserves actionable local size errors and never retries or treats them as token overflow", () => {
		const error = new RequestTooLargeError(500 * MIB);
		const expected = error.message;
		error.message = "do not publish this mutable provider-like error text";
		Object.assign(error, { status: 503, body: "private provider body" });
		const normalized = normalizeProviderError(error, "test", "context length exceeded");
		expect(formatProviderError(normalized)).toBe(expected);
		expect(normalized.recovery).toEqual({ retryable: false });
		expect(normalized.status).toBeUndefined();
		expect(classifyProviderFailure({ text: expected })).toEqual({ retryable: false });
	});

	it("keeps only bounded, owned omission counts and local timestamps through repeated projections", () => {
		const diagnostic = createRequestImagesOmittedDiagnostic(12, 8 * MIB);
		Object.assign(diagnostic, { details: { credential: "private" }, error: "private" });
		const first = projectAssistantMessageDiagnostics([diagnostic]);
		expect(first).toEqual([
			{ type: "request_images_omitted", timestamp: diagnostic.timestamp, imagesOmitted: 12, bytesSaved: 8 * MIB },
		]);
		expect(projectAssistantMessageDiagnostics(first)).toEqual(first);
		const oversized = createRequestImagesOmittedDiagnostic(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
		expect(projectAssistantMessageDiagnostics([oversized])?.[0]).toMatchObject({
			imagesOmitted: 100_000,
			bytesSaved: 1024 * MIB,
		});
	});

	it("drops forged omission values, including extra numeric fields on other diagnostic types", () => {
		const before = Date.now();
		const forged = {
			type: "request_images_omitted",
			timestamp: 42,
			imagesOmitted: 1234,
			bytesSaved: 5678,
			details: { private: true },
		};
		const other = createAssistantMessageDiagnostic("provider_limit");
		Object.assign(other, { imagesOmitted: 1234, bytesSaved: 5678 });
		const result = projectAssistantMessageDiagnostics([forged, other]);
		expect(result).toEqual([
			{ type: "request_images_omitted", timestamp: expect.any(Number) },
			{ type: "provider_limit", timestamp: other.timestamp },
		]);
		expect(result?.[0].timestamp).toBeGreaterThanOrEqual(before);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])("drops invalid owned omission counts %s", (value) => {
		const diagnostic = createRequestImagesOmittedDiagnostic(value, value);
		expect(projectAssistantMessageDiagnostics([diagnostic])).toEqual([
			{ type: "request_images_omitted", timestamp: diagnostic.timestamp },
		]);
	});
});
