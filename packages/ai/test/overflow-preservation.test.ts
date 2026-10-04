import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

const access = Buffer.from('{"alg":"none"}').toString("base64url") + "." +
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "audit-owned-account" } })).toString("base64url") + ".synthetic";
// smarty-dev#4703: owned overflow classification must survive suppression of provider prose.
it.each([openaiProvider(), openaiCodexProvider(), anthropicProvider()])("OAuth overflow preservation: $id", async provider => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider.id, async () => ({ type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 }));
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(provider);
  const output = await models.complete(provider.getModels()[0], { messages: [] }, {
    transport: "sse", maxRetries: 0,
    fetch: async () => Response.json({ type: "error", error: { type: "invalid_request_error", code: "context_length_exceeded", message: provider.id === "anthropic" ? "prompt is too long: 213462 tokens > 200000 maximum" : "Your input exceeds the context window of this model" } }, { status: 400 }),
  });
  expect(output.stopReason).toBe("error");
  expect(isContextOverflow(output), output.errorMessage).toBe(true);
});
