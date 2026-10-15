import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { getInputReceipt, promptReceived, receiveInput } from "../../src/core/received-input.ts";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
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

function storedUser(manager: SessionManager): SessionMessageEntry {
	const stored = manager.getEntries().find((value) => value.type === "message" && value.message.role === "user");
	if (stored?.type !== "message") throw new Error("missing user entry");
	return stored;
}

// pi#160 P1-1 baseline: the exact provenance slot is already locked by sealEntryProvenance, so a
// schema-valid keyboard record cannot replace a terminal entry's receipt. Not a new red case.
it("a terminal entry rejects an exact schema-valid keyboard provenance replacement", async () => {
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	const input = receiveInput("typed at the terminal");
	const before = receiptRecord(getInputReceipt(input));
	expect(before.channel).toBe("terminal");
	await promptReceived(h.session, input);

	const stored = storedUser(h.session.sessionManager);
	const forged = {
		v: 1,
		turnId: before.turnId,
		receivedAt: before.receivedAt,
		channel: "keyboard",
		principal: { id: "paul", binding: "herdr-client" },
		submissionToken: "a".repeat(32),
	};
	expect(getTurnProvenance({ ...stored, provenance: forged })).toMatchObject({
		channel: "keyboard",
		principal: { id: "paul" },
	});
	expect(() => {
		(stored as { provenance: unknown }).provenance = forged;
	}).toThrow(TypeError);
	expect(() => Object.defineProperty(stored, "provenance", { value: forged })).toThrow(TypeError);
	expect(getTurnProvenance(stored)).toEqual(before);
	expect(getTurnProvenance(storedUser(h.session.sessionManager))).toMatchObject({ channel: "terminal" });
});

// pi#160 P1-1: the containing entry stayed extensible and writable, so code holding
// AgentSession.sessionManager could swap entry.message for new text while the sealed keyboard
// receipt stayed attached. The append-only entry itself must be frozen.
it("a keyboard entry rejects containing entry.message replacement and keeps its receipt; forks still work", async () => {
	const token = "8".repeat(32);
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	const input = receiveInput(
		"typed by paul",
		undefined,
		captureKeyboardTurnReceipt("paul", token, new Date().toISOString()),
	);
	const before = receiptRecord(getInputReceipt(input));
	expect(before).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
	await promptReceived(h.session, input);

	const manager = h.session.sessionManager;
	const stored = storedUser(manager);
	const original = stored.message;
	const replacement = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "replaced message" }],
		timestamp: 0,
	};
	expect(() => {
		stored.message = replacement;
	}).toThrow(TypeError);
	expect(() => Object.defineProperty(stored, "message", { value: replacement })).toThrow(TypeError);
	expect(Reflect.deleteProperty(stored, "message")).toBe(false);
	expect(Reflect.set(stored, "extra", "added")).toBe(false);
	expect(Object.isFrozen(stored.provenance)).toBe(true);
	if (stored.provenance?.channel !== "keyboard") throw new Error("missing keyboard provenance");
	expect(Reflect.set(stored.provenance.principal, "id", "mallory")).toBe(false);
	expect(storedUser(manager).message).toBe(original);
	expect(getTurnProvenance(storedUser(manager))).toEqual(before);

	// Counterexample: forking a frozen branch still copies entries and re-parents them.
	const branchedFile = manager.createBranchedSession(manager.getLeafId()!);
	expect(branchedFile).toBeDefined();
	const reopened = SessionManager.open(branchedFile!);
	const exported = storedUser(reopened);
	expect(exported.message).toMatchObject({ role: "user", content: [{ type: "text", text: "typed by paul" }] });
	expect(JSON.stringify(reopened.getEntries())).not.toContain("replaced message");
	expect(getTurnProvenance(exported)).toEqual(before);
	expect(Object.isFrozen(exported)).toBe(true);
	expect(reopened.getEntries().map((entry) => entry.parentId)).toEqual(
		manager.getBranch().map((entry) => entry.parentId),
	);
	expect(Object.isFrozen(storedUser(manager))).toBe(true);
});
