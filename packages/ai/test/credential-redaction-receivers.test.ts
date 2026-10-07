// pi#150 redaction port: the pi#131 round-4 credential P1s (R4-1 Models half, R4-2, R4-3, R4-5) on v1.0.4.
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { classify as classifyLlamaCpp } from "../src/api/llama-cpp-classify.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { generateImages as generateOpenRouterImages } from "../src/api/openrouter-images.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { redactOAuthDiagnostic } from "../src/auth/oauth/credential-response.ts";
import { writePrivateAuthFile } from "../src/cli-auth.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { AssistantMessage, AssistantMessageEvent, ClassifierModel, ImageModel, Model } from "../src/types.ts";
import { AssistantMessageEventStream, protectAssistantMessageStream } from "../src/utils/event-stream.ts";

const KEY = "sk-live-PI150-REFLECTED-KEY-0123456789";
const OPAQUE = 'opaque"PI150\\HEADER-SECRET';
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

function encodings(secret: string): string[] {
	const json = JSON.stringify(secret).slice(1, -1);
	return [
		secret,
		json,
		encodeURIComponent(secret),
		encodeURIComponent(json),
		JSON.stringify(encodeURIComponent(json)),
	];
}

function expectNoKey(value: unknown, secrets: readonly string[] = [KEY]): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	for (const secret of secrets) for (const form of encodings(secret)) expect(text).not.toContain(form);
}

function echoResponse(status = 401): Response {
	return new Response(JSON.stringify({ error: { message: `invalid key ${KEY}`, code: KEY } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function collect(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(JSON.parse(JSON.stringify(event)) as AssistantMessageEvent);
	return { events, result: await stream.result() };
}

describe("R4-3: bounded serializer composition", () => {
	it.each([
		["URI(JSON(secret))", (s: string) => encodeURIComponent(JSON.stringify(s).slice(1, -1))],
		["JSON(URI(JSON(secret)))", (s: string) => JSON.stringify(encodeURIComponent(JSON.stringify(s).slice(1, -1)))],
		["URI(JSON(JSON(secret)))", (s: string) => encodeURIComponent(JSON.stringify(JSON.stringify(s)))],
		["lowercase percent hex", (s: string) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
		["form encoding", (s: string) => new URLSearchParams({ v: `Bearer ${s}` }).toString().slice(2)],
		["base64url", (s: string) => Buffer.from(s).toString("base64url")],
	])("masks %s of an opaque header value", (_name, encode) => {
		const text = `upstream rejected ?q=${encode(OPAQUE)}&x=1`;
		const masked = redactOAuthDiagnostic(text, [OPAQUE, `Bearer ${OPAQUE}`]);
		expectNoKey(masked, [OPAQUE]);
		expect(masked).toContain("upstream rejected");
	});

	it("withholds a field that exceeds the decode budget", () => {
		let text = OPAQUE;
		for (let i = 0; i < 20; i++) text = encodeURIComponent(JSON.stringify(text));
		expect(redactOAuthDiagnostic(text, [OPAQUE])).toBe("***");
	});

	it("keeps an unrelated diagnostic byte for byte", () => {
		const text = 'HTTP 500 {"detail":"a\\\\b %41 \\u0041"}';
		expect(redactOAuthDiagnostic(text, [OPAQUE])).toBe(text);
	});
});

describe("R4-2: every event and result of a protected stream", () => {
	it("masks partial events, technical metadata, the terminal event and end(result)", async () => {
		const stream = new AssistantMessageEventStream([KEY]);
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "openai-completions",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		} as AssistantMessage;
		partial.errorMessage = `unknown finish reason ${KEY}`;
		partial.rawStopReason = KEY;
		stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
		partial.diagnostics = [
			{ type: "t", timestamp: 1, details: { reason: `${KEY}`, nested: [encodeURIComponent(KEY)] } },
		];
		stream.push({ type: "done", reason: "stop", message: partial });
		const { events, result } = await collect(stream);
		expect(events).toHaveLength(2);
		expectNoKey({ events, result });

		const ended = new AssistantMessageEventStream();
		protectAssistantMessageStream(ended, [KEY]);
		ended.end({ ...partial, errorMessage: `late ${KEY}` });
		expectNoKey(await ended.result());
	});

	it("leaves a stream without live secrets untouched", async () => {
		const stream = new AssistantMessageEventStream();
		const message = { errorMessage: `authorization header ${KEY}` } as AssistantMessage;
		stream.push({ type: "error", reason: "error", error: message });
		expect((await stream.result()).errorMessage).toBe(`authorization header ${KEY}`);
	});
});

describe("R4-2: provider receivers with a reflected key", () => {
	it("Mistral HTTP error body", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const { events, result } = await collect(
			streamMistral(model, context, { apiKey: KEY, maxRetries: 0, fetch: async () => echoResponse() }),
		);
		expect(result.stopReason).toBe("error");
		expectNoKey({ events, result });
	});

	it("pi-messages HTTP error body", async () => {
		const model = {
			...getModel("openai", "gpt-4o-mini"),
			api: "pi-messages",
			provider: "pi",
			baseUrl: "https://pi.invalid",
		} as unknown as Model<"pi-messages">;
		const { events, result } = await collect(
			streamPiMessages(model, context, { apiKey: KEY, maxRetries: 0, fetch: async () => echoResponse(500) }),
		);
		expect(result.stopReason).toBe("error");
		expectNoKey({ events, result });
	});

	it("Azure OpenAI Responses error", async () => {
		const model = {
			...getModel("openai", "gpt-4o-mini"),
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com/openai/v1",
		} as unknown as Model<"azure-openai-responses">;
		const { events, result } = await collect(
			streamAzure(model, context, { apiKey: KEY, maxRetries: 0, fetch: async () => echoResponse() }),
		);
		expect(result.stopReason).toBe("error");
		expectNoKey({ events, result });
	});

	it("OpenAI Completions unknown finish reason in the first partial event", async () => {
		const model = getModel("openai", "gpt-4o-mini") as unknown as Model<"openai-completions">;
		const chunk = {
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: "gpt-4o-mini",
			choices: [{ index: 0, delta: { content: "hello" }, finish_reason: `reflected ${KEY}` }],
		};
		const fetch = async () =>
			new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		const { events, result } = await collect(
			streamOpenAICompletions({ ...model, api: "openai-completions" }, context, { apiKey: KEY, fetch }),
		);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		expectNoKey({ events, result });
	});

	it("Anthropic successful input-transformation diagnostics", async () => {
		const sse = [
			[
				"message_start",
				{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
			],
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
			["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			[
				"message_delta",
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { input_tokens: 1, output_tokens: 1 },
					input_transformations: [{ type: KEY, path: `messages.${KEY}`, reason: encodeURIComponent(KEY) }],
				},
			],
			["message_stop", { type: "message_stop" }],
		]
			.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
			.join("\n");
		const client = {
			beta: {
				messages: {
					create: () => ({
						asResponse: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
					}),
				},
			},
		} as unknown as Anthropic;
		const { events, result } = await collect(
			streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, { apiKey: KEY, client }),
		);
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics).toHaveLength(1);
		expectNoKey({ events, result });
	});

	it("OpenRouter image generation error result", async () => {
		const model = {
			id: "img",
			name: "img",
			type: "image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.invalid/api/v1",
			input: ["text"],
			output: ["image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as unknown as ImageModel<"openrouter-images">;
		let calls = 0;
		const result = await generateOpenRouterImages(
			model,
			{ input: [{ type: "text", text: "x" }] },
			{
				apiKey: KEY,
				maxRetries: 0,
				fetch: async () => {
					calls++;
					return echoResponse();
				},
			},
		);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expectNoKey(result);
	});

	it("llama.cpp classifier error result", async () => {
		const model = {
			id: "cls",
			name: "cls",
			type: "classifier",
			api: "llama-cpp-classify",
			provider: "llama",
			baseUrl: "http://127.0.0.1:1",
		} as unknown as ClassifierModel<"llama-cpp-classify">;
		let calls = 0;
		const result = await classifyLlamaCpp(
			model,
			{
				state: { text: "x" },
				questions: { q: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } },
			},
			{
				apiKey: KEY,
				maxRetries: 0,
				fetch: async () => {
					calls++;
					return echoResponse(500);
				},
			},
		);
		expect(calls).toBeGreaterThan(0);
		expect(result.stopReason).toBe("error");
		expectNoKey(result);
	});
});

describe("R4-1: Models non-chat and cancellation boundaries", () => {
	function setup(reject: (headers: Record<string, string | null>) => never) {
		type Options = { headers?: Record<string, string | null> };
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const fake = createProvider({
			id: "pi150",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [
				{
					type: "image",
					id: "img",
					name: "img",
					api: "pi150-images",
					provider: "pi150",
					baseUrl: "https://x.invalid",
					input: ["text"],
					output: ["image"],
					cost,
				},
				{
					type: "classifier",
					id: "cls",
					name: "cls",
					api: "pi150-classify",
					provider: "pi150",
					baseUrl: "https://x.invalid",
				},
				{
					id: "chat",
					name: "chat",
					api: "pi150-chat",
					provider: "pi150",
					baseUrl: "https://x.invalid",
					reasoning: false,
					input: ["text"],
					cost,
					contextWindow: 1,
					maxTokens: 1,
				},
			],
			api: {
				// A provider's own synchronous setup error that echoes the request key.
				stream: () => {
					throw new Error(`bad provider config for ${KEY}`);
				},
				streamSimple: () => new AssistantMessageEventStream(),
				cancelDeferred: async (_m: unknown, _h: unknown, options: Options) => reject(options.headers ?? {}),
			},
			images: {
				"pi150-images": {
					generateImages: async (_m: unknown, _c: unknown, options: Options) => reject(options.headers ?? {}),
				},
			},
			classifiers: {
				"pi150-classify": {
					classify: async (_m: unknown, _c: unknown, options: Options) => reject(options.headers ?? {}),
				},
			},
		} as never) as ReturnType<typeof createProvider>;
		const models = createModels({
			credentials: new InMemoryCredentialStore(),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(fake);
		const all = fake.getAllModels?.() ?? [];
		const find = (id: string) => all.find((model) => model.id === id) as never;
		return { models, image: find("img"), classifier: find("cls"), chat: find("chat") };
	}
	const options = { apiKey: KEY, headers: { authorization: `Bearer ${OPAQUE}` } };

	it("masks provider rejections after preparation", async () => {
		let calls = 0;
		const { models, image, classifier, chat } = setup((headers) => {
			calls++;
			throw new Error(`echo ${JSON.stringify(headers)} ${KEY}`);
		});
		expectNoKey(await models.generateImages(image, { prompt: "x" } as never, options), [KEY, OPAQUE]);
		expectNoKey(await models.classify(classifier, { questions: {} } as never, options), [KEY, OPAQUE]);
		const rejection = await models
			.cancelDeferred(chat, { id: "h" } as never, options)
			.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).cause).toBeUndefined();
		expectNoKey({ message: (rejection as Error).message, stack: (rejection as Error).stack }, [KEY, OPAQUE]);
		expect(calls).toBe(3);
	});

	it("keeps a provider setup error's text but masks the request key", async () => {
		const { models, chat } = setup(() => {
			throw new Error("not reached");
		});
		const result = await models.complete(chat, { messages: [] }, options);
		expect(result.errorMessage).toContain("bad provider config");
		expectNoKey(result, [KEY, OPAQUE]);
	});

	it("makes header-transform failures value-free", async () => {
		const { models, image, classifier, chat } = setup(() => {
			throw new Error("not reached");
		});
		const transformHeaders = (headers: Record<string, string | null>) => {
			throw new Error(`transform saw ${JSON.stringify(headers)}`);
		};
		const failing = { ...options, transformHeaders };
		const images = await models.generateImages(image, { prompt: "x" } as never, failing);
		expect(images.errorMessage).toBe("request setup failed: Error");
		expectNoKey(await models.classify(classifier, { questions: {} } as never, failing), [KEY, OPAQUE]);
		const rejection = await models
			.cancelDeferred(chat, { id: "h" } as never, failing)
			.catch((error: unknown) => error);
		expect((rejection as Error).message).toBe("request setup failed: Error");
	});
});

describe("R4-5: pi-ai login grant file", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it.skipIf(process.platform === "win32")("creates 0600 under umask 022 and replaces unsafe files and links", () => {
		dir = mkdtempSync(join(tmpdir(), "pi150-auth-"));
		const target = join(dir, "auth.json");
		const previous = process.umask(0o022);
		try {
			writePrivateAuthFile(target, '{"fake":"grant"}');
			expect(lstatSync(target).mode & 0o777).toBe(0o600);

			writeFileSync(target, "old", { mode: 0o644 });
			writePrivateAuthFile(target, '{"fake":"grant2"}');
			expect(lstatSync(target).mode & 0o777).toBe(0o600);

			const victim = join(dir, "victim");
			writeFileSync(victim, "untouched", { mode: 0o644 });
			rmSync(target);
			symlinkSync(victim, target);
			writePrivateAuthFile(target, '{"fake":"grant3"}');
			expect(lstatSync(target).isSymbolicLink()).toBe(false);
			expect(lstatSync(target).mode & 0o777).toBe(0o600);
			expect(readFileSync(victim, "utf-8")).toBe("untouched");
		} finally {
			process.umask(previous);
		}
	});
});
