import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { appendReceivedCustomMessage, appendReceivedMessage } from "../src/core/session-turn-appender.ts";
import type { TurnProvenance } from "../src/core/turn-provenance.ts";
import {
	captureKeyboardTurnReceipt,
	captureTerminalTurnReceipt,
	receiptRecord,
	restoreTerminalTurnReceipt,
	type TurnReceipt,
} from "../src/core/turn-receipts.ts";
import {
	getUnsentInputTransfer,
	linkUnsentInputTransfer,
	readUnsentInput,
	UNSENT_INPUT_TYPE,
	type UnsentInput,
} from "../src/core/unsent-input.ts";

describe("unsent input storage boundary", () => {
	// Regression control for pi#262 / smarty-dev#3155: only replayable display content parses.
	it("parses user and custom input while preserving mode, images, metadata, and origin", () => {
		const image = { type: "image" as const, data: "image-bytes", mimeType: "image/png" };
		const userInput: UnsentInput = {
			origin: { sessionId: "local-session", host: "local-host", uid: 42 },
			message: {
				role: "user",
				content: [{ type: "text", text: "retain this" }, image],
				timestamp: 123,
			},
			mode: "followUp",
			metadata: { requestId: "request-1", nested: { retained: true } },
			metadataSource: { kind: "extension", extensionPath: "/extensions/example.ts" },
		};
		const parsedUser = readUnsentInput(userInput);
		expect(parsedUser).toEqual(userInput);
		expect(parsedUser?.message).not.toBe(userInput.message);
		if (parsedUser?.message.role !== "user" || userInput.message.role !== "user")
			throw new Error("expected parsed user input");
		expect(parsedUser.message.content).not.toBe(userInput.message.content);

		const customInput: UnsentInput = {
			message: {
				role: "custom",
				customType: "operator-note",
				content: "retain custom content",
				display: true,
				details: { visible: true },
				timestamp: 456,
			},
			mode: "nextTurn",
		};
		expect(readUnsentInput(customInput)).toEqual(customInput);
	});

	// Regression control for pi#262 / smarty-dev#3155: assistant, tool, and executable payloads never replay.
	it("rejects unsupported roles, modes, and content blocks", () => {
		const validMessage = { role: "user", content: "text", timestamp: 1 };
		expect(readUnsentInput({ message: validMessage, mode: "nextTurn" })).toBeUndefined();
		expect(
			readUnsentInput({ message: { role: "assistant", content: "text", timestamp: 1 }, mode: "steer" }),
		).toBeUndefined();
		expect(
			readUnsentInput({ message: { role: "toolResult", content: "text", timestamp: 1 }, mode: "followUp" }),
		).toBeUndefined();
		expect(
			readUnsentInput({
				message: {
					role: "user",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
					timestamp: 1,
				},
				mode: "steer",
			}),
		).toBeUndefined();
		expect(
			readUnsentInput({
				message: {
					role: "custom",
					customType: "note",
					content: [{ type: "image", data: "x" }],
					display: true,
					timestamp: 1,
				},
				mode: "context",
			}),
		).toBeUndefined();
	});

	// Regression control for pi#262 / smarty-dev#3155: foreign stored input is draft material, not a trusted replay claim.
	it("parses foreign input without converting its origin or provenance", () => {
		const foreignProvenance: TurnProvenance = {
			v: 1,
			turnId: "12345678-1234-4234-8234-123456789abc",
			receivedAt: "2026-01-01T00:00:00.000Z",
			channel: "fabric",
			sender: { id: "foreign-agent", kind: "agent", verified: "mesh" },
		};
		const foreign: UnsentInput = {
			origin: { sessionId: "other-session", host: "other-host", uid: 7 },
			message: {
				role: "custom",
				customType: "foreign-note",
				content: [{ type: "text", text: "review before sending" }],
				display: false,
				details: { foreignSecret: "must remain draft-only" },
				timestamp: 789,
			},
			mode: "context",
			provenance: foreignProvenance,
			metadata: { foreign: true },
			metadataSource: { kind: "extension", extensionPath: "foreign-extension.ts" },
		};
		const parsed = readUnsentInput(foreign);
		expect(parsed).toEqual(foreign);
		expect(parsed?.origin).toEqual(foreign.origin);
		expect(parsed?.provenance).toEqual(foreignProvenance);
	});

	// Regression control for pi#262 / smarty-dev#3155: replay accepts only a terminal attestation.
	it("restores terminal provenance and downgrades keyboard provenance instead of fabricating attestation", () => {
		const token = "0123456789abcdef0123456789abcdef";
		const keyboard = captureKeyboardTurnReceipt("operator", token, "2026-01-01T00:00:00.000Z");
		const keyboardRecord = receiptRecord(keyboard);
		expect(() => restoreTerminalTurnReceipt(keyboardRecord)).toThrow("Invalid retained terminal receipt");

		const downgraded: TurnProvenance = {
			v: keyboardRecord.v,
			channel: "terminal",
			turnId: keyboardRecord.turnId,
			receivedAt: keyboardRecord.receivedAt,
			submissionToken: keyboardRecord.submissionToken,
		};
		const restored = restoreTerminalTurnReceipt(downgraded);
		expect(receiptRecord(restored)).toEqual(downgraded);
		expect(receiptRecord(restored).channel).toBe("terminal");
		expect("principal" in receiptRecord(restored)).toBe(false);

		const terminal = captureTerminalTurnReceipt();
		const terminalRecord = receiptRecord(terminal);
		const restoredTerminal = restoreTerminalTurnReceipt(terminalRecord);
		expect(receiptRecord(restoredTerminal)).toEqual(terminalRecord);
	});

	// Regression control for pi#262 / smarty-dev#3155: transfer identity is a WeakMap capability, not caller data.
	it("isolates transfer links by receipt identity", () => {
		const first = captureTerminalTurnReceipt();
		const second = captureTerminalTurnReceipt();
		const lookalike = Object.freeze({}) as TurnReceipt;
		linkUnsentInputTransfer(first, "outbox-1");
		expect(getUnsentInputTransfer(first)).toBe("outbox-1");
		expect(getUnsentInputTransfer(second)).toBeUndefined();
		expect(getUnsentInputTransfer(lookalike)).toBeUndefined();
		linkUnsentInputTransfer(first, "outbox-2");
		expect(getUnsentInputTransfer(first)).toBe("outbox-2");
	});

	// Regression control for pi#262 / smarty-dev#3155: only actual message/custom appends consume the transfer link.
	it("stamps consumed links on message and custom appends without flagging unrelated entries", () => {
		const manager = SessionManager.inMemory();
		const userOutbox = manager.appendCustomEntry(UNSENT_INPUT_TYPE, {
			message: { role: "user", content: "queued user", timestamp: 1 },
			mode: "steer",
		});
		const customOutbox = manager.appendCustomEntry(UNSENT_INPUT_TYPE, {
			message: {
				role: "custom",
				customType: "queued-custom",
				content: "queued custom",
				display: true,
				timestamp: 2,
			},
			mode: "followUp",
		});
		const userReceipt = captureTerminalTurnReceipt();
		const customReceipt = captureTerminalTurnReceipt();
		linkUnsentInputTransfer(userReceipt, userOutbox);
		linkUnsentInputTransfer(customReceipt, customOutbox);

		appendReceivedMessage(manager, { role: "user", content: "delivered user", timestamp: 3 }, userReceipt);
		appendReceivedCustomMessage(manager, "delivered-custom", "delivered custom", true, undefined, customReceipt);
		appendReceivedMessage(
			manager,
			{ role: "user", content: "ordinary user", timestamp: 4 },
			captureTerminalTurnReceipt(),
		);

		const entries = manager.getEntries();
		const deliveredUser = entries.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && entry.message.content === "delivered user",
		);
		const deliveredCustom = entries.find(
			(entry) => entry.type === "custom_message" && entry.customType === "delivered-custom",
		);
		const ordinaryUser = entries.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && entry.message.content === "ordinary user",
		);
		expect(deliveredUser?.unsentInputId).toBe(userOutbox);
		expect(deliveredCustom?.unsentInputId).toBe(customOutbox);
		expect(ordinaryUser?.unsentInputId).toBeUndefined();
	});
});
