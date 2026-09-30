// PR #95 R3: CLI initial inputs are admitted together, before startup and model waits.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { VERSION } from "../src/config.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import * as provenance from "../src/core/turn-provenance.ts";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

// Keep the real constructor, init, extension binding, run and session persistence paths.
// Only unrelated startup downloads/background work are disabled.
vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: vi.fn(async () => undefined) }));
vi.mock("../src/utils/syntax-highlight.ts", () => ({ loadAllHighlightLanguages: vi.fn(async () => {}) }));
vi.mock("../src/utils/version-check.ts", () => ({ checkForNewPiVersion: vi.fn(async () => undefined) }));

const RECEIPT = "2026-09-30T19:00:00.000Z";
const STARTUP_RELEASE = "2026-09-30T19:01:00.000Z";
const MODEL_RELEASE = "2026-09-30T19:02:00.000Z";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function userEntries(entries: SessionEntry[]) {
	return entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
}

afterEach(() => {
	stopThemeWatcher();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("PR #95 initial interactive receipt", () => {
	it.each([
		{
			name: "initialMessage with images and initialMessages",
			options: {
				initialMessage: "A",
				initialImages: [
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEioAAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
				],
				initialMessages: ["B"],
			},
		},
		{ name: "initialMessages A and B", options: { initialMessages: ["A", "B"] } },
		{ name: "identical initialMessages occurrences", options: { initialMessages: ["same", "same"] } },
	] satisfies Array<{ name: string; options: InteractiveModeOptions }>)(
		"stamps $name before held session_start and the preceding model run",
		async ({ options }) => {
			const startup = gate();
			const startupEntered = gate();
			const model = gate();
			const modelEntered = gate();
			const attest = vi.fn(() => ({ principal: "paul" }));
			const sources: string[] = [];
			const harness = await createHarness({
				persistSession: true,
				inputAttestation: { attest },
				settings: { quietStartup: true, lastChangelogVersion: VERSION },
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							startupEntered.release();
							await startup.promise;
						});
						pi.on("input", (event) => {
							sources.push(event.source);
						});
					},
				],
			});
			harness.setResponses([
				async () => {
					modelEntered.release();
					await model.promise;
					return fauxAssistantMessage("first");
				},
				fauxAssistantMessage("second"),
			]);
			const runtime = new AgentSessionRuntime(
				harness.session,
				{
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					modelRuntime: harness.session.modelRuntime,
					settingsManager: harness.settingsManager,
					resourceLoader: harness.session.resourceLoader,
					diagnostics: [],
				},
				async () => {
					throw new Error("unexpected session replacement");
				},
			);
			const prompt = vi.spyOn(harness.session, "prompt");
			const resolve = vi.spyOn(provenance, "resolveHostTurnProvenance");
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(RECEIPT));
			const terminal = new VirtualTerminal();
			const mode = new InteractiveMode(runtime, { ...options, terminal });
			const admitted = resolve.mock.results.map((result) => result.value as provenance.TurnProvenance);
			const done = new Error("initial inputs complete");
			vi.spyOn(mode, "getUserInput").mockRejectedValue(done);
			const errors = vi.spyOn(mode as unknown as { showError(message: string): void }, "showError");
			// Admission is the constructor's host buffer, not the later call to run().
			vi.setSystemTime(new Date("2026-09-30T19:00:30.000Z"));
			const running = mode.run().catch((error: unknown) => error);
			try {
				await startupEntered.promise;
				expect(userEntries(harness.sessionManager.getEntries())).toHaveLength(0);
				vi.setSystemTime(new Date(STARTUP_RELEASE));
				startup.release();
				await modelEntered.promise;
				expect(userEntries(harness.sessionManager.getEntries())).toHaveLength(1);
				vi.setSystemTime(new Date(MODEL_RELEASE));
				model.release();
				expect(await running).toBe(done);
				expect(errors).not.toHaveBeenCalled();
				const file = harness.sessionManager.getSessionFile()!;
				const disk = userEntries(
					readFileSync(file, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as SessionEntry),
				);
				const reopened = userEntries(SessionManager.open(file).getEntries());
				expect(disk).toHaveLength(2);
				const records = disk.map(provenance.getTurnProvenance);
				expect(records.map((record) => record?.receivedAt)).toEqual([RECEIPT, RECEIPT]);
				expect(admitted).toHaveLength(2);
				expect(records).toEqual(admitted);
				expect(reopened).toEqual(disk);
				expect(reopened.map(provenance.getTurnProvenance)).toEqual(admitted);
				expect(records[0]?.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
				expect(records[1]?.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
				expect(records[0]?.turnId).not.toBe(records[1]?.turnId);
				for (const record of records)
					expect(record).toEqual({ v: 1, turnId: record?.turnId, receivedAt: RECEIPT, channel: "terminal" });
				expect(attest).not.toHaveBeenCalled();
				expect(sources).toEqual(["interactive", "interactive"]);
				expect(
					disk.map((entry) => (entry.type === "message" ? getMessageText(entry.message).split("\n")[0] : "")),
				).toEqual(
					options.initialMessage ? [options.initialMessage, ...options.initialMessages!] : options.initialMessages,
				);
				if (options.initialImages) expect(prompt.mock.calls[0]?.[1]?.images).toEqual(options.initialImages);
			} finally {
				startup.release();
				model.release();
				await running;
				mode.stop();
				await terminal.flush();
				await harness.session.waitForIdle();
				harness.cleanup();
			}
		},
	);
});
