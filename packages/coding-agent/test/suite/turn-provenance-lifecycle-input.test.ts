import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	followUpReceived,
	getInputReceipt,
	promptReceived,
	receiveInput,
	steerReceived,
} from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { captureTerminalTurnReceipt, receiptRecord, type TurnReceipt } from "../../src/core/turn-receipts.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
// pi#95: automatic mode/session handoffs retain opaque receipts, never caller records.
describe("received input handoff", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	it.each([promptReceived, steerReceived, followUpReceived])(
		"retains admission across private handoff %s",
		async (send) => {
			const h = await createHarness({ persistSession: true });
			harnesses.push(h);
			h.sessionManager.appendMessage(fauxAssistantMessage("previous"));
			h.session.refreshContext();
			h.setResponses([fauxAssistantMessage("done")]);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(first);
			const input = receiveInput("same");
			const expected = receiptRecord(getInputReceipt(input));
			vi.setSystemTime(later);
			await send(h.session, input);
			if (send !== promptReceived) await h.session.agent.continue();
			const entry = h.sessionManager
				.getEntries()
				.find((value) => value.type === "message" && value.message.role === "user");
			expect(entry).toMatchObject({ provenance: expected });
			expect(SessionManager.open(h.session.sessionFile!).getEntry(entry!.id)).toEqual(entry);
			expect("receipt" in input).toBe(false);
			expect("provenance" in input).toBe(false);
		},
	);
	it("rejects forged handles at receive time and preserves issued handles on transfer", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		const issued = captureTerminalTurnReceipt();
		const transferred = receiveInput("same", undefined, issued);
		expect(getInputReceipt(transferred)).toBe(issued);
		const forged = { v: 1, turnId: "forged", receivedAt: "caller time", channel: "fabric" } as unknown as TurnReceipt;
		const rejected = receiveInput("same", undefined, forged);
		vi.setSystemTime(later);
		expect(receiptRecord(getInputReceipt(rejected))).toMatchObject({ receivedAt: first, channel: "terminal" });
		expect(getInputReceipt(rejected)).not.toBe(forged);
		expect(() => getInputReceipt({ text: "same" })).toThrow("not received");
	});
	it("keeps a refused pre-prompt compaction occurrence when it is later recovered", async () => {
		const h = await createHarness({
			persistSession: true,
			models: [{ id: "faux", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: Date.now() - 2000 });
		h.sessionManager.appendMessage({ ...fauxAssistantMessage("previous"), timestamp: Date.now() - 1000 });
		h.session.refreshContext();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await expect(h.session.prompt("retained occurrence")).rejects.toThrow("compaction was cancelled");
		expect(h.session.getSteeringMessages()).toEqual(["retained occurrence"]);
		const retained = h.session.agent.peekQueuedMessages()[0];
		vi.setSystemTime(later);
		// Recover without the oversized prior context, while keeping the actual queued message.
		h.sessionManager.appendCompaction("small summary", null, 1);
		h.session.refreshContext();
		h.session.setAutoCompactionEnabled(false);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.agent.prompt([]);
		const entry = h.sessionManager
			.getEntries()
			.find((value) => value.type === "message" && value.message === retained);
		expect(entry).toMatchObject({ provenance: { receivedAt: first, channel: "terminal" } });
		expect(SessionManager.open(h.session.sessionFile!).getEntry(entry!.id)).toEqual(entry);
	});
});
