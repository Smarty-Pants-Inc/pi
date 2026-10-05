import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type ClassifierModel,
	type ImageModel,
	InMemoryCredentialStore,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as azureStream } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { stream as mistralStream } from "@earendil-works/pi-ai/api/mistral-conversations";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const secret = "SYNTHETIC_RUNTIME_R141_CREDENTIAL";
async function runtime() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: secret,
		refresh: "SYNTHETIC_RUNTIME_REFRESH",
		expires: Date.now() + 3600000,
	}));
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

function journal(message: AssistantMessage): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-r141-journal-"));
	const session = SessionManager.create(directory, directory);
	session.appendMessage({ role: "user", content: "synthetic request", timestamp: 0 });
	const id = session.appendMessage(message);
	expect(session.getEntry(id)?.type).toBe("message");
	const file = session.getSessionFile();
	if (!file) throw new Error("Missing test journal");
	const jsonl = readFileSync(file, "utf8");
	expect(jsonl).toContain('"type":"message"');
	return jsonl;
}

// pi#141 / smarty-dev#4703: non-ordinary SDK callers cannot disable stored OAuth policy.
it.each([undefined, false, true])("derives OAuth diagnostics after option spreading (%s)", async (oauthDiagnostics) => {
	const models = await runtime();
	const model = models.getModels("radius")[0];
	const output = await models.complete(
		model,
		{ messages: [] },
		{
			oauthDiagnostics,
			fetch: async () =>
				Response.json({ error: { message: `receipt=${secret}; UNTRUSTED_RUNTIME_DIAGNOSTIC` } }, { status: 403 }),
		},
	);
	expect(output.stopReason).toBe("error");
	expect(JSON.stringify(output)).not.toContain(secret);
	expect(JSON.stringify(output)).not.toContain("UNTRUSTED_RUNTIME_DIAGNOSTIC");
	const jsonl = journal(output);
	expect(jsonl).not.toContain(secret);
	expect(jsonl).not.toContain("UNTRUSTED_RUNTIME_DIAGNOSTIC");
});

// pi#141: production JSONL persistence, not a simulated session serializer.
it.each([
	["Q7Z9V2B4 ", "Q7Z9V2B4"],
	["Q7 Z9", "Q7+%5a9"],
	["Q7.EXAMPLE.", "q7.example"],
	["éQ7.example", "xn--q7-9ia.example"],
])("persists no generated or canonical alias for %s", async (key, alias) => {
	const models = await runtime();
	const model = { ...models.getModels("openai")[0], api: "openai-completions" as const, compat: undefined };
	let wire: Headers | undefined;
	const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		wire = new Headers(init?.headers);
		return Response.json({ error: { message: `receipt=https://echo.invalid/?v=${alias}` } }, { status: 400 });
	});
	const events: unknown[] = [];
	const eventStream = models.stream(
		model,
		{ messages: [] },
		{
			apiKey: key,
			env: {},
			maxRetries: 0,
			fetch,
		},
	);
	for await (const event of eventStream) events.push(event);
	const output = await eventStream.result();
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(wire?.get("authorization")).toBe(new Headers({ authorization: `Bearer ${key}` }).get("authorization"));
	expect(output.stopReason).toBe("error");
	const jsonl = journal(output);
	expect(JSON.stringify({ events, jsonl })).not.toContain(alias);
});

// pi#141: direct active-provider diagnostics also use the real JSONL writer.
it.each(["azure", "mistral", "anthropic"] as const)(
	"persists no credential-bearing %s diagnostics",
	async (provider) => {
		const models = await runtime();
		const base = models.getModels("radius")[0];
		const options = {
			apiKey: secret,
			maxRetries: 0,
			fetch: async () =>
				provider === "anthropic"
					? new Response(
							[
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
									input_transformations: [{ type: "thinking_dropped", path: secret, reason: "synthetic" }],
								},
								{ type: "message_stop" },
							]
								.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
								.join(""),
							{ headers: { "content-type": "text/event-stream" } },
						)
					: Response.json({ error: { message: `receipt=${secret}` } }, { status: 403 }),
		};
		const context = normalizeContext({ messages: [] });
		const eventStream =
			provider === "azure"
				? azureStream({ ...base, api: "azure-openai-responses", compat: undefined }, context, options)
				: provider === "mistral"
					? mistralStream({ ...base, api: "mistral-conversations", compat: undefined }, context, options)
					: anthropicStream({ ...base, api: "anthropic-messages", compat: undefined }, context, options);
		const events: unknown[] = [];
		for await (const event of eventStream) events.push(event);
		const output = await eventStream.result();
		expect(output.stopReason).toBe(provider === "anthropic" ? "stop" : "error");
		expect(JSON.stringify({ events, jsonl: journal(output) })).not.toContain(secret);
	},
);

// pi#141: all exported inference and deferred operations use the same value-free preparation boundary.
describe("direct ModelRuntime preparation", () => {
	it.each([
		"stream",
		"complete",
		"streamSimple",
		"completeSimple",
		"streamDeferred",
		"fetchDeferred",
		"cancelDeferred",
		"generateImages",
		"classify",
	] as const)("contains transformHeaders failures in %s", async (method) => {
		const models = await runtime();
		const model: Model<"pi-messages"> = { ...models.getModels("radius")[0], api: "pi-messages", compat: undefined };
		const options = {
			headers: { Authorization: `Bearer ${secret}` },
			transformHeaders: async (headers: Record<string, string | null>) => {
				throw new Error(JSON.stringify(headers), { cause: new Error(secret) });
			},
		};
		const handle = { id: "synthetic", provider: model.provider, modelId: model.id, api: model.api };
		let outcome: unknown;
		if (method === "generateImages")
			outcome = await models.generateImages(
				{ ...model, type: "image", api: "openrouter-images", output: ["image"] } as ImageModel<"openrouter-images">,
				{ input: [{ type: "text", text: "synthetic" }] },
				options,
			);
		else if (method === "classify")
			outcome = await models.classify(
				{ ...model, type: "classifier", api: "llama-cpp-classify" } as ClassifierModel<"llama-cpp-classify">,
				{ state: {}, questions: {} },
				options,
			);
		else if (method === "cancelDeferred")
			outcome = await models.cancelDeferred(model, handle, options).catch((error: unknown) => error);
		else if (method === "streamDeferred") outcome = await models.streamDeferred(model, handle, options).result();
		else if (method === "fetchDeferred") outcome = await models.fetchDeferred(model, handle, options);
		else if (method === "stream" || method === "streamSimple")
			outcome = await models[method](model, { messages: [] }, options).result();
		else outcome = await models[method](model, { messages: [] }, options);
		if (outcome instanceof Error) {
			expect(outcome.cause).toBeUndefined();
			expect(outcome.message).not.toContain(secret);
			expect(outcome.stack).not.toContain(secret);
		} else expect(JSON.stringify(outcome)).not.toContain(secret);
	});
});
