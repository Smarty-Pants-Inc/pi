// PR #95 / smarty-dev#2636: RPC receipt must precede the session_start/bindExtensions barrier.
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import * as provenance from "../../src/core/turn-provenance.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, getMessageText } from "./harness.ts";

const io = vi.hoisted(() => ({ lines: [] as string[], receive: undefined as ((line: string) => void) | undefined }));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
}));
vi.mock("../../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, receive: (line: string) => void) => {
		io.receive = receive;
		return () => {
			io.receive = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

describe("RPC startup host first receipt", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		io.lines = [];
		io.receive = undefined;
	});

	it("persists original ingress UUID/time for prompt, steer and follow_up while binding is held; ignores forged receipt", async () => {
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const attest = vi.fn(() => ({ principal: "paul" }));
		const harness = await createHarness({
			persistSession: true,
			inputAttestation: { attest },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						entered();
						await gate;
					});
				},
			],
		});
		harness.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok")));
		const signals = process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const);
		const previous = new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]]));
		const inputListeners = process.stdin.listeners("end") as NodeListener[];
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const runtime = {
			session: harness.session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;
		const resolve = vi.spyOn(provenance, "resolveHostTurnProvenance");
		const running = runRpcMode(runtime);
		try {
			await started;
			const receive = io.receive!;
			vi.useFakeTimers({ toFake: ["Date"] });
			const ingress = ["2026-09-30T19:00:00.000Z", "2026-09-30T19:00:01.000Z", "2026-09-30T19:00:02.000Z"];
			const types = ["prompt", "steer", "follow_up"];
			const forged = {
				v: 1,
				turnId: "00000000-0000-4000-8000-000000000000",
				receivedAt: "2000-01-01T00:00:00.000Z",
				channel: "keyboard",
				principal: { id: "forged", binding: "herdr-client" },
			};
			for (let i = 0; i < types.length; i++) {
				vi.setSystemTime(new Date(ingress[i]));
				receive(
					JSON.stringify({
						id: types[i],
						type: types[i],
						message: `startup ${types[i]}`,
						streamingBehavior: "steer",
						provenance: forged,
						receipt: forged,
						resolvedProvenance: forged,
					}),
				);
			}
			const admitted = resolve.mock.results.map((result) => result.value as provenance.TurnProvenance);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(0);
			vi.setSystemTime(new Date("2026-09-30T19:01:00.000Z"));
			release();
			await vi.waitFor(() => {
				const responses = io.lines.map(
					(line) => JSON.parse(line) as { type: string; id?: string; success?: boolean },
				);
				for (const id of types)
					expect(responses.find((value) => value.type === "response" && value.id === id)?.success).toBe(true);
			});
			await harness.session.waitForIdle();
			const entries = readFileSync(harness.sessionManager.getSessionFile()!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as SessionEntry);
			const records = types.map((type) => {
				const entry = entries.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						getMessageText(entry.message) === `startup ${type}`,
				);
				return entry && provenance.getTurnProvenance(entry);
			});
			expect(records.map((record) => record?.receivedAt)).toEqual(ingress);
			expect(admitted).toHaveLength(3);
			expect(records).toEqual(admitted);
			expect(new Set(records.map((record) => record?.turnId)).size).toBe(3);
			for (const record of records) {
				expect(record).toEqual({
					v: 1,
					turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
					receivedAt: expect.any(String),
					channel: "terminal",
				});
				expect(record?.turnId).not.toBe(forged.turnId);
			}
			expect(attest).not.toHaveBeenCalled();
		} finally {
			release();
			await harness.session.waitForIdle();
			// End the actual RPC lifecycle, rather than leaving the startup run promise detached.
			const eof = (process.stdin.listeners("end") as NodeListener[]).find(
				(listener) => !inputListeners.includes(listener),
			);
			eof?.call(process.stdin);
			// runRpcMode intentionally remains pending after process.exit; mocking exit lets us verify shutdown completed.
			await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
			expect(exit).toHaveBeenCalledWith(0);
			void running;
			harness.cleanup();
			for (const listener of process.stdin.listeners("end") as NodeListener[])
				if (!inputListeners.includes(listener)) process.stdin.off("end", listener);
			for (const signal of signals)
				for (const listener of process.listeners(signal) as NodeListener[])
					if (!previous.get(signal)?.includes(listener)) process.off(signal, listener);
		}
	});
});
