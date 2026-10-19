import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SessionManager, type SessionProjection } from "../../src/core/session-manager.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
	temporaryRoots.length = 0;
});

function temporaryRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

function expectCurrentProjectionEntry(manager: SessionManager, id: string) {
	const current = manager.getEntry(id);
	if (!current) throw new Error(`Missing canonical session entry ${id}`);
	const projected = manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id);
	if (!projected) throw new Error(`Missing projected session entry ${id}`);
	expect(projected.sourceEntry).toBe(current);
	return projected;
}

function expectFlattenedMessageIdentity(projection: SessionProjection): void {
	let index = 0;
	for (const entry of projection.entries) {
		for (const message of entry.messages) expect(projection.messages[index++]).toBe(message);
	}
	expect(index).toBe(projection.messages.length);
}

interface NativeProjectionProbeReport {
	payloadBytes: number;
	retainedBuildCount: number;
	retainedHeapGrowthBytes: number;
	retainedBytesPerBuild: number;
	hotCpuMs: number;
	hotCpuMsPerBuild: number;
	referenceCpuMs: number;
	hotToReferenceCpuRatio: number;
}

function runNativeProjectionProbe(): NativeProjectionProbeReport {
	const sessionManagerPath = fileURLToPath(new URL("../../src/core/session-manager.ts", import.meta.url));
	const resolverPath = fileURLToPath(new URL("../../src/experimental/source-resolver.ts", import.meta.url));
	const childSource = `
import { SessionManager, buildSessionProjection as projectEntries } from ${JSON.stringify(sessionManagerPath)};
const blockBytes = 9 * 1024 * 1024;
const assistantText = "a".repeat(blockBytes);
const toolText = "t".repeat(blockBytes);
const usage = () => ({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } });
const manager = SessionManager.inMemory(process.cwd());
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: assistantText }], api: "openai-completions", provider: "openai", model: "native-cache-probe", usage: usage(), stopReason: "stop", timestamp: 1 });
manager.appendMessage({ role: "toolResult", toolCallId: "call-large-result", toolName: "read", content: [{ type: "text", text: toolText }], usage: usage(), isError: false, timestamp: 2 });
const entries = manager.getEntries();
const leafId = manager.getLeafId();
const payloadBytes = Buffer.byteLength(assistantText) + Buffer.byteLength(toolText);
const measureCpu = (operation) => {
  const start = process.cpuUsage();
  operation();
  const elapsed = process.cpuUsage(start);
  return elapsed.user + elapsed.system;
};
manager.buildSessionProjection();
manager.buildSessionContext();
if (typeof global.gc !== "function") throw new Error("Child was not started with --expose-gc");
global.gc();
const referenceCpuUs = measureCpu(() => {
  projectEntries(entries, leafId);
  projectEntries(entries, leafId);
});
global.gc();
const baselineHeap = process.memoryUsage().heapUsed;
const heldProjections = [];
const heldContexts = [];
const retainedBuildCount = 16;
const hotCpuUs = measureCpu(() => {
  for (let index = 0; index < retainedBuildCount / 2; index++) {
    heldProjections.push(manager.buildSessionProjection());
    heldContexts.push(manager.buildSessionContext());
  }
});
global.gc();
const retainedHeapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - baselineHeap);
const referenceCpuMs = referenceCpuUs / 1000 / 2;
const hotCpuMs = hotCpuUs / 1000;
console.log("REPORT " + JSON.stringify({
  payloadBytes,
  retainedBuildCount,
  retainedHeapGrowthBytes,
  retainedBytesPerBuild: retainedHeapGrowthBytes / retainedBuildCount,
  hotCpuMs,
  hotCpuMsPerBuild: hotCpuMs / retainedBuildCount,
  referenceCpuMs,
  hotToReferenceCpuRatio: hotCpuMs / (referenceCpuMs * 2),
}));
`;
	const root = temporaryRoot("pi-native-projection-probe-");
	const childPath = join(root, "probe.mjs");
	writeFileSync(childPath, childSource);
	const result = spawnSync(
		process.execPath,
		["--expose-gc", "--max-old-space-size=1024", "--import", resolverPath, childPath],
		{ encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
	);
	const output = JSON.stringify({
		status: result.status,
		error: result.error?.message,
		stderr: result.stderr.slice(-4096),
	});
	expect(result.error, output).toBeUndefined();
	expect(result.status, output).toBe(0);
	const reportLine = result.stdout.split("\n").find((line) => line.startsWith("REPORT "));
	expect(reportLine, output).toBeDefined();
	if (!reportLine) throw new Error(`Native projection probe produced no report: ${output}`);
	return JSON.parse(reportLine.slice("REPORT ".length)) as NativeProjectionProbeReport;
}

// smarty-dev#14893 / pi#306: measure the real native build methods on >16 MiB of active assistant and tool-result payloads.
it("keeps repeated native projection CPU and retained allocation within budget", () => {
	const report = runNativeProjectionProbe();
	console.log(`Native projection budget report: ${JSON.stringify(report)}`);
	expect.soft(report.payloadBytes, JSON.stringify(report)).toBeGreaterThanOrEqual(16 * 1024 * 1024);
	// Eight builds of each native API should cost no more than three full reference projections plus 5 ms.
	expect.soft(report.hotCpuMs, JSON.stringify(report)).toBeLessThan(report.referenceCpuMs * 3 + 5);
	// Held results make cloned payload retention observable after GC; the bound admits up to 64 MiB of wrappers/overhead.
	expect.soft(report.retainedHeapGrowthBytes, JSON.stringify(report)).toBeLessThan(64 * 1024 * 1024);
});

// smarty-dev#14893 / pi#306: immutable native payloads are shared; public containers and runtime usage stay detached and mutable.
it("shares frozen message payloads while isolating mutable projection and usage wrappers", () => {
	const manager = SessionManager.inMemory();
	const assistantId = manager.appendMessage({
		...fauxAssistantMessage("native payload"),
		content: [{ type: "text", text: "assistant payload" }],
	});
	const toolId = manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "tool payload" }],
		usage: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 3,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
		isError: false,
		timestamp: 2,
	});

	const first = manager.buildSessionProjection();
	const second = manager.buildSessionProjection();
	const firstAssistant = first.messages.find((message) => message.role === "assistant");
	const secondAssistant = second.messages.find((message) => message.role === "assistant");
	const firstTool = first.messages.find((message) => message.role === "toolResult");
	const secondTool = second.messages.find((message) => message.role === "toolResult");
	if (firstAssistant?.role !== "assistant" || secondAssistant?.role !== "assistant") {
		throw new Error("Missing assistant projection");
	}
	if (firstTool?.role !== "toolResult" || secondTool?.role !== "toolResult")
		throw new Error("Missing tool-result projection");
	const canonicalAssistant = manager.getEntry(assistantId);
	const canonicalTool = manager.getEntry(toolId);
	if (canonicalAssistant?.type !== "message" || canonicalAssistant.message.role !== "assistant") {
		throw new Error("Missing canonical assistant message");
	}
	if (canonicalTool?.type !== "message" || canonicalTool.message.role !== "toolResult") {
		throw new Error("Missing canonical tool-result message");
	}

	expectFlattenedMessageIdentity(first);
	expectFlattenedMessageIdentity(second);
	expect(first).not.toBe(second);
	expect(first.entries).not.toBe(second.entries);
	expect(first.messages).not.toBe(second.messages);
	expect(firstAssistant).not.toBe(secondAssistant);
	expect(firstTool).not.toBe(secondTool);
	expect(firstAssistant.content).toBe(canonicalAssistant.message.content);
	expect(firstAssistant.content).toBe(secondAssistant.content);
	expect(firstTool.content).toBe(canonicalTool.message.content);
	expect(firstTool.content).toBe(secondTool.content);
	expect(Object.isFrozen(firstAssistant.content)).toBe(true);
	expect(Object.isFrozen(firstTool.content)).toBe(true);
	const assistantBlock = firstAssistant.content[0];
	const toolBlock = firstTool.content[0];
	if (assistantBlock?.type !== "text" || toolBlock?.type !== "text") throw new Error("Missing projected text payload");
	expect(Object.isFrozen(assistantBlock)).toBe(true);
	expect(Object.isFrozen(toolBlock)).toBe(true);
	expect(Reflect.set(assistantBlock, "text", "poisoned assistant payload")).toBe(false);
	expect(Reflect.set(toolBlock, "text", "poisoned tool payload")).toBe(false);

	const firstAssistantEntry = first.entries.find((entry) => entry.sourceEntry.id === assistantId);
	const secondAssistantEntry = second.entries.find((entry) => entry.sourceEntry.id === assistantId);
	if (!firstAssistantEntry || !secondAssistantEntry) throw new Error("Missing assistant projected entry");
	expect(firstAssistantEntry.messages).not.toBe(secondAssistantEntry.messages);
	firstAssistantEntry.messages.pop();
	first.entries.pop();
	first.messages.pop();
	expect(secondAssistantEntry.messages).toHaveLength(1);
	expect(second.entries).toHaveLength(2);
	expect(second.messages).toHaveLength(2);

	const firstContext = manager.buildSessionContext();
	const secondContext = manager.buildSessionContext();
	const contextAssistant = firstContext.messages.find((message) => message.role === "assistant");
	const nextContextAssistant = secondContext.messages.find((message) => message.role === "assistant");
	if (contextAssistant?.role !== "assistant" || nextContextAssistant?.role !== "assistant") {
		throw new Error("Missing assistant context message");
	}
	expect(firstContext.messages).not.toBe(secondContext.messages);
	expect(contextAssistant).not.toBe(nextContextAssistant);
	expect(contextAssistant.content).toBe(nextContextAssistant.content);
	expect(contextAssistant.content).toBe(canonicalAssistant.message.content);
	const firstModel = firstContext.model;
	const secondModel = secondContext.model;
	if (!firstModel || !secondModel) throw new Error("Missing model context");
	expect(firstModel).not.toBe(secondModel);
	expect(Reflect.set(firstModel, "modelId", "local-only-model")).toBe(true);
	expect(secondModel.modelId).toBe("faux-1");
	firstContext.messages.pop();
	expect(secondContext.messages).toHaveLength(2);

	const firstUsage = firstAssistant.usage;
	const secondUsage = secondAssistant.usage;
	expect(firstUsage).not.toBe(secondUsage);
	expect(firstUsage).not.toBe(canonicalAssistant.message.usage);
	expect(firstUsage.cost).not.toBe(secondUsage.cost);
	expect(Object.isFrozen(firstUsage)).toBe(false);
	expect(Object.isFrozen(firstUsage.cost)).toBe(false);
	const originalInput = canonicalAssistant.message.usage.input;
	const originalCost = canonicalAssistant.message.usage.cost.total;
	firstUsage.input = originalInput + 100;
	firstUsage.cost.total = originalCost + 100;
	expect(secondUsage.input).toBe(originalInput);
	expect(secondUsage.cost.total).toBe(originalCost);
	expect(canonicalAssistant.message.usage.input).toBe(originalInput);
	expect(canonicalAssistant.message.usage.cost.total).toBe(originalCost);

	const firstToolUsage = firstTool.usage;
	const secondToolUsage = secondTool.usage;
	expect(firstToolUsage).toBeDefined();
	expect(secondToolUsage).toBeDefined();
	if (!firstToolUsage || !secondToolUsage || canonicalTool.message.role !== "toolResult") {
		throw new Error("Missing tool-result usage");
	}
	expect(firstToolUsage).not.toBe(secondToolUsage);
	expect(firstToolUsage.cost).not.toBe(secondToolUsage.cost);
	const originalToolInput = canonicalTool.message.usage?.input;
	const originalToolCost = canonicalTool.message.usage?.cost?.total;
	firstToolUsage.input += 100;
	firstToolUsage.cost!.total += 100;
	expect(secondToolUsage.input).toBe(originalToolInput);
	expect(secondToolUsage.cost!.total).toBe(originalToolCost);
	expect(canonicalTool.message.usage?.input).toBe(originalToolInput);
	expect(canonicalTool.message.usage?.cost?.total).toBe(originalToolCost);

	const fresh = manager.buildSessionProjection();
	expectFlattenedMessageIdentity(fresh);
	const freshAssistant = fresh.messages.find((message) => message.role === "assistant");
	if (freshAssistant?.role !== "assistant") throw new Error("Missing fresh assistant projection");
	expect(freshAssistant.content).toBe(canonicalAssistant.message.content);
	expect(freshAssistant.content[0]).toMatchObject({ type: "text", text: "assistant payload" });
	expect(fresh.messages).toHaveLength(2);
});

// smarty-dev#14893 / pi#306: use the candidate's real file-backed owner; no obsolete OwnedJournal fixture or skips.
it("shares file-backed canonical payloads while isolating mutable projection wrappers and usage", () => {
	const root = temporaryRoot("pi-native-file-projection-");
	const manager = SessionManager.create(root, root);
	const entryId = manager.appendMessage({
		...fauxAssistantMessage("owned payload"),
		usage: {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
	});
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing file-backed session");
	const journalBytes = readFileSync(file);
	const history = JSON.stringify(manager.getEntries());
	const first = manager.buildSessionProjection();
	const second = manager.buildSessionProjection();
	expectFlattenedMessageIdentity(first);
	expectFlattenedMessageIdentity(second);
	const firstEntry = first.entries[0];
	const secondEntry = second.entries[0];
	const sourceEntry = firstEntry?.sourceEntry;
	const firstMessages = first.messages;
	const firstEntries = first.entries;
	const firstMessage = first.messages[0];
	const secondMessage = second.messages[0];
	if (
		sourceEntry?.type !== "message" ||
		sourceEntry.message.role !== "assistant" ||
		!firstEntry ||
		!secondEntry ||
		firstMessage?.role !== "assistant" ||
		secondMessage?.role !== "assistant"
	)
		throw new Error("Missing file-backed assistant projection");
	const firstEntryMessages = firstEntry.messages;
	const originalContent = firstMessage.content;
	firstMessage.usage.input += 100;
	firstMessage.usage.cost.total += 100;
	firstMessage.content = [{ type: "text", text: "call-local replacement" }];
	firstEntry.messages.pop();
	first.entries.pop();
	first.messages.pop();
	const stored = manager.getEntry(entryId);
	if (stored?.type !== "message" || stored.message.role !== "assistant") throw new Error("Missing stored assistant");
	expect(sourceEntry.message.content).toBe(originalContent);
	expect(originalContent).toBe(secondMessage.content);
	expect(Object.isFrozen(sourceEntry)).toBe(true);
	expect(Object.isFrozen(sourceEntry.message.content)).toBe(true);
	expect(Object.isFrozen(sourceEntry.message.content[0])).toBe(true);
	expect(sourceEntry).toBe(secondEntry.sourceEntry);
	expect(sourceEntry).toBe(stored);
	expect(first).not.toBe(second);
	expect(firstEntries).not.toBe(second.entries);
	expect(firstMessages).not.toBe(second.messages);
	expect(firstEntry).not.toBe(secondEntry);
	expect(firstEntryMessages).not.toBe(secondEntry.messages);
	expect(firstMessage).not.toBe(secondMessage);
	expect(firstMessage.usage).not.toBe(secondMessage.usage);
	expect(firstMessage.usage.cost).not.toBe(secondMessage.usage.cost);
	expect(secondMessage.usage.input).toBe(2);
	expect(secondMessage.usage.cost.total).toBe(0.03);
	expect(second.entries).toHaveLength(1);
	expect(second.messages).toHaveLength(1);
	expect(secondMessage.content).toBe(originalContent);
	expect(stored.message.usage.input).toBe(2);
	expect(stored.message.usage.cost.total).toBe(0.03);
	expect(JSON.stringify(manager.getEntries())).toBe(history);
	expect(readFileSync(file).equals(journalBytes)).toBe(true);
	expect(JSON.stringify(SessionManager.open(file).getEntries())).toBe(history);
	const fresh = expectCurrentProjectionEntry(manager, entryId);
	expect(fresh.messages[0]).toMatchObject({ content: originalContent, usage: { input: 2, cost: { total: 0.03 } } });
});

// smarty-dev#14893 / pi#306: exceptional payloads stay native and bypass the revision cache even beside JSON entries.
it("preserves exceptional custom details and avoids stale same-revision projections", () => {
	interface NativeDetails {
		map: Map<string, { value: number }>;
		set: Set<string>;
		date: Date;
		bytes: Uint8Array;
		cycle: { self?: unknown; changed?: boolean };
	}
	const manager = SessionManager.inMemory();
	const ordinaryId = manager.appendMessage({
		...fauxAssistantMessage("ordinary"),
		content: [{ type: "text", text: "published" }],
	});
	const details: NativeDetails = {
		map: new Map([["before", { value: 1 }]]),
		set: new Set(["before"]),
		date: new Date(0),
		bytes: new Uint8Array([1, 2]),
		cycle: {},
	};
	details.cycle.self = details.cycle;
	const customId = manager.appendCustomMessageEntry("native-details", "visible", true, details);
	const stateId = manager.appendCustomEntry("native-state", new Map([["before", 1]]));
	const revision = manager.revision();
	const first = manager.buildSessionProjection();
	const firstCustom = first.messages.find((message) => message.role === "custom");
	const firstOrdinary = first.messages.find((message) => message.role === "assistant");
	if (firstCustom?.role !== "custom" || firstOrdinary?.role !== "assistant") {
		throw new Error("Missing mixed projection");
	}
	const ordinaryProjection = first.entries.find((entry) => entry.sourceEntry.id === ordinaryId);
	expect(ordinaryProjection?.messages).toHaveLength(1);
	const observed = firstCustom.details as NativeDetails;
	expect(observed.map).toBeInstanceOf(Map);
	expect(observed.set).toBeInstanceOf(Set);
	expect(observed.date).toEqual(new Date(0));
	expect(observed.bytes).toEqual(new Uint8Array([1, 2]));
	expect(observed.cycle.self).toBe(observed.cycle);
	expect(observed).not.toBe(details);
	expect(observed.map).not.toBe(details.map);
	expect(observed.bytes).not.toBe(details.bytes);
	for (const value of [observed, observed.map, observed.set, observed.date, observed.bytes, observed.cycle]) {
		expect(Object.isFrozen(value)).toBe(false);
	}
	expect(Object.isFrozen(firstOrdinary.content)).toBe(true);
	const stateProjection = first.entries.find((entry) => entry.sourceEntry.id === stateId);
	expect(stateProjection?.messages).toEqual([]);
	if (stateProjection?.sourceEntry.type !== "custom") throw new Error("Missing state-only exceptional entry");
	expect(stateProjection.sourceEntry.data).toBeInstanceOf(Map);
	expect(Object.isFrozen(stateProjection.sourceEntry.data)).toBe(false);

	const nativeCustom = manager.getEntry(customId);
	const nativeState = manager.getEntry(stateId);
	if (nativeCustom?.type !== "custom_message" || nativeState?.type !== "custom") {
		throw new Error("Missing exceptional history");
	}
	const nativeDetails = nativeCustom.details as NativeDetails;
	nativeDetails.map.set("after", { value: 2 });
	nativeDetails.set.add("after");
	nativeDetails.date.setTime(123);
	nativeDetails.bytes[0] = 99;
	nativeDetails.cycle.changed = true;
	const nativeStateMap = nativeState.data as Map<string, number>;
	nativeStateMap.set("after", 2);

	const second = manager.buildSessionProjection();
	const secondCustom = second.messages.find((message) => message.role === "custom");
	const secondOrdinary = second.messages.find((message) => message.role === "assistant");
	if (secondCustom?.role !== "custom" || secondOrdinary?.role !== "assistant") {
		throw new Error("Missing refreshed projection");
	}
	const refreshed = secondCustom.details as NativeDetails;
	expect(manager.revision()).toBe(revision);
	expect(second).not.toBe(first);
	expect(refreshed.map.get("after")).toEqual({ value: 2 });
	expect(refreshed.set.has("after")).toBe(true);
	expect(refreshed.date.getTime()).toBe(123);
	expect(refreshed.bytes[0]).toBe(99);
	expect(refreshed.cycle.changed).toBe(true);
	const refreshedState = second.entries.find((entry) => entry.sourceEntry.id === stateId);
	if (refreshedState?.sourceEntry.type !== "custom") throw new Error("Missing refreshed exceptional state");
	expect(refreshedState.sourceEntry.data).toBe(nativeStateMap);
	expect(nativeStateMap.get("after")).toBe(2);
	expect(secondOrdinary.content).toBe(firstOrdinary.content);
	expect(details.map.has("after")).toBe(false);
	expect(details.set.has("after")).toBe(false);
	expect(details.date.getTime()).toBe(0);
	expect(details.bytes[0]).toBe(1);
	expect(details.cycle.changed).toBeUndefined();
});

// smarty-dev#14893 / pi#306: system, custom, branch-summary, compaction and edited content retain safe cache semantics.
it("shares frozen context payloads while keeping nested history and runtime edits isolated", () => {
	const manager = SessionManager.inMemory();
	const systemTool = {
		name: "nested_tool",
		description: "test tool",
		parameters: {
			type: "object" as const,
			properties: {
				nested: {
					type: "object" as const,
					properties: { value: { type: "string" as const } },
					required: ["value"],
				},
			},
			required: ["nested"],
		},
	};
	manager.appendMessage({ role: "system", content: "system prompt", toolsAdded: [systemTool], timestamp: 0 });
	const userId = manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
	const answerId = manager.appendMessage({
		...fauxAssistantMessage("answer"),
		content: [{ type: "text", text: "answer" }],
	});
	const branchId = manager.branchWithSummary(answerId, "branch summary", { nested: { values: [1] } });
	const customId = manager.appendCustomMessageEntry("visible", [{ type: "text", text: "original custom" }], true, {
		nested: { values: [1] },
	});
	const editedContent = [{ type: "text" as const, text: "edited custom" }];
	const editId = manager.appendContextEdit(customId, { content: editedContent });
	editedContent[0].text = "caller mutation";
	const compactionId = manager.appendCompaction("checkpoint", branchId, 100, { nested: { values: [1] } });
	const assistantId = manager.appendMessage({
		...fauxAssistantMessage("after compaction"),
		content: [{ type: "text", text: "after compaction" }],
		usage: {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
	});
	const first = manager.buildSessionProjection();
	const second = manager.buildSessionProjection();
	expect(first.entries.map((entry) => entry.sourceEntry.type)).toEqual([
		"compaction",
		"branch_summary",
		"custom_message",
		"context_edit",
		"message",
	]);
	for (const entry of first.entries) expect(Object.isFrozen(entry.sourceEntry)).toBe(true);
	const firstSystem = first.messages.find((message) => message.role === "system");
	const secondSystem = second.messages.find((message) => message.role === "system");
	const firstBranch = first.messages.find((message) => message.role === "branchSummary");
	const secondBranch = second.messages.find((message) => message.role === "branchSummary");
	const firstCompaction = first.messages.find((message) => message.role === "compactionSummary");
	const secondCompaction = second.messages.find((message) => message.role === "compactionSummary");
	const firstCustom = first.messages.find((message) => message.role === "custom");
	const secondCustom = second.messages.find((message) => message.role === "custom");
	const firstAssistant = first.messages.find((message) => message.role === "assistant");
	const secondAssistant = second.messages.find((message) => message.role === "assistant");
	if (
		firstSystem?.role !== "system" ||
		secondSystem?.role !== "system" ||
		firstBranch?.role !== "branchSummary" ||
		secondBranch?.role !== "branchSummary" ||
		firstCompaction?.role !== "compactionSummary" ||
		secondCompaction?.role !== "compactionSummary" ||
		firstCustom?.role !== "custom" ||
		secondCustom?.role !== "custom" ||
		firstAssistant?.role !== "assistant" ||
		secondAssistant?.role !== "assistant"
	)
		throw new Error("Missing compaction projection messages");
	const block = (message: { content: unknown }) => (message.content as Array<{ type: string; text?: string }>)[0];
	const editedBlock = block(firstCustom);
	if (editedBlock?.type !== "text") throw new Error("Missing edited text block");
	expect(editedBlock).toMatchObject({ type: "text", text: "edited custom" });
	expect(Object.isFrozen(firstCustom.content)).toBe(true);
	expect(firstSystem.toolsAdded).toBe(secondSystem.toolsAdded);
	expect(firstCustom.content).toBe(secondCustom.content);
	expect(Reflect.set(editedBlock, "text", "poisoned edit")).toBe(false);
	const firstSystemTool = firstSystem.toolsAdded?.[0];
	const secondSystemTool = secondSystem.toolsAdded?.[0];
	if (!firstSystemTool || !secondSystemTool) throw new Error("Missing checkpoint tool definition");
	const firstNestedSchema = (firstSystemTool.parameters as unknown as { properties: { nested: object } }).properties
		.nested;
	const secondNestedSchema = (secondSystemTool.parameters as unknown as { properties: { nested: object } }).properties
		.nested;
	expect(firstNestedSchema).toBe(secondNestedSchema);
	expect(Object.isFrozen(firstNestedSchema)).toBe(true);
	expect(Reflect.set(firstNestedSchema, "description", "poisoned tool schema")).toBe(false);

	const branchEntry = first.entries.find((entry) => entry.sourceEntry.id === branchId)?.sourceEntry;
	const customEntry = first.entries.find((entry) => entry.sourceEntry.id === customId)?.sourceEntry;
	const editEntry = manager.getEntry(editId);
	const compactionEntry = first.entries.find((entry) => entry.sourceEntry.id === compactionId)?.sourceEntry;
	if (
		branchEntry?.type !== "branch_summary" ||
		customEntry?.type !== "custom_message" ||
		editEntry?.type !== "context_edit" ||
		!editEntry.replacement ||
		compactionEntry?.type !== "compaction"
	) {
		throw new Error("Missing frozen context history");
	}
	const branchDetails = branchEntry.details as { nested: { values: number[] } };
	const customDetails = customEntry.details as { nested: { values: number[] } };
	const compactionDetails = compactionEntry.details as { nested: { values: number[] } };
	expect((editEntry.replacement.content as Array<{ text?: string }>)[0]?.text).toBe("edited custom");
	expect(firstCustom.content).toBe(editEntry.replacement.content);
	for (const nested of [branchDetails.nested.values, customDetails.nested.values, compactionDetails.nested.values]) {
		expect(Object.isFrozen(nested)).toBe(true);
		expect(() => nested.push(2)).toThrow(TypeError);
	}
	expect(compactionEntry.systemMessage?.content).toBe(firstSystem.content);
	expect(compactionEntry.systemMessage?.toolsAdded).toBe(firstSystem.toolsAdded);

	const firstEdited = block(firstCustom);
	firstAssistant.content = [{ type: "text", text: "call-local content" }];
	firstAssistant.usage.input += 100;
	firstAssistant.usage.cost.total += 100;
	firstBranch.summary = "call-local branch";
	firstCompaction.summary = "call-local checkpoint";
	expect(secondCustom.content).toBe(editEntry.replacement.content);
	expect(block(secondCustom)).toMatchObject({ type: "text", text: "edited custom" });
	expect(secondAssistant.content).not.toBe(firstAssistant.content);
	expect(secondAssistant.usage.input).toBe(2);
	expect(secondAssistant.usage.cost.total).toBe(0.03);
	expect(secondBranch.summary).toBe("branch summary");
	expect(secondCompaction.summary).toBe("checkpoint");
	const fresh = manager.buildSessionProjection();
	const freshAssistant = fresh.messages.find((message) => message.role === "assistant");
	if (freshAssistant?.role !== "assistant") throw new Error("Missing fresh assistant");
	expect(freshAssistant.content).toBe(secondAssistant.content);
	expect(freshAssistant.usage.input).toBe(2);
	expect(manager.getEntry(assistantId)).toMatchObject({
		message: { content: [{ type: "text", text: "after compaction" }], usage: { input: 2 } },
	});
	expect(manager.getEntry(editId)).toMatchObject({
		replacement: { content: [{ type: "text", text: "edited custom" }] },
	});
	expect(editedContent[0].text).toBe("caller mutation");
	expect(firstEdited).toMatchObject({ type: "text", text: "edited custom" });
	expect(manager.getEntry(userId)).toMatchObject({ message: { content: "question" } });
});

// smarty-dev#14893 / pi#306: every append, branch, context edit, compaction and session replacement must publish canonical entries.
it("invalidates native projections after append, branch, context edit, compaction, and new session", () => {
	const manager = SessionManager.inMemory();
	const userId = manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
	expectCurrentProjectionEntry(manager, userId);

	const firstAssistantId = manager.appendMessage(fauxAssistantMessage("same answer"));
	expectCurrentProjectionEntry(manager, firstAssistantId);
	manager.branch(userId);
	const branched = manager.buildSessionProjection();
	expect(branched.entries.map((entry) => entry.sourceEntry.id)).toEqual([userId]);
	expectCurrentProjectionEntry(manager, userId);

	const assistantId = manager.appendMessage(fauxAssistantMessage("same answer"));
	expect(assistantId).not.toBe(firstAssistantId);
	expectCurrentProjectionEntry(manager, assistantId);
	const editId = manager.appendContextEdit(assistantId, { content: "edited answer" });
	const editedEntry = expectCurrentProjectionEntry(manager, assistantId);
	expect(editedEntry.messages[0]).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "edited answer" }],
	});
	expectCurrentProjectionEntry(manager, editId);

	const compactionId = manager.appendCompaction("checkpoint", assistantId, 12);
	const compacted = manager.buildSessionProjection();
	expect(compacted.entries[0]?.sourceEntry.id).toBe(compactionId);
	expectCurrentProjectionEntry(manager, compactionId);
	const compactedAssistant = expectCurrentProjectionEntry(manager, assistantId);
	expect(compactedAssistant.messages[0]).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "edited answer" }],
	});
	expectCurrentProjectionEntry(manager, editId);

	const beforeNewSession = compactedAssistant.sourceEntry;
	manager.newSession({ id: "native-projection-fresh" });
	const replacementId = manager.appendMessage(fauxAssistantMessage("same answer"));
	const replacement = expectCurrentProjectionEntry(manager, replacementId);
	expect(replacement.sourceEntry).not.toBe(beforeNewSession);
	expect(manager.buildSessionProjection().entries.map((entry) => entry.sourceEntry.id)).toEqual([replacementId]);
});

// smarty-dev#14893 / pi#306: cooling and rehydrating a real file-backed active message replaces its canonical entry object.
it("invalidates projections across cold/hot replacement and byte-identical file reload", () => {
	const root = temporaryRoot("pi-native-projection-reload-");
	const writer = SessionManager.create(root, root);
	const olderId = writer.appendMessage({
		...fauxAssistantMessage("same bytes"),
		content: [{ type: "text", text: "same bytes ".repeat(300) }],
	});
	const warmEntry = expectCurrentProjectionEntry(writer, olderId).sourceEntry;
	for (let index = 0; index < 110; index++) writer.appendCustomEntry("padding", { index });
	const compactionId = writer.appendCompaction("checkpoint", null, 1000);
	const coldEntry = writer.getEntry(olderId);
	if (!coldEntry) throw new Error("Missing cooled entry");
	expect(coldEntry).not.toBe(warmEntry);
	writer.branch(olderId);
	const hotEntry = writer.getEntry(olderId);
	if (!hotEntry) throw new Error("Missing rehydrated entry");
	expect(hotEntry).not.toBe(coldEntry);
	expect(expectCurrentProjectionEntry(writer, olderId).sourceEntry).toBe(hotEntry);

	const file = writer.getSessionFile();
	if (!file) throw new Error("Missing persisted session file");
	const reloaded = SessionManager.open(file);
	const beforeReload = expectCurrentProjectionEntry(reloaded, compactionId).sourceEntry;
	reloaded.setSessionFile(file);
	const afterReload = reloaded.getEntry(compactionId);
	if (!afterReload) throw new Error("Missing entry after file reload");
	expect(afterReload).not.toBe(beforeReload);
	expect(afterReload).toEqual(beforeReload);
	expect(expectCurrentProjectionEntry(reloaded, compactionId).sourceEntry).toBe(afterReload);
});

// smarty-dev#14893 / pi#306: selecting a branched session must not keep projections tied to the pre-fork objects.
it("rebuilds the canonical projection after creating a branched session", () => {
	const root = temporaryRoot("pi-native-projection-fork-");
	const manager = SessionManager.create(root, root);
	const userId = manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
	const assistantId = manager.appendMessage({
		...fauxAssistantMessage("same bytes"),
		content: [{ type: "text", text: "same bytes" }],
	});
	const beforeFork = expectCurrentProjectionEntry(manager, assistantId).sourceEntry;

	manager.createBranchedSession(assistantId);
	const forkEntry = manager.getEntry(assistantId);
	if (!forkEntry) throw new Error("Missing forked entry");
	expect(forkEntry).not.toBe(beforeFork);
	expect(forkEntry).toEqual(beforeFork);
	expect(expectCurrentProjectionEntry(manager, assistantId).sourceEntry).toBe(forkEntry);
	expectCurrentProjectionEntry(manager, userId);
});
