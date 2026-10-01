// PR #95 / smarty-dev#2636: print/JSON receipt precedes startup and earlier model responses.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import * as provenance from "../../src/core/turn-provenance.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getMessageText } from "./harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));

const ADMISSION = "2026-09-30T19:00:00.000Z";
const STARTUP_RELEASE = "2026-09-30T19:01:00.000Z";
const RESPONSE_RELEASE = "2026-09-30T19:02:00.000Z";

// Deliberately repeated across the initial input and both additional occurrences.
const TEXT = "same admitted input";

describe("print/JSON host first receipt", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		io.lines = [];
	});

	it.each(["text", "json"] as const)(
		"%s retains each occurrence's admission UUID/time through held startup and first response",
		async (mode) => {
			let enterStartup = () => {};
			const startupEntered = new Promise<void>((resolve) => {
				enterStartup = resolve;
			});
			let releaseStartup = () => {};
			const startupGate = new Promise<void>((resolve) => {
				releaseStartup = resolve;
			});
			let enterResponse = () => {};
			const responseEntered = new Promise<void>((resolve) => {
				enterResponse = resolve;
			});
			let releaseResponse = () => {};
			const responseGate = new Promise<void>((resolve) => {
				releaseResponse = resolve;
			});
			const attest = vi.fn(() => ({ principal: "paul" }));
			const inputSources: string[] = [];
			const harness = await createHarness({
				persistSession: true,
				settings: { images: { autoResize: false } },
				inputAttestation: { attest },
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							enterStartup();
							await startupGate;
						});
						pi.on("input", (event) => {
							inputSources.push(event.source);
						});
					},
				],
			});
			harness.setResponses([
				async () => {
					enterResponse();
					await responseGate;
					return fauxAssistantMessage("first response");
				},
				fauxAssistantMessage("second response"),
				fauxAssistantMessage("final response"),
			]);
			const runtime = {
				session: harness.session,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => harness.session.dispose()),
			} as unknown as AgentSessionRuntime;
			const resolve = vi.spyOn(provenance, "resolveHostTurnProvenance");
			const images: ImageContent[] = [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				},
			];
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(ADMISSION));
			const running = runPrintMode(runtime, {
				mode,
				initialMessage: TEXT,
				initialImages: images,
				messages: [TEXT, TEXT],
			});
			// Snapshot synchronously, before even awaiting session_start entry.
			const admitted = resolve.mock.results.map((result) => result.value as provenance.TurnProvenance);
			try {
				await startupEntered;
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(0);
				vi.setSystemTime(new Date(STARTUP_RELEASE));
				releaseStartup();
				await responseEntered;
				expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
				const capturedBeforeResponseRelease = resolve.mock.results.length;
				vi.setSystemTime(new Date(RESPONSE_RELEASE));
				releaseResponse();
				expect(await running).toBe(0);
				const sessionFile = harness.sessionManager.getSessionFile()!;
				const entries = readFileSync(sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as SessionEntry);
				const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
				const records = users.map(provenance.getTurnProvenance);
				// These timestamps fail on the unchanged implementation after both real gates settle.
				expect(records.map((record) => record?.receivedAt)).toEqual([ADMISSION, ADMISSION, ADMISSION]);
				expect(admitted).toHaveLength(3);
				expect(capturedBeforeResponseRelease).toBe(3);
				expect(resolve).toHaveBeenCalledTimes(3);
				expect(records).toEqual(admitted);
				expect(new Set(records.map((record) => record?.turnId)).size).toBe(3);
				for (const record of records) {
					expect(record).toEqual({
						v: 1,
						turnId: expect.stringMatching(
							/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
						),
						receivedAt: ADMISSION,
						channel: "terminal",
					});
				}
				expect(attest).not.toHaveBeenCalled();
				expect(inputSources).toEqual(["interactive", "interactive", "interactive"]);
				expect(users.map((entry) => entry.type === "message" && getMessageText(entry.message))).toEqual([
					TEXT,
					TEXT,
					TEXT,
				]);
				expect(users[0].type === "message" && users[0].message.role === "user" && users[0].message.content).toEqual(
					[{ type: "text", text: TEXT }, ...images],
				);
				for (const entry of users.slice(1))
					expect(entry.type === "message" && entry.message.role === "user" && entry.message.content).toEqual([
						{ type: "text", text: TEXT },
					]);
				const reopened = SessionManager.open(sessionFile, harness.tempDir);
				expect(
					reopened
						.getEntries()
						.filter((entry) => entry.type === "message" && entry.message.role === "user")
						.map(provenance.getTurnProvenance),
				).toEqual(records);
				if (mode === "text") {
					expect(io.lines).toEqual(["final response\n"]);
				} else {
					const events = io.lines.map((line) => JSON.parse(line) as { type: string });
					expect(events[0].type).toBe("session");
					expect(events.filter((event) => event.type === "agent_end")).toHaveLength(3);
				}
				expect(runtime.dispose).toHaveBeenCalledOnce();
			} finally {
				releaseStartup();
				releaseResponse();
				await running;
				harness.cleanup();
			}
		},
	);
});
