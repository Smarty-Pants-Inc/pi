import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "recovery-test",
	name: "Recovery test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
function response() {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
	return stream;
}
const convert = (messages: AgentMessage[]) => messages as Message[];

// Smarty-Pants-Inc/smarty-dev#16188: optional host callbacks guard the actual browser-capable generic model loop.
describe("generic recovery permission callbacks", () => {
	it.each(["prompt", "continue"] as const)(
		"holds %s before preparation, conversion or provider dispatch",
		async (kind) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const order: string[] = [];
			const agent = new Agent({
				initialState: { model, messages: [{ role: "user", content: "retained", timestamp: 1 }] },
				assertProviderPermission: async () => {
					order.push("permission");
					entered.resolve();
					await release.promise;
				},
				prepareRequest: () => {
					order.push("prepare");
				},
				convertToLlm: (messages) => {
					order.push("convert");
					return convert(messages);
				},
				streamFn: () => {
					order.push("provider");
					return response();
				},
			});
			const run = kind === "prompt" ? agent.prompt("hello") : agent.continue();
			await entered.promise;
			expect(order).toEqual(["permission"]);
			release.resolve();
			await run;
			expect(order.indexOf("permission")).toBeLessThan(order.indexOf("prepare"));
			expect(order.indexOf("prepare")).toBeLessThan(order.indexOf("convert"));
			expect(order.indexOf("convert")).toBeLessThan(order.indexOf("provider"));
		},
	);
	it("uses a provider-only repair without mutating raw signed reasoning", async () => {
		const raw: AgentMessage = {
			...fauxAssistantMessage([
				{ type: "thinking", thinking: "retained", thinkingSignature: "valid-signature" },
				{ type: "text", text: "prior" },
			]),
			timestamp: 1,
		};
		let providerMessages: unknown;
		const agent = new Agent({
			initialState: { model, messages: [raw] },
			assertProviderPermission: async () => {},
			projectProviderContext: async (messages) =>
				messages.map((message) =>
					message.role === "assistant"
						? { ...message, content: message.content.filter((part) => part.type !== "thinking") }
						: message,
				),
			convertToLlm: convert,
			streamFn: (_model, context) => {
				providerMessages = context.messages;
				return response();
			},
		});
		await agent.prompt("next");
		expect(JSON.stringify(providerMessages)).not.toContain("valid-signature");
		expect(JSON.stringify(agent.state.messages)).toContain("valid-signature");
	});
	it("rechecks after asynchronous projection and never converts a revoked view", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let permitted = true;
		let converted = 0;
		let dispatched = 0;
		const agent = new Agent({
			initialState: { model },
			assertProviderPermission: async () => {
				if (!permitted) throw new Error("held");
			},
			projectProviderContext: async (messages) => {
				entered.resolve();
				await release.promise;
				return messages;
			},
			convertToLlm: (messages) => {
				converted++;
				return convert(messages);
			},
			streamFn: () => {
				dispatched++;
				return response();
			},
		});
		const run = agent.prompt("hello");
		const observed = run.catch(() => {});
		await entered.promise;
		permitted = false;
		release.resolve();
		await observed;
		expect(converted).toBe(0);
		expect(dispatched).toBe(0);
	});
	it("ordinary valid signed reasoning passes through unchanged without optional ports", async () => {
		const raw = fauxAssistantMessage([{ type: "thinking", thinking: "prior", thinkingSignature: "signature" }]);
		let providerMessages: unknown;
		const agent = new Agent({
			initialState: { model, messages: [raw] },
			convertToLlm: convert,
			streamFn: (_model, context) => {
				providerMessages = context.messages;
				return response();
			},
		});
		await agent.prompt("next");
		expect(JSON.stringify(providerMessages)).toContain("signature");
	});
});
