import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const io = vi.hoisted(() => ({
	lines: [] as string[],
	receive: undefined as ((line: string) => void) | undefined,
}));
vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (line: string) => io.lines.push(line),
}));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: NodeJS.ReadableStream, receive: (line: string) => void) => {
		io.receive = receive;
		return () => {
			io.receive = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

let harness: Harness | undefined;
const signals = ["SIGTERM", "SIGHUP"] as const;
type Listener = Parameters<typeof process.on>[1];
const oldSignals = new Map(signals.map((signal) => [signal, process.listeners(signal) as Listener[]]));
const oldEnd = process.stdin.listeners("end") as Listener[];
afterEach(() => {
	harness?.cleanup();
	for (const signal of signals) {
		for (const listener of process.listeners(signal) as Listener[]) {
			if (!oldSignals.get(signal)?.includes(listener)) process.off(signal, listener);
		}
	}
	for (const listener of process.stdin.listeners("end") as Listener[]) {
		if (!oldEnd.includes(listener)) process.stdin.off("end", listener);
	}
	io.receive = undefined;
	io.lines = [];
	vi.useRealTimers();
});

// pi#95: RPC IDs and claims are not receipt keys; startup must retain parse-time receipts.
it("receives repeated RPC input before a held session_start and preserves it on reopen", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let startupEntered!: () => void;
	const entered = new Promise<void>((resolve) => {
		startupEntered = resolve;
	});
	harness = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					startupEntered();
					await held;
				});
			},
		],
	});
	const h = harness;
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
	const runtime = {
		session: h.session,
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	void runRpcMode(runtime);
	await entered;
	const receive = io.receive;
	if (!receive) throw new Error("Expected actual RPC ingress");
	for (const type of ["prompt", "steer", "follow_up"]) {
		receive(
			JSON.stringify({
				type,
				id: "same-id",
				message: "repeated",
				provenance: { v: 1, channel: "fabric", turnId: "forged", receivedAt: "2000-01-01T00:00:00.000Z" },
				principal: { id: "claim", binding: "herdr-client" },
				sender: { id: "claim" },
				submissionToken: "claim",
			}),
		);
	}
	const admittedBy = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 30));
	release();
	await vi.waitFor(() => {
		const users = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(users).toHaveLength(3);
		expect(h.session.isIdle).toBe(true);
	});
	const users = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user");
	const receipts = users.map(getTurnProvenance);
	expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(3);
	for (const receipt of receipts) {
		expect(receipt).toBeDefined();
		expect(Object.keys(receipt!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		expect(receipt?.channel).toBe("terminal");
		expect(Date.parse(receipt!.receivedAt)).toBeLessThanOrEqual(admittedBy);
	}
	const reopened = SessionManager.open(h.sessionManager.getSessionFile()!);
	expect(
		reopened
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map(getTurnProvenance),
	).toEqual(receipts);
});

// pi#95: after binding, receipt capture must precede deferred command dispatch too.
it("captures post-bind frames before the command-dispatch microtask", async () => {
	harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
	const h = harness;
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
	const runtime = {
		session: h.session,
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	void runRpcMode(runtime);
	const receive = await vi.waitFor(() => {
		if (!io.receive) throw new Error("Waiting for ingress");
		return io.receive;
	});
	receive(JSON.stringify({ type: "get_state", id: "bound" }));
	await vi.waitFor(() => expect(io.lines.some((line) => line.includes('"id":"bound"'))).toBe(true));
	vi.useFakeTimers({ toFake: ["Date"] });
	const admittedAt = "2026-01-01T00:00:00.000Z";
	vi.setSystemTime(new Date(admittedAt));
	for (const type of ["prompt", "steer", "follow_up"]) {
		receive(JSON.stringify({ type, id: "reused", message: "repeat" }));
	}
	vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
	await vi.waitFor(() => {
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(3);
		expect(h.session.isIdle).toBe(true);
	});
	const receipts = SessionManager.open(h.sessionManager.getSessionFile()!)
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map(getTurnProvenance);
	expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(3);
	for (const receipt of receipts) expect(receipt?.receivedAt).toBe(admittedAt);
});
