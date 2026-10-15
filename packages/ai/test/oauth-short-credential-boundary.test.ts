import { describe, expect, it } from "vitest";
import {
	getRequestDiagnosticSecrets,
	redactOAuthDiagnostic,
	redactValues,
} from "../src/auth/oauth/credential-response.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";

// smarty-dev#4703: a tiny live key must not corrupt owned hints or transport diagnostics.
describe("short known credential token boundaries", () => {
	it.each(["k", "ck"])("preserves ordinary words with a %s credential", (secret) => {
		const text = "Check your ChatGPT usage: https://chatgpt.com/settings/usage; socket hang up";
		for (const secrets of [
			getRequestDiagnosticSecrets(undefined, { apiKey: secret }),
			getRequestDiagnosticSecrets({ headers: { "x-api-key": secret } }, undefined),
		]) {
			expect(redactValues(text, secrets)).toBe(text);
			expect(redactOAuthDiagnostic(text, secrets)).toBe(text);
			expect(normalizeProviderError(new Error(text), undefined, undefined, secrets).localMessage).toBe(text);
		}
	});

	// smarty-dev#4703: raw and encoded tiny values still mask in every reflected credential context.
	it.each(["k", "ck"])("masks standalone values and URL userinfo for %s", (secret) => {
		const secrets = getRequestDiagnosticSecrets(undefined, { apiKey: secret });
		const percent = [...secret].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
		for (const value of [
			secret,
			percent,
			encodeURIComponent(percent),
			btoa(secret),
			btoa(secret).replace(/=+$/, ""),
		]) {
			for (const [text, expected] of [
				[value, "***"],
				[`receipt=${value}`, "receipt=***"],
				[`{"receipt":"${value}"}`, '{"receipt":"***"}'],
				[`X-Echo: ${value}`, "X-Echo: ***"],
				[`https://${value}@echo.invalid/`, "https://***@echo.invalid/"],
				[`https://user:${value}@echo.invalid/`, "https://user:***@echo.invalid/"],
				[`https://echo.invalid/${value}?receipt=${value}#${value}`, "https://echo.invalid/***?receipt=***#***"],
			]) {
				expect(redactValues(text, secrets)).toBe(expected);
				expect(redactOAuthDiagnostic(text, secrets)).toBe(expected);
			}
		}
	});

	// smarty-dev#4703: the short rule includes aliases and Unicode letters/numbers, not just ASCII prose.
	it("preserves embedded short aliases and uses the four-character substring floor", () => {
		expect(redactValues("draw", ["k"])).toBe("draw"); // "aw" is unpadded Base64(k).
		expect(redactValues("éko 1k2 _k_", ["k"])).toBe("éko 1k2 _***_");
		expect(redactValues("theme the", ["the"])).toBe("theme ***");
		expect(redactValues("xQ7Z9y", ["Q7Z9"])).toBe("x***y");
		expect(redactValues("https://echo.invalid/", ["/"])).toBe("https:******echo.invalid***");
	});
});
