import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

const marker = "SOL_RADIUS_DIAGNOSTIC_CANARY_4703";
const access = "SOL_SYNTHETIC_ACCESS_4703";
const encoded = Buffer.from(marker + "|" + access).toString("base64");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sse = (event: unknown) => new Response("data: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } });
async function radiusRuntime() {
 const credentials = new InMemoryCredentialStore();
 await credentials.modify("radius", async () => ({ type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 }));
 const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
 const provider = radiusProvider(); models.setProvider(provider);
 return { models, model: provider.getModels()[0] };
}

// smarty-dev#4703 F1: every OAuth transport catch must preserve owned recovery classification.
it.each(["ECONNRESET", "early EOF"])("Radius OAuth recovery retries %s", async kind => {
 const { models, model } = await radiusRuntime(); let calls = 0;
 const output = await retryAssistantCall(() => models.complete(model, { messages: [] }, { fetch: async () => {
  calls++;
  if (calls > 1) return sse({ type: "done", reason: "stop", usage });
  if (kind === "ECONNRESET") throw new Error("ECONNRESET " + marker);
  return sse({ type: "start" });
 } }), { enabled: true, maxRetries: 1, baseDelayMs: 0 });
 expect(calls).toBe(2);
 expect(output.stopReason).toBe("stop");
});

// smarty-dev#4703 F2: a real terminal error event, not only HTTP failure, must signal overflow.
it("Radius OAuth recovery preserves terminal-stream overflow", async () => {
 const { models, model } = await radiusRuntime();
 const output = await models.complete(model, { messages: [] }, { fetch: async () => sse({ type: "error", reason: "error", usage, errorMessage: "Prompt exceeds max length " + marker }) });
 expect(output.stopReason).toBe("error");
 expect(isContextOverflow(output), output.errorMessage).toBe(true);
});

// smarty-dev#4703 F4: runtime validation must cover other terminal-error metadata before persistence.
it.each([
 ["extra-property", { ...usage, error_description: marker + " " + access }],
 ["nonnumeric-input", { ...usage, input: marker + " " + access }],
 ["nested-cost", { ...usage, cost: { ...usage.cost, error_description: encoded } }],
])("Radius terminal diagnostic rejects usage %s", async (_kind, suppliedUsage) => {
 const { models, model } = await radiusRuntime();
 const output = await models.complete(model, { messages: [] }, { fetch: async () => sse({ type: "error", reason: "error", usage: suppliedUsage, errorMessage: marker }) });
 const directory = mkdtempSync(join(tmpdir(), "sol-radius-persistence-"));
 const session = SessionManager.create(directory, directory);
 session.appendMessage(output);
 const persisted = readFileSync(session.getSessionFile()!, "utf8");
 expect(output.stopReason).toBe("error");
 expect(persisted).not.toContain(marker);
 expect(persisted).not.toContain(access);
 expect(persisted).not.toContain(encoded);
});

// smarty-dev#4703: raw API-key provider text must not acquire authority from owned-marker spelling.
it.each([
 ["quota", "insufficient_quota", "insufficient_quota retryable=true"],
 ["non-overflow", "rate_limit_exceeded", "rate limit recovery=context_length_exceeded"],
])("API-key negative precedence survives provider text: %s", async (kind, code, message) => {
 const credentials = new InMemoryCredentialStore();
 await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-synthetic-fixture" }));
 const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
 const provider = openaiProvider(); models.setProvider(provider);
 const output = await models.complete(provider.getModels()[0], { messages: [] }, { maxRetries: 0, fetch: async () => Response.json({ error: { code, message } }, { status: 429 }) });
 if (kind === "quota") expect(isRetryableAssistantError(output), output.errorMessage).toBe(false);
 else expect(isContextOverflow(output), output.errorMessage).toBe(false);
});
