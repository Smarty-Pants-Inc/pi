// pi#202 round 2 P1-2 (smarty-dev#5822): a non-2xx pi-messages response publishes owned text only. Its message,
// code, body and status text are classified privately and never reach errorMessage, diagnostics or the event.
// The values below include a credential-shaped token and plain environment values that no pattern can match.
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/pi-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const CREDENTIAL = "sk-ant-api03-synthetic5822round2AAAAAAAAAAAAAAAAAAAA";
const PLAIN_ENV = "corp-eu-west-7-tenant-plum";
const PLAIN_CODE = "tenant_plum_quota_lane";
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

const model: Model<"pi-messages"> = {
	id: "test-model",
	name: "Test model",
	provider: "custom-5822",
	api: "pi-messages",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

async function run(response: () => Response): Promise<{ result: AssistantMessage; events: string[] }> {
	const s = stream(model, context, { apiKey: "k", fetch: async () => response() });
	const events: string[] = [];
	for await (const event of s as AsyncIterable<AssistantMessageEvent>) events.push(JSON.stringify(event));
	return { result: await s.result(), events };
}

function expectNothingPrivate(published: unknown): void {
	const json = JSON.stringify(published);
	for (const value of [CREDENTIAL, PLAIN_ENV, PLAIN_CODE]) expect(json).not.toContain(value);
}

describe("pi-messages non-2xx responses publish owned text only (smarty-dev#5822)", () => {
	it.each([
		[
			"JSON message and unknown code",
			{ error: { message: `bad key ${CREDENTIAL} at ${PLAIN_ENV}`, code: PLAIN_CODE } },
		],
		["JSON code carrying the values", { error: { message: "denied", code: `${CREDENTIAL}${PLAIN_ENV}` } }],
		["JSON details", { error: { message: "denied", details: { tenant: PLAIN_ENV, key: CREDENTIAL } } }],
		["plain-text body", `upstream said ${CREDENTIAL} for ${PLAIN_ENV}`],
	])("%s", async (_name, body) => {
		const { result, events } = await run(
			() =>
				new Response(typeof body === "string" ? body : JSON.stringify(body), {
					status: 401,
					statusText: PLAIN_ENV,
				}),
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider request failed (HTTP 401)");
		expect(result.diagnostics).toEqual([{ type: "pi_messages_response_failure", timestamp: expect.any(Number) }]);
		expectNothingPrivate(result);
		for (const event of events) expectNothingPrivate(event);
	});

	it("publishes an allow-listed code only as its closed category", async () => {
		const { result } = await run(() =>
			Response.json({ error: { message: `expired ${CREDENTIAL}`, code: "unauthorized" } }, { status: 401 }),
		);
		expect(result.errorMessage).toBe("Provider request failed (HTTP 401, unauthorized)");
		expectNothingPrivate(result);
	});

	it("still classifies privately: quota refusal is final, overload is retryable", async () => {
		const quota = await run(() =>
			Response.json(
				{ error: { message: `insufficient_quota for ${PLAIN_ENV}`, code: PLAIN_CODE } },
				{ status: 429 },
			),
		);
		expect(quota.result.errorMessage).toBe("Provider request failed (HTTP 429)");
		expect(quota.result.recovery).toEqual({ retryable: false });
		expect(isRetryableAssistantError(quota.result)).toBe(false);

		const busy = await run(() => Response.json({ error: { message: "try later", code: "busy" } }, { status: 503 }));
		expect(busy.result.errorMessage).toBe("Provider request failed (HTTP 503, overloaded)");
		expect(busy.result.recovery).toEqual({ recovery: "retryable", retryable: true });
	});
});
