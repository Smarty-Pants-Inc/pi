import { createAssistantMessageEventStream, fauxAssistantMessage, lazyStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

// Smarty-Pants-Inc/smarty-dev#14950: exercise lazy request setup, terminal publication and disk persistence together.
// Keep reason: cancellation at the auth/dispatch boundary must not send a request or persist a setup error.
describe("AgentSession abort during request setup", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it.each(
		(["auth", "headers", "routing", "asyncStreamFn", "lazyStream", "prepareRequest"] as const).flatMap((phase) =>
			[false, true].flatMap((abort) => [false, true].map((fail) => ({ phase, abort, fail }))),
		),
	)("$phase abort=$abort fail=$fail has one persisted terminal lifecycle", async ({ phase, abort, fail }) => {
		const h = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		harnesses.push(h);
		await h.modelRuntime.refresh({ allowNetwork: false });
		h.setResponses([fauxAssistantMessage("completed")]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const setup = async () => {
			entered.resolve();
			await release.promise;
			if (fail) throw new Error("controlled setup failure");
		};
		if (phase === "routing") {
			h.modelRuntime.registerVirtualModel({
				provider: h.getModel().provider,
				id: "deferred-route",
				name: "Deferred route",
				route: async () => {
					await setup();
					return { model: h.getModel(), thinkingLevel: "off" };
				},
			});
			await h.modelRuntime.refresh({ allowNetwork: false });
		}
		const provider = h.modelRuntime.getProvider(h.getModel().provider)!;
		const dispatch = vi.spyOn(provider, "streamSimple");
		if (phase === "auth") {
			vi.spyOn(provider.auth.apiKey!, "resolve").mockImplementation(async () => {
				await setup();
				return { auth: { apiKey: "faux-key" } };
			});
		}
		if (phase === "prepareRequest") {
			const previous = h.session.agent.prepareRequest;
			h.session.agent.prepareRequest = async (request, signal) => {
				await setup();
				return (await previous?.(request, signal)) || undefined;
			};
		}
		const runtimeTerminals: string[] = [];
		h.session.agent.streamFunction = async (model, context, options) => {
			if (phase === "asyncStreamFn") await setup();
			if (phase === "lazyStream") {
				// An uncooperative stream can return a setup error or success with no abort classification.
				return lazyStream(model, async () => {
					await setup();
					const response = createAssistantMessageEventStream();
					response.push({ type: "done", reason: "stop", message: fauxAssistantMessage("completed") });
					return response;
				});
			}
			const requestModel = phase === "routing" ? h.modelRuntime.getModel(model.provider, "deferred-route")! : model;
			const response = h.modelRuntime.streamSimple(requestModel, context, {
				...options,
				...(phase === "headers"
					? {
							transformHeaders: async (headers) => {
								await setup();
								return headers;
							},
						}
					: {}),
			});
			// Observe the runtime's own terminal before the loop can normalize it.
			void response.result().then((message) => runtimeTerminals.push(message.stopReason));
			return response;
		};
		const published: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				// Capture at publication, not after another consumer might mutate the object.
				published.push(event.message.stopReason);
			}
		});
		const run = h.session.prompt("test setup cancellation");
		await entered.promise;
		const cancellation = abort ? h.session.abort() : undefined;
		release.resolve();
		await Promise.all([run, cancellation]);

		const reason = abort ? "aborted" : fail ? "error" : "stop";
		const expectedDispatches = abort || fail || phase === "lazyStream" ? 0 : 1;
		expect(dispatch).toHaveBeenCalledTimes(expectedDispatches);
		expect(h.faux.state.callCount).toBe(expectedDispatches);
		expect(published).toEqual([reason]);
		if (phase === "auth" || phase === "headers" || phase === "routing") {
			expect(runtimeTerminals).toEqual([reason]);
		}
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: reason });
		expect(h.eventsOfType("message_start").filter((event) => event.message.role === "assistant")).toHaveLength(1);
		expect(h.eventsOfType("turn_start")).toHaveLength(1);
		expect(h.eventsOfType("turn_end")).toHaveLength(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
		expect(h.session.agent.state.isStreaming).toBe(false);
		expect(h.session.isIdle).toBe(true);
		const persisted = SessionManager.open(h.session.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ message: { role: "assistant", stopReason: reason } });
		if (abort) expect(persisted[0]).toMatchObject({ message: { errorMessage: "Operation aborted" } });
		if (!abort && fail) {
			expect(h.session.messages.at(-1)).toMatchObject({
				errorMessage: expect.stringContaining("setup"),
			});
		}
	});
});
