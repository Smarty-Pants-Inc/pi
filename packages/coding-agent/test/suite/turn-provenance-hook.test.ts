import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBeforeSettleEvent, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
function customs(h: Harness) {
	return h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
}
function receipt(entry: unknown) {
	return (entry as { provenance?: { turnId: string; receivedAt: string; channel: string } }).provenance;
}

// pi#95: accepted hook results are separate occurrences, including reused frozen objects.
describe("hook turn receipts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	it("reads before-start message once and stamps before getters and later handlers", async () => {
		let reads = 0;
		const shared = Object.freeze({ customType: "hook", content: "first value", display: false });
		const result = Object.freeze({
			get message() {
				reads++;
				vi.setSystemTime(later);
				return reads === 1 ? shared : { ...shared, content: "second value" };
			},
		});
		const h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => result);
					pi.on("before_agent_start", () => ({ message: shared }));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("start");
		const entries = customs(h);
		expect(reads).toBe(1);
		expect(entries.map((entry) => entry.content)).toEqual(["first value", "first value"]);
		expect(receipt(entries[0])).toMatchObject({ receivedAt: first, channel: "terminal" });
		expect(receipt(entries[1])).toMatchObject({ receivedAt: later, channel: "terminal" });
		expect(receipt(entries[0])!.turnId).not.toBe(receipt(entries[1])!.turnId);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toEqual(entries);
	});
	it("admits two handlers returning the same frozen result as separate turns", async () => {
		const result = Object.freeze({
			message: Object.freeze({ customType: "duplicate", content: "same", display: false }),
		});
		const h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => result);
					pi.on("before_agent_start", () => result);
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		const entries = customs(h);
		expect(entries).toHaveLength(2);
		expect(receipt(entries[0])!.turnId).not.toBe(receipt(entries[1])!.turnId);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toEqual(entries);
	});
	it.each(["turn_end", "agent_before_settle"] as const)(
		"retains positional duplicate receipts through %s preview and final commit",
		async (boundary) => {
			let preview: unknown[] = [];
			const draft = Object.freeze({
				type: "custom_message" as const,
				customType: "boundary",
				content: "same",
				display: false,
			});
			const h = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						const propose = () => ({ entries: [draft, draft] });
						const observe = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
							preview = event.context.contextEntries
								.filter((entry) => entry.sourceEntry.type === "custom_message")
								.map((entry) => receipt(entry.sourceEntry));
							vi.setSystemTime(later);
						};
						if (boundary === "turn_end") {
							pi.on("turn_end", propose);
							pi.on("turn_end", observe);
						} else {
							pi.on("agent_before_settle", propose);
							pi.on("agent_before_settle", observe);
						}
					},
				],
			});
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage("done")]);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(first);
			await h.session.prompt("start");
			const entries = customs(h);
			expect(entries).toHaveLength(2);
			expect(entries.map(receipt)).toEqual(preview);
			expect(preview).toEqual([
				expect.objectContaining({ receivedAt: first }),
				expect.objectContaining({ receivedAt: first }),
			]);
			expect(receipt(entries[0])!.turnId).not.toBe(receipt(entries[1])!.turnId);
			expect(
				SessionManager.open(h.session.sessionFile!)
					.getEntries()
					.filter((entry) => entry.type === "custom_message"),
			).toEqual(entries);
		},
	);
});
