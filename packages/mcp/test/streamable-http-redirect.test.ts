import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamableHttpTransport } from "../src/transports/streamable-http.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

// pi#244: exercise the dormant transport's credential boundary without re-enabling MCP admission.
vi.mock("../src/security-admission.ts", () => ({ refuseMcpAdmission: () => {} }));

afterEach(closeServers);

describe("StreamableHttpTransport redirects", () => {
	it.each([301, 302, 303, 307, 308])("never sends POST credentials or body to another origin (%i)", async (status) => {
		const leaked: IncomingMessage[] = [];
		const destination = await listen(async (request, response) => {
			leaked.push(request);
			await readBody(request);
			response.writeHead(202).end();
		});
		const origin = await listen(async (request, response) => {
			await readBody(request);
			response.writeHead(status, { location: `${destination}/stolen` }).end();
		});
		const transport = new StreamableHttpTransport({ url: `${origin}/mcp`, headers: { "x-api-key": "secret" } });
		await transport.start();
		try {
			await expect(
				transport.send({ jsonrpc: "2.0", method: "private", params: { text: "prompt" } }),
			).rejects.toThrow("cross-origin redirect");
			expect(leaked).toHaveLength(0);
		} finally {
			await transport.close();
		}
	});

	it.each(["GET", "DELETE"])("never redirects credentialed %s off-origin", async (method) => {
		const leaked: IncomingMessage[] = [];
		const destination = await listen(async (request, response) => {
			leaked.push(request);
			response.writeHead(405).end();
		});
		const origin = await listen(async (request, response) => {
			if (request.method === method) {
				response.writeHead(307, { location: `${destination}/stolen` }).end();
				return;
			}
			await readBody(request);
			response.writeHead(202, { "mcp-session-id": "session" }).end();
		});
		const transport = new StreamableHttpTransport({
			url: `${origin}/mcp`,
			headers: { "x-api-key": "secret" },
			openGetStream: method === "GET",
		});
		const errors: Error[] = [];
		const failed = new Promise<Error>((resolve) =>
			transport.onError((error) => {
				errors.push(error);
				resolve(error);
			}),
		);
		await transport.start();
		try {
			await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			if (method === "DELETE") {
				// McpClient removes its transport listeners before close(), so the promise must report refusal.
				await expect(transport.close()).rejects.toThrow("cross-origin redirect");
			} else {
				expect((await failed).message).toContain("cross-origin redirect");
				expect(errors).toHaveLength(1);
			}
			expect(leaked).toHaveLength(0);
		} finally {
			await transport.close();
		}
	});

	it.each([307, 308])("follows one same-origin redirect preserving POST body and headers (%i)", async (status) => {
		const seen: { path?: string; method?: string; key?: string; body: string }[] = [];
		const origin = await listen(async (request, response) => {
			seen.push({
				path: request.url,
				method: request.method,
				key: request.headers["x-api-key"] as string,
				body: await readBody(request),
			});
			if (request.url === "/mcp") response.writeHead(status, { location: "/moved" }).end();
			else response.writeHead(202).end();
		});
		const transport = new StreamableHttpTransport({ url: `${origin}/mcp`, headers: { "x-api-key": "secret" } });
		const message = { jsonrpc: "2.0" as const, method: "private", params: { text: "prompt" } };
		await transport.start();
		try {
			await transport.send(message);
			expect(seen).toEqual(
				["/mcp", "/moved"].map((path) => ({ path, method: "POST", key: "secret", body: JSON.stringify(message) })),
			);
		} finally {
			await transport.close();
		}
	});

	it.each([
		["GET", 307],
		["GET", 308],
		["DELETE", 307],
		["DELETE", 308],
	] as const)("preserves credentialed %s across one same-origin %i", async (method, status) => {
		const seen: { path?: string; method?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
		let finish = () => {};
		const completed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const origin = await listen(async (request, response) => {
			const body = await readBody(request);
			if (request.method !== method) {
				response.writeHead(202, { "mcp-session-id": "session" }).end();
				return;
			}
			seen.push({ path: request.url, method: request.method, headers: request.headers, body });
			if (request.url === "/mcp") response.writeHead(status, { location: "/moved" }).end();
			else {
				response.writeHead(method === "GET" ? 405 : 204).end();
				finish();
			}
		});
		const transport = new StreamableHttpTransport({
			url: `${origin}/mcp`,
			headers: { "x-api-key": "secret" },
			authProvider: { token: async () => "bearer-secret" },
			openGetStream: method === "GET",
		});
		transport.setProtocolVersion("test-version");
		await transport.start();
		try {
			await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			if (method === "DELETE") await transport.close();
			await completed;
			expect(seen.map((request) => ({ path: request.path, method: request.method, body: request.body }))).toEqual(
				["/mcp", "/moved"].map((path) => ({ path, method, body: "" })),
			);
			expect(seen[0]?.headers).toEqual(seen[1]?.headers);
			expect(seen[1]?.headers).toMatchObject({
				"x-api-key": "secret",
				authorization: "Bearer bearer-secret",
				"mcp-session-id": "session",
				"mcp-protocol-version": "test-version",
			});
		} finally {
			await transport.close();
		}
	});

	it("rejects a second same-origin redirect without following it", async () => {
		const paths: string[] = [];
		const origin = await listen(async (request, response) => {
			paths.push(request.url ?? "");
			await readBody(request);
			response.writeHead(307, { location: request.url === "/mcp" ? "/second" : "/third" }).end();
		});
		const transport = new StreamableHttpTransport({ url: `${origin}/mcp` });
		await transport.start();
		try {
			await expect(transport.send({ jsonrpc: "2.0", method: "private" })).rejects.toThrow("redirect limit");
			expect(paths).toEqual(["/mcp", "/second"]);
		} finally {
			await transport.close();
		}
	});
});
