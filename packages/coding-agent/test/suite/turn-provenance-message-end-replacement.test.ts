import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { getInputReceipt, promptReceived, receiveInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../src/core/turn-receipts.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

async function persistedUserProvenance(replace: (text: string) => unknown, typed: string, token: string) {
	const h = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.on("message_end", (event) => {
					if (event.message.role !== "user") return;
					return { message: { ...event.message, content: replace(typed) as string, timestamp: 1 } };
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	const at = new Date().toISOString();
	const input = receiveInput(typed, undefined, captureKeyboardTurnReceipt("paul", token, at));
	const before = receiptRecord(getInputReceipt(input));
	expect(before).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
	await promptReceived(h.session, input);
	const entry = SessionManager.open(h.sessionManager.getSessionFile()!)
		.getEntries()
		.find((value) => value.type === "message" && value.message.role === "user");
	return {
		before,
		at,
		message: entry?.type === "message" ? entry.message : undefined,
		provenance: getTurnProvenance(entry!),
	};
}

// pi#160 review (smarty-dev#2636): Herdr attested the typed bytes, not text a message_end hook produced.
it("drops keyboard attribution when a message_end replacement changes the user text", async () => {
	const token = "c".repeat(32);
	const { before, at, message, provenance } = await persistedUserProvenance(
		() => "replaced by message_end",
		"typed by paul",
		token,
	);
	expect(JSON.stringify(message)).toContain("replaced by message_end");
	expect(provenance).toEqual({
		v: 1,
		turnId: before.turnId,
		receivedAt: at,
		channel: "terminal",
		submissionToken: token,
	});
	expect(provenance).not.toHaveProperty("principal");
});

it("keeps keyboard attribution when a message_end replacement leaves the user text identical", async () => {
	const { before, message, provenance } = await persistedUserProvenance(
		(text) => [{ type: "text", text }],
		"typed by paul",
		"d".repeat(32),
	);
	expect(JSON.stringify(message)).toContain("typed by paul");
	expect(message).toMatchObject({ timestamp: 1 });
	expect(provenance).toEqual(before);
	expect(provenance).toMatchObject({ channel: "keyboard", principal: { id: "paul", binding: "herdr-client" } });
});
