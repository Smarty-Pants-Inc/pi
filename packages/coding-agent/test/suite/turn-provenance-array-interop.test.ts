import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { AgentBeforeSettleEvent, CustomMessageEntryDraft, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { captureCliInputPlan, finalizeCliInputPlan, handoffModeInputPlan } from "../../src/core/mode-turn-receipts.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { type PrintModeOptions, runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: () => {},
}));
const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
const shadows = ["normal", "map", "entries", "both"] as const;
type Shadow = (typeof shadows)[number];
const harnesses: Harness[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const h of harnesses.splice(0)) h.cleanup();
});

function shadowMethods<T>(array: T[], shadow: Shadow): T[] {
	if (shadow === "map" || shadow === "both") Object.defineProperty(array, "map", { value: 0, enumerable: true });
	if (shadow === "entries" || shadow === "both")
		Object.defineProperty(array, "entries", { value: 0, enumerable: true });
	return array;
}

function assertReceipts(entries: Parameters<typeof getTurnProvenance>[0][]) {
	const receipts = entries.map(getTurnProvenance);
	expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(entries.length);
	for (const receipt of receipts) {
		expect(receipt).toBeDefined();
		expect(Object.keys(receipt!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		expect(receipt?.channel).toBe("terminal");
		expect(receipt?.receivedAt).toBe(first);
	}
	return receipts;
}

// pi#95: valid arrays need no callable own map/entries to retain receipt occurrences.
describe.each(["turn_end", "agent_before_settle"] as const)("%s array interoperability", (boundary) => {
	it.each(shadows)("persists repeated proposals with %s methods and matching previews", async (shadow) => {
		let preview: ReturnType<typeof getTurnProvenance>[] = [];
		const errors: string[] = [];
		const h = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					const propose = () => {
						const draft: CustomMessageEntryDraft = {
							type: "custom_message",
							customType: "proposal",
							content: "repeat",
							display: false,
						};
						return { entries: shadowMethods([draft, draft], shadow) };
					};
					const observe = (event: TurnEndEvent | AgentBeforeSettleEvent) => {
						preview = event.context.contextEntries
							.filter((entry) => entry.sourceEntry.type === "custom_message")
							.map((entry) => getTurnProvenance(entry.sourceEntry));
						vi.setSystemTime(later);
					};
					if (boundary === "turn_end") {
						pi.on("turn_end", propose);
						pi.on("turn_end", observe);
					} else {
						pi.on("agent_before_settle", propose);
						pi.on("agent_before_settle", observe);
					}
				},
			],
		});
		harnesses.push(h);
		h.session.extensionRunner.onError((error) => errors.push(error.error));
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("start");
		const customs = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(customs.map((entry) => entry.content)).toEqual(["repeat", "repeat"]);
		expect(assertReceipts(customs)).toEqual(preview);
		expect(errors).toEqual([]);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toEqual(customs);
	});
});

// pi#95: both direct print batches and the CLI handoff preserve ordinary array delivery.
describe.each([false, true])("print array interoperability (CLI handoff: %s)", (cliHandoff) => {
	it.each(shadows)("delivers duplicate prompts with %s methods before startup advances the clock", async (shadow) => {
		const h = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						vi.setSystemTime(later);
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const runtime = new AgentSessionRuntime(
			h.session,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.session.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("No replacement requested");
			},
		);
		const messages = shadowMethods(["repeat", "repeat", "repeat"], shadow);
		const options: PrintModeOptions = { mode: "text", messages };
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		if (cliHandoff) {
			const cli = {};
			captureCliInputPlan(cli, messages, false);
			finalizeCliInputPlan(cli, "repeat", undefined);
			handoffModeInputPlan(cli, options);
		}
		expect(await runPrintMode(runtime, options)).toBe(0);
		expect(getUserTexts(h)).toEqual(["repeat", "repeat", "repeat"]);
		const users = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		const receipts = assertReceipts(users);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map(getTurnProvenance),
		).toEqual(receipts);
	});
});
