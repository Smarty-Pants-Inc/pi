import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { OAuthCallbackServer } from "../src/oauth/index.ts";

function callbackRequest(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const outgoing = request(url, { agent: false }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.once("error", reject);
			response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		outgoing.once("error", reject);
		outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("Callback request timed out")));
		outgoing.end();
	});
}

async function spareSocket(url: URL, unfinished: boolean): Promise<{ socket: Socket; closed: Promise<void> }> {
	const socket = connect({ host: url.hostname, port: Number(url.port) });
	// Forced retirement may report a reset instead of EOF on some platforms.
	socket.on("error", () => {});
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.resume();
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	if (unfinished) socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nX-Unfinished: `);
	return { socket, closed };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Callback retirement exceeded 1500 ms")), 1_500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe.sequential("MCP callback socket retirement", () => {
	// smarty-dev#2241 F25 / Astra5: actual accepted TCP sockets must not hold the public close join open.
	for (const unfinished of [false, true]) {
		it.each(["success", "cancellation", "provider-error"] as const)(
			`joins %s shutdown with a held ${unfinished ? "unfinished request" : "preconnection"}`,
			async (outcome) => {
				const callback = await OAuthCallbackServer.listen({ path: "/callback-random-path" });
				const url = new URL(callback.redirectUrl);
				const pending = callback.waitForCallback("expected-state");
				const result = pending.then(
					(value) => value,
					(error: unknown) => error,
				);
				const spare = await spareSocket(url, unfinished);
				let closes: Promise<void>[] = [];
				try {
					// A completed HTTP request on the same public listener orders acceptance of the spare socket.
					expect((await callbackRequest(`${url.origin}/other`)).status).toBe(404);
					expect((await callbackRequest(`${callback.redirectUrl}?state=wrong&code=forged`)).status).toBe(400);
					let response: Promise<{ status: number; body: string }> | undefined;
					if (outcome !== "cancellation") {
						const query =
							outcome === "success"
								? "state=expected-state&code=good&iss=https%3A%2F%2Fissuer.example"
								: "state=expected-state&error=access_denied&error_description=Denied";
						response = callbackRequest(`${callback.redirectUrl}?${query}`);
						response.catch(() => undefined);
						// Match the real caller: start finally/close when the callback settles, before reading the page.
						await result;
					}
					closes = [callback.close(), callback.close(), callback.close()];
					for (const close of closes) close.catch(() => undefined);
					await bounded(Promise.all([...closes, spare.closed]));
					expect(closes[1]).toBe(closes[0]);
					expect(closes[2]).toBe(closes[0]);
					expect(spare.socket.destroyed).toBe(true);
					await expect(callback.close()).resolves.toBeUndefined();
					await expect(callback.waitForCallback("late-state")).rejects.toThrow("OAuth callback server closed");
					if (outcome === "success") {
						expect(await result).toEqual({
							code: "good",
							state: "expected-state",
							iss: "https://issuer.example",
						});
						expect(await response).toEqual({
							status: 200,
							body: "Authorization complete. You may close this window.",
						});
					} else {
						expect(await result).toBeInstanceOf(Error);
						expect(((await result) as Error).message).toBe(
							outcome === "cancellation" ? "OAuth callback server closed" : "Denied",
						);
						if (response)
							expect(await response).toEqual({
								status: 200,
								body: "Authorization failed. You may close this window.\n\nDenied",
							});
					}
					await expect(callbackRequest(callback.redirectUrl)).rejects.toMatchObject({ code: "ECONNREFUSED" });
					// Allowed counterexample: retirement of one listener must not poison a fresh listener on its port.
					const fresh = await OAuthCallbackServer.listen({ port: Number(url.port), path: url.pathname });
					try {
						const next = fresh.waitForCallback("fresh-state");
						expect((await callbackRequest(`${fresh.redirectUrl}?state=fresh-state&code=next`)).status).toBe(200);
						await expect(next).resolves.toEqual({ state: "fresh-state", code: "next" });
					} finally {
						await fresh.close();
					}
				} finally {
					spare.socket.destroy();
					await spare.closed;
					if (closes.length === 0) closes.push(callback.close());
					await Promise.allSettled(closes);
				}
			},
		);
	}
});
