import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

// Refs Smarty-Pants-Inc/pi#97, Astra round 2: request-only input must not be replayed away.
describe("model switch recovery input (#97)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()!.cleanup();
	});

	async function setup(options: HarnessOptions = {}, converter?: Agent["convertToLlm"]): Promise<Harness> {
		const prepareRequest: Agent["prepareRequest"] = (request) => ({
			model: { ...request.model, contextWindow: 16_000 },
		});
		const h = await createHarness({
			models: [{ id: "large", contextWindow: 100_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				retry: { enabled: false },
			},
			...options,
			prepareRequest: options.prepareRequest ?? prepareRequest,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "small recovered summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
				...(options.extensionFactories ?? []),
			],
		});
		harnesses.push(h);
		if (converter) {
			// Install the SDK converter before constructing the session, as real SDK clients do.
			// Reuse the harness's offline model/auth runtime and faux-provider registration.
			const original = h.session;
			original.dispose();
			h.session = new AgentSession({
				agent: new Agent({
					initialState: { model: h.getModel(), systemPrompt: "", tools: [] },
					streamFn: streamSimple,
					getApiKey: () => "faux-key",
					convertToLlm: converter,
					prepareRequest: options.prepareRequest ?? prepareRequest,
					transformContext: (messages) => h.session.extensionRunner.emitContext(messages),
				}),
				sessionManager: h.sessionManager,
				settingsManager: h.settingsManager,
				modelRuntime: original.modelRuntime,
				resourceLoader: original.resourceLoader,
				cwd: h.tempDir,
			});
			h.session.subscribe((event) => h.events.push(event));
			const cleanup = h.cleanup;
			h.cleanup = () => {
				h.session.dispose();
				cleanup();
			};
		}
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(80_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("old response"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		return h;
	}

	function expectRefused(h: Harness): void {
		expect(h.faux.state.callCount).toBe(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringMatching(/context exceeds window/i),
		});
		expect(h.session.isIdle).toBe(true);
	}

	it.each(["replacement", "in-place"] as const)(
		"refuses oversized input after a one-shot %s context injection instead of draining it twice",
		async (mode) => {
			let pending = "one-shot instruction must not disappear";
			let transforms = 0;
			const h = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("context", (event) => {
							transforms++;
							if (!pending) return;
							const instruction = { role: "user" as const, content: pending, timestamp: Date.now() };
							pending = "";
							if (mode === "in-place") event.messages.push(instruction);
							else return { messages: [...event.messages, instruction] };
						});
					},
				],
			});
			h.setResponses([fauxAssistantMessage("must not send without the instruction")]);
			await h.session.prompt("new ordinary input");
			expect(transforms).toBe(1);
			expect(pending).toBe("");
			expectRefused(h);
			expect(JSON.stringify(h.sessionManager.getEntries())).not.toContain("one-shot instruction");
		},
	);

	it("refuses oversized input with opaque context metadata without replaying the transform", async () => {
		let transforms = 0;
		const details: { self?: unknown } = {};
		details.self = details;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => {
						transforms++;
						return {
							messages: [
								...event.messages,
								{
									role: "custom",
									customType: "opaque",
									content: "request-only input",
									display: false,
									details,
									timestamp: Date.now(),
								},
							],
						};
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage("must not replay opaque input")]);
		await h.session.prompt("new ordinary input");
		expect(transforms).toBe(1);
		expectRefused(h);
	});

	it.each(["one-shot", "identity"] as const)("never replays an oversized %s SDK converter", async (mode) => {
		let conversions = 0;
		let pending = "one-shot converted instruction";
		const h = await setup({}, async (messages) => {
			conversions++;
			const converted = convertToLlm(messages);
			if (mode === "one-shot" && pending) {
				converted.push({ role: "user", content: pending, timestamp: Date.now() });
				pending = "";
			}
			return converted;
		});
		h.setResponses([fauxAssistantMessage("must not send after replaying the converter")]);
		await h.session.prompt("new ordinary input");
		expect(conversions).toBe(1);
		expectRefused(h);
	});

	it("recovers canonical model-only overflow without replaying an unchanged context hook", async () => {
		let preparations = 0;
		let transforms = 0;
		const h = await setup({
			prepareRequest: (request) => {
				preparations++;
				return { model: { ...request.model, contextWindow: 16_000 } };
			},
			extensionFactories: [
				(pi) => {
					pi.on("context", () => {
						transforms++;
					});
				},
			],
		});
		h.setResponses([
			(context, _options, _state, model) => {
				expect(model.contextWindow).toBe(16_000);
				expect(JSON.stringify(context.messages)).toContain("small recovered summary");
				expect(JSON.stringify(context.messages)).toContain("new ordinary input");
				return fauxAssistantMessage("recovered safely");
			},
		]);
		await h.session.prompt("new ordinary input");
		expect(preparations).toBe(1);
		expect(transforms).toBe(1);
		expect(h.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "overflow" }]);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.getLastAssistantText()).toBe("recovered safely");
	});

	it("admits fitting one-shot converted input exactly once", async () => {
		let conversions = 0;
		const h = await setup({ prepareRequest: () => undefined }, (messages) => {
			conversions++;
			return [
				...convertToLlm(messages),
				{ role: "user", content: "one-shot converted instruction", timestamp: Date.now() },
			];
		});
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("one-shot converted instruction");
				return fauxAssistantMessage("fitting input retained");
			},
		]);
		await h.session.prompt("new ordinary input");
		expect(conversions).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it.each(["context", "converter"] as const)("admits a fitting stateless shrinking %s", async (mode) => {
		let conversions = 0;
		const short = { role: "user" as const, content: "short request-only input", timestamp: Date.now() };
		const h = await setup(
			{
				extensionFactories:
					mode === "context"
						? [
								(pi) => {
									pi.on("context", () => ({ messages: [short] }));
								},
							]
						: [],
			},
			mode === "converter"
				? () => {
						conversions++;
						return [short];
					}
				: undefined,
		);
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("short request-only input");
				return fauxAssistantMessage("shrinking input accepted");
			},
		]);
		await h.session.prompt("new ordinary input");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		if (mode === "converter") expect(conversions).toBe(1);
	});
});
