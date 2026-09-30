import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	type McpClient,
	McpConnectionClosedError,
} from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { createDefaultTransport, McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";

const cleanups: (() => Promise<void>)[] = [];

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Local MCP fixture did not reach its barrier")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

interface HeldRequest {
	closed: Promise<void>;
	respond(result?: unknown, status?: number): void;
}

interface Session {
	id: string;
	opened: ReturnType<typeof Promise.withResolvers<void>>;
	closed: ReturnType<typeof Promise.withResolvers<void>>;
	live: boolean;
}

/** Real HTTP/JSON-RPC sessions, with GET streams that deliberately survive a POST's 404. */
async function fixture(pause?: string, closeGate?: Promise<void>) {
	const sessions: Session[] = [];
	const expired = new Set<string>();
	const deleted: string[] = [];
	const calls: { session: string; name: string }[] = [];
	const heldNames = new Set<string>();
	const barriers = new Map<string, ReturnType<typeof Promise.withResolvers<HeldRequest>>>();
	const serverErrors: unknown[] = [];
	let publications = 0;
	const transportClosed = Promise.withResolvers<void>();
	const barrier = (key: string) => {
		let value = barriers.get(key);
		if (!value) {
			value = Promise.withResolvers<HeldRequest>();
			barriers.set(key, value);
		}
		return value;
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const sessionId = String(request.headers["mcp-session-id"] ?? "");
		if (request.method === "GET") {
			const session = sessions.find((value) => value.id === sessionId);
			if (!session) throw new Error(`Unknown GET session ${sessionId}`);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(": live\n\n");
			session.live = true;
			response.on("close", () => {
				session.live = false;
				session.closed.resolve();
			});
			session.opened.resolve();
			return;
		}
		if (request.method === "DELETE") {
			deleted.push(sessionId);
			// Do not end the GET here: the client must actually abort its owned stream.
			response.writeHead(200).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += String(chunk);
		const message = JSON.parse(body) as JsonRpcRequest & { params?: Record<string, unknown> };
		if (!("id" in message)) {
			response.writeHead(202).end();
			return;
		}
		let session = sessions.find((value) => value.id === sessionId);
		if (message.method === "initialize") {
			session = {
				id: String(sessions.length + 1),
				opened: Promise.withResolvers<void>(),
				closed: Promise.withResolvers<void>(),
				live: false,
			};
			sessions.push(session);
		}
		if (!session) throw new Error(`Unknown POST session ${sessionId}`);
		let result: unknown;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "ownership-fixture", version: "1" },
				};
				break;
			case "tools/list":
				result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
				break;
			case "resources/list":
				result = message.params?.cursor
					? { resources: [{ uri: "docs://second", name: "second" }] }
					: { resources: [{ uri: "docs://first", name: "first" }], nextCursor: "next" };
				break;
			case "resources/templates/list":
				result = message.params?.cursor
					? { resourceTemplates: [] }
					: { resourceTemplates: [{ uriTemplate: "docs://{page}", name: "page" }], nextCursor: "next" };
				break;
			case "resources/read":
				result = { contents: [{ uri: message.params?.uri, text: "resource" }] };
				break;
			default:
				result = { content: [{ type: "text", text: "ok" }] };
		}
		const closed = Promise.withResolvers<void>();
		response.on("close", () => closed.resolve());
		const respond = (value: unknown = result, status = 200) => {
			if (response.destroyed) return;
			response.writeHead(status, {
				"content-type": "application/json",
				...(message.method === "initialize" ? { "mcp-session-id": session.id } : {}),
			});
			response.end(status === 200 ? JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }) : "gone");
		};
		const held = { closed: closed.promise, respond };
		if (message.method === pause && (!pause.startsWith("resources/") || message.params?.cursor)) {
			barrier(`pause:${pause}`).resolve(held);
			return;
		}
		if (message.method === "tools/call") {
			const name = String(message.params?.name);
			calls.push({ session: session.id, name });
			if (message.params?.arguments && !heldNames.has(name)) {
				const args = message.params.arguments as Record<string, unknown>;
				if (args.hold) {
					heldNames.add(name);
					barrier(`${session.id}:${name}`).resolve(held);
					return;
				}
			}
			if (name === "echo" && expired.has(session.id)) {
				respond(undefined, 404);
				return;
			}
		}
		respond();
	};
	const server = createServer((request, response) => {
		void handle(request, response).catch((error) => {
			serverErrors.push(error);
			response.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No local MCP server address");
	const transports: ReturnType<typeof createDefaultTransport>[] = [];
	const connection = new McpServerConnection({
		entry: {
			name: "ownership",
			config: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "fixture" } },
			source: "test",
		},
		cwd: process.cwd(),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		createTransport: (entry, cwd, auth) => {
			const transport = createDefaultTransport(entry, cwd, auth);
			transports.push(transport);
			if (closeGate) {
				const close = transport.close.bind(transport);
				transport.close = async () => {
					await close();
					transportClosed.resolve();
					await closeGate;
				};
			}
			return transport;
		},
		onTools: () => publications++,
	});
	cleanups.push(async () => {
		await connection.close();
		// Fixture safety on failing/baseline runs; assertions happen before this fallback cleanup.
		await Promise.all(transports.map((transport) => transport.close()));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(serverErrors).toEqual([]);
	});
	return {
		connection,
		sessions,
		expired,
		deleted,
		calls,
		publications: () => publications,
		wait: (key: string) => within(barrier(key).promise),
		transportClosed: transportClosed.promise,
	};
}

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MCP runtime client ownership (smarty-dev#2241 F13/F14)", () => {
	// smarty-dev#2241 F13: retirement must interrupt both initialization and paginated discovery.
	it.each(["initialize", "tools/list", "resources/list", "resources/templates/list"])(
		"closes unpublished startup during %s without publishing incomplete tools",
		async (method) => {
			const server = await fixture(method);
			const opening = server.connection.getClient();
			const outcome = opening.then(
				() => "unexpected success",
				(error: unknown) => error,
			);
			expect(server.connection.getClient()).toBe(opening);
			const paused = await server.wait(`pause:${method}`);
			expect(server.connection.state).toBe("connecting");
			expect(server.publications()).toBe(0);
			await within(server.connection.close());
			await within(paused.closed);
			expect(await outcome).toBeInstanceOf(Error);
			expect(server.connection.state).toBe("closed");
			expect(server.publications()).toBe(0);
			await expect(server.connection.getClient()).rejects.toThrow("shut down");
			paused.respond();
			if (method !== "initialize") {
				await within(server.sessions[0].closed.promise);
				expect(server.sessions[0].live).toBe(false);
			}
		},
	);

	// smarty-dev#2241 F13: cancellation is not settlement until transport cleanup is joined.
	it("joins setup cleanup and concurrent close callers", async () => {
		const gate = Promise.withResolvers<void>();
		const server = await fixture("initialize", gate.promise);
		const opening = server.connection.getClient().catch((error: unknown) => error);
		await server.wait("pause:initialize");
		let settled = false;
		const closing = server.connection.close();
		void closing.then(() => {
			settled = true;
		});
		expect(server.connection.close()).toBe(closing);
		try {
			await within(server.transportClosed);
			expect(settled).toBe(false);
		} finally {
			gate.resolve();
		}
		await within(closing);
		expect(await opening).toBeInstanceOf(Error);
		expect(settled).toBe(true);
		expect(server.publications()).toBe(0);
	});

	// smarty-dev#2241 F13 counterexample: healthy discovery still publishes only the completed client.
	it("shares healthy startup, then supports tools and paginated resources", async () => {
		const server = await fixture("tools/list");
		const opening = server.connection.getClient();
		let published = false;
		void opening.then(() => {
			published = true;
		});
		const paused = await server.wait("pause:tools/list");
		expect(server.connection.getClient()).toBe(opening);
		expect(published).toBe(false);
		paused.respond();
		const client = await within(opening);
		expect(await server.connection.getClient()).toBe(client);
		expect(server.connection.state).toBe("connected");
		expect(server.publications()).toBe(1);
		expect(server.connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(server.connection.resources.map((resource) => resource.uri)).toEqual(["docs://first", "docs://second"]);
		expect(server.connection.resourceTemplates).toHaveLength(1);
		expect(await server.connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(await server.connection.readResource("docs://first", {})).toEqual({
			contents: [{ uri: "docs://first", text: "resource" }],
		});
		await within(server.sessions[0].opened.promise);
		await server.connection.close();
		await within(server.sessions[0].closed.promise);
	});

	// smarty-dev#2241 F14: old GET streams stay live on 404; valid old work is not silently discarded.
	it.each([1, 3])(
		"owns %i replaced sessions, preserves unrelated calls and retries each late 404 once",
		async (cycles) => {
			const server = await fixture();
			const clients: McpClient[] = [];
			for (let cycle = 0; cycle < cycles; cycle++) {
				const client = await server.connection.getClient();
				clients.push(client);
				const session = server.sessions[cycle];
				await within(session.opened.promise);
				const slowName = `slow-${cycle}`;
				const lateName = `late-${cycle}`;
				const slow = server.connection.callTool(slowName, { hold: true }, {});
				const late = server.connection.callTool(lateName, { hold: true }, {});
				const heldSlow = await server.wait(`${session.id}:${slowName}`);
				const heldLate = await server.wait(`${session.id}:${lateName}`);
				server.expired.add(session.id);
				expect(await server.connection.callTool("echo", {}, {})).toEqual({
					content: [{ type: "text", text: "ok" }],
				});
				const replacement = await server.connection.getClient();
				expect(replacement).not.toBe(client);
				await within(server.sessions[cycle + 1].opened.promise);
				expect(session.live).toBe(true);
				expect(client.connectionState).toBe("connected");
				heldSlow.respond();
				expect(await slow).toEqual({ content: [{ type: "text", text: "ok" }] });
				heldLate.respond(undefined, 404);
				expect(await late).toEqual({ content: [{ type: "text", text: "ok" }] });
				expect(server.calls.filter((call) => call.name === lateName).map((call) => call.session)).toEqual([
					session.id,
					server.sessions[cycle + 1].id,
				]);
				expect(server.sessions).toHaveLength(cycle + 2);
			}
			// The public raw client path also retains its pending work until explicit owner retirement.
			const pending = clients[0].callTool("old-pending", { hold: true }).catch((error: unknown) => error);
			const held = await server.wait("1:old-pending");
			clients.push(await server.connection.getClient());
			expect(server.sessions.every((session) => session.live)).toBe(true);
			await within(server.connection.close());
			expect(await pending).toBeInstanceOf(McpConnectionClosedError);
			await within(held.closed);
			await within(Promise.all(server.sessions.map((session) => session.closed.promise)));
			expect(clients.every((client) => client.connectionState === "closed")).toBe(true);
			expect(server.sessions.every((session) => !session.live)).toBe(true);
			expect([...server.deleted].sort()).toEqual(server.sessions.map((session) => session.id).sort());
		},
	);

	// smarty-dev#2241 F14: absent owner close, a superseded stream still has a finite retirement deadline.
	it("bounds old-session retirement without closing its healthy replacement", async () => {
		const server = await fixture();
		const old = await server.connection.getClient();
		await within(server.sessions[0].opened.promise);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = old.callTool("old-long", { hold: true }, { timeoutMs: 120_000 }).catch((error: unknown) => error);
		const held = await server.wait("1:old-long");
		server.expired.add("1");
		await server.connection.callTool("echo", {}, {});
		const replacement = await server.connection.getClient();
		await within(server.sessions[1].opened.promise);
		expect(server.sessions[0].live).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		vi.useRealTimers();
		expect(await pending).toBeInstanceOf(McpConnectionClosedError);
		await within(held.closed);
		await within(server.sessions[0].closed.promise);
		expect(old.connectionState).toBe("closed");
		expect(replacement.connectionState).toBe("connected");
		expect(server.sessions[1].live).toBe(true);
		expect(await server.connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		await server.connection.close();
		await within(server.sessions[1].closed.promise);
	});
});
