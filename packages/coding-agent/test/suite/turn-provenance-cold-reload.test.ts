import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { getInputReceipt, promptReceived, receiveInput } from "../../src/core/received-input.ts";
import { isColdEntry } from "../../src/core/session-lazy-entries.ts";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { getTurnProvenance, type TurnProvenance } from "../../src/core/turn-provenance.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../src/core/turn-receipts.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
});

function userEntry(manager: SessionManager, id: string): SessionMessageEntry {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("missing attested user entry");
	return entry;
}

function expectHistory(entry: SessionMessageEntry, text: string, receipt: TurnProvenance): void {
	expect(getTurnProvenance(entry)).toEqual(receipt);
	expect(entry.message).toMatchObject({ role: "user", content: [{ type: "text", text }] });
	if (entry.message.role !== "user") throw new Error("expected a user message");
	expect(entry.message.content).toEqual([{ type: "text", text }]);
}

async function persistedKeyboardSession(text: string, cold: boolean) {
	const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("attested reply")]);
	const input = receiveInput(
		text,
		undefined,
		captureKeyboardTurnReceipt("paul", "d".repeat(32), new Date().toISOString()),
	);
	const receipt = receiptRecord(getInputReceipt(input));
	await promptReceived(h.session, input);
	const stored = h.sessionManager
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (stored?.type !== "message") throw new Error("missing persisted user entry");
	expectHistory(stored, text, receipt);
	expect(receipt).toMatchObject({ channel: "keyboard", principal: { id: "paul", binding: "herdr-client" } });
	if (cold) {
		// More than the recent resident window, then omit the old turn from active context.
		// Merely opening a large current-context message promotes it back to hot storage.
		for (let i = 0; i < 105; i++) h.sessionManager.appendCustomEntry("cold-reload-padding", i);
		h.sessionManager.appendCompaction("the previous turn has been summarized", null, 100);
	}
	const file = h.sessionManager.getSessionFile();
	if (!file) throw new Error("expected a persisted session file");
	return { h, file, id: stored.id, receipt };
}

const mutations = ["content replacement", "nested text edit", "array append"] as const;
type Mutation = (typeof mutations)[number];

function mutateUser(entry: SessionMessageEntry, mutation: Mutation): void {
	const message = entry.message;
	if (message.role !== "user" || !Array.isArray(message.content) || message.content[0]?.type !== "text") {
		throw new Error("expected user content blocks");
	}
	switch (mutation) {
		case "content replacement":
			message.content = [{ type: "text", text: "forged content replacement" }];
			break;
		case "nested text edit":
			message.content[0].text = "forged nested text";
			break;
		case "array append":
			message.content.push({ type: "text", text: "forged appended block" });
			break;
	}
}

// pi#160 / smarty-dev#12863: reload must protect the message beside the sealed receipt,
// including large content read lazily from the parsed-line cache. The receipt has no digest;
// mutation must fail, not silently retain keyboard attribution on changed text.
describe.each([
	{ name: "small reloaded history", text: "typed by paul", cold: false },
	{ name: "cold reloaded history", text: "typed by paul\n".repeat(256), cold: true },
])("$name", ({ text, cold }) => {
	it.each(mutations)(
		"rejects %s and preserves attribution through reload, branch export and fork",
		async (mutation) => {
			const { h, file, id, receipt } = await persistedKeyboardSession(text, cold);
			const manager = SessionManager.open(file);
			const stored = userEntry(manager, id);
			expect(isColdEntry(stored)).toBe(cold);
			expectHistory(stored, text, receipt);

			// Soft assertion deliberately continues on the vulnerable baseline: the next read
			// demonstrates that the current production reader still returns the original receipt.
			expect.soft(() => mutateUser(stored, mutation)).toThrow(TypeError);
			expect(getTurnProvenance(stored)).toEqual(receipt);
			expectHistory(userEntry(manager, id), text, receipt);
			const branchEntry = manager.getBranch().find((entry) => entry.id === id);
			if (branchEntry?.type !== "message") throw new Error("missing user entry on branch");
			expectHistory(branchEntry, text, receipt);

			// Export while the canonical entry still owns the accessed content; reloading first
			// could discard a mutated parsed-line cache and hide corruption of a branch export.
			const branchedFile = manager.createBranchedSession(manager.getLeafId()!);
			if (!branchedFile) throw new Error("expected branch export");
			const branched = SessionManager.open(branchedFile);
			expectHistory(userEntry(branched, id), text, receipt);
			expect(isColdEntry(userEntry(branched, id))).toBe(cold);

			const fork = SessionManager.forkFrom(branchedFile, h.tempDir, h.tempDir);
			expectHistory(userEntry(fork, id), text, receipt);
			const forkFile = fork.getSessionFile();
			if (!forkFile) throw new Error("expected persisted fork");
			expectHistory(userEntry(SessionManager.open(forkFile), id), text, receipt);

			manager.setSessionFile(file);
			expect(isColdEntry(userEntry(manager, id))).toBe(cold);
			expectHistory(userEntry(manager, id), text, receipt);
		},
	);
});

// pi#160 / smarty-dev#12863: selecting the old turn promotes cold content to a parsed
// resident message. That transition must not reopen the same attested-text mutation route.
it.each(mutations)("rejects %s after selecting a cold turn as the active branch", async (mutation) => {
	const text = "keyboard-attested branch input\n".repeat(128);
	const { file, id, receipt } = await persistedKeyboardSession(text, true);
	const manager = SessionManager.open(file);
	expect(isColdEntry(userEntry(manager, id))).toBe(true);
	manager.branch(id);
	const stored = userEntry(manager, id);
	expect(isColdEntry(stored)).toBe(false);
	expect.soft(() => mutateUser(stored, mutation)).toThrow(TypeError);
	expect(getTurnProvenance(stored)).toEqual(receipt);
	expectHistory(userEntry(manager, id), text, receipt);
	const branchedFile = manager.createBranchedSession(id);
	if (!branchedFile) throw new Error("expected selected branch export");
	expectHistory(userEntry(SessionManager.open(branchedFile), id), text, receipt);
});

// pi#160 / smarty-dev#12863 counterexample, following smarty-dev#10720: provider request
// hooks still need mutable detached input, even when canonical reloaded history is frozen.
it("lets a request hook mutate its detached copy without changing reloaded keyboard history", async () => {
	const text = "keyboard-attested request input\n".repeat(128);
	const { file, id, receipt } = await persistedKeyboardSession(text, true);
	const manager = SessionManager.open(file);
	expect(isColdEntry(userEntry(manager, id))).toBe(true);
	manager.branch(id);
	let hookRan = false;
	let providerRan = false;
	const resumed = await createHarness({
		sessionManager: manager,
		settings: { compaction: { enabled: false } },
		prepareRequest: (request) => {
			const user = request.context.messages.find((message) => message.role === "user");
			if (user?.role !== "user" || !Array.isArray(user.content) || user.content[0]?.type !== "text") {
				throw new Error("missing attested request input");
			}
			expect(Object.isFrozen(user)).toBe(false);
			expect(Object.isFrozen(user.content)).toBe(false);
			expect(Object.isFrozen(user.content[0])).toBe(false);
			user.content[0].text = "hook nested edit";
			user.content.push({ type: "text", text: "hook append" });
			user.content = [...user.content, { type: "text", text: "hook replacement" }];
			hookRan = true;
		},
	});
	harnesses.push(resumed);
	resumed.setResponses([
		(context) => {
			const user = context.messages.find((message) => message.role === "user");
			expect(user).toMatchObject({
				role: "user",
				content: [
					{ type: "text", text: "hook nested edit" },
					{ type: "text", text: "hook append" },
					{ type: "text", text: "hook replacement" },
				],
			});
			providerRan = true;
			return fauxAssistantMessage("detached request reply");
		},
	]);
	await resumed.session.prompt("continue the selected branch");
	expect(hookRan).toBe(true);
	expect(providerRan).toBe(true);
	expect(resumed.session.getLastAssistantText()).toBe("detached request reply");
	expectHistory(userEntry(manager, id), text, receipt);
	expectHistory(userEntry(SessionManager.open(file), id), text, receipt);
});
