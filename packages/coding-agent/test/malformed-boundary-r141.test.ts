import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { SessionBoundaryDraft } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

// PR #141 cut item 6: malformed contribution cannot erase earlier validated drafts or escape containment.
describe("malformed boundary contribution isolation", () => {
	for (const entries of [42, [null], [{ type: "custom", customType: "bad", data: () => {} }]]) {
		for (const mutation of [false, true]) {
			it(`preserves the preceding draft when ${mutation ? "mutated" : "returned"} contribution is ${typeof entries === "number" ? "not an array" : entries[0] === null ? "null" : "uncloneable"}`, async () => {
				const runtime = createExtensionRuntime();
				const first = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), runtime, "<first>");
				const bad = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), runtime, "<bad>");
				const later = await loadExtensionFromFactory(() => {}, process.cwd(), createEventBus(), runtime, "<later>");
				const draft: SessionBoundaryDraft = { type: "custom", customType: "synthetic", data: "keep" };
				first.handlers.set("agent_before_settle", [async () => ({ entries: [draft], continue: true })]);
				bad.handlers.set("agent_before_settle", [
					async (event) => {
						if (typeof event !== "object" || event === null) throw new Error("Expected boundary event");
						if (!mutation) {
							if (typeof entries !== "number" && entries[0] !== null) {
								Reflect.set(event, "entries", [
									{ type: "custom", customType: "discard-this-edit", data: "bad" },
								]);
							}
							return { entries, continue: false };
						}
						Reflect.set(event, "entries", entries);
						Reflect.set(event, "continue", false);
						return undefined;
					},
				]);
				const observed = vi.fn(async (_event: unknown) => undefined);
				later.handlers.set("agent_before_settle", [observed]);
				const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
				const runner = new ExtensionRunner(
					[first, bad, later],
					runtime,
					process.cwd(),
					SessionManager.inMemory(process.cwd()),
					registry,
				);
				const errors = vi.fn();
				runner.onError(errors);
				const result = await runner.emitBoundary(
					{ type: "agent_before_settle", outcome: "completed" },
					(drafts) => {
						if (
							!Array.isArray(drafts) ||
							drafts.some((entry) => !entry || entry.type !== "custom" || typeof entry.customType !== "string")
						)
							throw new Error("invalid synthetic draft");
						return {
							contextEntries: [],
							contextMessages: [],
							llmMessages: [],
							pendingMessages: [],
							canContinue: true,
						};
					},
				);
				expect(result).toMatchObject({ entries: [draft], continue: true, valid: true });
				expect(observed).toHaveBeenCalledOnce();
				expect(observed.mock.calls[0]?.[0]).toMatchObject({ entries: [draft], continue: true });
				expect(errors).toHaveBeenCalledWith(
					expect.objectContaining({ extensionPath: "<bad>", event: "agent_before_settle" }),
				);
			});
		}
	}
});
