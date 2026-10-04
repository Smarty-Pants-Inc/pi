import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

// smarty-dev#4703 scope cut: Radius premature-stream retry remains deferred to smarty-dev#4790.
it.each(["ECONNRESET", "early EOF"])("Radius catch keeps baseline no-retry for %s", async (kind) => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: "synthetic-access",
		refresh: "synthetic-refresh",
		expires: Date.now() + 3_600_000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const provider = radiusProvider();
	models.setProvider(provider);
	let calls = 0;
	const output = await retryAssistantCall(
		() =>
			models.complete(
				provider.getModels()[0],
				{ messages: [] },
				{
					fetch: async () => {
						calls++;
						if (kind === "ECONNRESET") throw new Error("ECONNRESET SCOPE_CUT_DIAGNOSTIC_CANARY");
						return new Response('data: {"type":"start"}\n\n');
					},
				},
			),
		{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
	);
	expect(calls).toBe(1);
	expect(output.stopReason).toBe("error");
	expect(isRetryableAssistantError(output)).toBe(false);
	expect(output.errorMessage).not.toContain("SCOPE_CUT_DIAGNOSTIC_CANARY");
});
