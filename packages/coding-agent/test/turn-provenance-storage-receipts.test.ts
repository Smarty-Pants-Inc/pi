import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { appendReceivedCustomMessage, appendReceivedMessage } from "../src/core/session-turn-appender.ts";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";
import { captureTerminalTurnReceipt, receiptRecord, type TurnReceipt } from "../src/core/turn-receipts.ts";

afterEach(() => vi.useRealTimers());

describe("opaque receipt storage seam", () => {
	test("issuer has no claim inputs; handles resolve to frozen exact terminal records", () => {
		const claim = { channel: "voice", principal: { id: "forged", binding: "voice-call" } };
		const handle = Reflect.apply(captureTerminalTurnReceipt, undefined, [claim]);
		const record = receiptRecord(handle);
		expect(Object.isFrozen(handle)).toBe(true);
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.keys(record).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		expect(record.channel).toBe("terminal");
		expect(receiptRecord(handle)).toBe(record);
		const forged = { ...record, ...claim } as unknown as TurnReceipt;
		const replacement = receiptRecord(forged);
		expect(replacement.channel).toBe("terminal");
		expect(replacement.turnId).not.toBe(record.turnId);
		expect(receiptRecord().turnId).not.toBe(receiptRecord().turnId);
	});

	test("captured bodies retain first receipt across preview/final and ignore replaceable public methods", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
		const receipt = captureTerminalTurnReceipt();
		const original = receiptRecord(receipt);
		const preview = SessionManager.inMemory();
		const final = SessionManager.inMemory();
		const first = appendReceivedCustomMessage(preview, "boundary", "same", true, undefined, receipt);
		vi.setSystemTime(new Date("2021-01-01T00:00:00.000Z"));
		final.appendMessage = () => {
			throw new Error("public method reached");
		};
		final.appendCustomMessageEntry = () => {
			throw new Error("public method reached");
		};
		const second = appendReceivedCustomMessage(final, "boundary", "same", true, undefined, receipt);
		const third = appendReceivedMessage(final, { role: "user", content: "same", timestamp: 1 }, receipt);
		expect(getTurnProvenance(preview.getEntry(first))).toEqual(original);
		expect(getTurnProvenance(final.getEntry(second))).toEqual(original);
		expect(getTurnProvenance(final.getEntry(third))).toEqual(original);
		expect(original.receivedAt).toBe("2020-01-01T00:00:00.000Z");
		const assistant = appendReceivedMessage(final, fauxAssistantMessage("none"), receipt);
		expect(getTurnProvenance(final.getEntry(assistant))).toBeUndefined();
	});

	test("public methods always stamp a new occurrence even with a valid extra JS handle", () => {
		const m = SessionManager.inMemory();
		const receipt = captureTerminalTurnReceipt();
		const supplied = receiptRecord(receipt);
		const a = Reflect.apply(m.appendMessage, m, [{ role: "user", content: "same", timestamp: 1 }, receipt]);
		const b = Reflect.apply(m.appendCustomMessageEntry, m, ["same", "same", false, undefined, receipt]);
		expect(getTurnProvenance(m.getEntry(a))?.turnId).not.toBe(supplied.turnId);
		expect(getTurnProvenance(m.getEntry(b))?.turnId).not.toBe(supplied.turnId);
		expect(getTurnProvenance(m.getEntry(a))?.turnId).not.toBe(getTurnProvenance(m.getEntry(b))?.turnId);
	});
});
