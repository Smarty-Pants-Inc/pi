import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/api/llama-cpp-classify.ts";
import { generateImages } from "../src/api/openrouter-images.ts";
import { classifySystemOne } from "../src/api/system-one-shared.ts";
import type { ClassifierModel, ImageModel } from "../src/types.ts";

// pi#141 / smarty-dev#4703: scalar provider errors/loggers are diagnostic receivers too.
const secret = "SCALAR_R141_SYNTHETIC_CREDENTIAL";
const canary = "SCALAR_R141_UNTRUSTED_DIAGNOSTIC";
const base = {
	id: "synthetic",
	name: "Synthetic",
	provider: "audit",
	baseUrl: "https://mock.invalid/v1",
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
	headers: { "x-api-key": secret },
};

describe.each([false, true])("scalar diagnostics; OAuth=$0", (oauthDiagnostics) => {
	it.each(["image", "llama", "system-one"])("contains %s diagnostic credentials and raw OAuth text", async (kind) => {
		vi.stubEnv("OPENAI_LOG", "debug");
		const records: unknown[] = [];
		const spies = ["debug", "info", "warn", "error"].map((level) =>
			vi.spyOn(console, level as "debug" | "info" | "warn" | "error").mockImplementation((...args: unknown[]) => {
				records.push(args);
			}),
		);
		try {
			const options = {
				apiKey: secret,
				oauthDiagnostics,
				maxRetries: 0,
				fetch: async () => Response.json({ error: { message: `receipt=${secret}; ${canary}` } }, { status: 403 }),
			};
			const questions = {
				q: { type: "choice" as const, instructions: "Choose one", criteria: { yes: "Yes", no: "No" } },
			};
			const context = { state: {}, questions };
			const output =
				kind === "image"
					? await generateImages(
							{
								...base,
								type: "image",
								api: "openrouter-images",
								output: ["image"],
							} as ImageModel<"openrouter-images">,
							{ input: [{ type: "text", text: "Synthetic" }] },
							options,
						)
					: kind === "llama"
						? await classify(
								{
									...base,
									type: "classifier",
									api: "llama-cpp-classify",
								} as ClassifierModel<"llama-cpp-classify">,
								context,
								options,
							)
						: await classifySystemOne(
								{
									api: "typesafe-system-one",
									label: "Synthetic",
									url: () => new URL("https://mock.invalid/classify"),
									payload: (_model, request) => request,
									output: () => ({}),
								},
								{
									...base,
									type: "classifier",
									api: "typesafe-system-one",
								} as ClassifierModel<"typesafe-system-one">,
								context,
								options,
							);
			expect(output.stopReason).toBe("error");
			const sinks = JSON.stringify({ output, records });
			expect(sinks).not.toContain(secret);
			if (oauthDiagnostics) expect(sinks).not.toContain(canary);
		} finally {
			for (const spy of spies) spy.mockRestore();
			vi.unstubAllEnvs();
		}
	});
});
