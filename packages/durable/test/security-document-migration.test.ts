import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import {
	type CommitPublication,
	createSession,
	defineDoc,
	type JsonObject,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;
const Old = defineDoc<{ name: string }>({
	kind: "security.migration-only",
	version: 1,
	scope: "session",
	initial: () => ({ name: "first" }),
});
const Current = defineDoc<{ names: string[] }>({
	kind: "security.migration-only",
	version: 2,
	scope: "session",
	initial: () => ({ names: [] }),
	migrate: (value, version) => {
		if (version !== 1 || typeof value.name !== "string") throw new Error("Unexpected migration input");
		return { names: [value.name] };
	},
});

// A macrotask boundary drains the real Session/Chord observer queues without waiting for a missing frame.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("document migration publication (smarty-dev#2241 A13)", () => {
	// smarty-dev#2241: use the public Session, definitions, storage, state and watch paths, not a copied transaction.
	it("publishes a migration-only commit, resets older observers, and keeps already-current observers quiet", async () => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		try {
			await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
			const record = (await storage.findDocument(
				{ kind: Old.definition.kind, scope: { kind: "session" } },
				"current",
				context,
			))!;
			const oldState = (await session.documentState(Old, context))!;
			const oldWatch = (await session.watchDoc(Old, context))!;
			const oldStateValues: unknown[] = [];
			oldState.subscribe((value) => {
				oldStateValues.push(value);
			});
			const oldFrames: Array<{ value: unknown; ops: readonly Op[] }> = [];
			oldWatch.start(async (value, ops) => {
				oldFrames.push({ value, ops });
			});

			// New definition acquisition migrates only memory; old observers must not advance until commit.
			const migrated = (await session.snapshot(Current, context))!;
			const currentState = (await session.documentState(Current, context))!;
			const currentWatch = (await session.watchDoc(Current, context))!;
			const currentStateValues: unknown[] = [];
			currentState.subscribe((value) => {
				currentStateValues.push(value);
			});
			const currentFrames: Array<{ value: unknown; ops: readonly Op[] }> = [];
			currentWatch.start(async (value, ops) => {
				currentFrames.push({ value, ops });
			});
			await flush();
			expect((await storage.document(record.id, "current", context))!.version).toBe(1);
			expect(oldState.value).toEqual({ name: "first" });
			expect(oldFrames).toEqual([]);
			expect(currentFrames).toEqual([]);
			expect(oldStateValues).toEqual([{ name: "first" }]);
			expect(currentStateValues).toEqual([migrated]);
			const publications: CommitPublication[] = [];
			session.subscribeCommits((publication) => {
				publications.push(publication);
			});

			// Acquiring the draft, with no additional edit, persists the version transition.
			await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
			await flush();
			expect(await storage.document(record.id, "current", context)).toMatchObject({
				version: 2,
				value: { names: ["first"] },
				deltasSinceBase: 0,
			});
			expect(publications).toHaveLength(1);
			expect(publications[0]!.changes).toEqual([
				expect.objectContaining({ type: "document", record, version: 2, value: migrated, ops: [] }),
			]);
			expect(oldState.value).toBe(migrated);
			expect(oldWatch.value).toBe(migrated);
			expect(oldFrames).toEqual([{ value: migrated, ops: [["r", migrated]] }]);
			expect(currentState.value).toBe(migrated);
			expect(currentWatch.value).toBe(migrated);
			expect(currentFrames).toEqual([]);
			expect(oldStateValues).toEqual([{ name: "first" }, migrated]);
			expect(currentStateValues).toEqual([migrated]);

			// Once version 2 is persisted, an unchanged draft is an actual no-op: no commit or observer frame.
			await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
			await flush();
			expect(publications).toHaveLength(1);
			expect(oldFrames).toHaveLength(1);
			expect(currentFrames).toEqual([]);
			expect(oldStateValues).toHaveLength(2);
			expect(currentStateValues).toHaveLength(1);

			await session.commit(async (tx) => {
				(await tx.doc(Current)).names.push("second");
			}, context);
			await flush();
			const latest = await session.snapshot(Current, context);
			expect(latest).toEqual({ names: ["first", "second"] });
			expect(oldState.value).toBe(latest);
			expect(currentState.value).toBe(latest);
			expect(oldFrames).toHaveLength(2);
			expect(currentFrames).toHaveLength(1);
			expect(oldFrames[1]!.ops).toBe(currentFrames[0]!.ops);
			expect(oldFrames[1]!.ops.length).toBeGreaterThan(0);
			expect(oldFrames[1]!.ops[0]![0]).not.toBe("r");
			expect(oldStateValues).toEqual([{ name: "first" }, migrated, latest]);
			expect(currentStateValues).toEqual([migrated, latest]);

			await session.commit((tx) => tx.retireDoc(Current), context);
			await flush();
			expect(oldFrames).toHaveLength(3);
			expect(currentFrames).toHaveLength(2);
			expect(oldFrames[2]).toEqual({ value: null, ops: [["r", null]] });
			expect(currentFrames[1]).toEqual({ value: null, ops: [["r", null]] });
			expect(oldStateValues).toEqual([{ name: "first" }, migrated, latest, null]);
			expect(currentStateValues).toEqual([migrated, latest, null]);
			expect(oldState.value).toBeNull();
			expect(currentState.value).toBeNull();
			expect(await oldWatch.closed).toEqual({ reason: "retired" });
			expect(await currentWatch.closed).toEqual({ reason: "retired" });
			expect(publications.map((publication) => publication.seq)).toEqual([2, 3, 4]);
			oldState.dispose();
			currentState.dispose();
			await oldWatch.stop();
			await currentWatch.stop();
		} finally {
			await session.close(context);
		}
	});

	it("does not publish or advance old observers when the migration-only callback rolls back", async () => {
		const storage = new MemoryStorage();
		const session = createSession(storage);
		try {
			await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
			const record = (await storage.findDocument(
				{ kind: Old.definition.kind, scope: { kind: "session" } },
				"current",
				context,
			))!;
			const state = (await session.documentState(Old, context))!;
			const watch = (await session.watchDoc(Old, context))!;
			const frames: unknown[] = [];
			watch.start(async (value) => {
				frames.push(value);
			});
			const publications: CommitPublication[] = [];
			session.subscribeCommits((publication) => {
				publications.push(publication);
			});
			await expect(
				session.commit(async (tx) => {
					await tx.doc(Current);
					throw new Error("rollback migration");
				}, context),
			).rejects.toThrow("rollback migration");
			await flush();
			expect((await storage.document(record.id, "current", context))!.version).toBe(1);
			expect(publications).toEqual([]);
			expect(frames).toEqual([]);
			expect(state.value).toEqual({ name: "first" });
			expect(watch.value).toEqual({ name: "first" });

			await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
			await flush();
			expect(publications).toHaveLength(1);
			expect(frames).toEqual([{ names: ["first"] }]);
			expect(state.value).toEqual({ names: ["first"] });
			state.dispose();
			await watch.stop();
		} finally {
			await session.close(context);
		}
	});

	it("keeps current-version empty drafts quiet but still delivers nonempty structural no-ops", async () => {
		const Doc = defineDoc<{ items: string[] }>({
			kind: "security.migration-noop",
			version: 1,
			scope: "session",
			initial: () => ({ items: ["a", "b"] }),
		});
		const session = createSession(new MemoryStorage());
		try {
			await session.commit((tx) => tx.doc(Doc).then(() => undefined), context);
			const watch = (await session.watchDoc(Doc, context))!;
			const initial = watch.value;
			const frames: Array<{ value: Readonly<JsonObject> | null; ops: readonly Op[] }> = [];
			watch.start(async (value, ops) => {
				frames.push({ value, ops });
			});
			const publications: CommitPublication[] = [];
			session.subscribeCommits((publication) => {
				publications.push(publication);
			});
			await session.commit((tx) => tx.doc(Doc).then(() => undefined), context);
			await flush();
			expect(publications).toEqual([]);
			expect(frames).toEqual([]);
			await session.commit(async (tx) => {
				const value = await tx.doc(Doc);
				const first = value.items.shift()!;
				value.items.unshift(first);
			}, context);
			await flush();
			expect(publications).toHaveLength(1);
			expect(frames).toHaveLength(1);
			expect(frames[0]!.value).toEqual(initial);
			expect(frames[0]!.ops.length).toBeGreaterThan(0);
			await watch.stop();
		} finally {
			await session.close(context);
		}
	});
});
