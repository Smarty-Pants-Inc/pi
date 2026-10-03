import { describe, expect, it } from "vitest";
import { redactOAuthDiagnostic, redactOAuthDiagnosticValue } from "../src/auth/oauth/credential-response.ts";
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

	it("redacts unquoted authorization headers without leaving the bearer value", () => {
		expect(redactOAuthDiagnostic("connection failed Authorization: Bearer FAKE_BEARER_127")).not.toContain(
			"FAKE_BEARER_127",
		);
	});

	it.each(["FAKE\nHEADER_127", 'FAKE"QUOTED_127', "FAKE\ud800UNICODE_127"])(
		"redacts active values in raw and JSON-escaped native errors",
		(secret) => {
			for (const text of [secret, JSON.stringify(secret)]) {
				expect(redactOAuthDiagnostic(`TypeError: ${text}`, [secret])).toContain("[REDACTED]");
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
		).toEqual({ refresh_token: "[REDACTED]" });
	});
});
