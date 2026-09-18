import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadKimiCodingOAuth } from "../auth/oauth/load.ts";
import { MODELS } from "../models.generated.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

const kimiCodingModels =
	(MODELS as unknown as Record<string, Record<string, Model<"anthropic-messages">>>)["kimi-coding"] ?? {};

export function kimiCodingProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "kimi-coding",
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding",
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			oauth: lazyOAuth({
				name: "Kimi Code (subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Kimi Code",
				load: loadKimiCodingOAuth,
			}),
		},
		models: Object.values(kimiCodingModels),
		api: anthropicMessagesApi(),
	});
}
