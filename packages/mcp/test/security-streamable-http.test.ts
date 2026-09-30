import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	isJsonRpcRequest,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	McpConnectionClosedError,
	McpHttpError,
	McpTimeoutError,
	parseJsonRpcMessage,
	StreamableHttpTransport,
} from "../src/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

const clients: McpClient[] = [];

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function within<Value>(promise: Promise<Value>): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("HTTP body did not retire within 1500ms")), 1500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function reply(response: ServerResponse, id: JsonRpcRequest["id"], result: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function fixture(
	handler: (message: JsonRpcRequest, response: ServerResponse) => void,
	maxMessageBytes = 1024,
	initialize?: (message: JsonRpcRequest, response: ServerResponse) => void,
) {
	const cancelled: unknown[] = [];
	const cancellationReceived = deferred<unknown>();
	const origin = await listen(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(request.method === "GET" ? 405 : 200).end();
			return;
		}
		const message = parseJsonRpcMessage(JSON.parse(await readBody(request)));
		if (!isJsonRpcRequest(message)) {
			if ("method" in message && message.method === "notifications/cancelled") {
				cancelled.push(message.params);
				cancellationReceived.resolve(message.params);
			}
			response.writeHead(202).end();
			return;
		}
		if (message.method === "initialize") {
			if (initialize) initialize(message, response);
			else {
				reply(response, message.id, {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					serverInfo: { name: "security-http", version: "1" },
				});
			}
			return;
		}
		handler(message, response);
	});
	const client = new McpClient({ name: "security-http", version: "1", requestTimeoutMs: 1000 });
	clients.push(client);
	const transport = new StreamableHttpTransport({ url: origin, openGetStream: false, maxMessageBytes });
	return { client, transport, cancelled, cancellationReceived: cancellationReceived.promise };
}

function growingBody(response: ServerResponse, type: "json" | "error" | "sse") {
	const closed = deferred<void>();
	response.writeHead(type === "error" ? 400 : 200, {
		"content-type": type === "sse" ? "text/event-stream" : "application/json",
	});
	response.write(type === "json" ? '{"jsonrpc":"2.0","result":"' : type === "sse" ? ": waiting\n\n" : "error: ");
	let writes = 0;
	const timer = setInterval(() => {
		writes++;
		response.write(type === "sse" ? ": still waiting\n\n" : "xxxxxxxxxxxxxxxx");
	}, 5);
	response.on("close", () => {
		clearInterval(timer);
		closed.resolve();
	});
	return { closed: closed.promise, writes: () => writes };
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await closeServers();
});

// smarty-dev#2241, security F11 / Astra A3: exercise the public client with real loopback HTTP bodies.
describe("MCP HTTP received-byte and request-lifetime bounds", () => {
	it.each([false, true])(
		"rejects oversized JSON before parsing (chunked=%s) and retires its body",
		async (chunked) => {
			const retired = deferred<void>();
			let sent = 0;
			const { client, transport } = await fixture((message, response) => {
				const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "x".repeat(4096) });
				response.writeHead(200, { "content-type": "application/json" });
				response.on("close", () => retired.resolve());
				if (!chunked) {
					response.end(body);
					return;
				}
				const timer = setInterval(() => {
					response.write(body.slice(sent, sent + 128));
					sent += 128;
					if (sent >= body.length) {
						clearInterval(timer);
						response.end();
					}
				}, 5);
				response.on("close", () => clearInterval(timer));
			});
			await client.connect(transport);
			await expect(client.request("oversized")).rejects.toThrow("MCP JSON message exceeds 1024 bytes");
			await within(retired.promise);
			if (chunked) expect(sent).toBeLessThan(4096);
			expect(client.connectionState).toBe("connected");
		},
	);

	it("counts UTF-8 bytes rather than JSON string characters", async () => {
		const { client, transport } = await fixture((message, response) => reply(response, message.id, "é".repeat(600)));
		await client.connect(transport);
		await expect(client.request("multibyte")).rejects.toThrow("MCP JSON message exceeds 1024 bytes");
	});

	it("accepts an exact-limit chunked JSON batch and delivers notifications following its reply", async () => {
		const noticed = deferred<unknown>();
		const { client, transport } = await fixture((message, response) => {
			const result = { jsonrpc: "2.0", id: message.id, result: "" };
			const batch = [result, { jsonrpc: "2.0", method: "notifications/test", params: { kept: true } }];
			result.result = "x".repeat(1024 - Buffer.byteLength(JSON.stringify(batch)));
			const body = JSON.stringify(batch);
			expect(Buffer.byteLength(body)).toBe(1024);
			response.writeHead(200, { "content-type": "application/json" });
			response.write(body.slice(0, 31));
			response.end(body.slice(31));
		});
		client.onNotification("notifications/test", (params) => noticed.resolve(params));
		await client.connect(transport);
		const result = await client.request<string>("bounded");
		expect(result.length).toBeGreaterThan(800);
		expect(await within(noticed.promise)).toEqual({ kept: true });
	});

	it.each([false, true])("keeps only an 8KiB error prefix and cancels the remainder (chunked=%s)", async (chunked) => {
		const retired = deferred<void>();
		const prefix = "é".repeat(4096);
		const { client, transport } = await fixture((_message, response) => {
			response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
			response.on("close", () => retired.resolve());
			if (!chunked) {
				response.end(prefix + "must not be retained".repeat(1000));
				return;
			}
			const bytes = Buffer.from(prefix);
			let sent = 0;
			const timer = setInterval(() => {
				// Odd chunk sizes also exercise decoding across a UTF-8 code point boundary.
				response.write(sent < bytes.length ? bytes.subarray(sent, sent + 1023) : Buffer.alloc(1023, 120));
				sent += 1023;
			}, 5);
			response.on("close", () => clearInterval(timer));
		});
		await client.connect(transport);
		const error: unknown = await client.request("error").catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(McpHttpError);
		if (!(error instanceof McpHttpError)) throw new Error("Expected bounded HTTP error");
		expect(error.body).toBe(prefix);
		expect(Buffer.byteLength(error.body)).toBe(8192);
		expect(error.message.length).toBeLessThan(600);
		await within(retired.promise);
	});

	it.each(["json", "error", "sse"] as const)(
		"timeout stops a continuously growing %s body without cancelling a concurrent live request",
		async (type) => {
			const bodyStarted = deferred<ReturnType<typeof growingBody>>();
			const normalStarted = deferred<{ message: JsonRpcRequest; response: ServerResponse }>();
			const { client, transport, cancellationReceived } = await fixture((message, response) => {
				if (message.method === "growing") bodyStarted.resolve(growingBody(response, type));
				else normalStarted.resolve({ message, response });
			}, 1024 * 1024);
			const errors: Error[] = [];
			client.onError((error) => errors.push(error));
			await client.connect(transport);
			const normal = client.request("normal", undefined, { timeoutMs: 4000 });
			const failure = client.request("growing", undefined, { timeoutMs: 150 }).catch((error: unknown) => error);
			const growing = await within(bodyStarted.promise);
			const other = await within(normalStarted.promise);
			let otherClosed = false;
			other.response.on("close", () => {
				otherClosed = true;
			});
			expect(await failure).toBeInstanceOf(McpTimeoutError);
			await within(growing.closed);
			expect(otherClosed).toBe(false);
			expect(growing.writes()).toBeLessThan(300);
			reply(other.response, other.message.id, { live: true });
			expect(await normal).toEqual({ live: true });
			// The cooperative cancellation notification has its own uncancelled send.
			expect(await within(cancellationReceived)).toEqual({ requestId: 3, reason: "Request timed out" });
			expect(errors).toEqual([]);
			expect(client.connectionState).toBe("connected");
		},
	);

	it.each(["json", "error", "sse"] as const)("abort stops only the original %s body", async (type) => {
		const started = deferred<ReturnType<typeof growingBody>>();
		const { client, transport } = await fixture((message, response) => {
			if (message.method === "growing") started.resolve(growingBody(response, type));
			else reply(response, message.id, { usable: true });
		}, 1024 * 1024);
		await client.connect(transport);
		const controller = new AbortController();
		const failure = client
			.request("growing", undefined, { signal: controller.signal })
			.catch((error: unknown) => error);
		const growing = await within(started.promise);
		controller.abort("stop this request");
		expect(await failure).toBeInstanceOf(McpAbortError);
		await within(growing.closed);
		expect(await client.request("normal")).toEqual({ usable: true });
	});

	it("retires an open response SSE body on reply without dropping later notifications in the same event chunk", async () => {
		const retired = deferred<void>();
		const noticed = deferred<unknown>();
		const { client, transport } = await fixture((message, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.on("close", () => retired.resolve());
			response.write(
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n\n` +
					`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/test", params: { kept: true } })}\n\n`,
			);
		});
		client.onNotification("notifications/test", (params) => noticed.resolve(params));
		await client.connect(transport);
		expect(await client.request("sse")).toEqual({ ok: true });
		expect(await within(noticed.promise)).toEqual({ kept: true });
		await within(retired.promise);
	});

	it.each(["timeout", "close"] as const)(
		"retires an unpublished initialize body on startup %s without protocol cancellation",
		async (mode) => {
			const started = deferred<ReturnType<typeof growingBody>>();
			const { client, transport, cancelled } = await fixture(
				(message, response) => reply(response, message.id, {}),
				1024 * 1024,
				(_message, response) => started.resolve(growingBody(response, "json")),
			);
			const failure = client.connect(transport).catch((error: unknown) => error);
			const growing = await within(started.promise);
			if (mode === "close") await client.close();
			expect(await failure).toBeInstanceOf(mode === "close" ? McpConnectionClosedError : McpTimeoutError);
			await within(growing.closed);
			expect(cancelled).toEqual([]);
			expect(client.connectionState).toBe("closed");
		},
	);
});
