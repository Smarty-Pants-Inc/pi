import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { SessionBoundaryDraft } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

// PR #141 cut #11: safe extraction of hosted session-churn malformed assertions; no fixture cleanup.
it.each([null, {}, "malformed"])(
	"keeps prior valid proposal after malformed %j in the hosted fixture",
	async (malformed) => {
		const runtime = createExtensionRuntime();
		const kept: SessionBoundaryDraft = { type: "custom", customType: "preceding-valid", data: true };
		let observed = false;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("agent_before_settle", () => ({ entries: [kept], continue: true }));
				pi.on("agent_before_settle", () => ({ entries: malformed as unknown as SessionBoundaryDraft[] }));
				pi.on("agent_before_settle", (event) => {
					observed = true;
					expect(event.entries).toEqual([kept]);
					expect(event.continue).toBe(true);
				});
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(process.cwd()),
			registry,
		);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));
		const result = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, (entries) => {
			if (!Array.isArray(entries)) throw new Error("Boundary entries must be an array");
			return { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false };
		});
		expect(observed).toBe(true);
		expect(errors).toEqual(["Invalid boundary entries: Boundary entries must be an array"]);
		expect(result).toMatchObject({ valid: true, entries: [kept], continue: true });
	},
);
