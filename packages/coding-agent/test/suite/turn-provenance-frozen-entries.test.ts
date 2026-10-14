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

// pi#160 review: an unowned SessionManager returns stored entries by reference (getEntries,
// getBranch). The persisted user message is deep-frozen, so code holding
// AgentSession.sessionManager cannot rewrite text that keeps its keyboard attribution.
it("a stored user message from sessionManager.getEntries() cannot be mutated, and a branch export keeps it", async () => {
	const token = "9".repeat(32);
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	const input = receiveInput(
		"typed by paul",
		undefined,
		captureKeyboardTurnReceipt("paul", token, new Date().toISOString()),
	);
	const before = receiptRecord(getInputReceipt(input));
	await promptReceived(h.session, input);

	const manager = h.session.sessionManager;
	const stored = manager.getEntries().find((value) => value.type === "message" && value.message.role === "user");
	if (stored?.type !== "message" || stored.message.role !== "user") throw new Error("missing user entry");
	const message = stored.message;
	expect(getTurnProvenance(stored)).toEqual(before);
	expect(Object.isFrozen(message)).toBe(true);
	// Test modules run in strict mode: writes to frozen objects throw.
	expect(() => {
		message.content = [{ type: "text", text: "rewritten through getEntries" }];
	}).toThrow(TypeError);
	expect(() => {
		const block = Array.isArray(message.content) ? message.content[0] : undefined;
		if (block?.type === "text") block.text = "edited through getEntries";
		else (message as { content: unknown }).content = "edited through getEntries";
	}).toThrow(TypeError);
	expect(() => {
		if (Array.isArray(message.content)) message.content.push({ type: "text", text: "appended" });
		else (message as { content: unknown }).content = "appended";
	}).toThrow(TypeError);
	const branchMessage = manager.getBranch().find((value) => value.type === "message" && value.message.role === "user");
	expect(branchMessage?.type === "message" && Object.isFrozen(branchMessage.message)).toBe(true);

	const branchedFile = manager.createBranchedSession(manager.getLeafId()!);
	expect(branchedFile).toBeDefined();
	const exported = SessionManager.open(branchedFile!)
		.getEntries()
		.find((value) => value.type === "message" && value.message.role === "user");
	expect(exported?.type === "message" ? exported.message : undefined).toMatchObject({
		role: "user",
		content: [{ type: "text", text: "typed by paul" }],
	});
	expect(JSON.stringify(exported)).not.toMatch(/rewritten|edited|appended/);
	expect(getTurnProvenance(exported!)).toEqual(before);
	expect(getTurnProvenance(exported!)).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
});
