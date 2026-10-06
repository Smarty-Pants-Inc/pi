// smarty-dev#5822: SDK body text is private classifier input, never a rich display contract.
import { describe, expect, it } from "vitest";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";

const privateText = "SYNTHETIC_ERROR_BODY_5822";
class SdkHttpResponseBody {
	locked = false;
	state = { storedError: undefined };
}
class SdkInnerError {
	code = "EPROTO";
	internalState = {};
}
const shapes = [
	{ name: "Mistral body", error: { message: privateText, statusCode: 403, body: privateText }, status: 403 },
	{
		name: "OpenAI parsed body",
		error: { message: "403 status code (no body)", status: 403, error: { error: privateText } },
		status: 403,
	},
	{
		name: "Google folded body",
		error: { message: JSON.stringify({ error: { code: 403, message: privateText } }), status: 403 },
		status: 403,
	},
	{
		name: "Bedrock response body",
		error: {
			name: "UnknownError",
			message: privateText,
			$metadata: { httpStatusCode: 403 },
			$response: { statusCode: 403, body: privateText },
		},
		status: 403,
	},
	{
		name: "Bedrock stream",
		error: {
			message: privateText,
			$metadata: { httpStatusCode: 400 },
			$response: { statusCode: 400, body: { pipe: () => undefined, _events: { close: [null] } } },
		},
		status: 400,
	},
	{
		name: "SDK class response",
		error: {
			message: `Input is too long for requested model. ${privateText}`,
			$metadata: { httpStatusCode: 400 },
			$response: { body: new SdkHttpResponseBody() },
		},
		status: 400,
	},
	{
		name: "SDK class error",
		error: { message: `TLS handshake failed ${privateText}`, status: 502, error: new SdkInnerError() },
		status: 502,
	},
	{
		name: "plain parsed body",
		error: { message: "400 status code (no body)", status: 400, error: { message: privateText, field: "tools[0]" } },
		status: 400,
	},
	{ name: "non-Error value", error: { reason: privateText }, status: undefined },
	{ name: "empty body", error: { message: privateText, status: 403, error: {} }, status: 403 },
	{ name: "long body", error: { message: privateText, statusCode: 500, body: privateText.repeat(500) }, status: 500 },
	{
		name: "body already in message",
		error: { message: `500: ${privateText}`, statusCode: 500, body: privateText },
		status: 500,
	},
];

describe("normalizeProviderError owned projection", () => {
	it.each(shapes)("keeps status but drops text and body for $name", ({ error, status }) => {
		const normalized = normalizeProviderError(error);
		expect(normalized.status).toBe(status);
		expect(normalized.message).toMatch(/^provider_request_failed \(HTTP (unknown|[1-5]\d\d)\)$/);
		expect(Object.keys(normalized).sort()).toEqual(["message", "oauthRecovery", "status"]);
		expect(JSON.stringify(normalized)).not.toContain(privateText);
	});
	it("classifies original text even when the response body is an SDK class", () => {
		const normalized = normalizeProviderError(shapes[5].error);
		expect(normalized.oauthRecovery?.recovery).toBe("context_length_exceeded");
	});
	it.each(["body", "error", "$response"])("reads private %s for context overflow", (field) => {
		const body = `maximum context length exceeded ${privateText}`;
		const error = {
			status: 400,
			[field]: field === "$response" ? { body } : field === "error" ? { message: body } : body,
		};
		const normalized = normalizeProviderError(error);
		expect(normalized.oauthRecovery?.recovery).toBe("context_length_exceeded");
		expect(JSON.stringify(normalized)).not.toContain(privateText);
	});
	it.each([99, 600, 401.5, "401"])("rejects invalid status %s", (status) => {
		expect(normalizeProviderError({ status, code: 401 }).status).toBeUndefined();
	});
});

describe("formatProviderError", () => {
	it("returns owned text without a prefix", () => {
		expect(formatProviderError(normalizeProviderError(shapes[1].error))).toBe("provider_request_failed (HTTP 403)");
	});
	it("applies locally supplied prefix only to owned text", () => {
		expect(formatProviderError(normalizeProviderError(shapes[1].error), "OpenAI API error")).toBe(
			"OpenAI API error (403): provider_request_failed (HTTP 403)",
		);
	});
	it("does not publish a non-Error value", () => {
		expect(formatProviderError(normalizeProviderError({ reason: privateText }))).toBe(
			"provider_request_failed (HTTP unknown)",
		);
	});
});
