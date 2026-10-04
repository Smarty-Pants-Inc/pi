import { connect } from "node:net";
import { expect, it } from "vitest";
import { startOAuthCallbackServer } from "../src/auth/oauth/callback-server.ts";

// PR #131 P2-6: URL construction must not escape the complete async request handler.
it("contains parser-accepted malformed targets and preserves the legitimate pending grant", async () => {
	const callback = await startOAuthCallbackServer({
		providerName: "Example",
		host: "127.0.0.1",
		port: 0,
		path: "/callback",
		state: "expected",
		complete: async (code) => `safe:${code}`,
	});
	try {
		const url = new URL(callback.redirectUri);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = connect(Number(url.port), url.hostname);
			let data = "";
			socket.setTimeout(400, () => socket.destroy());
			socket.on("data", (chunk) => {
				data += chunk.toString();
			});
			socket.once("error", reject);
			socket.once("close", () => resolve(data));
			socket.once("connect", () =>
				socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
			);
		});
		expect(response).toContain("400");
		url.searchParams.set("state", "expected");
		url.searchParams.set("code", "legitimate");
		const accepted = await fetch(url);
		await accepted.text();
		expect(accepted.status).toBe(200);
		await expect(callback.wait()).resolves.toBe("safe:legitimate");
	} finally {
		callback.close();
	}
});
