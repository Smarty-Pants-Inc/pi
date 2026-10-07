import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function receipt(entry: unknown) {
	return (entry as { provenance: { turnId: string; receivedAt: string; channel: string } }).provenance;
}

// pi#95: automatic redispatch is not a second admission.
describe("deferred turn receipts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	it("preserves prompt and custom occurrences deferred by settlement", async () => {
		let queued = false;
		let h!: Harness;
		h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (queued) return;
						queued = true;
						// #3048: SDK prompt() refuses inside its own agent_settled handler; the detached
						// extension API schedules the same deferred user occurrence.
						pi.sendUserMessage("deferred user");
						await h.session.sendCustomMessage(
							{ customType: "settled", content: "deferred custom", display: false },
							{ triggerTurn: true },
						);
					});
					pi.on("agent_settled", () => {
						vi.setSystemTime(later);
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("user"), fauxAssistantMessage("custom")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("start");
		const entries = h.sessionManager
			.getEntries()
			.filter(
				(entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"),
			);
		expect(entries.map((entry) => receipt(entry).receivedAt)).toEqual([first, first, first]);
		expect(new Set(entries.map((entry) => receipt(entry).turnId)).size).toBe(3);
		expect(h.faux.state.callCount).toBe(3);
		expect(SessionManager.open(h.session.sessionFile!).getEntries()).toEqual(h.sessionManager.getEntries());
	});
	it.each(["steer", "followUp"] as const)("retains %s external switch-waiter receipts", async (deliverAs) => {
		const started = gate();
		const release = gate();
		const h = await createHarness({
			persistSession: true,
			models: [
				{ id: "large", contextWindow: 100_000 },
				{ id: "small", contextWindow: 16_000 },
			],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						started.release();
						await release.promise;
						return {
							compaction: {
								summary: "small",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("previous"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		h.setResponses([fauxAssistantMessage("delivered")]);
		const switching = h.session.setModel(h.getModel("small")!);
		await started.promise;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		const sent = h.session.sendCustomMessage(
			{ customType: "waiter", content: "same", display: false },
			{ triggerTurn: true, deliverAs },
		);
		vi.setSystemTime(later);
		release.release();
		await Promise.all([switching, sent]);
		await h.session.waitForIdle();
		const entries = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(entries).toHaveLength(1);
		expect(receipt(entries[0])).toMatchObject({ receivedAt: first, channel: "terminal" });
		expect(SessionManager.open(h.session.sessionFile!).getEntry(entries[0].id)).toEqual(entries[0]);
	});
});
