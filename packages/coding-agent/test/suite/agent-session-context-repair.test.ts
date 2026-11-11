import { readFileSync } from "node:fs";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function overflow() {
	const response = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	response.recovery = { recovery: "context_length_exceeded", retryable: false };
	return response;
}

function resultTool(name: string, text: string): AgentTool {
	return {
		name,
		label: name,
		description: "Returns retained context for the overflow regression",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	};
}

// smarty-dev#19998: use the actual AgentSession/ModelRuntime/provider loop, not recovery method doubles.
describe("AgentSession native tool-result context repair", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it("answers after a 3 MiB provider overflow even when the repaired short history needs no summary", async () => {
		const payload = `giant-raw-tool-reply:${"x".repeat(3 * 1024 * 1024)}`;
		const h = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
			tools: [resultTool("giant_reply", payload)],
		});
		harnesses.push(h);
		let rawPrefix = Buffer.alloc(0);
		let retry: AgentMessage[] = [];
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("giant_reply", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.some((message) => getMessageText(message) === payload)).toBe(true);
				rawPrefix = readFileSync(h.session.sessionFile!);
				return overflow();
			},
			(context) => {
				retry = structuredClone(context.messages);
				return fauxAssistantMessage("answered after native repair");
			},
		]);

		await h.session.prompt("Run the giant tool and answer this request.");

		expect(h.faux.state.callCount).toBe(3);
		expect(h.session.getLastAssistantText()).toBe("answered after native repair");
		expect(h.session.isIdle).toBe(true);
		expect(h.getPendingResponseCount()).toBe(0);
		const file = h.session.sessionFile!;
		expect(rawPrefix.byteLength).toBeGreaterThan(3 * 1024 * 1024);
		expect(readFileSync(file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		const rawResult = h.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (!rawResult || rawResult.type !== "message" || rawResult.message.role !== "toolResult")
			throw new Error("Missing raw tool result");
		expect(getMessageText(rawResult.message)).toBe(payload);
		const bytes = Buffer.byteLength(JSON.stringify(rawResult.message.content), "utf8");
		const resultText = retry
			.filter((message) => message.role === "toolResult")
			.map(getMessageText)
			.join("\n");
		expect(resultText).toContain(`${bytes} UTF-8 bytes`);
		expect(resultText).toContain(rawResult.id);
		expect(JSON.stringify(retry)).not.toContain(payload);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(h.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "overflow", aborted: false, willRetry: true }),
		);

		const reopened = SessionManager.open(file);
		expect(readFileSync(file).subarray(0, rawPrefix.length).equals(rawPrefix)).toBe(true);
		expect(
			reopened
				.buildSessionProjection()
				.messages.filter((message) => message.role === "toolResult")
				.map(getMessageText)
				.join("\n"),
		).toBe(resultText);
		expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain(payload);
		expect(reopened.getEntry(rawResult.id)).toEqual(rawResult);
	});

	it("repairs multiple oversized results largest first using UTF-8 bytes and keeps a small result", async () => {
		const texts = {
			unicode_reply: "🙂".repeat(300_000),
			largest_reply: "z".repeat(2_000_000),
			small_reply: "normal small result",
		};
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
			tools: Object.entries(texts).map(([name, text]) => resultTool(name, text)),
		});
		harnesses.push(h);
		let retry: AgentMessage[] = [];
		h.setResponses([
			fauxAssistantMessage(
				Object.keys(texts).map((name) => fauxToolCall(name, {})),
				{ stopReason: "toolUse" },
			),
			overflow(),
			(context) => {
				retry = structuredClone(context.messages);
				return fauxAssistantMessage("multiple results repaired");
			},
		]);

		await h.session.prompt("Run all three tools, then answer.");

		expect(h.session.getLastAssistantText()).toBe("multiple results repaired");
		const entries = h.sessionManager.getEntries();
		const rawResults = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const editedIds = entries.flatMap((entry) =>
			entry.type === "context_edit" && rawResults.some((raw) => raw.id === entry.targetId) ? [entry.targetId] : [],
		);
		const idsByName = new Map(
			rawResults.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolName, entry.id]] : [],
			),
		);
		expect(editedIds).toEqual([idsByName.get("largest_reply"), idsByName.get("unicode_reply")]);
		expect(retry.some((message) => getMessageText(message) === texts.small_reply)).toBe(true);
		const unicode = retry.find((message) => message.role === "toolResult" && message.toolName === "unicode_reply");
		if (!unicode) throw new Error("Missing projected Unicode result");
		expect(getMessageText(unicode)).toContain(
			`${Buffer.byteLength(JSON.stringify([{ type: "text", text: texts.unicode_reply }]), "utf8")} UTF-8 bytes`,
		);
		expect(JSON.stringify(retry)).not.toContain(texts.largest_reply);
		expect(JSON.stringify(retry)).not.toContain(texts.unicode_reply);
		expect(h.faux.state.callCount).toBe(3);
	});

	it("proactively repairs an oversized tool result before threshold planning without needing a summary", async () => {
		const payload = "x".repeat(9_000);
		let summaries = 0;
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [resultTool("large_reply", payload)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						summaries++;
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large_reply", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain(payload);
				expect(JSON.stringify(context.messages)).toContain("Tool result omitted from model context");
				return fauxAssistantMessage("answered without a summary");
			},
		]);

		await h.session.prompt("run the large tool");

		expect(h.faux.state.callCount).toBe(2);
		expect(h.session.getLastAssistantText()).toBe("answered without a summary");
		expect(summaries).toBe(0);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("caps retained results before ordinary manual compaction planning", async () => {
		const payload = `oversized-retained-result:${"x".repeat(3 * 1024 * 1024)}`;
		let planned = "";
		const h = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						planned = JSON.stringify(event.preparation);
						return {
							compaction: {
								summary: "bounded native context",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(h);
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
		h.sessionManager.appendMessage(fauxAssistantMessage("completed old request", { timestamp: now + 3 }));
		h.sessionManager.appendMessage({ role: "user", content: "keep this request", timestamp: now + 4 });
		h.session.agent.state.messages = h.sessionManager.buildSessionProjection().messages;
		const prefix = readFileSync(h.session.sessionFile!);

		await h.session.compact();

		expect(planned).not.toContain(payload);
		expect(planned).toContain(`raw session entry ${id}`);
		expect(h.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: id }),
		);
		expect(readFileSync(h.session.sessionFile!).subarray(0, prefix.length).equals(prefix)).toBe(true);
	});

	it.each(["during repair", "completion"] as const)(
		"does not retry a repaired context cancelled at %s",
		async (phase) => {
			const h = await createHarness({
				models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
				settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
				tools: [resultTool("giant_reply", "x".repeat(3 * 1024 * 1024))],
			});
			harnesses.push(h);
			h.session.subscribe((event) => {
				if (
					(phase === "during repair" &&
						event.type === "entry_appended" &&
						event.entry.type === "context_edit" &&
						JSON.stringify(event.entry).includes("Tool result omitted")) ||
					(phase === "completion" && event.type === "compaction_end" && !event.aborted)
				)
					h.session.abortCompaction();
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("giant_reply", {}), { stopReason: "toolUse" }),
				overflow(),
				fauxAssistantMessage("must not retry"),
			]);

			await h.session.prompt("run the tool");

			expect(h.faux.state.callCount).toBe(2);
			expect(h.getPendingResponseCount()).toBe(1);
			if (phase === "during repair")
				expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "overflow", aborted: true });
			expect(h.eventsOfType("agent_settled").at(-1)).toMatchObject({ outcome: "aborted", aborted: true });
			expect(h.session.isIdle).toBe(true);
		},
	);

	it("spends only the existing single retry and preserves accepted input on repeated overflow", async () => {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20_000 } },
			tools: [resultTool("giant_reply", "x".repeat(3 * 1024 * 1024))],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("giant_reply", {}), { stopReason: "toolUse" }),
			overflow(),
			async () => {
				await h.session.followUp("distinct accepted input waiting after failure");
				return overflow();
			},
			fauxAssistantMessage("must not dispatch a second recovery"),
		]);

		await h.session.prompt("run the tool");

		expect(h.faux.state.callCount).toBe(3);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("after one compact-and-retry attempt");
		expect(h.session.getFollowUpMessages()).toEqual(["distinct accepted input waiting after failure"]);
		expect(h.session.agent.hasQueuedMessages()).toBe(true);
		expect(h.session.isIdle).toBe(true);
	});
});
