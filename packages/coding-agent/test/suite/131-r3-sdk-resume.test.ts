import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness } from "./harness.ts";

// PR #131 F16: direct SDK restoration must load queued routers before looking up the saved selection.
it("restores a saved virtual selection with a fresh loader/runtime and routes the first SDK request", async () => {
	const h = await createHarness({ settings: { cacheWarming: "off" } });
	let resumed: Awaited<ReturnType<typeof createAgentSession>> | undefined;
	try {
		const physical = h.getModel();
		h.sessionManager.appendModelChange("saved-router", "auto");
		h.sessionManager.appendMessage({ role: "user", content: "old question", timestamp: 1 });
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("old answer"),
			provider: physical.provider,
			model: physical.id,
			api: physical.api,
		});
		const requests: string[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.registerVirtualModel({
						provider: "saved-router",
						id: "auto",
						name: "Saved router",
						route(request, ctx) {
							requests.push(`${request.model.provider}/${request.model.id}`);
							expect(ctx.model).toMatchObject({ provider: "saved-router", id: "auto" });
							return { model: physical, thinkingLevel: "off" };
						},
					});
				},
			],
			h.tempDir,
		);
		expect(h.session.modelRuntime.getModel("saved-router", "auto")).toBeUndefined();
		expect(extensionsResult.runtime.pendingVirtualModelRegistrations).toHaveLength(1);
		resumed = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			sessionManager: h.sessionManager,
			settingsManager: h.settingsManager,
			modelRuntime: h.session.modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: [],
		});
		h.setResponses([fauxAssistantMessage("new answer")]);
		await resumed.session.prompt("first resumed request");
		expect(requests).toEqual(["saved-router/auto"]);
		expect(resumed.session.model).toMatchObject({ provider: "saved-router", id: "auto" });
		expect(resumed.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: physical.provider,
			model: physical.id,
			stopReason: "stop",
		});
		expect(resumed.modelFallbackMessage).toBeUndefined();
	} finally {
		resumed?.session.dispose();
		h.session.dispose();
		h.faux.unregister();
	}
});
