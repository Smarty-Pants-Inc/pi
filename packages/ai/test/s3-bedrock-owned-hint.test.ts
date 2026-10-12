// T-C4 (smarty-dev#5822, S3 of #5443): Bedrock failures publish owned text only. The data-retention remedy stays
// as the owned `bedrock_data_retention` hint with the fixed AWS docs URL; the provider's message, unknown exception
// names, request ids and raw failure details are read for classification and never published.
import { beforeEach, describe, expect, it, vi } from "vitest";

type SendResult = { kind: "reject"; error: unknown } | { kind: "resolve"; response: unknown };

const bedrockMock = vi.hoisted(() => ({
	send: undefined as SendResult | undefined,
	// Exposed so tests can build errors that are real instances of the mocked base class.
	ServiceException: undefined as unknown as new (message?: string) => Error,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	bedrockMock.ServiceException = BedrockRuntimeServiceException;

	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };

		send(): Promise<unknown> {
			const outcome = bedrockMock.send;
			if (!outcome) return Promise.reject(new Error("test did not configure a send outcome"));
			return outcome.kind === "reject" ? Promise.reject(outcome.error) : Promise.resolve(outcome.response);
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

const SYNTHETIC = "sk-synthetic-5822-c4-0123456789abcdef";
const REQUEST_ID = "11111111-2222-3333-4444-555555555555";
const DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";
const RETENTION = `Validation error (400). Configure a supported Bedrock data retention mode. See ${DOCS_URL}`;

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

function getModelFixture(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
}

/** What the SDK's `handleError` path throws for a non-2xx response; `name` is the modeled AWS error code. */
function makeServiceException(name: string, message: string, extra: Record<string, unknown> = {}): Error {
	const error = new bedrockMock.ServiceException(message) as Error & Record<string, unknown>;
	error.name = name;
	Object.assign(error, extra);
	return error;
}

/** Fails after `messageStart`, as a stream exception item or a thrown unmarshaller error. */
function respondWithFailingStream(failure: { item: Record<string, unknown> } | { thrown: unknown }): SendResult {
	return {
		kind: "resolve",
		response: {
			$metadata: { httpStatusCode: 200, requestId: REQUEST_ID },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				if ("item" in failure) yield failure.item;
				else throw failure.thrown;
			})(),
		},
	};
}

async function runBedrock(signal?: AbortSignal): Promise<AssistantMessage> {
	return streamBedrock(getModelFixture(), context, { cacheRetention: "none", signal }).result();
}

function expectNoProviderText(message: AssistantMessage): void {
	const published = JSON.stringify(message);
	expect(published).not.toContain(SYNTHETIC);
	expect(published).not.toContain(REQUEST_ID);
	expect(message.diagnostics ?? []).toEqual([]);
}

beforeEach(() => {
	bedrockMock.send = undefined;
});

describe("T-C4: Bedrock owned failure text and hint (smarty-dev#5822)", () => {
	it("keeps the data-retention remedy as the owned hint without provider text", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException(
				"ValidationException",
				`The data retention mode 'default' is not available for this model. key=${SYNTHETIC}`,
				{ $metadata: { httpStatusCode: 400, requestId: REQUEST_ID } },
			),
		};

		const message = await runBedrock();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(RETENTION);
		expect(message.errorHint).toBe("bedrock_data_retention");
		expect(message.recovery).toEqual({ retryable: false });
		expectNoProviderText(message);
	});

	it("gives a generic validation failure no retention hint", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", `The provided model identifier is invalid. ${SYNTHETIC}`, {
				$metadata: { httpStatusCode: 400, requestId: REQUEST_ID },
			}),
		};

		const message = await runBedrock();

		expect(message.errorMessage).toBe("Validation error (400)");
		expect(message.errorHint).toBeUndefined();
		expectNoProviderText(message);
	});

	it("keeps the hint and text through repeated projection", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", "data retention mode 'default' is not available", {
				$metadata: { httpStatusCode: 400 },
			}),
		};
		const first = await runBedrock();
		const again = createAssistantMessageEventStream();
		again.push({ type: "error", reason: "error", error: first });
		const repeated = await again.result();
		expect(repeated.errorMessage).toBe(RETENTION);
		expect(repeated.errorHint).toBe("bedrock_data_retention");
	});

	it("classifies an input-too-long validation failure as overflow before dropping its text", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", "Input is too long for requested model.", {
				$metadata: { httpStatusCode: 400 },
			}),
		};

		const message = await runBedrock();

		expect(message.errorMessage).toBe("Validation error (400)");
		expect(message.recovery).toEqual({ recovery: "context_length_exceeded", retryable: false });
		expect(isContextOverflow(message)).toBe(true);
	});

	// pi#202 round 3: an unknown provider stop reason never reaches the published text.
	it("keeps a planted unknown stop reason private", async () => {
		bedrockMock.send = respondWithFailingStream({
			item: { messageStop: { stopReason: `corp-eu-west-7-tenant-plum ${SYNTHETIC}` } },
		});

		const message = await runBedrock();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("other");
		expect(JSON.stringify(message)).not.toContain("tenant-plum");
		expectNoProviderText(message);
	});

	it("labels a bare mid-stream throttle by its item, so 'Too many tokens' is not overflow", async () => {
		bedrockMock.send = respondWithFailingStream({
			item: { throttlingException: { message: `Too many tokens, please wait. ${SYNTHETIC}` } },
		});

		const message = await runBedrock();

		expect(message.errorMessage).toBe("Throttling error");
		expect(isContextOverflow(message)).toBe(false);
		expectNoProviderText(message);
	});

	it("publishes an owned label instead of an unknown exception name", async () => {
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("Unknown", `<html>gateway ${SYNTHETIC}</html>`, {
				$metadata: { httpStatusCode: 403, requestId: REQUEST_ID },
			}),
		};

		const message = await runBedrock();

		expect(message.errorMessage).toBe("Bedrock request failed (403)");
		expectNoProviderText(message);
	});

	it("keeps a modeled unmarshaller error's category", async () => {
		const unmodeled = new Error(`Model stream terminated unexpectedly. ${SYNTHETIC}`);
		unmodeled.name = "ModelStreamErrorException";
		bedrockMock.send = respondWithFailingStream({ thrown: unmodeled });

		const message = await runBedrock();

		expect(message.errorMessage).toBe("Model stream error");
		expectNoProviderText(message);
	});

	it("leaves transport failures to the classifier unchanged", async () => {
		bedrockMock.send = { kind: "reject", error: new Error("socket hang up") };

		const message = await runBedrock();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("socket hang up");
		expect(message.recovery).toEqual({ recovery: "retryable", retryable: true });
	});

	it("keeps chatgpt_usage as a separate exact owned hint", async () => {
		const responsesModel: Model<"openai-responses"> = {
			id: "test-model",
			name: "Test model",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		};
		const message = await streamResponses(responsesModel, context, {
			apiKey: "k",
			maxRetries: 0,
			fetch: async () =>
				Response.json(
					{ error: { code: "subscription_sharing_usage_limit_exceeded", message: "usage limit" } },
					{ status: 429 },
				),
		}).result();

		expect(message.errorHint).toBe("chatgpt_usage");
		expect(message.errorMessage).toContain("Check your ChatGPT usage: https://chatgpt.com/settings/usage");
		expect(message.recovery).toEqual({ retryable: false });
	});

	it("publishes only the two owned hint values", async () => {
		const stream = createAssistantMessageEventStream();
		const first = await runBedrock();
		stream.end({ ...first, errorHint: SYNTHETIC as "chatgpt_usage" });
		expect((await stream.result()).errorHint).toBeUndefined();
	});

	it("records nothing for an aborted turn", async () => {
		const controller = new AbortController();
		controller.abort();
		bedrockMock.send = {
			kind: "reject",
			error: makeServiceException("ValidationException", SYNTHETIC, {
				$metadata: { httpStatusCode: 400, requestId: REQUEST_ID },
			}),
		};

		const message = await runBedrock(controller.signal);

		expect(message.stopReason).toBe("aborted");
		expect(message.diagnostics ?? []).toEqual([]);
	});
});
