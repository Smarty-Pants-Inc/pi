import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { getInputReceipt, promptReceived, receiveInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../src/core/turn-receipts.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

async function persistedUserProvenance(token: string, mutate?: (event: AgentSessionEvent) => void) {
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	if (mutate) h.session.subscribe(mutate);
	const at = new Date().toISOString();
	const input = receiveInput("typed by paul", undefined, captureKeyboardTurnReceipt("paul", token, at));
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

function userMessage(event: AgentSessionEvent, type: "message_start" | "message_end"): AgentMessage | undefined {
	return event.type === type && event.message.role === "user" ? event.message : undefined;
}

// pi#160 review: the persistence boundary compares the written content with the attested snapshot.
it("drops keyboard attribution when a subscribe listener mutates the live user message on message_start", async () => {
	const token = "e".repeat(32);
	const { before, at, message, provenance } = await persistedUserProvenance(token, (event) => {
		const live = userMessage(event, "message_start");
		if (live?.role === "user") live.content = [{ type: "text", text: "rewritten by listener" }];
	});
	expect(JSON.stringify(message)).toContain("rewritten by listener");
	expect(provenance).toEqual({
		v: 1,
		turnId: before.turnId,
		receivedAt: at,
		channel: "terminal",
		submissionToken: token,
	});
	expect(provenance).not.toHaveProperty("principal");
});

it("drops keyboard attribution when a subscribe listener edits a content block in place", async () => {
	const token = "f".repeat(32);
	const { before, message, provenance } = await persistedUserProvenance(token, (event) => {
		const live = userMessage(event, "message_end");
		if (live?.role === "user" && Array.isArray(live.content)) {
			const block = live.content[0];
			if (block?.type === "text") block.text = `${block.text}, then edited`;
		}
	});
	expect(JSON.stringify(message)).toContain("typed by paul, then edited");
	expect(provenance).toMatchObject({ turnId: before.turnId, channel: "terminal", submissionToken: token });
	expect(provenance).not.toHaveProperty("principal");
});

it("keeps keyboard attribution when subscribe listeners leave the user message unchanged", async () => {
	const { before, message, provenance } = await persistedUserProvenance("0".repeat(32), (event) => {
		const live = userMessage(event, "message_start");
		if (live?.role === "user") live.content = [{ type: "text", text: "typed by paul" }];
	});
	expect(JSON.stringify(message)).toContain("typed by paul");
	expect(provenance).toEqual(before);
	expect(provenance).toMatchObject({ channel: "keyboard", principal: { id: "paul", binding: "herdr-client" } });
});

it("keeps keyboard attribution without listeners", async () => {
	const { before, provenance } = await persistedUserProvenance("1".repeat(32));
	expect(provenance).toEqual(before);
	expect(provenance).toMatchObject({ channel: "keyboard" });
});
