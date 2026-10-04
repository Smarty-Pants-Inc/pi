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

async function diagnostic(headers: Record<string, string>, text: string, origin: "model" | "options") {
	let wire: Headers | undefined;
	const events: unknown[] = [];
	const eventStream = stream(
		{ ...model, headers: origin === "model" ? headers : undefined },
		normalizeContext({ messages: [] }),
		{
			apiKey: "synthetic-audit-credential",
			headers: origin === "options" ? headers : undefined,
			env: {},
			maxRetries: 0,
			fetch: async (_input, init) => {
				wire = new Headers(init?.headers);
				return Response.json(
					{ error: { message: text, type: "invalid_request_error", code: "invalid_request" } },
					{ status: 400 },
				);
			},
		},
	);
	for await (const event of eventStream) events.push(event);
	const output = await eventStream.result();
	expect(output.stopReason).toBe("error");
	return { wire, sinks: JSON.stringify({ errorMessage: output.errorMessage, events }) };
}

describe("known credential wire and URL aliases", () => {
	// smarty-dev#4703: derived from fr-au-4703r/header-normalization-probe.mjs.
	it("masks bare credentials after header whitespace normalization in both header origins", async () => {
		const samples = [
			...Array.from({ length: 8 }, (_, i) => "Q7Z9V2B4".slice(0, i + 1)),
			"Q7Z9V2B4L0NG",
			"é",
			"\u00a0Q7\u00a0",
		];
		for (const secret of samples)
			for (const header of [
				"authorization",
				"proxy-authorization",
				"cf-aig-authorization",
				"x-api-key",
				"api-key",
			]) {
				for (const [left, right] of [
					["", ""],
					["  ", ""],
					["", "  "],
					["  ", "  "],
					["\t", "\t"],
				])
					for (const origin of ["model", "options"] as const) {
						const inner = header.endsWith("authorization") ? `Bearer ${secret}` : secret;
						const headers = { [header]: left + inner + right };
						expect(getOAuthDiagnosticSecrets(undefined, headers)).toContain(secret);
						const result = await diagnostic(headers, `receipt=${secret}`, origin);
						expect(result.wire?.get(header)).toBe(inner);
						expect(result.sinks).not.toContain(secret);
					}
			}
	});

	// smarty-dev#4703: derived from fr-au-4703r/url-alias-sink-probe.mjs.
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
					const result = await diagnostic(headers, text, "model");
					expect(result.sinks).not.toContain(value);
				}
		}
	});

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
