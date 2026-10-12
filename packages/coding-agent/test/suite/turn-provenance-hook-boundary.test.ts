import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessageEntryDraft } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
function receipt(entry: unknown) {
	return (entry as { provenance: { turnId: string; receivedAt: string; channel: string } }).provenance;
}
function drafts(content: string): CustomMessageEntryDraft {
	return { type: "custom_message", customType: "proposal", content, display: false };
}

// pi#95: proposal occurrences survive clones, observers and intentional mutations.
describe("boundary receipt retention", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	it.each(["reorder", "replace", "throw", "uncloneable", "invalid-repair", "accessor"] as const)(
		"accounts for %s proposals without stamping non-message state",
		async (route) => {
			let preview: ReturnType<typeof receipt>[] = [];
			let finalPreview: ReturnType<typeof receipt>[] = [];
			let accessorReads = 0;
			const h = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", () => ({ entries: [drafts("one"), drafts("two")] }));
						pi.on("turn_end", (event) => {
							preview = event.context.contextEntries
								.filter((entry) => entry.sourceEntry.type === "custom_message")
								.map((entry) => receipt(entry.sourceEntry));
							vi.setSystemTime(later);
							if (route === "reorder") event.entries = [event.entries[1], event.entries[0], event.entries[1]];
							if (route === "replace") return { entries: event.entries.map((draft) => ({ ...draft })) };
							if (route === "throw") {
								event.entries.push(drafts("retained after error"));
								throw new Error("handler failed after mutation");
							}
							if (route === "uncloneable") {
								event.entries.push(drafts("retained after error"));
								return { entries: [{ ...drafts("discarded"), details: () => {} }] };
							}
							if (route === "invalid-repair")
								return {
									entries: [
										drafts("invalid"),
										{ type: "context_edit", targetId: "missing", replacement: null },
									],
								};
							if (route === "accessor")
								return {
									entries: [
										{
											...drafts("accessor"),
											get type() {
												accessorReads++;
												return accessorReads === 1 ? ("custom_message" as const) : ("custom" as never);
											},
										},
									],
								};
						});
						pi.on("turn_end", (event) => {
							if (route === "invalid-repair") return { entries: [drafts("repaired")] };
							event.entries.push({ type: "custom", customType: "state", data: true });
						});
						pi.on("turn_end", (event) => {
							finalPreview = event.context.contextEntries
								.filter((entry) => entry.sourceEntry.type === "custom_message")
								.map((entry) => receipt(entry.sourceEntry));
						});
					},
				],
			});
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage("done")]);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(first);
			await h.session.prompt("start");
			const customs = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			const records = customs.map(receipt);
			expect(records).toEqual(finalPreview);
			if (route === "reorder") {
				expect(records.slice(0, 2)).toEqual([preview[1], preview[0]]);
				expect(records[2].receivedAt).toBe(later);
				expect(records[2].turnId).not.toBe(preview[1].turnId);
			} else if (route === "throw" || route === "uncloneable") {
				expect(records.slice(0, 2)).toEqual(preview);
				expect(customs[2].content).toBe("retained after error");
				expect(records[2].receivedAt).toBe(later);
			} else {
				expect(records.every((record) => record.receivedAt === later)).toBe(true);
				expect(records.every((record) => !preview.some((prior) => prior.turnId === record.turnId))).toBe(true);
			}
			if (route === "accessor") expect(accessorReads).toBe(1);
			expect(records.every((record) => record.channel === "terminal")).toBe(true);
			const state = h.sessionManager.getEntries().find((entry) => entry.type === "custom");
			if (state) expect(receipt(state)).toBeUndefined();
			expect(
				SessionManager.open(h.session.sessionFile!)
					.getEntries()
					.filter((entry) => entry.type === "custom_message"),
			).toEqual(customs);
		},
	);
	it("does not persist invalid final proposals", async () => {
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => ({
						entries: [drafts("invalid"), { type: "context_edit", targetId: "missing", replacement: null }],
					}));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
	});
});
