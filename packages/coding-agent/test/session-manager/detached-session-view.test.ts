import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isColdEntry } from "../../src/core/session-lazy-entries.ts";
import { detachedSessionView, SessionManager } from "../../src/core/session-manager.ts";

let dir: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

// pi#163 SEC/Astra P2: repeated reads must copy pointers, not image/history payloads.
// Benchmark: 2,000 entries, 20 x 1 MiB images, 100 getEntries()+getBranch() pairs.
// Node 24.19.0, median of 3 standalone --expose-gc trials, b9357a76 -> per-entry cache:
// including first read: 2849.52 -> 29.60 ms; end heap delta 264.79 -> 53.97 MiB.
// after priming: 2897.04 -> 9.51 ms; end heap delta 149.93 -> 11.54 MiB;
// post-GC retained delta 42.43 -> 0.03 MiB. GC before each batch; end delta is pre-GC,
// and the last entries/branch arrays remain live through post-GC measurement.
// pi#163 post-merge JSON normalization, same fixture/runtime, median of 3 trials, b470cafd -> JSON:
// including first read: 30.54 -> 55.17 ms; end heap delta 55.71 -> 54.01 MiB;
// post-GC retained delta 41.28 -> 40.97 MiB. After priming: 8.48 -> 9.10 ms;
// end heap delta 11.54 -> 11.55 MiB; post-GC retained delta 0.01 -> 0.02 MiB.
describe("detached session snapshots", () => {
	// pi#163 post-merge CODE P2: freezing a non-empty typed array must not break history reads.
	it("returns the persisted JSON form of typed-array custom data on every history route", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-detached-json-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "persist", timestamp: 1 });
		const data = new Uint8Array([1, 255]);
		const id = manager.appendCustomEntry("typed-array", data);
		const view = detachedSessionView(manager);
		const detached = view.getEntry(id);
		if (detached?.type !== "custom") throw new Error("missing custom entry");
		expect(detached.data).toEqual({ "0": 1, "1": 255 });
		expect(Object.getPrototypeOf(detached.data)).toBe(Object.prototype);
		expect(Object.isFrozen(detached.data)).toBe(true);
		for (const entry of [
			view.getLeafEntry(),
			view.getEntries().at(-1),
			view.getBranch().at(-1),
			view.buildContextEntries().at(-1),
			view.buildSessionProjection().entries.at(-1)?.sourceEntry,
			view.getTree()[0].children[0].entry,
		]) {
			expect(entry).toBe(detached);
		}
		expect(SessionManager.open(manager.getSessionFile()!).getEntry(id)).toEqual(detached);
		expect(manager.getEntry(id)?.type).toBe("custom");
		expect(Object.isFrozen(data)).toBe(false);
		expect(data).toEqual(new Uint8Array([1, 255]));
	});

	// pi#163 post-merge SEC P2: Object.freeze alone cannot stop Map/Set prototype mutation.
	it("freezes plain JSON custom data so Map/Set mutation cannot poison later snapshots", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-detached-json-"));
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "persist", timestamp: 1 });
		const data = { map: new Map([["original", 1]]), set: new Set([1]), nested: { values: [1] } };
		const id = manager.appendCustomEntry("collections", data);
		const view = detachedSessionView(manager);
		const entry = view.getEntry(id);
		if (entry?.type !== "custom") throw new Error("missing custom entry");
		const detached = entry.data as {
			map: Record<string, unknown>;
			set: Record<string, unknown>;
			nested: { values: number[] };
		};
		expect(detached).toEqual({ map: {}, set: {}, nested: { values: [1] } });
		for (const value of [entry, detached, detached.map, detached.set, detached.nested, detached.nested.values]) {
			expect(Object.isFrozen(value)).toBe(true);
		}
		for (const value of [detached, detached.map, detached.set, detached.nested]) {
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		}
		expect(() => Map.prototype.set.call(detached.map, "poisoned", 2)).toThrow(TypeError);
		expect(() => Set.prototype.add.call(detached.set, 2)).toThrow(TypeError);
		expect(Reflect.set(detached.map, "poisoned", 2)).toBe(false);
		expect(Reflect.set(detached.set, "poisoned", 2)).toBe(false);
		expect(() => detached.nested.values.push(2)).toThrow(TypeError);
		expect(detachedSessionView(manager).getEntry(id)).toBe(entry);
		expect(view.getEntries().at(-1)).toBe(entry);
		expect(SessionManager.open(manager.getSessionFile()!).getEntry(id)).toEqual(entry);
		expect(data.map).toEqual(new Map([["original", 1]]));
		expect(data.set).toEqual(new Set([1]));
		expect(data.nested.values).toEqual([1]);
	});

	it("JSON-round-trips each native entry once and freezes fresh pointer arrays", () => {
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 2_000; i++) {
			manager.appendMessage({
				role: "user",
				content:
					i % 100 === 0
						? [
								{
									type: "image",
									mimeType: "image/png",
									data: String.fromCharCode(65 + i / 100).repeat(1_048_576),
								},
							]
						: [{ type: "text", text: `entry ${i}` }],
				timestamp: i,
			});
		}
		const view = detachedSessionView(manager);
		expect(detachedSessionView(manager)).toBe(view);
		const serialize = vi.spyOn(JSON, "stringify");
		const parse = vi.spyOn(JSON, "parse");
		const first = view.getEntries();
		expect(serialize).toHaveBeenCalledTimes(2_000);
		expect(parse).toHaveBeenCalledTimes(2_000);
		for (let i = 0; i < 100; i++) {
			const entries = view.getEntries();
			const branch = view.getBranch();
			expect(entries).not.toBe(first);
			expect(branch).not.toBe(entries);
			expect(Object.isFrozen(entries)).toBe(true);
			expect(Object.isFrozen(branch)).toBe(true);
			for (let j = 0; j < first.length; j++) {
				expect(entries[j]).toBe(first[j]);
				expect(branch[j]).toBe(first[j]);
			}
		}
		expect(serialize).toHaveBeenCalledTimes(2_000);
		expect(parse).toHaveBeenCalledTimes(2_000);
		const id = manager.appendMessage({ role: "user", content: "new", timestamp: 2_001 });
		// Native receipt sealing also round-trips JSON; count only the subsequent detached reads.
		serialize.mockClear();
		parse.mockClear();
		expect(view.getEntry(id)).toBe(view.getEntries().at(-1));
		expect(view.getLeafEntry()).toBe(view.getBranch().at(-1));
		expect(view.getEntry("missing")).toBeUndefined();
		expect(serialize).toHaveBeenCalledTimes(1);
		expect(parse).toHaveBeenCalledTimes(1);
		expect(serialize.mock.calls.every(([entry]) => !Array.isArray(entry))).toBe(true);
		const image = first[0];
		if (image.type !== "message" || image.message.role !== "user" || !Array.isArray(image.message.content)) {
			throw new Error("missing image fixture");
		}
		expect(Object.isFrozen(image)).toBe(true);
		expect(Object.isFrozen(image.message)).toBe(true);
		expect(Object.isFrozen(image.message.content)).toBe(true);
		expect(Object.isFrozen(image.message.content[0])).toBe(true);
		expect(() => {
			first.length = 0;
		}).toThrow(TypeError);
		expect(() => {
			image.parentId = "edited";
		}).toThrow(TypeError);
		const message = image.message;
		expect(() => {
			message.content = "edited";
		}).toThrow(TypeError);
	});

	// pi#132 R4-3 / pi#163: projected content and tree wrappers must never reach native state.
	it("builds frozen trees and edited projections from the same detached entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("faux", "model");
		manager.appendThinkingLevelChange("high");
		const user = manager.appendMessage({ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 });
		manager.appendCustomMessageEntry("visible", [{ type: "text", text: "custom" }], true, { nested: [1] });
		const edit = manager.appendContextEdit(user, { content: [{ type: "text", text: "replacement" }] });
		manager.appendLabelChange(user, "bookmark");
		const view = detachedSessionView(manager);
		const entries = view.getEntries();
		const before = JSON.stringify({
			entries: manager.getEntries(),
			projection: manager.buildSessionProjection(),
			revision: manager.revision(),
		});
		const serialize = vi.spyOn(JSON, "stringify");
		const parse = vi.spyOn(JSON, "parse");
		for (let i = 0; i < 3; i++) {
			const projection = view.buildSessionProjection();
			expect(projection).toEqual(manager.buildSessionProjection());
			expect(projection.entries.map((entry) => entry.sourceEntry)).toEqual(view.buildContextEntries());
			for (const projected of projection.entries)
				expect(projected.sourceEntry).toBe(view.getEntry(projected.sourceEntry.id));
			const replacement = view.getEntry(edit);
			if (replacement?.type !== "context_edit" || !replacement.replacement) throw new Error("missing edit");
			expect((projection.messages[0] as { content: unknown }).content).toBe(replacement.replacement.content);
			expect(Object.isFrozen(projection)).toBe(true);
			expect(() => {
				projection.messages.length = 0;
			}).toThrow(TypeError);
			expect(() => {
				projection.model!.modelId = "edited";
			}).toThrow(TypeError);
			const tree = view.getTree();
			expect(tree).toEqual(manager.getTree());
			const pending = [...tree];
			while (pending.length) {
				const node = pending.pop()!;
				expect(node.entry).toBe(entries.find((entry) => entry.id === node.entry.id));
				expect(Object.isFrozen(node)).toBe(true);
				expect(Object.isFrozen(node.children)).toBe(true);
				expect(() => {
					node.label = "edited";
				}).toThrow(TypeError);
				pending.push(...node.children);
			}
		}
		expect(serialize).not.toHaveBeenCalled();
		expect(parse).not.toHaveBeenCalled();
		expect(
			JSON.stringify({
				entries: manager.getEntries(),
				projection: manager.buildSessionProjection(),
				revision: manager.revision(),
			}),
		).toBe(before);
		manager.appendLabelChange(user, "changed");
		expect(view.getEntry(user)).toBe(entries.find((entry) => entry.id === user));
		expect(view.getLabel(user)).toBe("changed");
		expect(view.getTree()[0].children[0].children[0].label).toBe("changed");
		manager.branch(user);
		expect(view.buildSessionProjection()).toEqual(manager.buildSessionProjection());
		expect(view.getBranch(user).at(-1)).toBe(view.getEntry(user));
		manager.resetLeaf();
		expect(view.buildSessionProjection()).toEqual(manager.buildSessionProjection());
		expect(view.getLeafEntry()).toBeUndefined();
	});

	it("preserves compaction projection semantics and freezes small header copies", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "system", toolsAdded: [], timestamp: 0 });
		manager.appendMessage({ role: "user", content: "summarized", timestamp: 1 });
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		manager.appendCompaction("first summary", kept, 100, { nested: [1] });
		manager.appendCompaction("second summary", kept, 100);
		manager.appendContextEdit(kept, { content: "edited" });
		const view = detachedSessionView(manager);
		expect(view.buildContextEntries()).toEqual(manager.buildContextEntries());
		expect(view.buildSessionProjection()).toEqual(manager.buildSessionProjection());
		const header = view.getHeader()!;
		expect(header).not.toBe(manager.getHeader());
		expect(Object.isFrozen(header)).toBe(true);
		expect(() => {
			header.cwd = "edited";
		}).toThrow(TypeError);
		for (const name of [
			"getCwd",
			"getSessionDir",
			"getSessionId",
			"getSessionFile",
			"getLeafId",
			"getSessionName",
		] as const) {
			expect(view[name]()).toBe(manager[name]());
		}
	});

	it("refreshes snapshots on cold/hot replacement, reload, fork and new session", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-detached-replacement-"));
		const manager = SessionManager.create(dir, dir);
		const first = manager.appendMessage({ role: "user", content: "original ".repeat(1_000), timestamp: 1 });
		const view = detachedSessionView(manager);
		const original = view.getEntry(first);
		for (let i = 0; i < 120; i++) manager.appendCustomEntry("old", { i });
		manager.appendCompaction("summary", null, 100);
		expect(isColdEntry(manager.getEntry(first)!)).toBe(true);
		const cold = view.getEntry(first);
		expect(cold).not.toBe(original);
		expect(cold).toEqual(original);
		expect(view.getEntry(first)).toBe(cold);
		manager.branch(first);
		expect(isColdEntry(manager.getEntry(first)!)).toBe(false);
		const hot = view.getEntry(first);
		expect(hot).not.toBe(cold);
		expect(hot).toEqual(cold);
		const file = manager.getSessionFile()!;
		const bytes = readFileSync(file);
		manager.setSessionFile(file);
		expect(view.getEntry(first)).not.toBe(hot);
		expect(view.getEntry(first)).toEqual(hot);
		expect(readFileSync(file)).toEqual(bytes);
		const prior = view.getEntry(first);
		manager.createBranchedSession(first);
		expect(view.getEntry(first)).not.toBe(prior);
		expect(view.getEntry(first)).toEqual(prior);
		manager.newSession();
		expect(view.getEntries()).toEqual([]);
		expect(view.getEntry(first)).toBeUndefined();
	});

	it("detaches retained tree wrappers from a structural readonly manager", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const nativeTree = manager.getTree();
		const source = { ...detachedSessionView(manager), getTree: () => nativeTree };
		const tree = detachedSessionView(source).getTree();
		expect(tree).not.toBe(nativeTree);
		expect(tree[0]).not.toBe(nativeTree[0]);
		expect(tree[0].entry).not.toBe(nativeTree[0].entry);
		expect(tree[0].children).not.toBe(nativeTree[0].children);
		expect(Object.isFrozen(nativeTree[0])).toBe(false);
		expect(Object.isFrozen(nativeTree[0].entry)).toBe(false);
		nativeTree[0].label = "native change";
		expect(tree[0].label).toBeUndefined();
		expect(detachedSessionView(source).getTree()[0].label).toBe("native change");
	});

	// pi#163: in-memory-only cycles are not persistable JSON and must not get a different wire form.
	it("rejects cyclic data like persistence without freezing native objects", () => {
		const data: { values: number[]; self?: unknown } = { values: [1] };
		data.self = data;
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomEntry("cycle", data);
		expect(() => JSON.stringify(manager.getEntry(id))).toThrow(TypeError);
		expect(() => detachedSessionView(manager).getEntry(id)).toThrow(TypeError);
		expect(Object.isFrozen(data)).toBe(false);
		expect(Object.isFrozen(data.values)).toBe(false);
		expect(data.self).toBe(data);
		expect(data.values).toEqual([1]);
	});

	it("freezes deep trees without recursive stack growth", () => {
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 10_000; i++) manager.appendCustomEntry("deep", { i });
		const tree = detachedSessionView(manager).getTree();
		let count = 0;
		let node = tree[0];
		while (node) {
			expect(Object.isFrozen(node)).toBe(true);
			count++;
			node = node.children[0];
		}
		expect(count).toBe(10_000);
	});
});
