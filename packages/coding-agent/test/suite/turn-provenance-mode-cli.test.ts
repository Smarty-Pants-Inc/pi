import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { main } from "../../src/main.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	restoreStdout: () => {},
	takeOverStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: () => {},
}));
let harness: Harness | undefined;
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
afterEach(() => {
	Object.defineProperty(process, "stdin", originalStdin);
	harness?.cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// pi#95: use real main/bootstrap, @file assembly, faux provider, and JSONL reopen.
it.each([false, true])("admits CLI argv/file and EOF before held runtime discovery (argv: %s)", async (argv) => {
	harness = await createHarness({ persistSession: true });
	const h = harness;
	vi.stubEnv(ENV_AGENT_DIR, h.tempDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
	vi.spyOn(process, "cwd").mockReturnValue(h.tempDir);
	const input = new Readable({ read() {} });
	Object.defineProperty(input, "isTTY", { value: false });
	Object.defineProperty(process, "stdin", { value: input, configurable: true });
	const file = join(h.tempDir, "prompt.md");
	writeFileSync(file, "file input");
	h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
	let entered!: () => void;
	const discovered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const model = h.getModel();
	const running = main(
		[
			"--offline",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-auto-compaction",
			"--session-dir",
			h.tempDir,
			"--model",
			`${model.provider}/${model.id}`,
			...(argv ? [`@${file}`, "repeat", "repeat", "repeat"] : []),
		],
		{
			extensionFactories: [
				async (pi) => {
					pi.registerProvider(model.provider, {
						api: h.faux.api,
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						models: h.faux.models.map((candidate) => ({
							id: candidate.id,
							name: candidate.name,
							api: candidate.api,
							reasoning: candidate.reasoning,
							input: candidate.input,
							cost: candidate.cost,
							contextWindow: candidate.contextWindow,
							maxTokens: candidate.maxTokens,
						})),
					});
					entered();
					await held;
				},
			],
		},
	);
	await discovered;
	const argvAdmittedBy = Date.now();
	input.push("piped input");
	input.push(null);
	await new Promise<void>((resolve) => input.once("end", resolve));
	const eofAdmittedBy = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 30));
	release();
	await running;
	const files = readdirSync(h.tempDir).filter((path) => path.endsWith(".jsonl"));
	expect(files).toHaveLength(1);
	const entries = SessionManager.open(join(h.tempDir, files[0]!))
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user");
	expect(entries).toHaveLength(argv ? 3 : 1);
	const receipts = entries.map(getTurnProvenance);
	expect(new Set(receipts.map((receipt) => receipt?.turnId)).size).toBe(entries.length);
	for (const receipt of receipts) {
		expect(Object.keys(receipt!).sort()).toEqual(["channel", "receivedAt", "turnId", "v"]);
		expect(receipt?.channel).toBe("terminal");
		expect(Date.parse(receipt!.receivedAt)).toBeLessThanOrEqual(argv ? argvAdmittedBy : eofAdmittedBy);
	}
});
