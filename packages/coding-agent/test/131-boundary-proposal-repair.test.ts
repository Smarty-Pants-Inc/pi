import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { BoundaryContextPreview, SessionBoundaryDraft } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

// PR #131: an invalid proposal must reach the next handler, not escape preview reconciliation.
describe("boundary proposal repair", () => {
	it.each([null, {}, "malformed"])(
		"isolates malformed entries %j and lets a later handler repair",
		async (malformed) => {
			const runtime = createExtensionRuntime();
			let repaired = false;
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("agent_before_settle", () => ({ entries: malformed as unknown as SessionBoundaryDraft[] }));
					pi.on("agent_before_settle", (event) => {
						expect(event.entries).toEqual(malformed);
						repaired = true;
						return { entries: [] };
					});
				},
				process.cwd(),
				createEventBus(),
				runtime,
				"<inline:repair>",
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				process.cwd(),
				SessionManager.inMemory(process.cwd()),
				{} as ModelRegistry,
			);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			const result = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, (entries) => {
				if (!Array.isArray(entries)) throw new Error("Boundary entries must be an array");
				return {
					contextEntries: [],
					contextMessages: [],
					llmMessages: [],
					pendingMessages: [],
					canContinue: false,
				} satisfies BoundaryContextPreview;
			});
			expect(repaired).toBe(true);
			expect(errors).toEqual(["Invalid boundary entries: Boundary entries must be an array"]);
			expect(result).toMatchObject({ valid: true, entries: [], continue: false });
		},
	);
});
