import { readFileSync } from "node:fs";
import { type AssistantMessage, InMemoryCredentialStore, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as azureStream } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { stream as vertexStream } from "@earendil-works/pi-ai/api/google-vertex";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { generateImages } from "@earendil-works/pi-ai/api/openrouter-images";
import { normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isRetryableAssistantError, throttledLimitWait } from "@earendil-works/pi-ai/utils/retry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdkDiagnosticLoggerOff } from "../../ai/src/auth/oauth/credential-response.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const state = vi.hoisted(() => ({ constructors: [] as Record<string, unknown>[] }));
const canary = "SYNTHETIC_AMBIENT_DIAGNOSTIC_5822";
vi.mock("@google/genai", () => ({
	ResourceScope: { COLLECTION: "COLLECTION" },
	Type: {},
	ThinkingLevel: {
		THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
		MINIMAL: "MINIMAL",
		LOW: "LOW",
		MEDIUM: "MEDIUM",
		HIGH: "HIGH",
	},
	FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
	GoogleGenAI: class {
		constructor(options: Record<string, unknown>) {
			state.constructors.push(options);
		}
		models = {
			generateContentStream: async () => {
				throw Object.assign(new Error("SYNTHETIC_AMBIENT_DIAGNOSTIC_5822"), { status: 503 });
			},
		};
	},
}));
vi.mock("../../../node_modules/@anthropic-ai/sdk/index.mjs", () => ({
	default: class {
		opts: Record<string, unknown>;
		constructor(options: Record<string, unknown>) {
			this.opts = options;
			state.constructors.push(options);
		}
		withOptions(options: Record<string, unknown>) {
			return new (this.constructor as new (options: Record<string, unknown>) => this)({ ...this.opts, ...options });
		}
		beta = {
			messages: {
				create: () => ({
					asResponse: async () => {
						throw Object.assign(new Error("SYNTHETIC_AMBIENT_DIAGNOSTIC_5822"), { status: 503 });
					},
				}),
			},
		};
	},
}));

const federationEnv = {
	ANTHROPIC_FEDERATION_RULE_ID: "synthetic-rule",
	ANTHROPIC_ORGANIZATION_ID: "synthetic-org",
	ANTHROPIC_IDENTITY_TOKEN_FILE: "/synthetic/never-read.jwt",
};
const vertexEnv = {
	GOOGLE_CLOUD_PROJECT: "synthetic-project",
	GOOGLE_CLOUD_LOCATION: "synthetic-location",
	GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/never-read.json",
};
const context = normalizeContext({ messages: [] });
function model<
	A extends
		| "anthropic-messages"
		| "google-vertex"
		| "openai-responses"
		| "openai-completions"
		| "azure-openai-responses",
>(api: A): Model<A> {
	return {
		id: "synthetic",
		name: "Synthetic",
		provider: api === "anthropic-messages" ? "anthropic" : api === "google-vertex" ? "google-vertex" : "openai",
		api,
		baseUrl: "https://mock.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 4096,
		maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
afterEach(() => {
	state.constructors.length = 0;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// smarty-dev#5822 T-R2-04: SDK-owned ambient auth is never an opt-out from owned publication.
describe.each([undefined, false, true])("ambient publication policy=%s", (oauthDiagnostics) => {
	it.each(["ADC", "federation"] as const)("projects direct %s failures without seeing a credential", async (kind) => {
		const stream =
			kind === "ADC"
				? vertexStream(model("google-vertex"), context, { env: vertexEnv, oauthDiagnostics, maxRetries: 0 })
				: anthropicStream(model("anthropic-messages"), context, {
						env: federationEnv,
						oauthDiagnostics,
						maxRetries: 0,
					});
		const events: unknown[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		expect(state.constructors.length, result.errorMessage).toBeGreaterThan(0);
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify({ events, result, sessionRow: { type: "message", message: result } })).not.toContain(
			canary,
		);
		expect(result.oauthRecovery?.retryable).toBe(true);
		if (kind === "ADC")
			expect(state.constructors[0].googleAuthOptions).toEqual({
				keyFilename: vertexEnv.GOOGLE_APPLICATION_CREDENTIALS,
			});
		else {
			expect(state.constructors[0].config).toMatchObject({ authentication: { type: "oidc_federation" } });
			expect(state.constructors[0].logger).toBeDefined();
			expect(state.constructors[0].logLevel).toBe("off");
		}
	});
	it.each(["ADC", "federation"] as const)("projects SDK-owned ModelRuntime %s failures", async (kind) => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const stream =
			kind === "ADC"
				? runtime.stream(
						model("google-vertex"),
						{ messages: [] },
						{ env: vertexEnv, apiKey: "gcp-vertex-credentials", oauthDiagnostics, maxRetries: 0 },
					)
				: runtime.stream(
						model("anthropic-messages"),
						{ messages: [] },
						{ env: federationEnv, oauthDiagnostics, maxRetries: 0 },
					);
		const events: unknown[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		expect(state.constructors.length, result.errorMessage).toBeGreaterThan(0);
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify({ events, result })).not.toContain(canary);
		expect(result.oauthRecovery?.retryable).toBe(true);
	});
});

// smarty-dev#5822: OPENAI_LOG/ANTHROPIC_LOG cannot enable request logging for any credential source.
it.each([
	"responses",
	"completions",
	"azure",
	"anthropic-key",
	"anthropic-header",
	"anthropic-oauth",
	"federation",
] as const)("fixes SDK logger/off for %s", async (adapter) => {
	vi.stubEnv("OPENAI_LOG", "debug");
	vi.stubEnv("ANTHROPIC_LOG", "debug");
	const records: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args) => {
			records.push(args);
		});
	const opts = {
		apiKey: "synthetic-key",
		maxRetries: 0,
		oauthDiagnostics: false,
		fetch: async () => Response.json({ error: { message: canary } }, { status: 403 }),
	};
	const stream =
		adapter === "responses"
			? responsesStream(model("openai-responses"), context, opts)
			: adapter === "completions"
				? completionsStream(model("openai-completions"), context, opts)
				: adapter === "azure"
					? azureStream(model("azure-openai-responses"), context, opts)
					: anthropicStream(
							model("anthropic-messages"),
							context,
							adapter === "federation"
								? { env: federationEnv, maxRetries: 0 }
								: adapter === "anthropic-header"
									? { headers: { Authorization: "Bearer synthetic" }, maxRetries: 0 }
									: { ...opts, apiKey: adapter === "anthropic-oauth" ? "sk-ant-oat-synthetic" : opts.apiKey },
						);
	await stream.result();
	expect(records).toEqual([]);
	if (adapter.startsWith("anthropic") || adapter === "federation") {
		expect(state.constructors[0].logLevel).toBe("off");
		expect(state.constructors[0].logger).toBeDefined();
	}
});

// smarty-dev#5822: the non-streaming image SDK shares the off logger too.
it("keeps image SDK logging off", async () => {
	vi.stubEnv("OPENAI_LOG", "debug");
	const records: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args) => {
			records.push(args);
		});
	const output = await generateImages(
		{ ...model("openai-completions"), api: "openrouter-images", type: "image", output: ["image"] },
		{ input: [{ type: "text", text: "synthetic" }] },
		{
			apiKey: "synthetic",
			maxRetries: 0,
			fetch: async () => Response.json({ error: { message: canary } }, { status: 403 }),
		},
	);
	expect(output.stopReason).toBe("error");
	expect(records).toEqual([]);
	expect(JSON.stringify(output)).not.toContain(canary);
});

// smarty-dev#5822: Smithy has no off log-level option; every auth config gets the shared no-op logger.
it("keeps Smithy logging off for all authentication configurations", () => {
	const records: unknown[] = [];
	for (const level of ["debug", "info", "warn", "error"] as const)
		vi.spyOn(console, level).mockImplementation((...args) => {
			records.push(args);
		});
	for (const log of Object.values(sdkDiagnosticLoggerOff)) log(canary, { credential: canary });
	expect(records).toEqual([]);
	const source = readFileSync(new URL("../../ai/src/api/bedrock-converse-stream.ts", import.meta.url), "utf8");
	expect(source).toContain("logger: sdkDiagnosticLoggerOff");
});

// smarty-dev#5822: universal normalization classifies the original SDK body before discarding it.
it.each(["status", "statusCode", "$metadata", "$response"])("normalizes %s with owned recovery", (field) => {
	const error = Object.assign(
		new Error(canary),
		field === "$metadata"
			? { $metadata: { httpStatusCode: 503 } }
			: field === "$response"
				? { $response: { statusCode: 503, body: canary } }
				: { [field]: 503 },
	);
	const normalized = normalizeProviderError(error);
	expect(normalized.status).toBe(503);
	expect(normalized.oauthRecovery?.retryable).toBe(true);
	expect(JSON.stringify(normalized)).not.toContain(canary);
});

// smarty-dev#5822: model-less, direct and lazy streams share immutable unconditional projection.
it.each([undefined, false, true])("projects partial/end with policy=%s", async (oauthDiagnostics) => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "generated" }],
		api: "google-vertex",
		provider: "google-vertex",
		model: "synthetic",
		timestamp: 0,
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		errorMessage: canary,
		rawStopReason: canary,
		responseId: canary,
		diagnostics: [{ type: "provider_limit", timestamp: 0, details: { canary }, error: { message: canary } }],
	};
	const stream = new AssistantMessageEventStream(undefined, { oauthDiagnostics });
	stream.push({ type: "start", partial: message });
	stream.end(message);
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	expect(JSON.stringify({ events, result: await stream.result() })).not.toContain(canary);
	expect(message.errorMessage).toBe(canary);
	expect(message.responseId).toBe(canary);
});

// smarty-dev#5822: a live one-shot gateway wait survives direct and SDK-owned copies, never JSON reconstruction.
it.each(["direct", "ModelRuntime"] as const)("keeps private throttle timing through %s", async (receiver) => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const options = {
		apiKey: "synthetic-key",
		maxRetries: 0,
		fetch: async () =>
			Response.json(
				{ error: { code: "smarty_limit", throttled: true, message: canary } },
				{ status: 429, headers: { "retry-after": "2" } },
			),
	};
	const stream =
		receiver === "direct"
			? completionsStream(model("openai-completions"), context, options)
			: runtime.stream({ ...model("openai-completions"), provider: "groq" }, { messages: [] }, options);
	const output = await stream.result();
	expect(throttledLimitWait(output)).toEqual({ delayMs: 2000, waitMessage: "Flash runs one request at a time" });
	expect(isRetryableAssistantError(output)).toBe(false);
	expect(JSON.stringify(output)).not.toContain(canary);
	expect(JSON.stringify(output)).not.toContain("retryAfterSeconds");
	expect(throttledLimitWait(JSON.parse(JSON.stringify(output)) as AssistantMessage)).toBeUndefined();
});

// smarty-dev#5822: all configurable SDK logger construction sites must be fixed/off, not credential-selected.
it("guards logger construction sites", () => {
	for (const file of [
		"anthropic-messages",
		"openai-completions",
		"openai-responses",
		"azure-openai-responses",
		"openrouter-images",
	]) {
		const source = readFileSync(new URL(`../../ai/src/api/${file}.ts`, import.meta.url), "utf8");
		expect(source).not.toMatch(/logger: oauthDiagnostics \?/);
		expect(source).not.toContain("const redactArgs");
		expect(source).toContain('logLevel: "off"');
		expect(source).toContain("logger: oauthDiagnosticLogger");
	}
});
