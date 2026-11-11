import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
	type ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { loadExtensionFromFactory, loadExtensions } from "../../src/core/extensions/loader.ts";
import type { ExtensionFactory, SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const WINDOW = 200_000;
const CAPTION = "Public Pi mascot: preserve this caption and its image exactly.";
// Existing public package asset, not private/client data, fabricated base64, or a new binary fixture.
const png = readFileSync(new URL("../../src/modes/interactive/assets/clankolas.png", import.meta.url));
const image: ImageContent = { type: "image", mimeType: "image/png", data: png.toString("base64") };
const fittingContent: ToolResultMessage["content"] = [{ type: "text", text: CAPTION }, image];
const largeText = `oversized non-image evidence: ${"x".repeat(240_000)}`;
const guardPath = process.env.PI_TOOL_IMAGE_REPAIR_GUARD;

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toolResult(content: ToolResultMessage["content"], id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "fixture_image",
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

function projectedTool(messages: AgentMessage[], id: string): ToolResultMessage {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
	);
	if (!result) throw new Error(`Missing model-visible tool result ${id}`);
	return result;
}

function expectImagePreserved(result: ToolResultMessage, soft = false): void {
	const check = soft ? expect.soft : expect;
	check(result.content.filter((part) => part.type === "image").map(digest)).toEqual([digest(image)]);
}

// PR #337 F2: data-safety regression. Compaction must not equate image base64 bytes with text tokens.
// These portable native-core cases always run. The private fleet guard is loaded only when explicitly supplied.
describe("AgentSession proactive tool-image repair", () => {
	const harnesses: { h: Harness; label: string }[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		while (harnesses.length) {
			const record = harnesses.pop()!;
			const evidence = process.env.PI_TOOL_IMAGE_REPAIR_EVIDENCE;
			if (evidence && record.h.session.sessionFile) {
				mkdirSync(evidence, { recursive: true });
				copyFileSync(record.h.session.sessionFile, join(evidence, `${record.label}.jsonl`));
			}
			await record.h.cleanup();
		}
	});

	it("uses a genuine PNG larger than the byte cap but only 1200 native image tokens", () => {
		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(estimateTokens(toolResult([image], "estimate-only"))).toBe(1200);
		expect(estimateTokens(toolResult(fittingContent, "estimate-with-caption"))).toBeLessThan(1300);
		expect(Buffer.byteLength(JSON.stringify(fittingContent), "utf8")).toBeGreaterThan(WINDOW);
	});

	for (const mode of ["manual", "threshold"] as const) {
		for (const kind of [
			"fitting image",
			"mixed large text and image",
			"oversized text",
			"structured text",
			"small tool",
		] as const) {
			it(`${mode}: preserves fitting images in summarized and kept history; bounds ${kind}`, async () => {
				const content: ToolResultMessage["content"] =
					kind === "fitting image"
						? fittingContent
						: kind === "mixed large text and image"
							? [{ type: "text", text: largeText }, image]
							: kind === "oversized text"
								? [{ type: "text", text: largeText }]
								: kind === "structured text"
									? [{ type: "text", text: JSON.stringify({ rows: [{ payload: largeText }] }) }]
									: [{ type: "text", text: "ordinary small tool output" }];
				const preparations: SessionBeforeCompactEvent[] = [];
				const h = await createHarness({
					persistSession: true,
					models: [{ id: "faux-1", input: ["text", "image"], contextWindow: WINDOW, maxTokens: 100 }],
					settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
					extensionFactories: [
						(pi) => {
							pi.on("session_before_compact", (event) => {
								preparations.push(event);
								return {
									compaction: {
										summary: "Synthetic older-history checkpoint",
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
										details: {},
									},
								};
							});
						},
					],
				});
				harnesses.push({ h, label: `core-${mode}-${kind.replaceAll(" ", "-")}` });
				const manager = h.sessionManager;
				const now = Date.now() - 10_000;
				manager.appendMessage({ role: "user", content: "Inspect earlier tool evidence", timestamp: now });
				const oldCall = fauxToolCall("fixture_image", {});
				manager.appendMessage(fauxAssistantMessage(oldCall, { stopReason: "toolUse", timestamp: now + 1 }));
				const oldId = manager.appendMessage(toolResult(content, oldCall.id));
				manager.appendMessage(fauxAssistantMessage("earlier observation", { timestamp: now + 2 }));
				manager.appendMessage({ role: "user", content: "o".repeat(160_000 * 4), timestamp: now + 3 });
				manager.appendMessage(fauxAssistantMessage("older planning completed", { timestamp: now + 4 }));
				// This span crosses keepRecentTokens. Its tool result must remain verbatim in the kept suffix.
				const keptId = manager.appendMessage({ role: "user", content: "k".repeat(25_000 * 4), timestamp: now + 5 });
				const recentCall = fauxToolCall("fixture_image", {});
				manager.appendMessage(fauxAssistantMessage(recentCall, { stopReason: "toolUse", timestamp: now + 6 }));
				const recentId = manager.appendMessage(toolResult(content, recentCall.id));
				manager.appendMessage(fauxAssistantMessage("recent observation", { timestamp: now + 7 }));
				h.session.refreshContext();
				const file = h.session.sessionFile!;
				const prefix = readFileSync(file);
				const rawOld = digest(manager.getEntry(oldId));
				const rawRecent = digest(manager.getEntry(recentId));
				const fitting = kind === "fitting image" || kind === "small tool";
				if (fitting) {
					const tokens = h.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
					expect(tokens).toBeGreaterThan(WINDOW - 16_384);
					expect(tokens).toBeLessThan(WINDOW);
				}
				let requestMessages: AgentMessage[] = [];
				if (mode === "manual") await h.session.compact();
				else {
					h.setResponses([
						(context) => {
							requestMessages = structuredClone(context.messages);
							return fauxAssistantMessage("answered after proactive threshold compaction");
						},
					]);
					await h.session.prompt("Continue inspecting the kept evidence");
					expect(h.faux.state.callCount).toBe(1);
				}
				expect(preparations).toHaveLength(1);
				expect(preparations[0].reason).toBe(mode);
				expect(preparations[0].willRetry).toBe(false);
				expect(preparations[0].preparation.firstKeptEntryId).toBe(keptId);
				// Assert raw retention before the intentional RED assertions so it is tested on this baseline too.
				expect(readFileSync(file).subarray(0, prefix.length).equals(prefix)).toBe(true);
				expect(digest(manager.getEntry(oldId))).toBe(rawOld);
				expect(digest(manager.getEntry(recentId))).toBe(rawRecent);
				const reopened = SessionManager.open(file);
				expect(digest(reopened.getEntry(oldId))).toBe(rawOld);
				expect(digest(reopened.getEntry(recentId))).toBe(rawRecent);
				const summaryTool = projectedTool(
					[...preparations[0].preparation.messagesToSummarize, ...preparations[0].preparation.turnPrefixMessages],
					oldCall.id,
				);
				const keptTool = projectedTool(manager.buildSessionProjection().messages, recentCall.id);
				const reloadedTool = projectedTool(reopened.buildSessionProjection().messages, recentCall.id);
				const views = [summaryTool, keptTool, reloadedTool];
				if (mode === "threshold") views.push(projectedTool(requestMessages, recentCall.id));
				const hasImage = kind === "fitting image" || kind === "mixed large text and image";
				for (const view of views) {
					if (hasImage) expectImagePreserved(view, true);
					if (fitting) expect.soft(digest(view.content)).toBe(digest(content));
					else {
						const nonImages = view.content.filter((part) => part.type !== "image");
						expect(Buffer.byteLength(JSON.stringify(nonImages), "utf8")).toBeLessThanOrEqual(WINDOW);
						expect(getMessageText(view)).not.toContain(largeText);
						expect(getMessageText(view)).toContain("raw session entry");
					}
				}
				if (fitting)
					expect.soft(manager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(0);
				else expect(manager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(2);
			});
		}
	}

	// Optional external integration, never a replacement for the always-running portable core regressions.
	// No private guard implementation or fixture is copied into this repository.
	it.skipIf(!guardPath).each([
		{ mode: "manual", mixed: false },
		{ mode: "threshold", mixed: false },
		{ mode: "manual", mixed: true },
		{ mode: "threshold", mixed: true },
	] as const)(
		"real guard/native $mode preserves the image the guard admitted (mixed=$mixed)",
		async ({ mode, mixed }) => {
			vi.stubEnv("SMARTY_ALPHA", "1"); // No fleet credential inventory or redaction source reads.
			const preparations: SessionBeforeCompactEvent[] = [];
			const loaded = await loadExtensions([guardPath!], process.cwd());
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
			const observer: ExtensionFactory = (pi) => {
				pi.on("session_before_compact", (event) => {
					preparations.push(event);
					return {
						compaction: {
							summary: "Real-guard synthetic checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			};
			loaded.extensions.push(
				await loadExtensionFromFactory(
					observer,
					process.cwd(),
					createEventBus(),
					loaded.runtime,
					"<inline:image-compaction-observer>",
				),
			);
			const incoming: ToolResultMessage["content"] = mixed
				? [{ type: "text", text: largeText }, image]
				: fittingContent;
			const tool: AgentTool = {
				name: "fixture_image",
				label: "fixture_image",
				description: "Returns an existing public PNG fixture",
				parameters: Type.Object({}),
				execute: async () => ({
					content: incoming,
					details: {},
					...(mixed ? { structuredContent: { payload: largeText } } : {}),
				}),
			};
			const h = await createHarness({
				persistSession: true,
				models: [{ id: "faux-1", input: ["text", "image"], contextWindow: WINDOW, maxTokens: 100 }],
				settings: { compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
				resourceLoader: createTestResourceLoader({ extensionsResult: loaded }),
				tools: [tool],
			});
			harnesses.push({ h, label: `guard-${mode}-${mixed ? "mixed" : "fitting"}` });
			const extensionErrors: unknown[] = [];
			await h.session.bindExtensions({
				onError: (error) => {
					extensionErrors.push(error);
				},
			});
			const now = Date.now() - 10_000;
			h.sessionManager.appendMessage({ role: "user", content: "o".repeat(160_000 * 4), timestamp: now });
			h.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: now + 1 }));
			const keptId = h.sessionManager.appendMessage({
				role: "user",
				content: "k".repeat(25_000 * 4),
				timestamp: now + 2,
			});
			h.sessionManager.appendMessage(fauxAssistantMessage("kept context", { timestamp: now + 3 }));
			h.session.refreshContext();
			const call = fauxToolCall("fixture_image", {});
			h.setResponses([
				fauxAssistantMessage(call, { stopReason: "toolUse" }),
				fauxAssistantMessage("image received"),
			]);
			await h.session.prompt("Return the public fixture image");
			const admitted = projectedTool(h.session.messages, call.id);
			// Executed actual guard through native tool_result dispatch, before any core repair.
			expectImagePreserved(admitted);
			if (mixed) {
				expect(
					Buffer.byteLength(JSON.stringify(admitted.content.filter((part) => part.type !== "image")), "utf8"),
				).toBeLessThan(64 * 1024);
				expect(getMessageText(admitted)).not.toContain(largeText);
				expect(getMessageText(admitted)).toContain("output truncated by the context guard");
				expect(admitted.structuredContent).toBeUndefined();
				expect(
					h.sessionManager
						.getEntries()
						.filter((entry) => entry.type === "custom" && entry.customType === "tool-context-guard-full"),
				).toHaveLength(1);
			} else {
				expect(digest(admitted.content)).toBe(digest(fittingContent));
				expect(getMessageText(admitted)).toBe(CAPTION);
			}
			const admittedDigest = digest(admitted.content);
			expect(extensionErrors).toEqual([]);
			const prefix = readFileSync(h.session.sessionFile!);
			h.settingsManager.applyOverrides({ compaction: { enabled: true } });
			if (mode === "manual") await h.session.compact();
			else {
				h.setResponses([fauxAssistantMessage("continued after threshold")]);
				await h.session.prompt("Inspect the retained image");
			}
			expect(preparations).toHaveLength(1);
			expect(preparations[0].reason).toBe(mode);
			expect(preparations[0].preparation.firstKeptEntryId).toBe(keptId);
			expect(readFileSync(h.session.sessionFile!).subarray(0, prefix.length).equals(prefix)).toBe(true);
			expect(extensionErrors).toEqual([]);
			const reopened = SessionManager.open(h.session.sessionFile!);
			const raw = h.sessionManager
				.getEntries()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === call.id,
				);
			if (!raw || raw.type !== "message" || raw.message.role !== "toolResult")
				throw new Error("Missing raw guard result");
			expect(digest(raw.message.content)).toBe(admittedDigest);
			expect(digest(reopened.getEntry(raw.id))).toBe(digest(raw));
			for (const kept of [
				projectedTool(h.session.messages, call.id),
				projectedTool(reopened.buildSessionProjection().messages, call.id),
			]) {
				expectImagePreserved(kept, true);
				expect.soft(digest(kept.content)).toBe(admittedDigest);
			}
		},
	);
});
