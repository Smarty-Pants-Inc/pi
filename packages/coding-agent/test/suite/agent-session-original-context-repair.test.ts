import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOriginalSessionCompaction, runOriginalSessionCompaction } from "../../src/core/agent-session.ts";
import type { OriginalCompactionAttempt } from "../../src/core/ordinary-compaction.ts";
import { appendReceivedMessage } from "../../src/core/session-turn-appender.ts";
import { captureTerminalTurnReceipt } from "../../src/core/turn-receipts.ts";
import { linkUnsentInputTransfer, UNSENT_INPUT_TYPE } from "../../src/core/unsent-input.ts";
import { createHarness, type Harness } from "./harness.ts";

// Control-flow fixture, not owner/attempt authentication qualification. Only the external
// authority ports are doubled. The actual AgentSession private original-compaction closure,
// branch fence, SessionManager appenders, ModelRuntime and faux summary provider all run.
vi.mock("../../src/core/ordinary-tools.ts", () => ({ createOrdinaryToolDefinitions: () => ({}) }));
vi.mock("../../src/core/ordinary-compaction.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	assertOriginalCompactionAttempt() {},
}));
vi.mock("../../src/core/ordinary-owner-context.ts", () => {
	const owner = {
		assertActive() {},
		assertSessionStart() {},
		assertCompactionIdle() {},
		bindSessionAdmission() {},
		interruptAutomaticCapture() {},
		stopAutomatic() {},
		operationalAudit: { session() {} },
		requestProvenance: { interrupt() {} },
	};
	return {
		assertOrdinaryRuntime() {},
		ordinaryOwnerOf: (value: object) => ("agent" in value && "sessionManager" in value ? owner : undefined),
	};
});

// smarty-dev#19998: original-owned compaction deliberately skips extension preparation hooks.
describe("original-compaction native context repair control flow", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it.each([false, true])(
		"caps retained tool results before fencing and rejects later branch mutation (%s)",
		async (mutate) => {
			const h = await createHarness({
				persistSession: true,
				models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
				settings: { compaction: { keepRecentTokens: 1 } },
			});
			harnesses.push(h);
			const payload = `original-owned-raw-result:${"x".repeat(3 * 1024 * 1024)}`;
			const now = Date.now() - 10_000;
			h.sessionManager.appendMessage({ role: "user", content: "old request", timestamp: now });
			const call = fauxToolCall("read", {});
			h.sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse", timestamp: now + 1 }));
			const id = h.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read",
				content: [{ type: "text", text: payload }],
				isError: false,
				timestamp: now + 2,
			});
			h.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: now + 3 }));
			h.sessionManager.appendMessage({ role: "user", content: "keep the current request", timestamp: now + 4 });
			h.session.agent.state.messages = h.sessionManager.buildSessionProjection().messages;
			const prefix = readFileSync(h.session.sessionFile!);
			let preparation = "";
			const attempt: OriginalCompactionAttempt = {
				signal: new AbortController().signal,
				check: () => checkOriginalSessionCompaction(h.session, attempt),
				settle: async () => {},
				request: (invoke) => invoke(),
				prepare: (value) => {
					preparation = JSON.stringify(value);
				},
				beginAppend: () => ({}),
				appended: () => {},
				finishAppend: () => {},
				failAppend: (cause) => {
					throw cause;
				},
			};
			const replaceableAppend = vi.spyOn(h.sessionManager, "appendContextEdit").mockImplementation(() => {
				throw new Error("must use captured native appender");
			});
			h.session.subscribe((event) => {
				if (mutate && event.type === "entry_appended" && event.entry.type === "context_edit")
					h.sessionManager.appendCustomEntry("unexpected-branch-mutation", {});
			});
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).not.toContain(payload);
					expect(JSON.stringify(context.messages)).toContain(`raw session entry ${id}`);
					return fauxAssistantMessage("original native bounded summary");
				},
			]);

			if (mutate) {
				await expect(runOriginalSessionCompaction(h.session, attempt)).rejects.toThrow(
					"OPS_COMPACTION_SESSION_CHANGED",
				);
				expect(h.faux.state.callCount).toBe(0);
			} else {
				await expect(runOriginalSessionCompaction(h.session, attempt)).resolves.toMatchObject({
					summary: "original native bounded summary",
				});
				expect(preparation).toContain(`raw session entry ${id}`);
				expect(preparation).not.toContain(payload);
				expect(h.faux.state.callCount).toBe(1);
			}
			expect(replaceableAppend).not.toHaveBeenCalled();
			expect(h.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({ type: "context_edit", targetId: id }),
			);
			expect(readFileSync(h.session.sessionFile!).subarray(0, prefix.length).equals(prefix)).toBe(true);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
				mutate ? 0 : 1,
			);
		},
	);

	it.each(["completed", "branch mutation", "cancel before repair", "cancel after repair"] as const)(
		"repairs an oversized recovered accepted user before the original fence (%s)",
		async (outcome) => {
			const h = await createHarness({
				persistSession: true,
				models: [{ id: "faux-1", contextWindow: 60_000, maxTokens: 100 }],
				settings: { compaction: { keepRecentTokens: 1 } },
			});
			harnesses.push(h);
			const payload = `original-owned-accepted-input:${"x".repeat(300 * 1024)}`;
			const now = Date.now() - 10_000;
			h.sessionManager.appendMessage({ role: "user", content: "old request", timestamp: now });
			h.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: now + 1 }));
			const message: UserMessage = { role: "user", content: payload, timestamp: now + 2 };
			const outboxId = h.sessionManager.appendCustomEntry(UNSENT_INPUT_TYPE, { mode: "steer", message });
			const receipt = captureTerminalTurnReceipt();
			linkUnsentInputTransfer(receipt, outboxId);
			const id = appendReceivedMessage(h.sessionManager, message, receipt);
			h.sessionManager.appendMessage(fauxAssistantMessage("accepted input answered", { timestamp: now + 3 }));
			h.sessionManager.appendMessage({ role: "user", content: "keep current request", timestamp: now + 4 });
			h.session.refreshContext();
			const prefix = readFileSync(h.session.sessionFile!);
			const original = h.sessionManager.getEntry(id);
			const outbox = h.sessionManager.getEntry(outboxId);
			const cancellation = new AbortController();
			let preparation = "";
			const attempt: OriginalCompactionAttempt = {
				signal: cancellation.signal,
				check: () => {
					cancellation.signal.throwIfAborted();
					checkOriginalSessionCompaction(h.session, attempt);
				},
				settle: async () => {},
				request: (invoke) => invoke(),
				prepare: (value) => {
					preparation = JSON.stringify(value);
				},
				beginAppend: () => ({}),
				appended: () => {},
				finishAppend: () => {},
				failAppend: (cause) => {
					throw cause;
				},
			};
			const replaceableAppend = vi.spyOn(h.sessionManager, "appendContextEdit").mockImplementation(() => {
				throw new Error("must use captured native appender");
			});
			h.session.subscribe((event) => {
				if (event.type !== "entry_appended" || event.entry.type !== "context_edit") return;
				if (outcome === "branch mutation") h.sessionManager.appendCustomEntry("unexpected-branch-mutation", {});
				if (outcome === "cancel after repair") cancellation.abort(new Error("cancel original repair"));
			});
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context.messages)).not.toContain(payload);
					expect(JSON.stringify(context.messages)).toContain(`raw session entry ${id}`);
					return fauxAssistantMessage("original recovered input bounded summary");
				},
			]);
			if (outcome === "cancel before repair") cancellation.abort(new Error("cancel original repair"));

			if (outcome === "completed") {
				await expect(runOriginalSessionCompaction(h.session, attempt)).resolves.toMatchObject({
					summary: "original recovered input bounded summary",
				});
				expect(preparation).not.toContain(payload);
				expect(preparation).toContain(`raw session entry ${id}`);
			} else {
				await expect(runOriginalSessionCompaction(h.session, attempt)).rejects.toThrow(
					outcome === "branch mutation" ? "OPS_COMPACTION_SESSION_CHANGED" : "cancel original repair",
				);
			}
			expect(h.faux.state.callCount).toBe(outcome === "completed" ? 1 : 0);
			expect(replaceableAppend).not.toHaveBeenCalled();
			expect(
				h.sessionManager.getEntries().filter((entry) => entry.type === "context_edit" && entry.targetId === id),
			).toHaveLength(outcome === "cancel before repair" ? 0 : 1);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
				outcome === "completed" ? 1 : 0,
			);
			expect(h.sessionManager.getEntry(id)).toEqual(original);
			expect(h.sessionManager.getEntry(id)?.unsentInputId).toBe(outboxId);
			expect(h.sessionManager.getEntry(outboxId)).toEqual(outbox);
			expect(readFileSync(h.session.sessionFile!).subarray(0, prefix.length).equals(prefix)).toBe(true);
		},
	);

	it.each(["fitting recovered text", "fitting recovered image", "ordinary oversized user"] as const)(
		"does not proactively stub %s in original-owned preparation",
		async (kind) => {
			const h = await createHarness({
				persistSession: true,
				models: [
					{ id: "faux-1", contextWindow: kind === "ordinary oversized user" ? 60_000 : 1_000_000, maxTokens: 100 },
				],
				settings: { compaction: { keepRecentTokens: 1 } },
			});
			harnesses.push(h);
			// Same genuine BMP as the runtime image counterexample: serialized base64
			// exceeds 256 KiB while Pi's image token estimate fits the whole window.
			const pixels = 512 * 256 * 3;
			const image = Buffer.alloc(54 + pixels, 0x7f);
			image.fill(0, 0, 54);
			image.write("BM", 0, "ascii");
			image.writeUInt32LE(image.length, 2);
			image.writeUInt32LE(54, 10);
			image.writeUInt32LE(40, 14);
			image.writeInt32LE(512, 18);
			image.writeInt32LE(256, 22);
			image.writeUInt16LE(1, 26);
			image.writeUInt16LE(24, 28);
			image.writeUInt32LE(pixels, 34);
			const content: UserMessage["content"] =
				kind === "fitting recovered image"
					? [{ type: "image", mimeType: "image/bmp", data: image.toString("base64") }]
					: `accepted oversized input: ${"x".repeat(300 * 1024)}`;
			const now = Date.now() - 10_000;
			const message: UserMessage = { role: "user", content, timestamp: now };
			const receipt = captureTerminalTurnReceipt();
			if (kind !== "ordinary oversized user") {
				const outbox = h.sessionManager.appendCustomEntry(UNSENT_INPUT_TYPE, { mode: "steer", message });
				linkUnsentInputTransfer(receipt, outbox);
			}
			const id = appendReceivedMessage(h.sessionManager, message, receipt);
			h.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: now + 1 }));
			h.sessionManager.appendMessage({ role: "user", content: "keep current request", timestamp: now + 2 });
			h.session.refreshContext();
			const prefix = readFileSync(h.session.sessionFile!);
			let preparation = "";
			const attempt: OriginalCompactionAttempt = {
				signal: new AbortController().signal,
				check: () => checkOriginalSessionCompaction(h.session, attempt),
				settle: async () => {},
				request: (invoke) => invoke(),
				prepare: (value) => {
					preparation = JSON.stringify(value);
				},
				beginAppend: () => ({}),
				appended: () => {},
				finishAppend: () => {},
				failAppend: (cause) => {
					throw cause;
				},
			};
			const replaceableAppend = vi.spyOn(h.sessionManager, "appendContextEdit").mockImplementation(() => {
				throw new Error("must use captured native appender");
			});
			h.setResponses([fauxAssistantMessage("original unmodified context summary")]);

			if (kind === "ordinary oversized user") {
				// Ordinary user input remains untouched, so the native summary
				// preflight must refuse it rather than silently stubbing it.
				await expect(runOriginalSessionCompaction(h.session, attempt)).rejects.toThrow("Context exceeds window");
			} else {
				await expect(runOriginalSessionCompaction(h.session, attempt)).resolves.toMatchObject({
					summary: "original unmodified context summary",
				});
			}

			expect(preparation).toContain(typeof content === "string" ? content : image.toString("base64"));
			expect(h.faux.state.callCount).toBe(kind === "ordinary oversized user" ? 0 : 1);
			expect(replaceableAppend).not.toHaveBeenCalled();
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toEqual([]);
			expect(h.sessionManager.getEntry(id)).toMatchObject({ message });
			expect(readFileSync(h.session.sessionFile!).subarray(0, prefix.length).equals(prefix)).toBe(true);
		},
	);
});
