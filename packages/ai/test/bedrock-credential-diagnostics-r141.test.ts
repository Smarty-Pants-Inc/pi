import { expect, it } from "vitest";
import { type BedrockOptions, stream } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
// pi#141 / P1-AUDIT-BEDROCK: refuse in onPayload before SDK send; no provider request.
it.each(
	(["bearerToken", "env", "signing"] as const).flatMap((source) =>
		[undefined, false, true].map((oauthDiagnostics) => ({ source, oauthDiagnostics })),
	),
)("masks $source credentials with OAuth option $oauthDiagnostics", async ({ source, oauthDiagnostics }) => {
	const key = `SYNTHETIC_BEDROCK_${source}`;
	let refused = 0;
	const options: BedrockOptions = {
		oauthDiagnostics,
		region: "us-east-1",
		env: {
			AWS_ACCESS_KEY_ID: source === "signing" ? key : "synthetic-access",
			AWS_SECRET_ACCESS_KEY: "synthetic-secret",
			AWS_SESSION_TOKEN: "synthetic-session",
			AWS_PROFILE: "",
		},
		onPayload: () => {
			refused++;
			throw new Error(`receipt=${key} synthetic-secret synthetic-session`);
		},
	};
	if (source === "bearerToken") options.bearerToken = `${key}\t`;
	else if (source === "env") options.env = { ...options.env, AWS_BEARER_TOKEN_BEDROCK: `${key}\t` };
	const events = stream(model, normalizeContext({ messages: [] }), options);
	const published: unknown[] = [];
	for await (const event of events) published.push(event);
	const output = await events.result();
	expect(refused).toBe(1);
	expect(output.stopReason).toBe("error");
	const sinks = JSON.stringify({ output, published });
	for (const value of [key, "synthetic-secret", "synthetic-session"]) expect(sinks).not.toContain(value);
});
