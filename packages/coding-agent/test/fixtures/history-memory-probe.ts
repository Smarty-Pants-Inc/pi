// smarty-dev#11897: owned child only; no providers, tools, sockets or model requests.
import assert from "node:assert/strict";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import { detachedSessionView, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

const gc = () => {
	assert(global.gc, "run this child with --expose-gc");
	global.gc();
	global.gc();
	return process.memoryUsage();
};
const [mode, file] = process.argv.slice(2);
const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
const moduleHeap = gc().heapUsed;
const manager = SessionManager.open(file);
const view = detachedSessionView(manager);
const sessionHeap = gc().heapUsed;
const pureSessionBytes = sessionHeap - moduleHeap;
let peak = sessionHeap;
const sample = () => {
	peak = Math.max(peak, process.memoryUsage().heapUsed);
};
const errors: string[] = [];
if (mode === "history" || mode === "ancestry" || mode === "projection") {
	// Drop every result. The manager/view stay live across GC, exposing a per-entry cache.
	let chars = 0;
	let visited = 0;
	const consume = (entry: SessionEntry) => {
		visited++;
		if (entry.type === "message" && entry.message.role === "toolResult") {
			for (const part of entry.message.content) if (part.type === "text") chars += part.text.length;
		}
		sample();
	};
	if (mode === "ancestry") {
		let entry = view.getLeafEntry();
		while (entry) {
			consume(entry);
			entry = entry.parentId ? view.getEntry(entry.parentId) : undefined;
		}
	} else if (mode === "history") {
		for (const entry of view.getBranch()) consume(entry);
	} else {
		for (const entry of view.buildSessionProjection().entries) consume(entry.sourceEntry);
	}
	assert.equal(chars, mode === "projection" ? 0 : 300 * 1024 * 1024);
	assert.equal(visited, mode === "projection" ? 151 : manager.getEntryCount());
	const retainedBytes = gc().heapUsed - sessionHeap;
	console.log(
		`REPORT ${JSON.stringify({ mode, moduleHeap, sessionHeap, pureSessionBytes, retainedBytes, peak, entries: manager.getEntryCount(), visited, chars })}`,
	);
	assert(retainedBytes < 16 * 1024 * 1024, `${mode} retained ${retainedBytes} bytes; budget <16 MiB`);
} else {
	assert.equal(mode, "compact");
	const runtime = createExtensionRuntime();
	const held: SessionBeforeCompactEvent[] = [];
	const extensions = [];
	for (let i = 0; i < 3; i++) {
		extensions.push(
			await loadExtensionFromFactory(
				(pi) => {
					pi.on("session_before_compact", (event) => {
						sample();
						held.push(event);
						// Like telemetry/ordinary: the full branch is available, but only one entry is needed.
						assert(event.branchEntries.length > 49_000);
						assert.equal(event.branchEntries[0].id, manager.getBranch()[0].id);
						sample();
					});
				},
				manager.getCwd(),
				createEventBus(),
				runtime,
				`memory-observer-${i}`,
			),
		);
	}
	const runner = new ExtensionRunner(extensions, runtime, manager.getCwd(), manager, registry);
	runner.onError((error) => errors.push(error.error));
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		preparation: prepareCompaction(manager.getBranch(), { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 32 })!,
		branchEntries: manager.getBranch(),
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
	assert(event.preparation);
	const before = gc().heapUsed;
	peak = before;
	console.log("COMPACT_PEAK_START");
	await runner.emit(event);
	sample();
	console.log("COMPACT_PEAK_END");
	assert.deepEqual(errors, []);
	assert.equal(held.length, 3);
	const after = gc().heapUsed;
	console.log(
		`REPORT ${JSON.stringify({ mode, moduleHeap, sessionHeap, pureSessionBytes, before, after, peak, incrementalPeak: peak - before, budget: 2 * sessionHeap, sameBranch: held.every((e) => e.branchEntries === held[0].branchEntries) })}`,
	);
	assert(peak < 2 * sessionHeap, `compaction peak ${peak} bytes; budget <2x loaded session heap ${2 * sessionHeap}`);
}
// Keep source and extension view provably live through the final sample.
assert(manager.getEntryCount() > 49_000);
assert.equal(view.getSessionId(), manager.getSessionId());
