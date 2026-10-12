// Unit tests for the shared provider error normalizer. The SDK shapes (Mistral, openai APIError, @google/genai
// ApiError, AWS Bedrock ServiceException) still supply the status and the private classification text, but since
// smarty-dev#5822 (pi#202 round 2) the published text is owned: no provider message or body reaches it.

import { describe, expect, it } from "vitest";
import { formatProviderError, normalizeProviderError, providerErrorText } from "../src/utils/error-body.ts";

const PRIVATE = "blocked by gateway WAF for tenant corp-eu-west-7-tenant-plum";

describe("normalizeProviderError", () => {
	it.each([
		["Mistral statusCode/body", { statusCode: 403, body: `{"error":"${PRIVATE}"}` }, 403],
		["openai status/error", { status: 403, error: { error: PRIVATE } }, 403],
		[
			"Bedrock $metadata/$response",
			{ $metadata: { httpStatusCode: 403 }, $response: { statusCode: 403, body: PRIVATE } },
			403,
		],
		["Bedrock $response only", { $response: { statusCode: 502, body: PRIVATE } }, 502],
	])("reads the status of a %s error and keeps no provider text", (_name, fields, status) => {
		const norm = normalizeProviderError(Object.assign(new Error(`failed: ${PRIVATE}`), fields));
		expect(norm.status).toBe(status);
		expect(Object.keys(norm).sort()).toEqual(["recovery", "status"]);
		expect(JSON.stringify(norm)).not.toContain("corp-eu-west-7");
	});

	it("classifies from the private body, not only the message", () => {
		const error = Object.assign(new Error("400 status code (no body)"), {
			status: 400,
			error: { message: "prompt is too long" },
		});
		expect(normalizeProviderError(error).recovery).toEqual({ recovery: "context_length_exceeded", retryable: false });
	});

	it("classifies extra private text such as OpenRouter metadata.raw", () => {
		const error = Object.assign(new Error("400"), { status: 400 });
		expect(normalizeProviderError(error, "openrouter", "upstream overloaded").recovery).toEqual({
			recovery: "retryable",
			retryable: true,
		});
	});

	it("never treats a non-HTTP numeric status as a status", () => {
		expect(normalizeProviderError(Object.assign(new Error("x"), { status: 0, code: 503 })).status).toBeUndefined();
	});
});

describe("providerErrorText (private classification input)", () => {
	it("joins the message and a plain body", () => {
		expect(providerErrorText(Object.assign(new Error("m"), { status: 400, error: { e: 1 } }))).toBe('m\n{"e":1}');
	});

	it("ignores response streams and class-instance bodies instead of serializing them", () => {
		class SdkHttpResponseBody {
			locked = false;
		}
		const stream = Object.assign(new Error("Input is too long for requested model."), {
			$response: { statusCode: 400, body: { pipe: () => undefined, _readableState: {} } },
		});
		const instance = Object.assign(new Error("TLS handshake failed"), {
			status: 502,
			error: new SdkHttpResponseBody(),
		});
		expect(providerErrorText(stream)).toBe("Input is too long for requested model.");
		expect(providerErrorText(instance)).toBe("TLS handshake failed");
	});

	it("JSON-stringifies a non-Error thrown value", () => {
		expect(providerErrorText({ reason: "boom" })).toBe('{"reason":"boom"}');
	});
});

describe("formatProviderError (owned text)", () => {
	it("renders the label and status only, never the provider body or message", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error(`403 ${PRIVATE}`), { status: 403, error: { error: PRIVATE } }),
		);
		expect(formatProviderError(norm, "OpenAI API error")).toBe("OpenAI API error (403)");
		expect(formatProviderError(norm)).toBe("Provider request failed (403)");
	});

	it("names the owned recovery class so the text stays classifiable", () => {
		const overflow = normalizeProviderError(Object.assign(new Error("prompt is too long"), { status: 400 }));
		expect(formatProviderError(overflow)).toBe("Provider request failed (400): context length exceeded");
		// A provider response without a status: its parsed error body makes it a provider error, not a local one.
		const network = normalizeProviderError(
			Object.assign(new Error(`upstream connect error ${PRIVATE}`), { error: { detail: PRIVATE } }),
		);
		expect(formatProviderError(network)).toBe("Provider request failed: network or server error");
		const premature = normalizeProviderError(
			Object.assign(new Error("stream ended before message_stop"), { error: { detail: PRIVATE } }),
		);
		expect(formatProviderError(premature)).toBe("Provider request failed: stream ended without completing");
	});

	it("keeps the masked message of a local (Pi or transport) failure, which carries no provider response", () => {
		const local = normalizeProviderError(new Error("Request timed out after 50ms"), undefined, undefined, ["k"]);
		expect(formatProviderError(local, "OpenAI API error")).toBe("Request timed out after 50ms");
		const masked = normalizeProviderError(new Error("bad header sk-live-5822"), undefined, undefined, [
			"sk-live-5822",
		]);
		expect(formatProviderError(masked)).not.toContain("sk-live-5822");
	});

	it("renders a non-Error value as owned text", () => {
		expect(formatProviderError(normalizeProviderError({ reason: "boom" }))).toBe("Provider request failed");
	});
});
