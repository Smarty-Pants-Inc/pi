import { describe, expect, it } from "vitest";
import { generateImages } from "../src/api/openrouter-images.ts";
import type { ImageModel } from "../src/types.ts";

// smarty-dev#5822 defensive failure-publication regression. Fake Response only; no listener.
const marker = "SYNTHETIC_FAILED_IMAGE_RECEIPT_5822";
const model: ImageModel<"openrouter-images"> & { contextWindow: number; maxTokens: number } = {
	id: "synthetic",
	name: "Synthetic",
	api: "openrouter-images",
	provider: "openrouter",
	type: "image",
	output: ["image"],
	baseUrl: "https://mock.invalid",
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
describe.each([undefined, false, true])("failed-image diagnostic policy=%s", (oauthDiagnostics) => {
	it("omits private response identity when response conversion fails", async () => {
		const output = await generateImages(
			model,
			{ input: [{ type: "text", text: "synthetic" }] },
			{
				apiKey: "synthetic",
				oauthDiagnostics,
				maxRetries: 0,
				fetch: async () => Response.json({ id: marker, choices: null }),
			},
		);
		expect(output.stopReason).toBe("error");
		expect(JSON.stringify(output)).not.toContain(marker);
	});
});
