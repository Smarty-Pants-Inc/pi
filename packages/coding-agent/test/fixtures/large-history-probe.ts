// smarty-dev#11897 / #14576 P2-2: streamed real-sized entry count; no providers.
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { detachedSessionView, SessionManager } from "../../src/core/session-manager.ts";

assert(global.gc, "run with --expose-gc");
const root = mkdtempSync(join(tmpdir(), "pi-large-history-"));
const file = join(root, "session.jsonl");
const mode = process.argv[2] ?? "default";
const count = mode === "overflow" ? 240_000 : 122_169;
const budget = 128 * 1024 * 1024;
const gc = () => {
	global.gc!();
	global.gc!();
	return process.memoryUsage().heapUsed;
};
try {
	const fd = openSync(file, "wx", 0o600);
	try {
		writeSync(
			fd,
			`${JSON.stringify({ type: "session", version: 3, id: "large-history", timestamp: "2026-10-18T00:00:00.000Z", cwd: root })}\n`,
		);
		for (let i = 0; i < count; i++) {
			const common = { id: String(i), parentId: i ? String(i - 1) : null, timestamp: "2026-10-18T00:00:00.000Z" };
			const entry =
				i % 1000 === 0
					? {
							...common,
							type: "message",
							message: { role: "user", content: [{ type: "text", text: `message ${i}` }], timestamp: i },
						}
					: {
							...common,
							type: "custom",
							customType: "metadata",
							data: { index: i, nested: { values: [i, i + 1] }, text: "x".repeat(128) },
						};
			writeSync(fd, `${JSON.stringify(entry)}\n`);
		}
	} finally {
		closeSync(fd);
	}
	const manager = SessionManager.open(file);
	if (mode === "mixed") {
		const id = manager.appendCustomEntry("metadata", {
			index: count,
			nested: { values: [count, count + 1] },
			text: "x".repeat(128),
			// Symbols are dropped by ingress ownership; use a native value that actually survives it.
			liveSchema: new Map([["native", true]]),
		});
		const entry = manager.getEntry(id);
		assert(entry?.type === "custom");
		assert((entry.data as { liveSchema: unknown }).liveSchema instanceof Map);
	}
	const expectedCount = count + (mode === "mixed" ? 1 : 0);
	const history = detachedSessionView(manager);
	const loadedHeap = gc();
	const consume = () => {
		const projection = mode === "projection" ? history.buildSessionProjection() : undefined;
		const entries = projection?.entries ?? history.getEntries();
		if (projection) {
			assert(Object.isFrozen(projection));
			assert(Object.isFrozen(projection.messages));
			assert.equal(projection.messages.length, Math.ceil(count / 1000));
		}
		assert.equal(entries.length, expectedCount);
		assert(Object.isFrozen(entries));
		let visited = 0;
		let sum = 0;
		for (const value of entries) {
			const entry = "sourceEntry" in value ? value.sourceEntry : value;
			if ("sourceEntry" in value) {
				assert(Object.isFrozen(value));
				assert(Object.isFrozen(value.messages));
			}
			visited++;
			assert(Object.isFrozen(entry));
			if (entry.type === "custom") {
				const data = entry.data as { index: number; nested: { values: number[] }; text: string };
				sum += data.index + data.nested.values[1] + data.text.length;
			} else if (entry.type === "message" && entry.message.role === "user") {
				assert(Array.isArray(entry.message.content));
				sum += entry.message.content[0].type === "text" ? entry.message.content[0].text.length : 0;
			}
		}
		assert.equal(visited, expectedCount);
		return sum;
	};
	if (mode === "overflow") {
		// Fitting is determined by charged bytes, not a fixed entry-count cliff.
		// This selection exceeds 64 MiB of conservative wrapper/array charges.
		assert.notEqual(history.getEntries(), history.getEntries());
		assert.notEqual(history.buildSessionProjection(), history.buildSessionProjection());
		const expected = consume();
		assert.equal(consume(), expected);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const retainedBytes = gc() - loadedHeap;
		console.log(`REPORT ${JSON.stringify({ mode, count: expectedCount, retainedBytes, budget: 16 * 1024 * 1024 })}`);
		assert(retainedBytes < 16 * 1024 * 1024, `uncached over-budget selection retained ${retainedBytes} bytes`);
	} else {
		const firstWallStart = performance.now();
		const firstStart = process.cpuUsage();
		const expected = consume();
		const firstCPU = process.cpuUsage(firstStart);
		const firstUs = firstCPU.user + firstCPU.system;
		const firstMs = performance.now() - firstWallStart;
		const repeatWallStart = performance.now();
		const repeatStart = process.cpuUsage();
		for (let i = 0; i < 20; i++) assert.equal(consume(), expected);
		const repeatCPU = process.cpuUsage(repeatStart);
		const repeatUs = repeatCPU.user + repeatCPU.system;
		const repeatMs = performance.now() - repeatWallStart;
		// Idle readers run in separate jobs. A WeakRef-only cache disappears at GC.
		// Exclude forced-GC CPU itself: budget the accessor and full enumeration, not the probe.
		let idleUs = 0;
		let idleMs = 0;
		for (let i = 0; i < 20; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			gc();
			const wallStart = performance.now();
			const start = process.cpuUsage();
			assert.equal(consume(), expected);
			const cpu = process.cpuUsage(start);
			idleUs += cpu.user + cpu.system;
			idleMs += performance.now() - wallStart;
		}
		const heldSelectionBytes = gc() - loadedHeap;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const retainedBytes = gc() - loadedHeap;
		console.log(
			`REPORT ${JSON.stringify({ mode, count: expectedCount, fileBytes: statSync(file).size, firstUs, repeatUs, ratio: repeatUs / firstUs, idleUs, idleRatio: idleUs / firstUs, firstMs, repeatMs, idleMs, loadedHeap, heldSelectionBytes, retainedBytes, budget, consumed: 41 * expectedCount, checksum: expected })}`,
		);
		assert(repeatUs < 3 * firstUs, `20 full enumerations cost ${repeatUs} us; one cost ${firstUs} us`);
		assert(idleUs < 3 * firstUs, `20 enumerations across GC cost ${idleUs} us; one cost ${firstUs} us`);
		assert(repeatMs < 3 * firstMs, `20 full enumerations took ${repeatMs} ms; one took ${firstMs} ms`);
		assert(idleMs < 3 * firstMs, `20 enumerations across GC took ${idleMs} ms; one took ${firstMs} ms`);
		assert(heldSelectionBytes < budget, `live selection retained ${heldSelectionBytes} bytes; budget ${budget}`);
		assert(retainedBytes < budget, `retained ${retainedBytes} bytes; budget ${budget}`);
	}
	assert.equal(manager.getEntryCount(), expectedCount);
	assert.equal(history.getSessionId(), manager.getSessionId());
} finally {
	rmSync(root, { recursive: true, force: true });
}
