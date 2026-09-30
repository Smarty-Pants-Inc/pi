import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	isJsonRpcRequest,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	type McpClientOptions,
	type McpRequestOptions,
	McpTimeoutError,
	parseJsonRpcMessage,
	StreamableHttpTransport,
} from "../src/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const clients: McpClient[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();

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
				timer = setTimeout(() => reject(new Error("Catalogue HTTP control did not settle within 1500ms")), 1500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function failureMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function reply(response: ServerResponse, id: JsonRpcRequest["id"], result: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function fixture(
	handler: (message: JsonRpcRequest, response: ServerResponse) => void,
	options: McpClientOptions & { catalogueTimeoutMs?: number } = { name: "catalogue-test", version: "1" },
) {
	const requests: JsonRpcRequest[] = [];
	const cancelled = deferred<unknown>();
	const errors: Error[] = [];
	const origin = await listen(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const message = parseJsonRpcMessage(JSON.parse(await readBody(request)));
		if (!isJsonRpcRequest(message)) {
			if ("method" in message && message.method === "notifications/cancelled") cancelled.resolve(message.params);
			response.writeHead(202).end();
			return;
		}
		if (message.method === "initialize") {
			reply(response, message.id, {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "catalogue-fixture", version: "1" },
			});
			return;
		}
		requests.push(message);
		handler(message, response);
	});
	const client = new McpClient(options);
	clients.push(client);
	client.onError((error) => errors.push(error));
	// Raise the transport cap only to isolate the client's own single-page cap.
	await client.connect(
		new StreamableHttpTransport({ url: origin, openGetStream: false, maxMessageBytes: MAX_BYTES * 2 }),
	);
	return { client, requests, cancelled: cancelled.promise, errors };
}

interface CataloguePath {
	name: string;
	key: string;
	item: Record<string, unknown>;
	list: (client: McpClient, options?: McpRequestOptions) => Promise<unknown>;
}

const allPaths: CataloguePath[] = [
	{
		name: "tools",
		key: "tools",
		item: { name: "echo", inputSchema: {} },
		list: (client, options) => client.listTools(options),
	},
	{
		name: "resources",
		key: "resources",
		item: { uri: "file:///one" },
		list: (client, options) => client.listResources(options),
	},
	{
		name: "templates",
		key: "resourceTemplates",
		item: { uriTemplate: "repo://{id}" },
		list: (client, options) => client.listResourceTemplates(options),
	},
];
const pagePaths: CataloguePath[] = [
	{ ...allPaths[1], name: "resources page", list: (client, options) => client.listResourcesPage(undefined, options) },
	{
		...allPaths[2],
		name: "templates page",
		list: (client, options) => client.listResourceTemplatesPage(undefined, options),
	},
];
const paths = [...allPaths, ...pagePaths];

afterEach(async () => {
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await closeServers();
});

// smarty-dev#2241 / Pi PR92 round2: actual public APIs, real loopback HTTP, no credentials.
describe("bounded MCP catalogue traversal", () => {
	for (const path of allPaths) {
		it.each(["x", "é"])(
			`bounds aggregate ${path.name} UTF-8 result bytes (%s) before retaining another page`,
			async (character) => {
				let pages = 0;
				const description = character.repeat(character === "x" ? 9 * 1024 * 1024 : (9 * 1024 * 1024) / 2);
				const { client, requests } = await fixture((message, response) => {
					pages++;
					reply(response, message.id, {
						[path.key]: [{ ...path.item, description }],
						...(pages === 1 ? { nextCursor: "second" } : {}),
					});
				});
				expect(await failureMessage(path.list(client))).toMatch(/exceeded .* bytes/);
				expect(requests).toHaveLength(2);
				expect(client.connectionState).toBe("connected");
			},
		);

		it(`bounds aggregate ${path.name} items across individually acceptable pages`, async () => {
			let pages = 0;
			const { client, requests } = await fixture((message, response) => {
				pages++;
				reply(response, message.id, {
					[path.key]: Array(5001).fill(path.item),
					...(pages === 1 ? { nextCursor: "second" } : {}),
				});
			});
			expect(await failureMessage(path.list(client))).toMatch(/exceeded 10000 items/);
			expect(requests).toHaveLength(2);
		});
	}

	for (const path of paths) {
		it(`rejects a single oversized ${path.name} result including unrecognized metadata`, async () => {
			const { client } = await fixture((message, response) =>
				reply(response, message.id, {
					[path.key]: [path.item],
					_meta: { padding: "x".repeat(MAX_BYTES) },
				}),
			);
			expect(await failureMessage(path.list(client))).toMatch(/exceeded .* bytes/);
		});

		it(`bounds ${path.name} single-page items before validation/normalization`, async () => {
			// An invalid final item proves the size guard runs before item validation.
			const { client } = await fixture((message, response) =>
				reply(response, message.id, {
					[path.key]: [...Array(10000).fill(path.item), null],
				}),
			);
			expect(await failureMessage(path.list(client))).toMatch(/exceeded 10000 items/);
		});
	}

	it("accepts the exact UTF-8 byte and item limits", async () => {
		const result = { tools: [{ name: "echo", inputSchema: {}, description: "" }] };
		result.tools[0].description = "é".repeat((MAX_BYTES - Buffer.byteLength(JSON.stringify(result))) / 2);
		// The JSON overhead is odd, so add the remaining single-byte character.
		result.tools[0].description += "x".repeat(MAX_BYTES - Buffer.byteLength(JSON.stringify(result)));
		expect(Buffer.byteLength(JSON.stringify(result))).toBe(MAX_BYTES);
		let calls = 0;
		const { client } = await fixture((message, response) =>
			reply(
				response,
				message.id,
				calls++ === 0 ? result : { tools: Array(10000).fill({ name: "echo", inputSchema: {} }) },
			),
		);
		expect(await client.listTools()).toHaveLength(1);
		expect(await client.listTools()).toHaveLength(10000);
	});

	it("charges empty pages and their cursors/metadata against aggregate bytes", async () => {
		let pages = 0;
		const { client, requests } = await fixture((message, response) => {
			pages++;
			reply(response, message.id, {
				resources: [],
				...(pages < 3 ? { nextCursor: String(pages) } : {}),
				_meta: { padding: "x".repeat(9 * 1024 * 1024) },
			});
		});
		await expect(client.listResources()).rejects.toThrow(/exceeded .* bytes/);
		expect(requests).toHaveLength(2);
	});

	it("stops many tiny distinct pages at 100 without requesting page 101", async () => {
		const { client, requests } = await fixture((message, response) =>
			reply(response, message.id, {
				tools: [],
				...(requests.length < 150 ? { nextCursor: String(requests.length) } : {}),
			}),
		);
		await expect(client.listTools()).rejects.toThrow("exceeded 100 pages");
		expect(requests).toHaveLength(100);
	});

	it("accepts exactly 100 terminating pages", async () => {
		const { client, requests } = await fixture((message, response) =>
			reply(response, message.id, {
				resourceTemplates: [{ uriTemplate: `repo://${requests.length}/{id}` }],
				...(requests.length < 100 ? { nextCursor: String(requests.length) } : {}),
			}),
		);
		expect(await client.listResourceTemplates()).toHaveLength(100);
		expect(requests).toHaveLength(100);
	});

	it("preserves normal multi-page results, duplicate-cursor detection and page cursor passthrough", async () => {
		const { client, requests } = await fixture((message, response) => {
			const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
			if (message.method === "tools/list") reply(response, message.id, { tools: [], nextCursor: "repeated" });
			else if (message.method === "resources/list")
				reply(
					response,
					message.id,
					cursor === undefined
						? { resources: [{ uri: "file:///one" }], nextCursor: "two" }
						: { resources: [{ uri: "file:///two" }] },
				);
			else reply(response, message.id, { resourceTemplates: [{ uriTemplate: "repo://{id}" }], nextCursor: "more" });
		});
		expect(await client.listResources()).toEqual([
			{ uri: "file:///one", name: "file:///one" },
			{ uri: "file:///two", name: "file:///two" },
		]);
		expect(await client.listResourcesPage("two")).toEqual({
			resources: [{ uri: "file:///two", name: "file:///two" }],
		});
		expect(requests[2].params).toEqual({ cursor: "two" });
		expect(await client.listResourceTemplatesPage("opaque")).toEqual({
			resourceTemplates: [{ uriTemplate: "repo://{id}", name: "repo://{id}" }],
			nextCursor: "more",
		});
		expect(requests[3].params).toEqual({ cursor: "opaque" });
		await expect(client.listTools()).rejects.toThrow("duplicate cursor: repeated");
	});

	it("does not restart the whole deadline on distinct slow pages or progress; retires only the current SSE body", async () => {
		const retired = deferred<void>();
		const otherStarted = deferred<{ message: JsonRpcRequest; response: ServerResponse }>();
		let pages = 0;
		let progressCount = 0;
		const { client, requests, cancelled, errors } = await fixture(
			(message, response) => {
				if (message.method === "tools/call") {
					otherStarted.resolve({ message, response });
					return;
				}
				pages++;
				const pageNumber = pages;
				const token = (message.params as { _meta: { progressToken: number } })._meta.progressToken;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.flushHeaders();
				const progressTimer = setInterval(
					() =>
						response.write(
							`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1 } })}\n\n`,
						),
					20,
				);
				timers.add(progressTimer);
				const resultTimer = setTimeout(
					() =>
						response.write(
							`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [], ...(pageNumber < 4 ? { nextCursor: String(pageNumber) } : {}) } })}\n\n`,
						),
					110,
				);
				timers.add(resultTimer);
				response.on("close", () => {
					clearInterval(progressTimer);
					clearTimeout(resultTimer);
					if (pageNumber === 2) retired.resolve();
				});
			},
			{ name: "catalogue-test", version: "1", catalogueTimeoutMs: 190 },
		);
		const other = client.callTool("held", undefined, { timeoutMs: 1000 }).catch((error: unknown) => error);
		const otherRequest = await within(otherStarted.promise);
		let otherClosed = false;
		otherRequest.response.on("close", () => {
			otherClosed = true;
		});
		const failure = await client
			.listTools({
				timeoutMs: 70,
				onProgress: () => {
					progressCount++;
				},
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(McpTimeoutError);
		expect(failure).toMatchObject({ timeoutMs: 190 });
		await within(retired.promise);
		expect(pages).toBe(2);
		expect(progressCount).toBeGreaterThan(2);
		expect(otherClosed).toBe(false);
		expect(await within(cancelled)).toMatchObject({ requestId: requests[2].id });
		reply(otherRequest.response, otherRequest.message.id, { content: [], structuredContent: { live: true } });
		expect(await other).toMatchObject({ structuredContent: { live: true } });
		expect(errors).toEqual([]);
		expect(client.connectionState).toBe("connected");
	});

	it.each([0, -1, Number.POSITIVE_INFINITY])(
		"whole deadline still retires a growing JSON page when timeoutMs=%s",
		async (timeoutMs) => {
			const retired = deferred<void>();
			const { client, cancelled } = await fixture(
				(message, response) => {
					response.writeHead(200, { "content-type": "application/json" });
					response.write(`{"jsonrpc":"2.0","id":${message.id},"result":{"resources":[`);
					const timer = setInterval(() => response.write(" "), 10);
					timers.add(timer);
					response.on("close", () => {
						clearInterval(timer);
						retired.resolve();
					});
					const finish = setTimeout(() => response.end("]}}"), 400);
					timers.add(finish);
				},
				{ name: "catalogue-test", version: "1", catalogueTimeoutMs: 80 },
			);
			await expect(client.listResourcesPage(undefined, { timeoutMs })).rejects.toMatchObject({
				name: "McpTimeoutError",
				timeoutMs: 80,
			});
			await within(retired.promise);
			expect(await within(cancelled)).toMatchObject({ requestId: 2 });
		},
	);

	it.each(["all", "page"] as const)(
		"caller abort retires the active %s catalogue body and preserves request attribution",
		async (mode) => {
			const started = deferred<void>();
			const retired = deferred<void>();
			const { client, cancelled, requests } = await fixture((message, response) => {
				if (message.method === "ping") {
					reply(response, message.id, {});
					return;
				}
				if (mode === "all" && requests.length === 1) {
					reply(response, message.id, { resourceTemplates: [], nextCursor: "two" });
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(": waiting\n\n");
				response.on("close", () => retired.resolve());
				started.resolve();
			});
			const controller = new AbortController();
			const failure = (
				mode === "all"
					? client.listResourceTemplates({ signal: controller.signal })
					: client.listResourceTemplatesPage(undefined, { signal: controller.signal })
			).catch((error: unknown) => error);
			await within(started.promise);
			controller.abort("stop catalogue");
			expect(await failure).toBeInstanceOf(McpAbortError);
			await within(retired.promise);
			expect(await within(cancelled)).toEqual({ requestId: mode === "all" ? 3 : 2, reason: "stop catalogue" });
			await client.ping();
			expect(client.connectionState).toBe("connected");
		},
	);

	it("does not send a catalogue request for an already-aborted caller", async () => {
		const { client, requests } = await fixture((message, response) => reply(response, message.id, { tools: [] }));
		const controller = new AbortController();
		controller.abort();
		await expect(client.listTools({ signal: controller.signal })).rejects.toBeInstanceOf(McpAbortError);
		expect(requests).toEqual([]);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
		"rejects non-finite/disabled/overflowing catalogue timeout configuration (%s)",
		async (catalogueTimeoutMs) => {
			const { client, requests } = await fixture((message, response) => reply(response, message.id, { tools: [] }), {
				name: "catalogue-test",
				version: "1",
				catalogueTimeoutMs,
			});
			await expect(client.listTools()).rejects.toThrow("catalogueTimeoutMs");
			expect(requests).toEqual([]);
		},
	);

	it.each([0, -1, Number.POSITIVE_INFINITY])(
		"leaves ordinary callTool timeout-disable semantics unchanged (%s)",
		async (timeoutMs) => {
			const { client } = await fixture(
				(message, response) => {
					const timer = setTimeout(() => reply(response, message.id, { content: [] }), 80);
					timers.add(timer);
				},
				{ name: "catalogue-test", version: "1", catalogueTimeoutMs: 30 },
			);
			expect(await client.callTool("slow", undefined, { timeoutMs })).toEqual({ content: [] });
		},
	);
});
