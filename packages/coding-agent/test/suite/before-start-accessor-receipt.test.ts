// pi#95 R4: before_agent_start accessors must not orphan or shift host receipts.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import * as turnProvenance from "../../src/core/turn-provenance.ts";
import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionError } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const FIRST_RECEIPT = "2026-09-30T19:00:01.000Z";
const DELAYED_RECEIPT = "2026-09-30T19:00:05.000Z";
const APPENDED_AT = "2026-09-30T19:00:09.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function customEntries(manager: SessionManager) {
	return manager.getEntries().filter((entry) => entry.type === "custom_message");
}

describe("before_agent_start accessor receipts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	for (const firstReadThrows of [false, true]) {
		// pi#95 R4: cover both second-read failure and rejection before receipt admission.
		it(`${firstReadThrows ? "rejects a first-read throw without admitting a receipt" : "reads a getter once even when its second read would throw"} and preserves the delayed message's receipt on reopen`, async () => {
			let reads = 0;
			const accessorMessage = Object.freeze({
				customType: "accessor-message",
				content: "message captured from getter",
				display: false,
			});
			const delayedMessage = Object.freeze({
				customType: "delayed-message",
				content: "message after held handler",
				display: false,
			});
			const returned: BeforeAgentStartEventResult = Object.freeze({
				get message() {
					reads++;
					if (firstReadThrows || reads > 1) throw new Error("message accessor failed");
					return accessorMessage;
				},
			});
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let markEntered!: () => void;
			const entered = new Promise<void>((resolve) => {
				markEntered = resolve;
			});
			const harness = await createHarness({
				persistSession: true,
				extensionFactories: [
					{
						name: "accessor-receipts",
						factory: (pi: ExtensionAPI) => {
							pi.on("before_agent_start", () => {
								vi.setSystemTime(new Date(FIRST_RECEIPT));
								return returned;
							});
							pi.on("before_agent_start", async () => {
								markEntered();
								await held;
								return { message: delayedMessage };
							});
							pi.on("before_agent_start", async () => {
								await Promise.resolve();
								vi.setSystemTime(new Date(APPENDED_AT));
							});
						},
					},
				],
			});
			harnesses.push(harness);
			const errors: ExtensionError[] = [];
			await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
			// Observe real host stamps, including their original UUIDs; do not replace the resolver.
			const receipts = vi.spyOn(turnProvenance, "resolveExtensionTurnProvenance");
			vi.useFakeTimers({ toFake: ["Date"] });
			harness.setResponses([fauxAssistantMessage("done")]);
			const prompt = harness.session.prompt("input");
			try {
				await entered;
				vi.setSystemTime(new Date(DELAYED_RECEIPT));
			} finally {
				release();
				await prompt;
			}

			const entries = customEntries(harness.sessionManager);
			const delayed = entries.find((entry) => entry.customType === delayedMessage.customType);
			expect(delayed).toBeDefined();
			if (!delayed) throw new Error("delayed message was not persisted");
			// Assert timing first so RED exposes the orphan receipt, not just the double read.
			expect(turnProvenance.getTurnProvenance(delayed)?.receivedAt).toBe(DELAYED_RECEIPT);
			expect(reads).toBe(1);
			expect(errors.map(({ event, error }) => ({ event, error }))).toEqual(
				firstReadThrows ? [{ event: "before_agent_start", error: "message accessor failed" }] : [],
			);
			const expectedMessages = firstReadThrows ? [delayedMessage] : [accessorMessage, delayedMessage];
			const expectedTimes = firstReadThrows ? [DELAYED_RECEIPT] : [FIRST_RECEIPT, DELAYED_RECEIPT];
			expect(entries).toHaveLength(expectedMessages.length);
			expect(receipts).toHaveBeenCalledTimes(expectedMessages.length);
			const originalReceipts = receipts.mock.results.map((result) => {
				if (result.type !== "return") throw new Error("receipt resolver did not return");
				return result.value;
			});
			const records = entries.map(turnProvenance.getTurnProvenance);
			expect(records).toEqual(originalReceipts);
			expect(new Set(records.map((record) => record?.turnId)).size).toBe(entries.length);
			for (let index = 0; index < entries.length; index++) {
				expect(entries[index]).toMatchObject({ ...expectedMessages[index], timestamp: APPENDED_AT });
				expect(records[index]).toEqual({
					v: 1,
					turnId: expect.stringMatching(UUID),
					receivedAt: expectedTimes[index],
					channel: "terminal",
				});
				expect(Object.isFrozen(records[index])).toBe(true);
			}
			const file = harness.sessionManager.getSessionFile();
			if (!file) throw new Error("session file missing");
			const persisted = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as SessionEntry)
				.filter((entry) => entry.type === "custom_message");
			expect(persisted).toEqual(entries);
			expect(persisted.map(turnProvenance.getTurnProvenance)).toEqual(originalReceipts);
			const reopened = customEntries(SessionManager.open(file, harness.tempDir));
			expect(reopened).toEqual(entries);
			expect(reopened.map(turnProvenance.getTurnProvenance)).toEqual(originalReceipts);
		});
	}
});
