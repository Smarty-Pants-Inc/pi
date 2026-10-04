import { createServer } from "node:http";
import { LATEST_PROTOCOL_VERSION, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore, McpServerConnection, signInMcpServer } from "../src/extensions/mcp/runtime.ts";

// pi#137 / smarty-dev#3535, security finding 6.
it.each(["file:///tmp/local", "myapp://localhost/login", "http://remote.example/login"])(
	"never presents a discovered non-web sign-in target %s",
	async (authorizationEndpoint) => {
		let origin = "";
		const server = createServer((request, response) => {
			request.resume();
			if (request.url !== "/metadata") {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					issuer: origin,
					authorization_endpoint: authorizationEndpoint,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No TCP address");
		origin = `http://127.0.0.1:${address.port}`;
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()).forServer("fake", `${origin}/mcp`);
		const showAuthorizationUrl = vi.fn();
		const promptForRedirectUrl = vi.fn(async () => undefined);
		try {
			await expect(
				signInMcpServer({
					serverUrl: `${origin}/mcp`,
					store,
					settings: { clientId: "test", authServerMetadataUrl: new URL(`${origin}/metadata`) },
					prompt: { showAuthorizationUrl, promptForRedirectUrl },
				}),
			).rejects.toThrow("Invalid authorization endpoint");
			expect(showAuthorizationUrl).not.toHaveBeenCalled();
			expect(promptForRedirectUrl).not.toHaveBeenCalled();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);

// pi#137 / smarty-dev#3535, security finding 7.
it.each(["initialize", "tools/list", "resources/list"])("closes and joins MCP setup pending %s", async (stage) => {
	const pair = createInMemoryTransportPair();
	const seen: string[] = [];
	pair.server.onMessage((message) => {
		if (!("method" in message) || !("id" in message)) return;
		seen.push(message.method);
		if (message.method === stage) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {}, resources: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [] }
					: message.method === "resources/list"
						? { resources: [] }
						: { resourceTemplates: [] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	const close = vi.spyOn(pair.client, "close");
	const published = vi.fn();
	const connection = new McpServerConnection({
		entry: { name: "fake", config: { command: "unused" }, source: "test" },
		cwd: process.cwd(),
		createTransport: () => pair.client,
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: published,
	});
	const opening = connection.getClient();
	const outcome = opening.catch((error: unknown) => error);
	try {
		await vi.waitFor(() => expect(seen).toContain(stage));
		await connection.close();
		expect(await outcome).toBeInstanceOf(Error);
		expect(close).toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
		expect(connection.state).toBe("closed");
	} finally {
		await connection.close();
		await pair.server.close();
	}
});

it("aborts a stalled HTTP initialized notification and joins connection cleanup", async () => {
	let notificationStarted = false;
	let notificationClosed = false;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as { method: string; id?: number };
		if (message.method === "notifications/initialized") {
			notificationStarted = true;
			response.once("close", () => {
				notificationClosed = true;
			});
			return;
		}
		response.writeHead(200, { "content-type": "application/json" }).end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					serverInfo: { name: "fake", version: "1" },
				},
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No TCP address");
	const connection = new McpServerConnection({
		entry: {
			name: "fake",
			config: { url: `http://127.0.0.1:${address.port}`, headers: { Authorization: "test" } },
			source: "test",
		},
		cwd: process.cwd(),
		createTransport: (entry) =>
			new StreamableHttpTransport({ url: "url" in entry.config ? entry.config.url : "", openGetStream: false }),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: () => {},
	});
	const opening = connection.getClient().catch((error: unknown) => error);
	try {
		await vi.waitFor(() => expect(notificationStarted).toBe(true));
		await connection.close();
		expect(await opening).toBeInstanceOf(Error);
		await vi.waitFor(() => expect(notificationClosed).toBe(true));
	} finally {
		await connection.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
