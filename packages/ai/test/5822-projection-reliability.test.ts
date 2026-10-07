import { expect, it } from "vitest";
import type { AssistantImages, Usage } from "../src/types.ts";
import { projectAssistantImages, projectUsage } from "../src/utils/diagnostics.ts";

// smarty-dev#5822: an incomplete breakdown must not discard valid aggregate accounting.
it("preserves bounded aggregate cost across repeated projection of incomplete pricing", () => {
	const usage = {
		input: 7,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 7,
		cost: { input: 0.25, output: "untrusted", cacheRead: null, cacheWrite: [], total: 0.5 },
	} as unknown as Usage;
	const first = projectUsage(usage);
	expect(first.cost).toEqual({ input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 });
	expect(projectUsage(first)).toEqual(first);
});

// smarty-dev#5822: abort text is an owned constant, never the supplied diagnostic.
it.each([undefined, "untrusted diagnostic", "provider_request_failed (HTTP unknown)"])(
	"owns image abort text regardless of supplied message %s",
	(errorMessage) => {
		const source: AssistantImages = {
			api: "openrouter-images",
			provider: "openrouter",
			model: "synthetic",
			output: [],
			stopReason: "aborted",
			timestamp: 0,
			errorMessage,
		};
		expect(projectAssistantImages(source).errorMessage).toBe("Request aborted");
		expect(source.errorMessage).toBe(errorMessage);
	},
);
