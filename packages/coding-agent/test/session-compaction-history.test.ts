import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionBeforeCompactEvent } from "../src/core/extensions/types.ts";
import { createHarness } from "./suite/harness.ts";

// smarty-dev#11897: real manual compaction, faux provider, native history isolation.
describe("compaction observer history isolation", () => {
	it("shares only frozen detached history, not mutable preparation or observer flags", async () => {
		const held: SessionBeforeCompactEvent[] = [];
		const errors: string[] = [];
		let customId = "";
		let originalLength = 0;
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: true, keepRecentTokens: 16, reserveTokens: 1024 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						held.push(event);
						originalLength = event.branchEntries.length;
						const entry = event.branchEntries.find((item) => item.id === customId);
						if (entry?.type !== "custom") throw new Error("missing custom entry");
						const data = entry.data as { nested: number[] };
						expect(Object.isFrozen(event.branchEntries)).toBe(true);
						expect(Object.isFrozen(entry)).toBe(true);
						expect(() => data.nested.push(2)).toThrow(TypeError);
						expect(() => {
							event.branchEntries.length = 0;
						}).toThrow(TypeError);
						expect(Reflect.set(event, "_fabricCompaction", true)).toBe(true);
						event.preparation.fileOps.read.add("observer-only");
					});
				},
				(pi) => {
					pi.on("session_before_compact", (event) => {
						held.push(event);
						expect(event.branchEntries).toBe(held[0].branchEntries);
						expect(event.branchEntries.length).toBe(originalLength);
						expect(event.preparation).not.toBe(held[0].preparation);
						expect(event.preparation.fileOps.read.has("observer-only")).toBe(false);
						expect(Reflect.has(event, "_fabricCompaction")).toBe(false);
						return { cancel: true };
					});
				},
			],
		});
		try {
			h.sessionManager.appendMessage({ role: "user", content: "old content ".repeat(1000), timestamp: 1 });
			customId = h.sessionManager.appendCustomEntry("state", { nested: [1] });
			h.sessionManager.appendMessage({ role: "user", content: "recent content ".repeat(100), timestamp: 2 });
			await h.session.bindExtensions({ onError: (error) => errors.push(error.error) });
			const bytes = readFileSync(h.sessionManager.getSessionFile()!);
			const before = JSON.stringify(h.sessionManager.getEntries());
			const revision = h.sessionManager.revision();
			await expect(h.session.compact()).rejects.toThrow("Compaction cancelled");
			expect(errors).toEqual([]);
			expect(held).toHaveLength(2);
			expect(held[0].signal).toBe(held[1].signal);
			const entry = held[0].branchEntries.find((item) => item.id === customId);
			if (entry?.type !== "custom") throw new Error("missing retained entry");
			expect(() => {
				entry.data = "late mutation";
			}).toThrow(TypeError);
			expect(JSON.stringify(h.sessionManager.getEntries())).toBe(before);
			expect(h.sessionManager.revision()).toBe(revision);
			expect(readFileSync(h.sessionManager.getSessionFile()!)).toEqual(bytes);
			expect(h.getPendingResponseCount()).toBe(0);
		} finally {
			await h.cleanup();
		}
	});
});
