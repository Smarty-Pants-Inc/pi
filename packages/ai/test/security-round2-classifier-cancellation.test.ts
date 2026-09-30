import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { classify } from "../src/api/llama-cpp-classify.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";

const context: ClassifierContext = {
	state: { fixture: "local-only" },
	questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "first", b: "second" } } },
};

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Waiter did not settle within 500ms")), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture() {
	const requests: Array<{ path: string; waiter: string; model: string }> = [];
	const pending: Array<() => void> = [];
	let gated = true;
	let failTokens = false;
	const server = createServer(async (request, response: ServerResponse) => {
		try {
			let text = "";
			for await (const chunk of request) text += String(chunk);
			const body = JSON.parse(text) as { content?: string; model: string };
			const path = request.url ?? "";
			requests.push({ path, waiter: String(request.headers["x-waiter"] ?? ""), model: body.model });
			const send = () => {
				if (response.destroyed) return;
				response.setHeader("content-type", "application/json");
				if (path === "/tokenize") {
					if (failTokens) {
						response.writeHead(400).end(JSON.stringify({ error: "fixture tokenization failed" }));
					} else {
						response.end(
							JSON.stringify({ tokens: [...(body.content ?? "")].map((char) => char.codePointAt(0)) }),
						);
					}
				} else if (path === "/apply-template") {
					response.end(JSON.stringify({ prompt: "fixture prompt" }));
				} else if (path === "/completion") {
					response.end(
						JSON.stringify({
							completion_probabilities: [
								{
									top_logprobs: [
										{ id: 65, logprob: -0.1 },
										{ id: 66, logprob: -2.5 },
									],
								},
							],
						}),
					);
				} else {
					response.writeHead(404).end("{}");
				}
			};
			if (path === "/tokenize" && gated) pending.push(send);
			else send();
		} catch {
			response.destroy();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	const model: ClassifierModel<"llama-cpp-classify"> = {
		type: "classifier",
		id: "fixture",
		name: "fixture",
		api: "llama-cpp-classify",
		provider: "llama.cpp",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
	};
	return {
		model,
		requests,
		async started(waiter: string) {
			const deadline = Date.now() + 500;
			while (!requests.some((entry) => entry.path === "/apply-template" && entry.waiter === waiter)) {
				if (Date.now() >= deadline) throw new Error(`Caller ${waiter} did not reach the template endpoint`);
				await delay(5);
			}
		},
		release() {
			gated = false;
			for (const send of pending.splice(0)) send();
		},
		failTokens(value: boolean) {
			failTokens = value;
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

describe("classifier cancellation ownership", () => {
	// Regression for #2241 / Astra9: exercise the public API with real loopback HTTP, not mocked fetch.
	for (const cancelled of ["A", "B"] as const) {
		it(`cancels ${cancelled} promptly without cancelling the other cold-cache caller`, async () => {
			const server = await fixture();
			const controllers = { A: new AbortController(), B: new AbortController() };
			const calls: Array<Promise<unknown>> = [];
			try {
				const a = classify(server.model, context, {
					signal: controllers.A.signal,
					headers: { "x-waiter": "A" },
					apiKey: "fixture-only",
					maxRetries: 0,
				});
				calls.push(a);
				await server.started("A");
				const b = classify(server.model, context, {
					signal: controllers.B.signal,
					headers: { "x-waiter": "B" },
					apiKey: "fixture-only",
					maxRetries: 0,
				});
				calls.push(b);
				await server.started("B");
				let liveSettled = false;
				const live = cancelled === "A" ? b : a;
				void live.then(() => {
					liveSettled = true;
				});
				controllers[cancelled].abort();
				const aborted = await within(cancelled === "A" ? a : b);
				expect(aborted.stopReason).toBe("aborted");
				expect(aborted.answers).toEqual({});
				await delay(20);
				expect(liveSettled).toBe(false);
				server.release();
				const completed = await within(live);
				expect(completed.stopReason).toBe("stop");
				expect(completed.answers.pick).toMatchObject({ type: "choice", choice: "a" });
				const tokenizations = server.requests.filter((entry) => entry.path === "/tokenize").length;
				expect((await classify(server.model, context, { maxRetries: 0 })).stopReason).toBe("stop");
				expect(server.requests.filter((entry) => entry.path === "/tokenize")).toHaveLength(tokenizations);
			} finally {
				controllers.A.abort();
				controllers.B.abort();
				server.release();
				await Promise.allSettled(calls);
				await server.close();
			}
		});
	}

	it("retries failed cold lookups and keeps resolved tokens scoped to server and model", async () => {
		const first = await fixture();
		const second = await fixture();
		try {
			first.release();
			second.release();
			first.failTokens(true);
			expect((await classify(first.model, context, { maxRetries: 0 })).stopReason).toBe("error");
			const failedCount = first.requests.filter((entry) => entry.path === "/tokenize").length;
			first.failTokens(false);
			expect((await classify(first.model, context, { maxRetries: 0 })).stopReason).toBe("stop");
			expect(first.requests.filter((entry) => entry.path === "/tokenize").length).toBeGreaterThan(failedCount);
			expect((await classify({ ...first.model, id: "another" }, context, { maxRetries: 0 })).stopReason).toBe(
				"stop",
			);
			expect(first.requests.filter((entry) => entry.path === "/tokenize" && entry.model === "another")).toHaveLength(
				4,
			);
			expect((await classify(second.model, context, { maxRetries: 0 })).stopReason).toBe("stop");
			expect(second.requests.filter((entry) => entry.path === "/tokenize")).toHaveLength(4);
		} finally {
			await first.close();
			await second.close();
		}
	});
});
