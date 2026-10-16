import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { type FileEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import { createHarness, type Harness } from "./harness.ts";

const SIBLING_ID = "late-sibling";
const NATIVE_ID = "native-mutation";
const CONTENT = "durable native mutation\n";
const BEFORE = "before mutation\n";

type NativeName = "write" | "edit";
type Outcome = "success" | "throw" | "cancel";
type Scheduling = "default" | "parallel-override";

interface Batch {
	harness: Harness;
	native: NativeName;
	outcome: Outcome;
	scheduling: Scheduling;
	path: string;
	trace: string[];
	siblingExecutions: number;
	siblingSawAbort: boolean;
	cancellation?: Promise<void>;
}

function toolResults(messages: readonly AgentMessage[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function entryMessages(entries: readonly FileEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function assertSettlement(batch: Batch, sessionEvents: AgentSessionEvent[], failure?: Error, nativeOnly = false): void {
	const { harness, native, outcome, path, scheduling } = batch;
	const nativeContent = [
		{
			type: "text",
			text: native === "write" ? `Successfully wrote to ${path}` : `Successfully replaced 1 block(s) in ${path}.`,
		},
	];
	const siblingContent = [
		{
			type: "text",
			text:
				outcome === "success"
					? "sibling completed"
					: outcome === "cancel"
						? "Operation aborted"
						: "late sibling failure",
		},
	];
	// Establish the completed filesystem effect before checking for the missing transcript artifact.
	expect(readFileSync(path, "utf8")).toBe(CONTENT);
	expect(batch.trace).toEqual(nativeOnly ? ["native_end"] : ["native_end", "sibling_settle"]);
	expect(batch.siblingExecutions).toBe(nativeOnly ? 0 : 1);
	expect(batch.siblingSawAbort).toBe(!nativeOnly && outcome === "cancel");
	const results = toolResults(harness.session.agent.state.messages);
	const callOrder = nativeOnly
		? [NATIVE_ID]
		: scheduling === "default"
			? [NATIVE_ID, SIBLING_ID]
			: [SIBLING_ID, NATIVE_ID];
	expect(results.map((result) => result.toolCallId)).toEqual(callOrder);
	const nativeResult = results.find((result) => result.toolCallId === NATIVE_ID);
	expect(nativeResult).toMatchObject({ toolName: native, isError: false });
	expect(nativeResult?.content).toEqual(nativeContent);
	if (!nativeOnly) {
		const siblingResult = results.find((result) => result.toolCallId === SIBLING_ID);
		expect(siblingResult).toMatchObject({ toolName: "sibling", isError: outcome !== "success" });
		expect(siblingResult?.content).toEqual(siblingContent);
	}

	// Compare the entire result, including edit details, across live events and actual storage.
	const canonical = JSON.parse(JSON.stringify(results)) as ToolResultMessage[];
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("persistSession did not allocate a session file");
	const jsonl = readFileSync(file, "utf8");
	expect(jsonl.endsWith("\n")).toBe(true);
	const disk = jsonl
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as FileEntry);
	expect(disk[0]).toMatchObject({ type: "session", id: harness.session.sessionId });
	const reopened = SessionManager.open(file);
	expect(reopened.getSessionFile()).toBe(file);
	expect(reopened.getSessionId()).toBe(harness.session.sessionId);
	const transcripts: Array<[string, AgentMessage[]]> = [
		["agent.messages", harness.session.agent.state.messages],
		["SessionManager entries", entryMessages(harness.sessionManager.getEntries())],
		["SessionManager branch", entryMessages(harness.sessionManager.getBranch())],
		["SessionManager context", harness.sessionManager.buildSessionContext().messages],
		["disk JSONL", entryMessages(disk)],
		["reopened entries", entryMessages(reopened.getEntries())],
		["reopened branch", entryMessages(reopened.getBranch())],
		["reopened context", reopened.buildSessionContext().messages],
	];
	const observers: Array<[string, readonly AgentSessionEvent[]]> = [
		["harness observer", harness.events],
		["healthy session observer", sessionEvents],
	];
	for (const [source, events] of observers) {
		const completions = events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		// Only the explicit parallel fixture puts the sibling first in assistant-call order.
		expect(
			completions.map((event) => event.toolCallId),
			source,
		).toEqual(nativeOnly ? [NATIVE_ID] : [NATIVE_ID, SIBLING_ID]);
		expect(completions[0]).toMatchObject({ toolName: native, isError: false });
		expect(completions[0].result.content, source).toEqual(nativeContent);
		if (!nativeOnly) {
			expect(completions[1]).toMatchObject({ toolName: "sibling", isError: outcome !== "success" });
			expect(completions[1].result.content, source).toEqual(siblingContent);
		}
		for (const type of ["message_start", "message_end"] as const) {
			transcripts.push([
				`${source} ${type}`,
				events.flatMap((event) => (event.type === type ? [event.message] : [])),
			]);
		}
		if (!failure) {
			const turns = events.filter(
				(event): event is Extract<AgentSessionEvent, { type: "turn_end" }> =>
					event.type === "turn_end" && event.toolResults.length > 0,
			);
			expect(turns, source).toHaveLength(1);
			transcripts.push([`${source} turn_end`, turns[0].toolResults]);
			const ends = events.filter(
				(event): event is Extract<AgentSessionEvent, { type: "agent_end" }> => event.type === "agent_end",
			);
			expect(ends, source).toHaveLength(1);
			transcripts.push([`${source} agent_end`, ends[0].messages]);
		}
	}
	for (const [source, messages] of transcripts) {
		expect(JSON.parse(JSON.stringify(toolResults(messages))), source).toEqual(canonical);
	}
	expect(harness.session.agent.state.pendingToolCalls.size).toBe(0);
	expect(harness.session.agent.state.isStreaming).toBe(false);
	expect(harness.session.isIdle).toBe(true);
	expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	if (!failure) {
		expect(harness.eventsOfType("agent_settled")).toMatchObject([
			{ outcome: outcome === "cancel" ? "aborted" : "completed", aborted: outcome === "cancel" },
		]);
		if (outcome !== "cancel") expect(harness.session.getLastAssistantText()).toBe("done");
	} else {
		// Normal Agent behavior converts a one-shot subscriber throw to an assistant error, not a rejection.
		expect(
			harness.session.messages.filter(
				(message) => message.role === "assistant" && message.errorMessage === failure.message,
			),
		).toHaveLength(1);
	}
}

const controls = (["write", "edit"] as const).flatMap((native) =>
	(["success", "throw", "cancel"] as const).flatMap((outcome) =>
		(["default", "parallel-override"] as const).map((scheduling) => ({ native, outcome, scheduling })),
	),
);
const sequentialRegressions = (["write", "edit"] as const).flatMap((native) =>
	(["tool_execution_end", "message_start", "message_end"] as const).map((stage) => ({ native, stage })),
);
const failureSites = [
	{ stage: "tool_execution_end", target: SIBLING_ID },
	{ stage: "message_start", target: SIBLING_ID },
	{ stage: "message_end", target: SIBLING_ID },
	{ stage: "message_start", target: NATIVE_ID },
	{ stage: "message_end", target: NATIVE_ID },
] as const;
const regressions = (["write", "edit"] as const).flatMap((native) =>
	(["throw", "cancel"] as const).flatMap((outcome) =>
		failureSites.map(({ stage, target }) => ({ native, outcome, stage, target })),
	),
);

describe("native tool batch settlement", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		try {
			while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		} finally {
			vi.restoreAllMocks();
		}
	});

	async function createBatch(native: NativeName, outcome: Outcome, scheduling: Scheduling): Promise<Batch> {
		const nativeFinished = Promise.withResolvers<void>();
		const parameters = Type.Object({});
		const sibling: AgentTool<typeof parameters, undefined> = {
			name: "sibling",
			label: "sibling",
			description: "Settles only after the native mutation's completion event.",
			parameters,
			execute: async (_id, _args, signal) => {
				batch.siblingExecutions++;
				await nativeFinished.promise;
				batch.trace.push("sibling_settle");
				// Cancel only once this sibling actually starts, after the observed native completion.
				// Default sequential execution has already published the native result by this point.
				if (outcome === "cancel") batch.cancellation = harness.session.abort();
				batch.siblingSawAbort = signal?.aborted ?? false;
				if (outcome === "cancel") throw new Error("Operation aborted");
				if (outcome === "throw") throw new Error("late sibling failure");
				return { content: [{ type: "text", text: "sibling completed" }], details: undefined };
			},
		};
		const nativeTool = native === "write" ? createWriteTool(process.cwd()) : createEditTool(process.cwd());
		const harness = await createHarness({
			persistSession: true,
			// Default built-ins are SEQUENTIAL. Parallel cases explicitly override metadata only;
			// the real native execute/IO implementation is unchanged. This is not default scheduling.
			tools: [sibling, scheduling === "default" ? nativeTool : { ...nativeTool, executionMode: "parallel" }],
		});
		harnesses.push(harness);
		harness.session.setAutoRetryEnabled(false);
		harness.session.setAutoCompactionEnabled(false);
		await harness.session.bindExtensions({});
		const path = join(harness.tempDir, "native-result.txt");
		if (native === "edit") writeFileSync(path, BEFORE);
		const batch: Batch = {
			harness,
			native,
			outcome,
			scheduling,
			path,
			trace: [],
			siblingExecutions: 0,
			siblingSawAbort: false,
		};
		harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_end" || event.toolCallId !== NATIVE_ID) return;
			batch.trace.push("native_end");
			nativeFinished.resolve();
		});
		const nativeCall = fauxToolCall(
			native,
			native === "write" ? { path, content: CONTENT } : { path, edits: [{ oldText: BEFORE, newText: CONTENT }] },
			{ id: NATIVE_ID },
		);
		const siblingCall = fauxToolCall("sibling", {}, { id: SIBLING_ID });
		harness.setResponses([
			fauxAssistantMessage(scheduling === "default" ? [nativeCall, siblingCall] : [siblingCall, nativeCall], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		return batch;
	}

	// Smarty-Pants-Inc/smarty-dev#10068: tool throws/cancellation alone already normalize without losing writes.
	it.each(controls)(
		"control: $scheduling $native with late $outcome sibling, no listener failures",
		async ({ native, outcome, scheduling }) => {
			const log = vi.spyOn(console, "error");
			const batch = await createBatch(native, outcome, scheduling);
			const sessionEvents: AgentSessionEvent[] = [];
			batch.harness.session.subscribe((event) => {
				sessionEvents.push(event);
			});
			await batch.harness.session.prompt("run the native tool batch");
			await batch.cancellation;
			assertSettlement(batch, sessionEvents);
			expect(log).not.toHaveBeenCalled();
		},
	);

	// Smarty-Pants-Inc/smarty-dev#10068: default native-first execution loses its own result before persistence.
	it.each(sequentialRegressions)(
		"default sequential $native survives its $stage subscriber",
		async ({ native, stage }) => {
			const batch = await createBatch(native, "throw", "default");
			const failure = new Error(`native ${stage} listener failed`);
			let failureCalls = 0;
			batch.harness.session.subscribe((event) => {
				const selected =
					stage === "tool_execution_end"
						? event.type === "tool_execution_end" && event.toolCallId === NATIVE_ID
						: (event.type === "message_start" || event.type === "message_end") &&
							event.type === stage &&
							event.message.role === "toolResult" &&
							event.message.toolCallId === NATIVE_ID;
				if (!selected) return;
				failureCalls++;
				throw failure;
			});
			const sessionEvents: AgentSessionEvent[] = [];
			batch.harness.session.subscribe((event) => {
				sessionEvents.push(event);
			});
			await batch.harness.session.prompt("run the default native-first batch");
			assertSettlement(batch, sessionEvents, failure, true);
			expect(failureCalls).toBe(1);
		},
	);

	// Smarty-Pants-Inc/smarty-dev#10068: persistent listeners still reject with the original error after persistence.
	it.each(["write", "edit"] as const)(
		"default sequential %s persists before a persistent subscriber rejects the prompt",
		async (native) => {
			const batch = await createBatch(native, "throw", "default");
			const { harness } = batch;
			const failure = new Error("persistent native listener failure");
			let failing = false;
			let failureCalls = 0;
			harness.session.subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolCallId === NATIVE_ID) failing = true;
				if (
					failing &&
					(event.type === "tool_execution_end" || event.type === "message_start" || event.type === "message_end")
				) {
					failureCalls++;
					throw failure;
				}
			});
			const sessionEvents: AgentSessionEvent[] = [];
			harness.session.subscribe((event) => {
				sessionEvents.push(event);
			});
			await expect(harness.session.prompt("run the default native-first batch")).rejects.toBe(failure);
			// Native end, result start/end, then the unchanged synthetic assistant failure's start.
			expect(failureCalls).toBe(4);
			expect(readFileSync(batch.path, "utf8")).toBe(CONTENT);
			expect(batch.trace).toEqual(["native_end"]);
			expect(batch.siblingExecutions).toBe(0);
			const results = toolResults(harness.session.agent.state.messages);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ toolCallId: NATIVE_ID, toolName: native, isError: false });
			const canonical = JSON.parse(JSON.stringify(results)) as ToolResultMessage[];
			const file = harness.sessionManager.getSessionFile();
			if (!file) throw new Error("persistSession did not allocate a session file");
			const disk = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as FileEntry);
			for (const messages of [
				entryMessages(harness.sessionManager.getEntries()),
				entryMessages(disk),
				SessionManager.open(file).buildSessionContext().messages,
			]) {
				expect(JSON.parse(JSON.stringify(toolResults(messages)))).toEqual(canonical);
			}
			const completions = sessionEvents.filter((event) => event.type === "tool_execution_end");
			expect(completions).toMatchObject([{ toolCallId: NATIVE_ID, toolName: native, isError: false }]);
			for (const type of ["message_start", "message_end"] as const) {
				const messages = sessionEvents.flatMap((event) => (event.type === type ? [event.message] : []));
				expect(JSON.parse(JSON.stringify(toolResults(messages)))).toEqual(canonical);
			}
			expect(harness.session.agent.state.pendingToolCalls.size).toBe(0);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	// Smarty-Pants-Inc/smarty-dev#10068: no-late-effects counterexample, not completed-sibling settlement.
	it.each([
		{ order: "unknown-first", stage: "tool_execution_end" },
		{ order: "prepared-first", stage: "tool_execution_end" },
		{ order: "unknown-first", stage: "tool_execution_start" },
	] as const)("parallel preflight $order / $stage prevents late writes", async ({ order, stage }) => {
		const nativeTool = createWriteTool(process.cwd());
		const harness = await createHarness({
			persistSession: true,
			tools: [{ ...nativeTool, executionMode: "parallel" } as AgentTool],
		});
		harnesses.push(harness);
		harness.session.setAutoRetryEnabled(false);
		harness.session.setAutoCompactionEnabled(false);
		await harness.session.bindExtensions({});
		const path = join(harness.tempDir, "must-not-exist.txt");
		const unknownId = "unknown-preflight";
		const unknownCall = fauxToolCall("missing-tool", {}, { id: unknownId });
		const nativeCall = fauxToolCall("write", { path, content: CONTENT }, { id: NATIVE_ID });
		harness.setResponses([
			fauxAssistantMessage(order === "unknown-first" ? [unknownCall, nativeCall] : [nativeCall, unknownCall], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const failure = new Error(`preflight ${stage} subscriber failed`);
		let failureCalls = 0;
		harness.session.subscribe((event) => {
			if (event.type !== stage) return;
			if (event.toolCallId !== (stage === "tool_execution_end" ? unknownId : NATIVE_ID)) return;
			failureCalls++;
			throw failure;
		});

		await harness.session.prompt("do not execute tools after preflight publication fails");

		// An earlier prepared entry is still unstarted, even though its start event was emitted.
		expect(existsSync(path)).toBe(false);
		expect(failureCalls).toBe(1);
		expect(harness.eventsOfType("tool_execution_end")).toMatchObject([
			{ toolCallId: unknownId, toolName: "missing-tool", isError: true },
		]);
		const results = toolResults(harness.session.agent.state.messages);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolCallId: unknownId, toolName: "missing-tool", isError: true });
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("persistSession did not allocate a session file");
		const disk = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as FileEntry);
		for (const messages of [
			entryMessages(harness.sessionManager.getEntries()),
			entryMessages(disk),
			SessionManager.open(file).buildSessionContext().messages,
			...(["message_start", "message_end"] as const).map((type) =>
				harness.events.flatMap((event) => (event.type === type ? [event.message] : [])),
			),
		]) {
			expect(toolResults(messages)).toEqual(results);
		}
		expect(
			harness.session.messages.filter(
				(message) => message.role === "assistant" && message.errorMessage === failure.message,
			),
		).toHaveLength(1);
		expect(harness.session.agent.state.pendingToolCalls.size).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	// Smarty-Pants-Inc/smarty-dev#10068: explicit parallel scheduling must settle every completed sibling result.
	// Scope is Session's synchronous subscribers; pre-session Agent listeners and async Session callbacks are excluded.
	it.each(regressions)(
		"parallel-override $native / late $outcome / session throw at $stage for $target",
		async ({ native, outcome, stage, target }) => {
			const batch = await createBatch(native, outcome, "parallel-override");
			const failure = new Error(`session ${stage} ${target} listener failed`);
			let failureCalls = 0;
			batch.harness.session.subscribe((event) => {
				const selected =
					stage === "tool_execution_end"
						? event.type === "tool_execution_end" && event.toolCallId === target
						: (event.type === "message_start" || event.type === "message_end") &&
							event.type === stage &&
							event.message.role === "toolResult" &&
							event.message.toolCallId === target;
				if (selected) {
					failureCalls++;
					throw failure;
				}
			});
			// This healthy observer must receive the real native result despite the preceding subscriber's throw.
			const sessionEvents: AgentSessionEvent[] = [];
			batch.harness.session.subscribe((event) => {
				sessionEvents.push(event);
			});
			await batch.harness.session.prompt("run the native tool batch");
			await batch.cancellation;
			assertSettlement(batch, sessionEvents, failure);
			expect(failureCalls).toBe(1);
		},
	);
});
