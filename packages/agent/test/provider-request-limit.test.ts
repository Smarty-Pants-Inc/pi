// Regression for Smarty-Pants-Inc/smarty-dev#2751: unknown-tool turns share physical attempt admission.
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentLoopConfig } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "test",
	name: "test",
	provider: "synthetic",
	api: "openai-completions",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
afterEach(() => vi.unstubAllGlobals());

describe("agent loop physical request admission", () => {
	// Smarty-Pants-Inc/smarty-dev#16188: repeatable permission checks must not spend physical admission.
	it.each([
		{ cap: undefined, permission: false },
		{ cap: 2, permission: false },
		{ cap: undefined, permission: true },
		{ cap: 2, permission: true },
	])("forwards admission (cap $cap, critical permission $permission)", async ({ cap, permission }) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const work = { prepare: 0, nextTurn: 0, project: 0, convert: 0, dispatch: 0 };
		let permissionChecks = 0;
		let physical = 0;
		const fetch = vi.fn(async () => {
			physical++;
			const tool = cap !== undefined || physical < 3;
			const chunk = {
				id: "test",
				choices: [
					{
						index: 0,
						delta: tool
							? {
									tool_calls: [
										{
											index: 0,
											id: `unknown-${physical}`,
											type: "function",
											function: { name: "unavailable", arguments: "{}" },
										},
									],
								}
							: { content: "OK" },
						finish_reason: null,
					},
				],
			};
			const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetch);
		let admitted = 0;
		const config: AgentLoopConfig = {
			model,
			apiKey: "synthetic",
			maxRetries: 0,
			assertProviderPermission: permission
				? async () => {
						permissionChecks++;
						entered.resolve();
						await release.promise;
					}
				: undefined,
			prepareRequest: () => {
				work.prepare++;
			},
			prepareNextTurn: () => {
				work.nextTurn++;
				return undefined;
			},
			projectProviderContext: async (messages) => {
				work.project++;
				return messages;
			},
			convertToLlm: (messages) => {
				work.convert++;
				return messages as Message[];
			},
			beforeProviderRequest:
				cap === undefined
					? undefined
					: () => {
							if (admitted === cap) throw new Error(`Provider request limit reached (${cap}/${cap})`);
							admitted++;
						},
		};
		const run = runAgentLoop(
			[{ role: "user", content: "test", timestamp: 0 }],
			{ messages: [], tools: [] },
			config,
			() => {},
			undefined,
			(requestModel, context, options) => {
				work.dispatch++;
				expect(options?.beforeProviderRequest).toBe(config.beforeProviderRequest);
				return streamSimple(requestModel as Model<"openai-completions">, context, options);
			},
		);
		if (permission) {
			await entered.promise;
			try {
				expect(work).toEqual({ prepare: 0, nextTurn: 0, project: 0, convert: 0, dispatch: 0 });
				expect(physical).toBe(0);
				expect(admitted).toBe(0);
			} finally {
				release.resolve();
			}
		}
		const result = await run;
		if (permission) expect(permissionChecks).toBeGreaterThan(physical);
		expect(work).toEqual({ prepare: 3, nextTurn: 2, project: 3, convert: 3, dispatch: 3 });
		expect(physical).toBe(cap ?? 3);
		expect(admitted).toBe(cap ?? 0);
		const last = result.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe(cap === undefined ? "stop" : "error");
		if (cap !== undefined) expect(last.errorMessage).toBe("Provider request limit reached (2/2)");
	});
});
