import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";

const owned = vi.hoisted(() => ({ servers: [] as FakeServer[] }));
class FakeSocket extends EventEmitter {
	destroyed = false;
	destroy() {
		this.destroyed = true;
		this.emit("close");
	}
}
class FakeServer extends EventEmitter {
	readonly handler: RequestListener;
	listening = false;
	port = 0;
	readonly sockets = [new FakeSocket(), new FakeSocket()];
	constructor(handler: RequestListener) {
		super();
		this.handler = handler;
	}
	listen(port: number, _host: string, callback: () => void) {
		this.port = port;
		this.listening = true;
		queueMicrotask(() => {
			for (const socket of this.sockets) this.emit("connection", socket);
			callback();
		});
		return this;
	}
	address() {
		return { port: this.port, address: "127.0.0.1", family: "IPv4" };
	}
	close(callback?: () => void) {
		this.listening = false;
		callback?.();
		return this;
	}
	closeAllConnections() {
		for (const socket of this.sockets) socket.destroy();
	}
	callback(url: string) {
		const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
		this.handler({ url, method: "GET" } as IncomingMessage, response);
	}
}
vi.mock("node:http", () => ({
	createServer: (handler: RequestListener) => {
		const server = new FakeServer(handler);
		owned.servers.push(server);
		return server;
	},
}));
afterEach(() => {
	vi.unstubAllGlobals();
	owned.servers.length = 0;
});

// pi#141 / security F7: callback binding creates custody before any fallible notification.
it.each(["chatgpt", "radius"])(
	"retires %s listener and accepted/spare sockets when notify throws",
	async (provider) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ authorizationEndpoint: "https://mock.invalid/authorize" })),
		);
		const controller = new AbortController();
		const auth =
			provider === "chatgpt"
				? openaiChatGPTOAuth
				: createRadiusOAuth({ name: "Synthetic Radius", gateway: "https://mock.invalid" });
		try {
			await expect(
				auth.login(
					{
						signal: controller.signal,
						prompt: async () => "browser",
						notify: () => {
							throw new Error("synthetic notification failure");
						},
					},
					{ getDeviceId: () => "e61bbe28-07ef-466d-8e5d-a344f94ab305" },
				),
			).rejects.toThrow();
			expect(owned.servers).toHaveLength(1);
			expect(owned.servers[0].listening).toBe(false);
			expect(owned.servers[0].sockets.every((socket) => socket.destroyed)).toBe(true);
		} finally {
			controller.abort();
			for (const server of owned.servers) {
				server.close();
				server.closeAllConnections();
			}
		}
	},
);
