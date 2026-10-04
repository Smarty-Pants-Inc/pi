import { afterEach, expect, it, vi } from "vitest";
import { exchangeAuthorizationCode, refreshAuthorization, startAuthorization } from "../src/oauth/flow.ts";
import { parseAuthorizationServerMetadata } from "../src/oauth/types.ts";
import { StreamableHttpTransport } from "../src/transports/streamable-http.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

afterEach(closeServers);

// pi#137 / smarty-dev#3535, security findings 2, 6 and 10.
it.each([307, 308])("rejects %s token redirects without forwarding POST credentials", async (status) => {
	const stolen: string[] = [];
	const destination = await listen(async (request, response) => {
		stolen.push(await readBody(request));
		response
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ access_token: "stolen", token_type: "Bearer" }));
	});
	const origin = await listen(async (_request, response) => {
		response.writeHead(status, { location: `${destination}/token` }).end();
	});
	const options = {
		clientInformation: {
			client_id: "client",
			client_secret: "secret",
			token_endpoint_auth_method: "client_secret_post",
			redirect_uris: [],
		},
	};
	await expect(refreshAuthorization(origin, { ...options, refreshToken: "private-refresh" })).rejects.toThrow();
	await expect(
		exchangeAuthorizationCode(origin, {
			...options,
			code: "private-code",
			codeVerifier: "private-verifier",
			redirectUrl: "http://localhost/callback",
		}),
	).rejects.toThrow();
	expect(stolen).toEqual([]);
});

it.each([307, 308])("rejects %s MCP POST, GET and DELETE redirects with custom credential headers", async (status) => {
	const stolen: unknown[] = [];
	const destination = await listen(async (request, response) => {
		stolen.push(request.headers["x-api-key"]);
		response.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	let redirect = false;
	const methods: string[] = [];
	const origin = await listen(async (request, response) => {
		methods.push(request.method ?? "");
		if (redirect || request.method === "GET" || request.method === "DELETE") {
			response.writeHead(status, { location: destination }).end();
		} else response.writeHead(202, { "mcp-session-id": "test" }).end();
	});
	const transport = new StreamableHttpTransport({
		url: origin,
		headers: { "x-api-key": "private-key" },
		reconnect: { maxRetries: 0 },
	});
	const errors: Error[] = [];
	transport.onError((error) => errors.push(error));
	await transport.start();
	await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
	redirect = true;
	await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toThrow();
	await transport.close();
	expect(methods).toEqual(expect.arrayContaining(["POST", "GET", "DELETE"]));
	expect(errors.length).toBeGreaterThan(0);
	expect(stolen).toEqual([]);
});

it.each(["file:///tmp/local", "myapp://localhost/login", "ftp://localhost/login", "http://remote.example/login"])(
	"rejects discovered and configured non-web authorization endpoint %s",
	async (authorization_endpoint) => {
		const metadata = {
			issuer: "https://auth.example",
			authorization_endpoint,
			token_endpoint: "https://auth.example/token",
			response_types_supported: ["code"],
		};
		expect(() => parseAuthorizationServerMetadata(metadata)).toThrow();
		await expect(
			startAuthorization(metadata.issuer, {
				metadata,
				clientInformation: { client_id: "client" },
				redirectUrl: "http://localhost/callback",
			}),
		).rejects.toThrow();
	},
);

it.each([false, true])("cancels oversized streamed JSON before parsing (batch=%s)", async (batch) => {
	let cancelled = false;
	let produced = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			produced++;
			controller.enqueue(new TextEncoder().encode(`${batch ? "[" : "{"}${" ".repeat(100)}`));
		},
		cancel() {
			cancelled = true;
		},
	});
	const transport = new StreamableHttpTransport({
		url: "https://example.test",
		openGetStream: false,
		maxMessageBytes: 64,
		fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }),
	});
	await transport.start();
	try {
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toThrow("exceeds 64 bytes");
	} finally {
		await transport.close();
	}
	expect(cancelled).toBe(true);
	expect(produced).toBeLessThanOrEqual(2);
});

it("cancels oversized streamed error bodies at the 8 KiB byte bound", async () => {
	let cancelled = false;
	let produced = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			produced++;
			controller.enqueue(new TextEncoder().encode("é".repeat(5000)));
		},
		cancel() {
			cancelled = true;
		},
	});
	const transport = new StreamableHttpTransport({
		url: "https://example.test",
		openGetStream: false,
		fetch: async () => new Response(stream, { status: 500 }),
	});
	await transport.start();
	try {
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toMatchObject({
			status: 500,
			body: expect.any(String),
		});
	} finally {
		await transport.close();
	}
	expect(cancelled).toBe(true);
	expect(produced).toBeLessThanOrEqual(2);
});
