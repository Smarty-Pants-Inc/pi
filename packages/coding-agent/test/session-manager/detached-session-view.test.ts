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

// smarty-dev#11897 / pi#289 / pi#291: share owned immutable data, not a second payload history.
// Real-sized retention/dispatch/reuse budgets live in session-history-{memory,large}.test.ts.
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
			expect(entry).toEqual(detached);
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
		const reads = {
			getEntry: () => view.getEntry(id),
			getLeafEntry: () => view.getLeafEntry(),
			getEntries: () => view.getEntries().at(-1),
			getBranch: () => view.getBranch().at(-1),
			getBranchFromId: () => view.getBranch(id).at(-1),
			buildContextEntries: () => view.buildContextEntries().at(-1),
			buildSessionProjection: () => view.buildSessionProjection().entries.at(-1)?.sourceEntry,
			getTree: () => view.getTree()[0].children[0].entry,
		};
		for (const [accessor, read] of Object.entries(reads)) {
			const value = read();
			if (value?.type !== "custom") throw new Error(`missing custom entry through ${accessor}`);
			expect(value, accessor).not.toBe(manager.getEntry(id));
			expect(value, accessor).toEqual(entry);
			const payload = value.data as typeof detached;
			expect(() => {
				value.parentId = "poisoned";
			}, accessor).toThrow(TypeError);
			expect(() => Map.prototype.set.call(payload.map, "poisoned", 2), accessor).toThrow(TypeError);
			expect(() => Set.prototype.add.call(payload.set, 2), accessor).toThrow(TypeError);
			expect(Reflect.set(payload.map, "poisoned", 2), accessor).toBe(false);
			expect(Reflect.set(payload.set, "poisoned", 2), accessor).toBe(false);
			expect(() => payload.nested.values.push(2), accessor).toThrow(TypeError);
			expect(read(), accessor).toEqual(entry);
		}
		for (const array of [view.getEntries(), view.getBranch(), view.buildContextEntries()]) {
			expect(() => {
				array.length = 0;
			}).toThrow(TypeError);
		}
		expect(detachedSessionView(manager).getEntry(id)).toEqual(entry);
		expect(view.getEntries().at(-1)).toEqual(entry);
		expect(SessionManager.open(manager.getSessionFile()!).getEntry(id)).toEqual(entry);
		expect(data.map).toEqual(new Map([["original", 1]]));
		expect(data.set).toEqual(new Set([1]));
		expect(data.nested.values).toEqual([1]);
	});

	it("does not hydrate cold selections or reserialize immutable snapshots", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-detached-lazy-"));
		const manager = SessionManager.create(dir, dir);
		const id = manager.appendMessage({ role: "user", content: "cold ".repeat(200_000), timestamp: 1 });
		for (let i = 0; i < 120; i++) manager.appendCustomEntry("metadata", { i });
		manager.appendCompaction("summary", null, 100);
		expect(isColdEntry(manager.getEntry(id)!)).toBe(true);
		const view = detachedSessionView(manager);
		const serialize = vi.spyOn(JSON, "stringify");
		const branch = view.getBranch();
		const all = view.getEntries();
		const context = view.buildContextEntries();
		expect(branch.length).toBe(manager.getEntryCount());
		expect(all.length).toBe(branch.length);
		expect(context.length).toBeLessThan(branch.length);
		expect(serialize).not.toHaveBeenCalled();
		for (const entries of [branch, all, context]) expect(Object.isFrozen(entries)).toBe(true);
		const first = branch[0];
		expect(first.id).toBe(id);
		expect(serialize).not.toHaveBeenCalled();
		const second = branch[0];
		expect(serialize).not.toHaveBeenCalled();
		expect(first).toBe(second);
		expect(first).toEqual(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(isColdEntry(manager.getEntry(id)!)).toBe(true);
	});

	it("reuses frozen snapshots without duplicating native payloads", () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendMessage({ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 });
		const view = detachedSessionView(manager);
		expect(detachedSessionView(manager)).toBe(view);
		const first = view.getEntries();
		const second = view.getBranch();
		expect(first).not.toBe(second);
		expect(first[0]).not.toBe(second[0]);
		expect(first).toEqual(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(second)).toBe(true);
		expect(view.getEntry(id)).toEqual(first[0]);
		expect(view.getLeafEntry()).toEqual(first[0]);
		expect(view.getEntry("missing")).toBeUndefined();
		const entry = first[0];
		if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) {
			throw new Error("missing message");
		}
		const message = entry.message;
		for (const value of [entry, message, message.content, message.content[0]]) {
			expect(Object.isFrozen(value)).toBe(true);
		}
		expect(() => {
			first.length = 0;
		}).toThrow(TypeError);
		expect(() => {
			entry.parentId = "edited";
		}).toThrow(TypeError);
		expect(() => {
			message.content = [];
		}).toThrow(TypeError);
		expect(view.getEntries()).toEqual(second);
	});

	// pi#132 R4-3 / pi#163: projected content and tree wrappers must never reach native state.
	it("builds frozen trees and edited projections with detached entry values", () => {
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
		for (let i = 0; i < 3; i++) {
			const projection = view.buildSessionProjection();
			expect(projection).toEqual(manager.buildSessionProjection());
			expect(projection.entries.map((entry) => entry.sourceEntry)).toEqual(view.buildContextEntries());
			for (const projected of projection.entries)
				expect(projected.sourceEntry).toEqual(view.getEntry(projected.sourceEntry.id));
			const replacement = view.getEntry(edit);
			if (replacement?.type !== "context_edit" || !replacement.replacement) throw new Error("missing edit");
			expect((projection.messages[0] as { content: unknown }).content).toEqual(replacement.replacement.content);
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
				expect(node.entry).toEqual(entries.find((entry) => entry.id === node.entry.id));
				expect(Object.isFrozen(node)).toBe(true);
				expect(Object.isFrozen(node.children)).toBe(true);
				expect(() => {
					node.label = "edited";
				}).toThrow(TypeError);
				pending.push(...node.children);
			}
		}
		expect(
			JSON.stringify({
				entries: manager.getEntries(),
				projection: manager.buildSessionProjection(),
				revision: manager.revision(),
			}),
		).toBe(before);
		manager.appendLabelChange(user, "changed");
		expect(view.getEntry(user)).toEqual(entries.find((entry) => entry.id === user));
		expect(view.getLabel(user)).toBe("changed");
		expect(view.getTree()[0].children[0].children[0].label).toBe("changed");
		manager.branch(user);
		expect(view.buildSessionProjection()).toEqual(manager.buildSessionProjection());
		expect(view.getBranch(user).at(-1)).toEqual(view.getEntry(user));
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
		expect(view.getEntry(first)).toEqual(cold);
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

	// smarty-dev#14576: only the private native reader's revision is a cache contract.
	it("leaves structural readers lazy and ignores untrusted revision methods", () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const values = [JSON.parse(JSON.stringify(manager.getEntry(id)))];
		const revision = vi.fn(() => 0);
		const source = { ...detachedSessionView(manager), revision, getEntries: () => values };
		const view = detachedSessionView(source);
		expect(view.getEntries()).toHaveLength(1);
		values.push({ ...values[0], id: "second" });
		expect(view.getEntries()).toHaveLength(2);
		expect(revision).not.toHaveBeenCalled();
		const proxy = new Proxy(values[0], {
			ownKeys: () => {
				throw new Error("untrusted descriptor trap");
			},
		});
		const proxyView = detachedSessionView({ ...source, getEntries: () => [proxy] });
		expect(() => proxyView.getEntries()).not.toThrow();
		expect(() => proxyView.getEntries()[0]).toThrow("untrusted descriptor trap");
	});

	it("detaches retained tree wrappers from a structural readonly manager", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const nativeTree = manager.getTree();
		// pi#160: canonical entries are frozen; give the structural source an independent mutable
		// entry so the assertions below still prove wrapping never freezes source entries.
		nativeTree[0].entry = { ...nativeTree[0].entry };
		expect(Object.isFrozen(nativeTree[0].entry)).toBe(false);
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

	// smarty-dev#14576 P2-1/P2-2: every native history route must share only immutable data.
	it("does not reserialize unchanged JSON through any history accessor and invalidates selections", () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomEntry("json", { nested: { values: [1] } });
		const view = detachedSessionView(manager);
		const first = view.getEntries();
		expect(view.getEntries()).toBe(first);
		const serialize = vi.spyOn(JSON, "stringify");
		for (const entry of [
			view.getEntry(id),
			view.getLeafEntry(),
			view.getBranch()[0],
			view.getBranch(id)[0],
			view.getEntries()[0],
			view.buildContextEntries()[0],
			view.getTree()[0].entry,
		]) {
			if (entry?.type !== "custom") throw new Error("missing JSON custom entry");
			expect(Object.isFrozen(entry)).toBe(true);
			const data = entry.data as { nested: { values: number[] } };
			expect(() => data.nested.values.push(2)).toThrow(TypeError);
		}
		const projection = view.buildSessionProjection();
		expect(view.buildSessionProjection()).toBe(projection);
		expect(serialize).not.toHaveBeenCalled();
		serialize.mockRestore();
		const projected = projection.entries[0].sourceEntry;
		if (projected.type !== "custom") throw new Error("missing projected JSON");
		expect(() => (projected.data as { nested: { values: number[] } }).nested.values.push(2)).toThrow(TypeError);
		manager.appendCustomEntry("second", {});
		expect(view.getEntries()).toHaveLength(2);
		expect(first).toHaveLength(1);
		manager.branch(id);
		expect(view.getBranch()).toHaveLength(1);
		manager.resetLeaf();
		expect(view.getBranch()).toEqual([]);
	});

	// pi#291 SEC P2: JavaScript extensions can pass null to select the active leaf.
	it("extends getBranch(null) with appends through the active-branch cache", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("first", { value: 1 });
		const view = detachedSessionView(manager);
		const before = Reflect.apply(view.getBranch, view, [null]);
		expect(before).toEqual(manager.getBranch());
		manager.appendCustomEntry("second", { value: 2 });
		const after = Reflect.apply(view.getBranch, view, [null]);
		expect(after).toEqual(manager.getBranch());
		expect(after).toBe(view.getBranch());
		expect(after).toHaveLength(2);
		expect(after[0]).toBe(before[0]);
		expect(before).toHaveLength(1);
	});

	// pi#291 SEC P2: non-append mutations must also retire the null active-leaf selection.
	it("refreshes getBranch(null) after a branch switch", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendCustomEntry("root", {});
		manager.appendCustomEntry("descendant", {});
		const view = detachedSessionView(manager);
		const before = Reflect.apply(view.getBranch, view, [null]);
		expect(before).toEqual(manager.getBranch());
		manager.branch(root);
		const after = Reflect.apply(view.getBranch, view, [null]);
		expect(after).toEqual(manager.getBranch());
		expect(after).toBe(view.getBranch());
		expect(after).toHaveLength(1);
		expect(before).toHaveLength(2);
	});

	// smarty-dev#14576 P2-2: exercise actual messages and edits while the spy is active.
	it("does not serialize unchanged projected messages or context edits", () => {
		const manager = SessionManager.inMemory();
		const user = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		manager.appendCustomMessageEntry("visible", [{ type: "text", text: "custom" }], true, { nested: [1] });
		manager.appendContextEdit(user, { content: [{ type: "text", text: "edited" }] });
		const view = detachedSessionView(manager);
		const serialize = vi.spyOn(JSON, "stringify");
		const first = view.buildSessionProjection();
		expect(view.buildSessionProjection()).toBe(first);
		expect(first.messages).toHaveLength(2);
		expect((first.messages[0] as { content: unknown }).content).toEqual([{ type: "text", text: "edited" }]);
		expect(serialize).not.toHaveBeenCalled();
	});

	it.each(["reload", "rewrite", "cooling"])("invalidates a cached projection synchronously across %s", (operation) => {
		dir = mkdtempSync(join(tmpdir(), "pi-projection-invalidation-"));
		const manager = SessionManager.create(dir, dir);
		const id = manager.appendMessage({ role: "user", content: "original ".repeat(1_000), timestamp: 1 });
		for (let i = 0; i < 120; i++) manager.appendCustomEntry("old", { i });
		const view = detachedSessionView(manager);
		const before = view.buildSessionProjection();
		expect(view.buildSessionProjection()).toBe(before);
		if (operation === "reload") manager.setSessionFile(manager.getSessionFile()!);
		else if (operation === "rewrite") (manager as unknown as { _rewriteFile(): void })._rewriteFile();
		else manager.appendCompaction("summary", null, 100);
		const after = view.buildSessionProjection();
		expect(after).not.toBe(before);
		expect(after).toEqual(manager.buildSessionProjection());
		expect(view.buildSessionProjection()).toBe(after);
		if (operation === "cooling") expect(isColdEntry(manager.getEntry(id)!)).toBe(true);
	});

	// A shallow frozen keyboard wrapper must not hide an unfrozen nested extension field.
	it("deeply protects JSON children of already sealed keyboard message wrappers", () => {
		const manager = SessionManager.inMemory();
		const id = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const entry = JSON.parse(JSON.stringify(manager.getEntry(id)));
		entry.provenance.channel = "keyboard";
		entry.message.extra = { values: [1] };
		const imported = SessionManager.inMemory("/synthetic", undefined, [manager.getHeader()!, entry]);
		const value = detachedSessionView(imported).getEntry(id);
		if (value?.type !== "message") throw new Error("missing keyboard entry");
		const extra = Reflect.get(value.message, "extra") as { values: number[] };
		expect(Object.isFrozen(extra.values)).toBe(true);
		expect(() => extra.values.push(2)).toThrow(TypeError);
	});

	// smarty-dev#14576 P2-3: never pin an arbitrary unmatched cache key.
	it("does not retain a large unmatched branch id", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("one", {});
		const view = detachedSessionView(manager);
		const missing = "missing".repeat(6_000_000);
		const first = view.getBranch(missing);
		expect(first).toEqual([]);
		expect(view.getBranch(missing)).not.toBe(first);
		const small = view.getBranch("missing");
		expect(view.getBranch("missing")).not.toBe(small);
	});

	it("invalidates cached lists and projections across reload, rewrite and hot-to-cold replacement", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-detached-list-invalidation-"));
		const manager = SessionManager.create(dir, dir);
		const id = manager.appendMessage({ role: "user", content: "original ".repeat(1_000), timestamp: 1 });
		for (let i = 0; i < 120; i++) manager.appendCustomEntry("old", { i });
		const view = detachedSessionView(manager);
		const hot = view.getEntries();
		expect(view.getEntries()).toBe(hot);
		manager.appendCompaction("summary", null, 100);
		const cold = view.getEntries();
		expect(cold).not.toBe(hot);
		expect(cold[0]).toEqual(hot[0]);
		expect(view.getEntries()).toBe(cold);
		expect(isColdEntry(manager.getEntry(id)!)).toBe(true);
		const rewriteProjection = view.buildSessionProjection();
		const beforeRewrite = view.getEntries();
		(manager as unknown as { _rewriteFile(): void })._rewriteFile();
		const rewritten = view.getEntries();
		expect(rewritten).not.toBe(beforeRewrite);
		expect(rewritten).toEqual(beforeRewrite);
		expect(view.buildSessionProjection()).not.toBe(rewriteProjection);
		const beforeReload = view.getEntries();
		expect(view.getEntries()).toBe(beforeReload);
		manager.setSessionFile(manager.getSessionFile()!);
		expect(view.getEntries()).not.toBe(beforeReload);
		const reloadProjection = view.buildSessionProjection();
		manager.setSessionFile(manager.getSessionFile()!);
		expect(view.getEntries()).not.toBe(beforeReload);
		expect(view.getEntries()).toEqual(beforeReload);
		expect(view.buildSessionProjection()).not.toBe(reloadProjection);
		manager.branch(id);
		expect(isColdEntry(manager.getEntry(id)!)).toBe(false);
		expect(view.getEntries()).not.toBe(rewritten);
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
