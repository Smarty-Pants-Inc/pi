import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { hasAssistantOutput, isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const encode = new TextEncoder();
const frames = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
async function runtime() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: "synthetic-access",
		refresh: "synthetic-refresh",
		expires: Date.now() + 3600000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const provider = radiusProvider();
	models.setProvider(provider);
	return { models, model: provider.getModels()[0] };
}
// smarty-dev#4703 R5: retain baseline no replay after output; Radius retry is deferred to smarty-dev#4790.
it.each(["text", "thinking", "toolcall"].flatMap((kind) => ["EOF", "read-error"].map((failure) => [kind, failure])))(
	"does not retry %s after %s",
	async (kind, failure) => {
		const { models, model } = await runtime();
		let calls = 0;
		let observedOutput = false;
		const events = [
			{ type: "start" },
			...(kind === "text"
				? [
						{ type: "text_start", contentIndex: 0 },
						{ type: "text_delta", contentIndex: 0, delta: "real-partial-text" },
					]
				: kind === "thinking"
					? [
							{ type: "thinking_start", contentIndex: 0 },
							{ type: "thinking_delta", contentIndex: 0, delta: "real-partial-reasoning" },
						]
					: [
							{ type: "toolcall_start", contentIndex: 0, id: "owned-call", toolName: "write" },
							{ type: "toolcall_delta", contentIndex: 0, delta: "{}" },
							{
								type: "toolcall_end",
								contentIndex: 0,
								toolCall: { type: "toolCall", id: "owned-call", name: "write", arguments: {} },
							},
						]),
		];
		const output = await retryAssistantCall(
			async () => {
				const stream = models.stream(
					model,
					{ messages: [] },
					{
						fetch: async () => {
							calls++;
							if (calls > 1) return new Response(frames([{ type: "done", reason: "stop", usage }]));
							if (failure === "EOF") return new Response(frames(events));
							let n = 0;
							return new Response(
								new ReadableStream<Uint8Array>({
									pull(c) {
										if (n++ === 0) c.enqueue(encode.encode(frames(events)));
										else c.error(new Error("socket hang up synthetic-provider-diagnostic"));
									},
								}),
							);
						},
					},
				);
				for await (const event of stream)
					if ("partial" in event && hasAssistantOutput(event.partial)) observedOutput = true;
				return stream.result();
			},
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		);
		expect(observedOutput, `${kind}/${failure} fixture must really stream output`).toBe(true);
		expect(calls, `${kind}/${failure} must not issue a second request`).toBe(1);
		expect(output.stopReason).toBe("error");
	},
);
// smarty-dev#4703 R6: even an empty stream observer failure must not rerun the failing callback.
it("does not retry a transient-looking provider stream observer failure", async () => {
	const { models, model } = await runtime();
	let calls = 0,
		observers = 0;
	const output = await retryAssistantCall(
		() =>
			models.complete(
				model,
				{ messages: [] },
				{
					fetch: async () => {
						calls++;
						return new Response(frames([{ type: "start" }]));
					},
					onProviderStreamEvent: () => {
						observers++;
						throw new Error("terminated synthetic-observer-diagnostic");
					},
				},
			),
		{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
	);
	expect(calls).toBe(1);
	expect(observers).toBe(1);
	expect(isRetryableAssistantError(output)).toBe(false);
});
