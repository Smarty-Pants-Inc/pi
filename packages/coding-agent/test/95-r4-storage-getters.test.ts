// pi#95 R4 / smarty-dev#2818: caller getters must be materialized before canonical publication.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../src/core/agent-session-runtime.ts";
import { getEntryLocation, isColdEntry } from "../src/core/session-lazy-entries.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

type Field = "data" | "details";
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-95-r4-getters-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

class KeyedMetadata {
	value = "original";
	toJSON(key: string) {
		return { key, value: this.value };
	}
}

function callerMetadata(frozen: boolean) {
	let reads = 0;
	let payload = { value: "original", items: [{ value: "original" }] };
	const child = new KeyedMetadata();
	const buffer = Buffer.from([1, 2, 3]);
	const date = new Date("2026-09-30T12:00:00.000Z");
	const serializer = {
		child,
		toJSON(key: string) {
			// A serializer can relocate children: the child must see "moved", not "child".
			return { key, moved: this.child, buffer, date };
		},
	};
	const value = {
		get payload() {
			reads++;
			return payload;
		},
		get serialized() {
			reads++;
			return serializer;
		},
	};
	return {
		value: frozen ? Object.freeze(value) : value,
		reads: () => reads,
		expected: {
			payload: { value: "original", items: [{ value: "original" }] },
			serialized: {
				key: "serialized",
				moved: { key: "moved", value: "original" },
				buffer: { type: "Buffer", data: [1, 2, 3] },
				date: "2026-09-30T12:00:00.000Z",
			},
		},
		mutate() {
			payload.items[0].value = "changed nested value";
			payload = { value: "changed getter result", items: [] };
			child.value = "changed serializer";
			buffer.fill(9);
			date.setUTCFullYear(2000);
		},
	};
}

function append(manager: SessionManager, field: Field, value: unknown): string {
	return field === "data"
		? manager.appendCustomEntry("r4-getters", value)
		: manager.appendCustomMessageEntry("r4-getters", "custom content", false, value);
}

function metadata(entry: SessionEntry | undefined): unknown {
	if (entry?.type === "custom") return entry.data;
	if (entry?.type === "custom_message" || entry?.type === "compaction" || entry?.type === "branch_summary")
		return entry.details;
	if (entry?.type === "message" && (entry.message.role === "custom" || entry.message.role === "toolResult"))
		return entry.message.details;
	throw new Error("Missing metadata entry");
}

function diskEntry(manager: SessionManager, id: string): SessionEntry | undefined {
	return readFileSync(manager.getSessionFile()!, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionEntry)
		.find((entry) => entry.id === id);
}

function inspect(manager: SessionManager, id: string, expected: unknown): void {
	expect(metadata(manager.getEntry(id))).toEqual(expected);
	expect(metadata(manager.getEntries().find((entry) => entry.id === id))).toEqual(expected);
	expect(metadata(manager.getBranch(id).at(-1))).toEqual(expected);
	const parentId = manager.getEntry(id)!.parentId;
	if (parentId !== null)
		expect(metadata(manager.getChildren(parentId).find((entry) => entry.id === id))).toEqual(expected);
	const stack = [...manager.getTree()];
	while (stack.length) {
		const node = stack.pop()!;
		if (node.entry.id === id) expect(metadata(node.entry)).toEqual(expected);
		stack.push(...node.children);
	}
}

async function withManager(route: "append" | "newSession setup", run: (manager: SessionManager) => void) {
	if (route === "append") {
		run(SessionManager.create(dir, dir));
		return;
	}
	const harness = await createHarness({ persistSession: true });
	let runtime: AgentSessionRuntime | undefined;
	try {
		await harness.session.bindExtensions({});
		const services = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: [],
		});
		runtime = new AgentSessionRuntime(harness.session, services, factory);
		await runtime.newSession({ setup: async (manager) => run(manager) });
	} finally {
		await runtime?.dispose();
		harness.cleanup();
	}
}

describe("pi#95 R4 storage getters (smarty-dev#2818)", () => {
	for (const route of ["append", "newSession setup"] as const) {
		for (const field of ["data", "details"] as const) {
			for (const frozen of [false, true]) {
				it(`${route} ${field} ${frozen ? "frozen" : "mutable"}: inspection captures getters before caller mutation`, async () => {
					await withManager(route, (manager) => {
						manager.appendCustomEntry("parent", 0);
						const input = callerMetadata(frozen);
						const id = append(manager, field, input.value);
						expect.soft(input.reads()).toBe(2);
						const held = manager.getEntry(id);
						const stored = metadata(held) as typeof input.value;
						expect.soft(Object.getOwnPropertyDescriptor(stored, "payload")?.get).toBeUndefined();
						expect(Object.isFrozen(stored)).toBe(frozen);
						expect(existsSync(manager.getSessionFile()!)).toBe(false);
						input.mutate();
						expect(metadata(held)).toEqual(input.expected);
						inspect(manager, id, input.expected);
						expect(metadata(manager.getLeafEntry())).toEqual(input.expected);
						expect(metadata(manager.buildContextEntries().find((entry) => entry.id === id))).toEqual(
							input.expected,
						);
						expect(input.reads()).toBe(2);
						manager.appendMessage(fauxAssistantMessage("flush"));
						expect(metadata(diskEntry(manager, id))).toEqual(input.expected);
						inspect(SessionManager.open(manager.getSessionFile()!, manager.getSessionDir()), id, input.expected);
					});
				});

				it(`${route} ${field} ${frozen ? "frozen" : "mutable"}: first assistant flush handles unread getters`, async () => {
					await withManager(route, (manager) => {
						manager.appendCustomEntry("parent", 0);
						const input = callerMetadata(frozen);
						const id = append(manager, field, input.value);
						input.mutate();
						// No inspection has read metadata before this deferred JSONL flush.
						manager.appendMessage(fauxAssistantMessage("flush unread metadata"));
						expect(metadata(diskEntry(manager, id))).toEqual(input.expected);
						inspect(manager, id, input.expected);
						inspect(SessionManager.open(manager.getSessionFile()!, manager.getSessionDir()), id, input.expected);
						expect(input.reads()).toBe(2);
					});
				});
			}
		}
	}

	for (const field of ["data", "details"] as const) {
		it(`${field}: failing caller getter never publishes an entry`, () => {
			const manager = SessionManager.create(dir, dir);
			const before = manager.appendCustomEntry("before", 1);
			const failure = new Error("caller getter failed");
			expect(() =>
				append(manager, field, {
					get value() {
						throw failure;
					},
				}),
			).toThrow(failure);
			expect(manager.getLeafId()).toBe(before);
			expect(manager.getEntries()).toHaveLength(1);
			expect(existsSync(manager.getSessionFile()!)).toBe(false);
			manager.appendMessage(fauxAssistantMessage("flush after rejected getter"));
			expect(SessionManager.open(manager.getSessionFile()!, dir).getEntries()).toHaveLength(2);
		});

		it(`${field}: a caller-supplied frozen cold view is materialized at admission, not retained as storage laziness`, () => {
			const source = SessionManager.create(dir, dir);
			const id = append(source, field, { items: [{ value: "original" }], padding: "x".repeat(4096) });
			const keep = source.appendMessage(fauxAssistantMessage("flush source"));
			source.appendCompaction("summary", keep, 10);
			for (let i = 0; i < 105; i++) source.appendCustomEntry("padding", i);
			const file = source.getSessionFile()!;
			const caller = Object.freeze(SessionManager.open(file, dir).getEntry(id)!);
			expect(isColdEntry(caller)).toBe(true);
			expect(Object.getOwnPropertyDescriptor(caller, field)?.get).toBeTypeOf("function");
			const expected = diskEntry(source, id);
			const target = SessionManager.create(dir, join(dir, "target"));
			const copiedId = append(target, field, caller);
			const hidden = `${file}.hidden`;
			renameSync(file, hidden);
			try {
				const stored = metadata(target.getEntry(copiedId)) as SessionEntry;
				expect(isColdEntry(stored)).toBe(false);
				expect(Object.getOwnPropertyDescriptor(stored, field)?.get).toBeUndefined();
				expect(stored).toEqual(expected);
				target.appendMessage(fauxAssistantMessage("flush copied view"));
				expect(metadata(diskEntry(target, copiedId))).toEqual(expected);
				expect(metadata(SessionManager.open(target.getSessionFile()!, dir).getEntry(copiedId))).toEqual(expected);
			} finally {
				renameSync(hidden, file);
			}
		});

		for (const freezeSnapshot of [false, true]) {
			it(`${field}: ${freezeSnapshot ? "frozen" : "mutable"} cold snapshots retain lazy, detached mutable values and locations`, () => {
				const manager = SessionManager.create(dir, dir);
				const expected = { items: [{ value: "original" }], padding: "x".repeat(4096) };
				const id = append(manager, field, expected);
				const keep = manager.appendMessage(fauxAssistantMessage("flush"));
				manager.appendCompaction("summary", keep, 10);
				for (let i = 0; i < 105; i++) manager.appendCustomEntry("padding", i);
				const file = manager.getSessionFile()!;
				const reopened = SessionManager.open(file, dir);
				const hidden = `${file}.hidden`;
				renameSync(file, hidden);
				let view: SessionEntry;
				let replaced: SessionEntry;
				try {
					// Tree walks and snapshots must not try to read large metadata off disk.
					view = reopened.getEntry(id)!;
					replaced = reopened.getEntries().find((entry) => entry.id === id)!;
					reopened.getTree();
					reopened.getBranch(id);
					expect(isColdEntry(view)).toBe(true);
					expect(getEntryLocation(view)).toEqual(getEntryLocation(replaced));
					expect(getEntryLocation(view)?.file).toBe(file);
					expect(Object.getOwnPropertyDescriptor(view, field)?.get).toBeTypeOf("function");
					// The setter must replace the lazy field without reading its old value.
					Reflect.set(replaced, field, { replacement: true });
					expect(metadata(replaced)).toEqual({ replacement: true });
					if (freezeSnapshot) Object.freeze(view);
				} finally {
					renameSync(hidden, file);
				}
				const value = metadata(view) as typeof expected;
				expect(value).toEqual(expected);
				expect(metadata(view)).toBe(value);
				value.items[0].value = "snapshot-only mutation";
				expect(metadata(view)).toBe(value);
				expect(metadata(reopened.getEntry(id))).toEqual(expected);
				expect(metadata(diskEntry(reopened, id))).toEqual(expected);
			});
		}
	}

	it("cold message content stays lazy and readable after its snapshot is frozen", () => {
		const manager = SessionManager.create(dir, dir);
		const content = [{ type: "text" as const, text: "x".repeat(4096) }];
		const id = manager.appendMessage({ role: "user", content, timestamp: 1 });
		const keep = manager.appendMessage(fauxAssistantMessage("flush"));
		manager.appendCompaction("summary", keep, 10);
		for (let i = 0; i < 105; i++) manager.appendCustomEntry("padding", i);
		const reopened = SessionManager.open(manager.getSessionFile()!, dir);
		const view = reopened.getEntry(id)!;
		if (view.type !== "message" || view.message.role !== "user") throw new Error("Missing user message");
		expect(isColdEntry(view)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(view.message, "content")?.get).toBeTypeOf("function");
		Object.freeze(view.message);
		Object.freeze(view);
		expect(view.message.content).toEqual(content);
		expect(view.message.content).toBe(view.message.content);
		const value = view.message.content as typeof content;
		value[0].text = "snapshot-only";
		const fresh = reopened.getEntry(id)!;
		expect(fresh.type === "message" && fresh.message.role === "user" && fresh.message.content).toEqual(content);
	});

	for (const route of ["custom message", "tool result", "compaction", "branch summary"] as const) {
		it(`${route}: public append materializes frozen details before mutation`, () => {
			const manager = SessionManager.create(dir, dir);
			const input = callerMetadata(true);
			const id =
				route === "custom message"
					? manager.appendMessage({
							role: "custom",
							customType: "r4-getters",
							content: "custom content",
							display: false,
							details: input.value,
							timestamp: 1,
						})
					: route === "tool result"
						? manager.appendMessage({
								role: "toolResult",
								toolCallId: "tool-call",
								toolName: "offline-test",
								content: [{ type: "text", text: "tool content" }],
								details: Object.freeze({
									get payload() {
										return input.value.payload;
									},
								}),
								isError: false,
								timestamp: 1,
							})
						: route === "compaction"
							? manager.appendCompaction("summary", null, 10, input.value)
							: manager.branchWithSummary(null, "summary", input.value);
			const expected = route === "tool result" ? { payload: input.expected.payload } : input.expected;
			input.mutate();
			expect(metadata(manager.getEntry(id))).toEqual(expected);
			manager.appendMessage(fauxAssistantMessage("flush"));
			expect(metadata(diskEntry(manager, id))).toEqual(expected);
			expect(metadata(SessionManager.open(manager.getSessionFile()!, dir).getEntry(id))).toEqual(expected);
		});
	}
});
