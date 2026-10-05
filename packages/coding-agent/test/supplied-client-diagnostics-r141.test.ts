import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "anthropic-messages",
	provider: "audit",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
// pi#141 / P1-AUDIT-CLIENT: supplied SDK authentication must be masked before real JSONL persistence.
it.each(
	(
		[
			"apiKey",
			"authToken",
			"defaultHeaders",
			"defaultAuthorization",
			"headersAuthorization",
			"tupleAuthorization",
			"dynamic",
		] as const
	).flatMap((kind) => [undefined, false, true].map((oauthDiagnostics) => ({ kind, oauthDiagnostics }))),
)("protects supplied $kind authentication with OAuth option $oauthDiagnostics", async ({ kind, oauthDiagnostics }) => {
	const key =
		kind === "authToken"
			? "[REDACTED:api-key]"
			: kind === "defaultAuthorization"
				? "sk-ant-" + "oat-synthetic-header"
				: `SYNTHETIC_CLIENT_${kind}`;
	let wire: Headers | undefined;
	const headerAuth =
		kind === "defaultAuthorization" || kind === "headersAuthorization" || kind === "tupleAuthorization";
	const bearerAuth = kind === "authToken" || kind === "dynamic" || headerAuth;
	const client = new Anthropic({
		apiKey:
			kind === "apiKey" ? `${key}\t` : kind === "defaultHeaders" || headerAuth ? "SYNTHETIC_OVERRIDDEN_KEY" : null,
		authToken: kind === "authToken" ? key : null,
		credentials: kind === "dynamic" ? async () => ({ token: key, expiresAt: null }) : null,
		webhookKey: null,
		defaultHeaders:
			kind === "defaultHeaders"
				? { "x-api-key": `${key}\t` }
				: kind === "defaultAuthorization"
					? { Authorization: `Bearer ${key}\t` }
					: kind === "headersAuthorization"
						? new Headers({ Authorization: `Bearer ${key}\t` })
						: kind === "tupleAuthorization"
							? [["Authorization", `Bearer ${key}\t`]]
							: undefined,
		baseURL: "https://mock.invalid",
		maxRetries: 0,
		fetch: async (_input, init) => {
			wire = new Headers(init?.headers);
			return Response.json({ error: { message: `receipt=${key} UNTRUSTED_CLIENT_DIAGNOSTIC` } }, { status: 403 });
		},
	});
	const events = stream(model, normalizeContext({ messages: [] }), { client, oauthDiagnostics, maxRetries: 0 });
	const published: unknown[] = [];
	for await (const event of events) published.push(event);
	const output = await events.result();
	expect(output.stopReason).toBe("error");
	expect(wire?.get(bearerAuth ? "authorization" : "x-api-key")).toBe(bearerAuth ? `Bearer ${key}` : key);
	const directory = mkdtempSync(join(tmpdir(), "pi-r141-client-journal-"));
	const session = SessionManager.create(directory, directory);
	session.appendMessage({ role: "user", content: "synthetic request", timestamp: 0 });
	session.appendMessage(output);
	const file = session.getSessionFile();
	if (!file) throw new Error("Missing actual journal");
	const jsonl = readFileSync(file, "utf8");
	expect(jsonl).toContain('"role":"assistant"');
	expect(jsonl).not.toContain(key);
	expect(JSON.stringify({ output, published })).not.toContain(key);
	if (kind === "authToken" || kind === "dynamic" || kind === "defaultAuthorization" || oauthDiagnostics) {
		expect(jsonl).not.toContain("UNTRUSTED_CLIENT_DIAGNOSTIC");
		expect(JSON.stringify(published)).not.toContain("UNTRUSTED_CLIENT_DIAGNOSTIC");
	}
});
