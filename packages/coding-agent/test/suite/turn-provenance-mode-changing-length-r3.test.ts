import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: () => {},
}));
const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0)) h.cleanup();
});

// pi#145 Astra R3-2: allocation and collection must use the same observed length.
it.each(["ordinary", "stable-proxy", "3->1"] as const)(
	"direct print receives %s batch without phantom inputs",
	async (scenario) => {
		const h = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
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
		let lengthReads = 0;
		const batch = ["first", "second", "third"];
		const messages =
			scenario === "ordinary"
				? batch
				: new Proxy(batch, {
						get(target, key, receiver) {
							if (key === "length") {
								lengthReads++;
								if (scenario === "3->1" && lengthReads > 1) return 1;
							}
							return Reflect.get(target, key, receiver);
						},
					});
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((error: unknown) => errors.push(String(error)));
		const status = await runPrintMode(runtime, { mode: "text", messages });
		expect.soft(errors).toEqual([]);
		expect.soft(status).toBe(0);
		expect.soft(getUserTexts(h)).toEqual(batch);
		if (scenario === "3->1") expect.soft(lengthReads).toBe(1);
		const users = h.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user");
		const receipts = users.map(getTurnProvenance);
		expect.soft(receipts).toHaveLength(3);
		expect(new Set(receipts.map((r) => r?.turnId)).size).toBe(receipts.length);
		for (const receipt of receipts) expect(receipt).toMatchObject({ channel: "terminal", v: 1 });
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((e) => e.type === "message" && e.message.role === "user"),
		).toEqual(users);
		const physical = readFileSync(h.session.sessionFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string } })
			.filter((e) => e.type === "message" && e.message?.role === "user");
		expect(physical).toEqual(users);
	},
);
