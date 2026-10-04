import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expect, it } from "vitest";
import { fetchBoundedResponse } from "../src/utils/bounded-response.ts";

// PR #131 P2-10: direct native probes, without provider credentials or remote endpoints.
it.each(["headers", "trickle", "bytes"])("retires a native %s response", async (mode) => {
	const sockets = new Set<Socket>();
	let timer: ReturnType<typeof setInterval> | undefined;
	const server = createServer((_request, response) => {
		if (mode === "headers") return;
		response.writeHead(200, { "content-type": "application/json" });
		response.write("{");
		timer = setInterval(() => response.write(mode === "bytes" ? " ".repeat(1024) : " "), 5);
		response.on("close", () => clearInterval(timer));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing TCP address");
	try {
		await expect(fetchBoundedResponse(`http://127.0.0.1:${address.port}`, {}, 128, 100)).rejects.toThrow(
			mode === "bytes" ? "byte limit" : "timed out",
		);
	} finally {
		clearInterval(timer);
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
