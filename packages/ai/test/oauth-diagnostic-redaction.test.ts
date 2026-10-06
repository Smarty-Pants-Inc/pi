import { describe, expect, it } from "vitest";
import {
	getRequestDiagnosticSecrets,
	redactOAuthDiagnostic,
	redactOAuthDiagnosticValue,
} from "../src/auth/oauth/credential-response.ts";
import { createAssistantMessageDiagnostic } from "../src/utils/diagnostics.ts";
import { MAX_PROVIDER_ERROR_BODY_CHARS, normalizeProviderError } from "../src/utils/error-body.ts";

// pi#127: credentials can cross multiple SDK serialization layers before reaching a diagnostic.
describe("OAuth diagnostic redaction", () => {
	it.each(["access_token", "refresh_token", "id_token", "account_id", "chatgpt-account-id", "Authorization"])(
		"redacts %s before truncation and nested serialization",
		(field) => {
			const secret = `FAKE_${field}_127`;
			let body = JSON.stringify({ [field]: secret, code: "server_error" });
			for (let depth = 0; depth < 4; depth++) {
				const result = redactOAuthDiagnostic(`503: ${body}`);
				expect(result).not.toContain(secret);
				expect(result).toContain("server_error");
				body = JSON.stringify({ message: body });
			}
			const error = Object.assign(new Error("server_error"), {
				status: 503,
				body: JSON.stringify({ [field]: secret.repeat(MAX_PROVIDER_ERROR_BODY_CHARS) }),
			});
			expect(normalizeProviderError(error).body).not.toContain(secret);
		},
	);

	it.each(["", "503: "])("redacts JSON-escaped credential field names with prefix %s", (prefix) => {
		const body = '{"refresh\\u005ftoken":"FAKE_ESCAPED_FIELD_127","code":"server_error"}';
		for (const suffix of ["", "; malformed tail"]) {
			const result = redactOAuthDiagnostic(prefix + body + suffix);
			expect(result).not.toContain("FAKE_ESCAPED_FIELD_127");
			expect(result).toContain("server_error");
		}
	});

	// pi#127 / audit-2b P1-1: delimiter escaping is not limited to one JSON layer.
	it.each(["refresh_token", "access_token", "id_token", "account_id", "chatgpt_account_id", "Authorization"])(
		"redacts arbitrary escaped delimiters and malformed fragments for %s",
		(field) => {
			const secret = "FAKE_UNKNOWN_FRAGMENT_127";
			for (let depth = 0; depth < 5; depth++) {
				for (const quote of ['"', "'"]) {
					const delimiter = "\\".repeat(depth) + quote;
					for (const value of [
						`${delimiter}${secret}${delimiter}, code=server_error`,
						`${delimiter}${secret} unfinished fragment`,
					]) {
						const result = redactOAuthDiagnostic(`503 server_error ${delimiter}${field}${delimiter}: ${value}`);
						expect(result).not.toContain(secret);
						expect(result).toContain("503 server_error");
						if (value.includes("code=")) expect(result).toContain("code=server_error");
					}
				}
			}
			const result = redactOAuthDiagnostic(`503 server_error ${field} ${secret} unfinished fragment`);
			expect(result).not.toContain(secret);
			expect(result).not.toContain("unfinished fragment");
			expect(result).toContain("503 server_error");
		},
	);

	it("redacts unquoted authorization headers without leaving the bearer value", () => {
		expect(redactOAuthDiagnostic("connection failed Authorization: Bearer FAKE_BEARER_127")).not.toContain(
			"FAKE_BEARER_127",
		);
	});

	it.each(["FAKE\nHEADER_127", 'FAKE"QUOTED_127', "FAKE\ud800UNICODE_127"])(
		"redacts active values in raw and JSON-escaped native errors",
		(secret) => {
			for (const text of [secret, JSON.stringify(secret)]) {
				expect(redactOAuthDiagnostic(`TypeError: ${text}`, [secret])).toContain("***");
			}
		},
	);

	it("clones SDK log data without retaining errors, causes, custom inspect hooks or cycles", () => {
		const secret = "FAKE_LOG_127";
		const error = Object.assign(new Error(secret, { cause: new Error(secret) }), { refresh_token: secret });
		const value = { error, toJSON: () => secret, [Symbol.for("nodejs.util.inspect.custom")]: () => secret, loop: {} };
		value.loop = value;
		const result = redactOAuthDiagnosticValue(value, [secret]);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(result).not.toBe(value);
		expect(
			createAssistantMessageDiagnostic("provider_error", error, { refresh_token: secret }, [secret]).details,
		).toEqual({ refresh_token: "***" });
	});

	// pi#150 security round 2: custom credential headers have no fixed name.
	it.each(["X-Portkey-Api-Key", "X-Custom-Token", "X-Client-Secret", "Cookie", "X-Session-Id", "X-Auth"])(
		"redacts the value of the custom sensitive header %s",
		(header) => {
			const secret = "FAKE_CUSTOM_HEADER_150";
			const secrets = getRequestDiagnosticSecrets(
				{ headers: { [header]: `Token ${secret}` } },
				{ headers: { "Content-Type": "application/json" } },
			);
			expect(secrets).not.toContain("application/json");
			expect(redactOAuthDiagnostic(`401 rejected ${secret}`, secrets)).toBe("401 rejected ***");
		},
	);

	// pi#150 security round 3: one label set classifies headers and masks labels.
	it("redacts an X-Client-Credential value reflected in an error under its label", () => {
		const secret = "FAKE_CLIENT_CREDENTIAL_150";
		const secrets = getRequestDiagnosticSecrets({ headers: { "X-Client-Credential": secret } }, undefined);
		expect(secrets).toContain(secret);
		const reflected = `401 {"error":"rejected","X-Client-Credential":"${secret}"} X-Client-Credential: ${secret}`;
		expect(redactOAuthDiagnostic(reflected, secrets)).not.toContain(secret);
		// Without the live value, label masking still hides a short one.
		const labelOnly = redactOAuthDiagnostic('401 {"X-Client-Credential":"c1"} x-client-credential=c2; code=bad');
		expect(labelOnly).not.toContain("c1");
		expect(labelOnly).not.toContain("c2");
		expect(labelOnly).toContain("code=bad");
		expect(redactOAuthDiagnosticValue({ "X-Client-Credential": "c3" })).toEqual({ "X-Client-Credential": "***" });
	});

	it.each(["X-Cred", "X-Amz-Signature", "X-Jwt", "X-Bearer", "X-Private-Id", "X-Passwd"])(
		"treats %s as a credential header and label",
		(header) => {
			const secret = "FAKE_HEADER_VALUE_150";
			expect(getRequestDiagnosticSecrets({ headers: { [header]: secret } }, undefined)).toContain(secret);
			expect(redactOAuthDiagnostic(`${header}: v1`)).not.toContain("v1");
		},
	);

	it("keeps prose and usage counts that only mention a credential word", () => {
		for (const text of [
			"Your session expired; invalid X-Client-Credential header. max_tokens: 4096, input_tokens=12",
			"401 Unauthorized: Token expired (unauthorized)",
			"Limit used up. Add credit: https://billing.example/checkout",
		])
			expect(redactOAuthDiagnostic(text)).toBe(text);
	});

	it.each(["api_key", "apiKey", "api-key", "x-api-key", "x-goog-api-key"])(
		"redacts a short value under the API-key label %s",
		(label) => {
			const result = redactOAuthDiagnostic(`401 server_error {"${label}":"sk-1"} ${label}=sk-2, code=bad`);
			expect(result).not.toContain("sk-1");
			expect(result).not.toContain("sk-2");
			expect(result).toContain("code=bad");
		},
	);
});
