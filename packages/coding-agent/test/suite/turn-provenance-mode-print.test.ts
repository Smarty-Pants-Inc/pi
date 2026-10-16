import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { captureCliInputPlan, finalizeCliInputPlan, handoffModeInputPlan } from "../../src/core/mode-turn-receipts.ts";
import { receiveInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { type PrintModeOptions, runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: () => {},
}));
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

// pi#95: all initial occurrences are received before binding or earlier batch runs.
it.each([false, true])("captures initial batches before held startup (CLI handoff: %s)", async (cliHandoff) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const h = await createHarness({
		persistSession: true,
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					started();
					await held;
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("third")]);
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
	const options: PrintModeOptions = { mode: "text", initialMessage: "repeat", messages: ["repeat", "repeat"] };
	const cli = {};
	if (cliHandoff) {
		captureCliInputPlan(cli, ["repeat", "repeat", "repeat"], false);
		finalizeCliInputPlan(cli, "repeat", undefined);
		handoffModeInputPlan(cli, options);
	}
	const admittedBy = Date.now();
	await new Promise((resolve) => setTimeout(resolve, cliHandoff ? 30 : 0));
	const running = runPrintMode(runtime, options);
	await entered;
	const directAdmittedBy = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 30));
	release();
	expect(await running).toBe(0);
	const entries = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user");
	expect(entries).toHaveLength(3);
	const receipts = entries.map(getTurnProvenance);
	expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(3);
	for (const receipt of receipts) {
		expect(receipt).toBeDefined();
		expect(Object.keys(receipt!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		expect(receipt?.channel).toBe("terminal");
		expect(Date.parse(receipt!.receivedAt)).toBeLessThanOrEqual(cliHandoff ? admittedBy : directAdmittedBy);
	}
	expect(
		SessionManager.open(h.sessionManager.getSessionFile()!)
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map(getTurnProvenance),
	).toEqual(receipts);
});

// pi#95: stdin-only handoff retains the EOF occurrence through later assembly and mode startup.
it("retains an EOF receipt through stdin-only initial assembly", async () => {
	const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
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
	const cli = {};
	captureCliInputPlan(cli, [], false);
	const eof = receiveInput("piped");
	const admittedBy = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 30));
	finalizeCliInputPlan(cli, "piped", undefined, eof);
	const options: PrintModeOptions = { mode: "text", initialMessage: "piped" };
	handoffModeInputPlan(cli, options);
	expect(await runPrintMode(runtime, options)).toBe(0);
	const entry = SessionManager.open(h.sessionManager.getSessionFile()!)
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	const receipt = getTurnProvenance(entry);
	expect(receipt).toBeDefined();
	expect(Date.parse(receipt!.receivedAt)).toBeLessThanOrEqual(admittedBy);
});
