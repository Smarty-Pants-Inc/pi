import { expect, it } from "vitest";
import { McpClient, StdioTransport, StreamableHttpTransport } from "../src/index.ts";
import {
	adaptOAuthProvider,
	authorizeMcp,
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	exchangeAuthorizationCode,
	McpOAuthProvider,
	OAuthCallbackServer,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from "../src/oauth/index.ts";

const poison = new Proxy(
	{},
	{
		get() {
			throw new Error("INPUT_INSPECTED");
		},
	},
);
const refused = "MCP_SECURITY_REVIEW_REQUIRED";

// PR #131: public package admissions must refuse before input, process, network or store work.
it("refuses every public client, transport and provider constructor", () => {
	for (const construct of [
		() => new McpClient(poison as never),
		() => new StdioTransport(poison as never),
		() => new StreamableHttpTransport(poison as never),
		() => new McpOAuthProvider(poison as never),
	]) {
		expect(construct).toThrow(refused);
	}
	expect(() => adaptOAuthProvider(poison as never)).toThrow(refused);
});

it("refuses callback binding, discovery and OAuth flows before reading injected fetch or storage", async () => {
	for (const run of [
		() => OAuthCallbackServer.listen(poison),
		() => discoverProtectedResourceMetadata("https://example.invalid/mcp", poison),
		() => discoverAuthorizationServerMetadata("https://example.invalid", poison),
		() => discoverOAuthServerInfo("https://example.invalid/mcp", poison),
		() => startAuthorization("https://example.invalid", poison as never),
		() => registerClient("https://example.invalid", poison as never),
		() => exchangeAuthorizationCode("https://example.invalid", poison as never),
		() => refreshAuthorization("https://example.invalid", poison as never),
		() => authorizeMcp(poison as never, poison as never),
	])
		await expect(run()).rejects.toThrow(refused);
});
