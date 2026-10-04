import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

const access = Buffer.from('{"alg":"none"}').toString("base64url") + "." +
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "audit-owned-account" } })).toString("base64url") + ".synthetic";
const terminal = () => new Response('data: ' + JSON.stringify({ type: "response.completed", response: { id: "resp_owned", status: "completed", output: [] } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });

// smarty-dev#4703: redacting diagnostics must not disable bounded retries for owned transient failures.
describe.each([openaiProvider(), openaiCodexProvider()])("OAuth retry preservation: $id", provider => {
  it.each(["transport", "early EOF"])("still retries %s with no emitted output", async kind => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(provider.id, async () => ({ type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 }));
    const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(provider);
    const model = provider.getModels()[0];
    let calls = 0;
    const output = await retryAssistantCall(async () => models.complete(model, { messages: [] }, {
      transport: "sse", maxRetries: 0,
      fetch: async () => {
        calls++;
        if (calls > 1) return terminal();
        if (kind === "transport") throw new TypeError("fetch failed");
        return new Response('data: ' + JSON.stringify({ type: "response.created", response: { id: "resp_owned", status: "in_progress", output: [] } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    }), { enabled: true, maxRetries: 1, baseDelayMs: 0 });
    expect(calls).toBe(2);
    expect(output.stopReason).toBe("stop");
  });
});
