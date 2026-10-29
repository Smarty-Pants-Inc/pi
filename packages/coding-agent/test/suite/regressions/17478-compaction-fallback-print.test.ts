import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getPackageDir } from "../../../src/config.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

const partial = "PARTIAL_17478_MUST_NOT_BE_SAVED";
const complete = "COMPLETE_17478_CHECKPOINT";
const continued = "CONTINUED_WITH_PRIMARY";
const retained = "input held after failed compaction";
const harnesses: Harness[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0)) await h.cleanup();
});

async function fixture(seed = true, startupCompact = false) {
	let compact: (() => Promise<unknown>) | undefined;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					if (startupCompact) {
						try {
							await compact?.();
						} catch {}
					}
				});
				pi.registerCommand("compact-native", {
					description: "Exercise native manual compaction",
					handler: async () => {
						try {
							await compact?.();
						} catch {}
					},
				});
			},
		],
		persistSession: true,
		models: [
			{ id: "primary", contextWindow: 8192, maxTokens: 1024 },
			{ id: "fallback", contextWindow: 32768, maxTokens: 8192 },
		],
		settings: {
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1024, fallbackModel: "faux/fallback" },
			retry: { enabled: false },
		},
	});
	harnesses.push(h);
	compact = () => h.session.compact();
	if (seed) {
		// Both history and a split-turn prefix must fit the single fallback allowance.
		h.sessionManager.appendMessage({
			role: "user",
			content: "earlier history before split",
			timestamp: Date.now() - 4000,
		});
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("earlier answer", { timestamp: Date.now() - 3000 }),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
		});
		h.sessionManager.appendMessage({ role: "user", content: "history to summarize", timestamp: Date.now() - 2000 });
		const old = fauxAssistantMessage("old answer", { timestamp: Date.now() - 1000 });
		h.sessionManager.appendMessage({
			...old,
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
			usage: { ...old.usage, input: 7500, totalTokens: 7500 },
		});
		h.session.refreshContext();
	}
	const runtime = new AgentSessionRuntime(
		h.session,
		{
			cwd: h.tempDir,
			agentDir: h.tempDir,
			modelRuntime: h.modelRuntime,
			settingsManager: h.settingsManager,
			resourceLoader: h.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("2a must not replace the session");
		},
	);
	return { h, runtime };
}

function captureOutput() {
	const lines: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array,
		callback?: (error?: Error | null) => void,
	) => {
		lines.push(String(chunk));
		callback?.();
		return true;
	}) as typeof process.stdout.write);
	const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
	return { lines, stderr };
}

function script(h: Harness, fallbackFails: boolean, ordinaryFirst = false) {
	const calls: Array<{ model: string; context: string }> = [];
	const response: FauxResponseFactory = (context, _options, _state, model) => {
		calls.push({ model: model.id, context: JSON.stringify(context) });
		const summaryCall = calls.length - (ordinaryFirst ? 1 : 0);
		if (summaryCall === 0)
			return fauxAssistantMessage(`ordinary answer completed before compaction ${"x".repeat(30_000)}`);
		if (summaryCall <= 3 || (summaryCall === 4 && fallbackFails)) {
			return fauxAssistantMessage(partial, { stopReason: "error", errorMessage: "terminated" });
		}
		return fauxAssistantMessage(summaryCall === 4 ? complete : continued);
	};
	h.setResponses(Array.from({ length: 8 }, () => response));
	return calls;
}

// #17478: real native print/runtime and faux provider, never a mocked compact() or paid endpoint.
describe("print compaction fallback", () => {
	it.each(["text", "json"] as const)("%s continues with the unchanged main model after fallback", async (mode) => {
		const { h, runtime } = await fixture();
		const calls = script(h, false);
		const { lines, stderr } = captureOutput();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = runPrintMode(runtime, { mode, initialMessage: "continue once" });
		await vi.advanceTimersByTimeAsync(6000);
		expect(await running).toBe(0);
		expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "fallback", "primary"]);
		expect(h.session.model?.id).toBe("primary");
		expect(calls[3]?.context).toContain("earlier history before split");
		expect(calls[3]?.context).toContain("history to summarize");
		expect(h.eventsOfType("agent_start")).toHaveLength(1);
		expect(getUserTexts(h).filter((text) => text === "continue once")).toHaveLength(1);
		const entries = h.sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "model_change")).toEqual([]);
		expect(JSON.stringify(entries)).not.toContain(partial);
		if (mode === "text") expect(lines.join("")).toBe(`${continued}\n`);
		else
			expect(JSON.parse(lines.filter(Boolean).at(-1)!)).toMatchObject({
				type: "agent_settled",
				outcome: "completed",
			});
		expect(stderr.mock.calls.some(([line]) => String(line).includes("Compaction failed"))).toBe(false);
	});

	it.each(["text", "json"] as const)(
		"%s terminates visibly with retained queues and no partial checkpoint",
		async (mode) => {
			const { h, runtime } = await fixture();
			const calls = script(h, true);
			await h.session.steer("steering still owned");
			await h.session.followUp("follow-up still owned");
			let queues: string[] = [];
			h.session.subscribe((event) => {
				if (event.type === "compaction_end")
					queues = [...h.session.getSteeringMessages(), ...h.session.getFollowUpMessages()];
			});
			const { lines, stderr } = captureOutput();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const running = runPrintMode(runtime, {
				mode,
				initialMessage: retained,
				messages: ["must not start another turn"],
			});
			await vi.advanceTimersByTimeAsync(6000);
			expect(await running).toBe(1);
			expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "fallback"]);
			expect(queues).toEqual(["steering still owned", "follow-up still owned"]);
			expect(h.eventsOfType("agent_start")).toHaveLength(0);
			expect(h.session.model?.id).toBe("primary");
			expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(JSON.stringify(h.sessionManager.getEntries())).not.toContain(partial);
			expect(stderr.mock.calls.some(([line]) => String(line).includes("Auto-compaction failed"))).toBe(true);
			if (mode === "text") expect(lines.join("")).toBe("");
			else {
				const records = lines.filter(Boolean).map((line) => JSON.parse(line));
				expect(records.find((record) => record.type === "compaction_end")).toMatchObject({
					aborted: false,
					willRetry: false,
					errorMessage: expect.stringContaining("Auto-compaction failed"),
				});
				const rejections = records.filter((record) => record.type === "input_rejected");
				expect(JSON.stringify(rejections)).toContain(retained);
				expect(JSON.stringify(rejections)).toContain("must not start another turn");
				expect(records.some((record) => record.type === "print_end" || record.type === "error")).toBe(false);
			}
		},
	);

	it.each(["text", "json"] as const)(
		"%s cannot hide post-turn compaction failure behind a completed assistant",
		async (mode) => {
			const { h, runtime } = await fixture(false);
			const calls = script(h, true, true);
			const { lines, stderr } = captureOutput();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const running = runPrintMode(runtime, {
				mode,
				initialMessage: "complete an ordinary turn before compaction",
				messages: ["do not replay"],
			});
			await vi.advanceTimersByTimeAsync(6000);
			expect(await running).toBe(1);
			expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "primary", "fallback"]);
			expect(h.eventsOfType("agent_start")).toHaveLength(1);
			expect(h.eventsOfType("agent_settled").at(-1)).toMatchObject({ outcome: "error" });
			expect(h.session.messages.findLast((message) => message.role === "assistant")?.stopReason).toBe("stop");
			expect(stderr.mock.calls.some(([line]) => String(line).includes("Auto-compaction failed"))).toBe(true);
			if (mode === "text") expect(lines.join("")).toBe("");
		},
	);

	it.each(["text", "json"] as const)("%s rejects invalid request limits without starting compaction", async (mode) => {
		const { h, runtime } = await fixture();
		const calls = script(h, true);
		const { stderr } = captureOutput();
		expect(await runPrintMode(runtime, { mode, initialMessage: retained, maxProviderRequests: 0 })).toBe(1);
		expect(calls).toEqual([]);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		expect(stderr).toHaveBeenCalledWith("maxProviderRequests must be a positive safe integer");
	});

	it.each(["text", "json"] as const)(
		"%s successful bootstrap compaction still submits its input exactly once",
		async (mode) => {
			const { h, runtime } = await fixture(true, true);
			const calls = script(h, false);
			const { lines } = captureOutput();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const running = runPrintMode(runtime, { mode, initialMessage: "bootstrap input" });
			await vi.advanceTimersByTimeAsync(6000);
			expect(await running).toBe(0);
			expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "fallback", "primary"]);
			expect(getUserTexts(h).filter((text) => text === "bootstrap input")).toHaveLength(1);
			expect(h.session.model?.id).toBe("primary");
			expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({
				reason: "manual",
				aborted: false,
				result: { summary: complete },
			});
			if (mode === "text") expect(lines.join("")).toBe(`${continued}\n`);
			else
				expect(JSON.parse(lines.filter(Boolean).at(-1)!)).toMatchObject({
					type: "agent_settled",
					outcome: "completed",
				});
		},
	);

	it("observes caught startup compaction failure before submitting any print input", async () => {
		const { h, runtime } = await fixture(true, true);
		const calls = script(h, true);
		const { lines } = captureOutput();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;
		const running = runPrintMode(runtime, { mode: "json", initialMessage: retained, initialImages: [image] });
		await vi.advanceTimersByTimeAsync(6000);
		expect(await running).toBe(1);
		expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "fallback"]);
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
		const records = lines.filter(Boolean).map((line) => JSON.parse(line));
		expect(records.find((record) => record.type === "compaction_end")).toMatchObject({
			aborted: false,
			reason: "manual",
		});
		expect(records.find((record) => record.type === "input_rejected")).toMatchObject({
			reason: "shutdown",
			messages: [{ role: "user", content: [{ type: "text", text: retained }, image] }],
		});
	});

	it("fails JSON print even when a manual command catches the native failure", async () => {
		const { h, runtime } = await fixture();
		const calls = script(h, true);
		const { lines } = captureOutput();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const running = runPrintMode(runtime, { mode: "json", initialMessage: "/compact-native" });
		await vi.advanceTimersByTimeAsync(6000);
		expect(await running).toBe(1);
		expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "fallback"]);
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
		const records = lines.filter(Boolean).map((line) => JSON.parse(line));
		expect(records.find((record) => record.type === "compaction_end")).toMatchObject({
			reason: "manual",
			aborted: false,
			errorMessage: expect.stringContaining("Compaction failed"),
		});
	});

	it("does not replay partial ordinary output or invoke the compaction fallback", async () => {
		const { h, runtime } = await fixture(false);
		h.settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 0, fallbackModel: "faux/fallback" },
		});
		h.setResponses([
			fauxAssistantMessage(partial, { stopReason: "error", errorMessage: "terminated" }),
			fauxAssistantMessage("must not replay an ordinary turn"),
		]);
		captureOutput();
		expect(await runPrintMode(runtime, { mode: "text", initialMessage: "ordinary partial output" })).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.model?.id).toBe("primary");
		expect(h.eventsOfType("compaction_start")).toEqual([]);
	});

	it("operator cancellation never spends the fallback allowance", async () => {
		const { h, runtime } = await fixture();
		const calls = script(h, true);
		captureOutput();
		h.session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") h.session.abortCompaction();
		});
		expect(await runPrintMode(runtime, { mode: "json", initialMessage: retained })).toBe(1);
		expect(calls.map((call) => call.model)).toEqual(["primary"]);
		expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it.each(["text", "json"] as const)("keeps ordinary successful %s output unchanged", async (mode) => {
		const { h, runtime } = await fixture(false);
		h.setResponses([fauxAssistantMessage("ordinary success")]);
		const { lines, stderr } = captureOutput();
		expect(await runPrintMode(runtime, { mode, initialMessage: "hello" })).toBe(0);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		expect(stderr).not.toHaveBeenCalled();
		if (mode === "text") expect(lines.join("")).toBe("ordinary success\n");
		else
			expect(JSON.parse(lines.filter(Boolean).at(-1)!)).toMatchObject({
				type: "agent_settled",
				outcome: "completed",
			});
	});
});

async function launchCli(mode: "text" | "json", fallbackFails: boolean, postTurn = false) {
	const { h, runtime } = await fixture(!postTurn);
	if (postTurn) {
		h.sessionManager.appendMessage({ role: "user", content: "small persisted history", timestamp: Date.now() });
	}
	const sessionFile = h.sessionManager.getSessionFile()!;
	// Retire the seed writer before the real CLI becomes this file's sole owner.
	await runtime.dispose({ terminal: true });
	const agentDir = join(h.tempDir, "cli-agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1024, fallbackModel: "faux/fallback" },
			retry: { enabled: false },
		}),
	);
	const callsPath = join(h.tempDir, "cli-calls.json");
	const extensionPath = join(h.tempDir, "cli-faux.mjs");
	const aiUrl = pathToFileURL(join(getPackageDir(), "..", "ai", "src", "index.ts")).href;
	writeFileSync(
		extensionPath,
		`
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(aiUrl)};
export default function (pi) {
	const faux = fauxProvider({ provider: "faux", tokenSize: { min: 8192, max: 8192 }, models: [
		{ id: "primary", contextWindow: 8192, maxTokens: 1024 },
		{ id: "fallback", contextWindow: 32768, maxTokens: 8192 }
	] });
	const calls = [];
	faux.setResponses(Array.from({ length: 8 }, () => (context, options, state, model) => {
		calls.push({ model: model.id, context });
		writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
		const summaryCall = calls.length - (${postTurn} ? 1 : 0);
		if (summaryCall === 0) return fauxAssistantMessage("completed ordinary answer " + "x".repeat(30000));
		if (summaryCall <= 3 || (summaryCall === 4 && ${fallbackFails})) {
			return fauxAssistantMessage(${JSON.stringify(partial)}, { stopReason: "error", errorMessage: "terminated" });
		}
		return fauxAssistantMessage(summaryCall === 4 ? ${JSON.stringify(complete)} : ${JSON.stringify(continued)});
	}));
	pi.registerProvider("faux", {
		api: faux.api, apiKey: "local-faux-key", baseUrl: faux.getModel().baseUrl,
		models: faux.models, streamSimple: faux.provider.streamSimple
	});
}
`,
	);
	const resolver = pathToFileURL(join(getPackageDir(), "src", "experimental", "source-resolver.ts")).href;
	const env: NodeJS.ProcessEnv = { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" };
	delete env.HERDR_PANE_ID;
	delete env.HERDR_SOCKET_PATH;
	const child = spawn(
		process.execPath,
		[
			"--import",
			resolver,
			join(getPackageDir(), "src", "cli.ts"),
			"--mode",
			mode,
			"--print",
			"--session",
			sessionFile,
			"--model",
			"faux/primary",
			"--no-extensions",
			"--extension",
			extensionPath,
			"--no-mcp",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-tools",
			"--offline",
			"--approve",
			"continue once",
			"second untouched prompt",
		],
		{ cwd: h.tempDir, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
		child.once("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(deadline);
			resolve({ code, signal });
		});
	});
	const entries = SessionManager.open(sessionFile).getEntries();
	const calls = JSON.parse(readFileSync(callsPath, "utf8")) as Array<{ model: string; context: unknown }>;
	return { ...result, stdout, stderr, calls, entries };
}

// #17478: source-native CLI launch, actual exit code and stdout/stderr framing (not managed-factory proof).
describe("native print launch compaction fallback", () => {
	it.each(["text", "json"] as const)(
		"%s exits nonzero when post-turn compaction fails after a successful assistant",
		async (mode) => {
			const result = await launchCli(mode, true, true);
			expect(result.signal).toBeNull();
			expect(result.code, result.stderr).toBe(1);
			expect(result.calls.map((call) => call.model)).toEqual([
				"primary",
				"primary",
				"primary",
				"primary",
				"fallback",
			]);
			expect(result.entries.some((entry) => entry.type === "compaction")).toBe(false);
			const assistant = result.entries.findLast(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			expect(assistant).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "stop" } });
			expect(result.stderr).toContain("Auto-compaction failed");
			if (mode === "text") expect(result.stdout).toBe("");
			else {
				const records = result.stdout
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(records.filter((record) => record.type === "agent_start")).toHaveLength(1);
				expect(records.find((record) => record.type === "agent_settled")).toMatchObject({ outcome: "error" });
				expect(JSON.stringify(records.filter((record) => record.type === "input_rejected"))).toContain(
					"second untouched prompt",
				);
			}
		},
		60_000,
	);

	it.each(["text", "json"] as const)(
		"%s completes the original inputs once with the unchanged main model",
		async (mode) => {
			const result = await launchCli(mode, false);
			expect(result.signal).toBeNull();
			expect(result.code, result.stderr).toBe(0);
			expect(result.calls.map((call) => call.model)).toEqual([
				"primary",
				"primary",
				"primary",
				"fallback",
				"primary",
				"primary",
			]);
			expect(result.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(JSON.stringify(result.entries)).not.toContain(partial);
			expect(
				result.entries
					.filter((entry) => entry.type === "model_change")
					.every((entry) => entry.modelId === "primary"),
			).toBe(true);
			const users = result.entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
			expect(JSON.stringify(users).match(/continue once/g)).toHaveLength(1);
			expect(JSON.stringify(users).match(/second untouched prompt/g)).toHaveLength(1);
			if (mode === "text") expect(result.stdout).toBe(`${continued}\n`);
			else {
				const records = result.stdout
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(records.at(-1)).toMatchObject({ type: "agent_settled", outcome: "completed" });
				expect(records.filter((record) => record.type === "agent_start")).toHaveLength(2);
			}
		},
		60_000,
	);

	it.each(["text", "json"] as const)(
		"%s exits nonzero after primary and fallback exhaustion",
		async (mode) => {
			const result = await launchCli(mode, true);
			expect(result.signal).toBeNull();
			expect(result.code, result.stderr).toBe(1);
			expect(result.calls.map((call) => call.model)).toEqual(["primary", "primary", "primary", "fallback"]);
			expect(result.entries.some((entry) => entry.type === "compaction")).toBe(false);
			expect(JSON.stringify(result.entries)).not.toContain(partial);
			expect(result.stderr).toContain("Auto-compaction failed");
			if (mode === "text") {
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("second untouched prompt");
			} else {
				const records = result.stdout
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(records[0]).toMatchObject({ type: "session" });
				expect(records.find((record) => record.type === "compaction_end")).toMatchObject({
					aborted: false,
					willRetry: false,
					errorMessage: expect.stringContaining("Auto-compaction failed"),
				});
				expect(records.some((record) => record.type === "agent_start")).toBe(false);
				const rejected = records.filter((record) => record.type === "input_rejected");
				expect(JSON.stringify(rejected)).toContain("continue once");
				expect(JSON.stringify(rejected)).toContain("second untouched prompt");
			}
		},
		60_000,
	);
});
