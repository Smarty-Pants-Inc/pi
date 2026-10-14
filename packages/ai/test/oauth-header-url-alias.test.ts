import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import { getOAuthDiagnosticSecrets, redactOAuthDiagnostic } from "../src/auth/oauth/credential-response.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "masking-regression",
	name: "Masking regression",
	api: "openai-completions",
	provider: "audit",
	baseUrl: "https://mock.invalid/v1",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};

async function diagnostic(headers: Record<string, string>, text: string, origin: "model" | "options" = "model") {
	const events: unknown[] = [];
	let requested = false;
	const eventStream = stream(
		{ ...model, headers: origin === "model" ? headers : undefined },
		normalizeContext({ messages: [] }),
		{
			apiKey: "synthetic-audit-credential",
			headers: origin === "options" ? headers : undefined,
			env: {},
			maxRetries: 0,
			fetch: async () => {
				requested = true;
				return Response.json(
					{ error: { message: text, type: "invalid_request_error", code: "invalid_request" } },
					{ status: 400 },
				);
			},
		},
	);
	for await (const event of eventStream) events.push(event);
	const output = await eventStream.result();
	expect(requested).toBe(true);
	expect(output.stopReason).toBe("error");
	return JSON.stringify({ errorMessage: output.errorMessage, events });
}

describe("known credential URL aliases", () => {
	// smarty-dev#4703: ported from the audited carry's URL-alias sink regression.
	it("masks equivalent percent encodings at errorMessage and error-event sinks", async () => {
		for (const secret of ["é", "/", "Q7", "Q7Z9V2B4", "Q7Z9V2B4L0NG"]) {
			const canonical = encodeURIComponent(secret);
			const values = [
				secret,
				canonical,
				canonical.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
				[...new TextEncoder().encode(secret)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
				encodeURIComponent(canonical),
			];
			for (const header of ["x-api-key", "api-key", "proxy-authorization", "cf-aig-authorization"])
				for (const value of values) {
					const headers = { [header]: header.endsWith("authorization") ? `Basic ${secret}` : secret };
					const text = `receipt=https://echo.invalid/path/${value}?receipt=${value}#${value}`;
					expect(redactOAuthDiagnostic(text, getOAuthDiagnosticSecrets(undefined, headers))).not.toContain(value);
					expect(await diagnostic(headers, text)).not.toContain(value);
				}
		}
	});

	// smarty-dev#4703: URL userinfo has no credential label; it must use the live-value mask.
	it.each(["Q7", "Q7Z9", "Q7Z9V2B4L0NG"])("masks known credentials in URL userinfo (%s)", async (secret) => {
		const headers = { "x-api-key": secret };
		for (const value of [secret, [...secret].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("")]) {
			const text = `receipt=https://${value}@echo.invalid/`;
			expect(redactOAuthDiagnostic(text, getOAuthDiagnosticSecrets(undefined, headers))).not.toContain(value);
			expect(await diagnostic(headers, text, "options")).not.toContain(value);
		}
	});

	// smarty-dev#4703: retain the carry's malformed-neighbor, mixed-layer and budget assertions.
	it("canonicalizes mixed Unicode aliases, invalid neighbors and alternating encoding layers", () => {
		for (const [secret, alias] of [
			["éQ7", "é%51%37"],
			["éQ7", "%c3%a9Q%37"],
			["é", "%ff%c3%a9"],
			["Q7", "%51%37%ff"],
			["Q7", "%2551%2537"],
			["%51", "%2551"],
			["\ufeffQ7", "%ef%bb%bf%51%37"],
			["%51", "\\u002551"],
			["Q7", "%5cu0051%5cu0037"],
		]) {
			expect(redactOAuthDiagnostic(`receipt=${alias}`, [secret])).not.toContain(alias);
		}
		expect(redactOAuthDiagnostic("unrelated %41%ff and %broken", ["Q7"])).toBe("unrelated %41%ff and %broken");
		let nested = "%51%37";
		for (let i = 0; i < 20; i++) nested = encodeURIComponent(nested);
		expect(redactOAuthDiagnostic(nested, ["Q7"])).toBe("***");
		expect(redactOAuthDiagnostic("%41".repeat(100000), ["Q7"])).toBe("***");
	});
});
