import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { getInputReceipt, promptReceived, receiveInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../src/core/turn-receipts.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

// pi#160 R9 P2 / smarty-dev#12838: request-only edits have no keyboard receipt to impersonate.
// The receipt attests the frozen persisted original, not the mutable provider-bound clone.
it("sends prepareRequest edits without keyboard attribution and keeps the receipt on the typed history", async () => {
	const typed = "typed by paul";
	const rewritten = "rewritten by prepareRequest";
	const input = receiveInput(
		typed,
		undefined,
		captureKeyboardTurnReceipt("paul", "a".repeat(32), new Date().toISOString()),
	);
	const receipt = receiptRecord(getInputReceipt(input));
	let providerPayload: TranscriptContext | undefined;
	let hookInput: unknown;
	const h = await createHarness({
		persistSession: true,
		prepareRequest: ({ context }) => {
			const stored = h.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (stored?.type !== "message") throw new Error("missing persisted user entry before request hook");
			expect(getTurnProvenance(stored)).toEqual(receipt);
			expect(Object.isFrozen(stored)).toBe(true);
			expect(Object.isFrozen(stored.message)).toBe(true);
			expect(getMessageText(stored.message)).toBe(typed);
			const user = context.messages.find((message) => message.role === "user");
			if (user?.role !== "user") throw new Error("missing request user");
			expect(user).not.toBe(stored.message);
			expect(Object.isFrozen(user)).toBe(false);
			hookInput = structuredClone(user);
			user.content = rewritten;
		},
	});
	harnesses.push(h);
	h.setResponses([
		(context) => {
			// Observe the actual normalized payload consumed by the faux provider, not a hook-call count.
			providerPayload = structuredClone(context);
			return fauxAssistantMessage("done");
		},
	]);
	await promptReceived(h.session, input);
	expect(h.session.getLastAssistantText()).toBe("done");
	expect(providerPayload?.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
		rewritten,
	]);
	const outbound = JSON.stringify(providerPayload);
	expect(outbound).toBeDefined();
	for (const artifact of [JSON.stringify(hookInput), outbound]) {
		expect(artifact).not.toMatch(/"(?:provenance|receipt|principal|channel|turnId|submissionToken)"\s*:/);
		expect(artifact).not.toContain(receipt.turnId);
		expect(artifact).not.toContain(receipt.submissionToken!);
	}
	const stored = SessionManager.open(h.sessionManager.getSessionFile()!)
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	expect(stored?.type === "message" && getMessageText(stored.message)).toBe(typed);
	expect(getTurnProvenance(stored)).toEqual(receipt);
	expect(JSON.stringify(stored)).not.toContain(rewritten);
});
