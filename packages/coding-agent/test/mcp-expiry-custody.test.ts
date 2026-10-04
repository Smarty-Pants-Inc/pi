import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { createDefaultTransport, McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";

describe("expired MCP session custody", () => {
	// smarty-dev#3535 / pi#137 A11: expiration must not abandon a live GET SSE reader.
	it.each(["drain", "shutdown", "bound"] as const)("retains the expired transport until %s", async (mode) => {
		let sessions = 0;
		const streams = new Map<string, ServerResponse>();
		let held: { response: ServerResponse; id: number } | undefined;
		const server = createServer(async (request, response) => {
			const session = String(request.headers["mcp-session-id"] ?? "");
			if (request.method === "GET") {
				streams.set(session, response);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(": connected\n\n");
				response.on("close", () => streams.delete(session));
				return;
			}
			if (request.method === "DELETE") {
				response.writeHead(204).end();
				return;
			}
			let bytes = "";
			for await (const chunk of request) bytes += String(chunk);
			const message = JSON.parse(bytes) as { id?: number; method: string; params?: { name?: string } };
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			if (message.method === "tools/call" && session === "1") {
				if (message.params?.name === "hold") {
					held = { response, id: message.id };
					return;
				}
				response.writeHead(404).end("expired");
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "fake", version: "1" },
						}
					: message.method === "tools/list"
						? { tools: [] }
						: { content: [{ type: "text", text: "ok" }] };
			response.writeHead(200, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "mcp-session-id": String(++sessions) } : {}),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const connection = new McpServerConnection({
			entry: {
				name: "fake",
				source: "test",
				config: {
					url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
					headers: { Authorization: "test" },
					timeout: mode === "bound" ? 0.2 : 5,
				},
			},
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		let pending: Promise<unknown> | undefined;
		try {
			await connection.getClient();
			await expect.poll(() => streams.has("1")).toBe(true);
			pending = connection.callTool("hold", {}, { timeoutMs: 0 }).then(
				(value) => value,
				(error: unknown) => error,
			);
			await expect.poll(() => held !== undefined).toBe(true);
			expect(await connection.callTool("expire", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
			await expect.poll(() => streams.has("2")).toBe(true);
			if (mode === "drain") {
				expect(streams.has("1")).toBe(true);
				held!.response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: held!.id,
						result: { content: [{ type: "text", text: "drained" }] },
					}),
				);
				expect(await pending).toEqual({ content: [{ type: "text", text: "drained" }] });
				await expect.poll(() => streams.has("1")).toBe(false);
			} else if (mode === "bound") {
				await expect.poll(() => streams.has("1"), { timeout: 2000 }).toBe(false);
				expect(await pending).toBeInstanceOf(Error);
			} else {
				await connection.close();
				await expect.poll(() => streams.size).toBe(0);
				expect(await pending).toBeInstanceOf(Error);
			}
			await connection.close();
			await expect.poll(() => streams.size).toBe(0);
		} finally {
			await connection.close();
			for (const response of streams.values()) response.destroy();
			held?.response.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await pending;
		}
	});
});
