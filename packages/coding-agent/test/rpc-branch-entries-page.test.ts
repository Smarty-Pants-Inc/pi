import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

const BRANCH_PAGE_SERIALIZED_RESPONSE_TARGET_BYTES = 32 * 1024 * 1024;

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			if (rpcIo.lineHandler === onLine) {
				rpcIo.lineHandler = undefined;
			}
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Array<{ signal: NodeJS.Signals; listeners: NodeListener[] }>;
};

type PageData = {
	entries: Array<{ id: string; timestamp: string }>;
	leafId: string | null;
	nextCursor?: string;
	complete: boolean;
};

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: signals.map((signal) => ({ signal, listeners: process.listeners(signal) as NodeListener[] })),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const { signal, listeners } of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!listeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function getResponse(id: string): Record<string, unknown> {
	const response = rpcIo.outputLines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.find((record) => record.type === "response" && record.id === id);
	if (!response) {
		throw new Error(`Missing response: ${id}`);
	}
	return response;
}

async function requestBranchEntriesPage(
	lineHandler: (line: string) => void,
	id: string,
	request: { limit: number; before?: string; leafId?: string },
): Promise<PageData> {
	lineHandler(JSON.stringify({ id, type: "get_branch_entries_page", ...request }));
	await vi.waitFor(() => expect(getResponse(id).success).toBe(true));
	return getResponse(id).data as PageData;
}

async function startRpcMode(harness: Harness): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => void;
}> {
	const listenerSnapshot = takeListenerSnapshot();
	void runRpcMode(createRuntimeHost(harness));
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		cleanup: () => {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		},
	};
}

describe("get_branch_entries_page", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("pages a same-timestamp branch snapshot backwards in chronological order", async () => {
		const harness = await createHarness();
		vi.useFakeTimers();
		let rootId: string;
		let abandonedLeafId: string;
		let currentFirstId: string;
		let currentLeafId: string;
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "abandoned first", timestamp: 2 });
			abandonedLeafId = harness.sessionManager.appendMessage({
				role: "user",
				content: "abandoned leaf",
				timestamp: 3,
			});
			harness.sessionManager.branch(rootId);
			currentFirstId = harness.sessionManager.appendMessage({
				role: "user",
				content: "current first",
				timestamp: 4,
			});
			currentLeafId = harness.sessionManager.appendMessage({ role: "user", content: "current leaf", timestamp: 5 });
		} finally {
			vi.useRealTimers();
		}

		expect(new Set(harness.sessionManager.getEntries().map((entry) => entry.timestamp)).size).toBe(1);
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "first", type: "get_branch_entries_page", limit: 2 }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));

			const first = getResponse("first");
			expect(first.success).toBe(true);
			const firstData = first.data as PageData;
			expect(firstData.entries.map((entry) => entry.id)).toEqual([currentFirstId, currentLeafId]);
			expect(firstData.leafId).toBe(currentLeafId);
			expect(firstData.nextCursor).toBe(currentFirstId);
			expect(firstData.complete).toBe(false);

			harness.sessionManager.branch(abandonedLeafId);
			lineHandler(
				JSON.stringify({
					id: "second",
					type: "get_branch_entries_page",
					limit: 2,
					before: firstData.nextCursor,
					leafId: firstData.leafId,
				}),
			);
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(2));

			const second = getResponse("second");
			expect(second.success).toBe(true);
			const secondData = second.data as PageData;
			expect(secondData.entries.map((entry) => entry.id)).toEqual([rootId]);
			expect(secondData.leafId).toBe(currentLeafId);
			expect(secondData).not.toHaveProperty("nextCursor");
			expect(secondData.complete).toBe(true);

			lineHandler(
				JSON.stringify({
					id: "foreign-cursor",
					type: "get_branch_entries_page",
					limit: 1,
					before: abandonedLeafId,
					leafId: currentLeafId,
				}),
			);
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(3));
			expect(getResponse("foreign-cursor")).toMatchObject({
				success: false,
				error: `Cursor not found in branch: ${abandonedLeafId}`,
			});
		} finally {
			cleanup();
		}
	});

	it("walks long branches in bounded work with issued cursors", async () => {
		const harness = await createHarness();
		const entryIds: string[] = [];
		for (let index = 0; index < 4096; index++) {
			entryIds.push(
				harness.sessionManager.appendMessage({ role: "user", content: `entry ${index}`, timestamp: index }),
			);
		}
		const getBranch = vi.spyOn(harness.sessionManager, "getBranch");
		const getEntry = vi.spyOn(harness.sessionManager, "getEntry");
		const { lineHandler, cleanup } = await startRpcMode(harness);
		getBranch.mockClear();
		getEntry.mockClear();

		try {
			let before: string | undefined;
			let leafId: string | undefined;
			for (let index = 0; index < 64; index++) {
				const id = `page-${index}`;
				lineHandler(
					JSON.stringify(
						before === undefined
							? { id, type: "get_branch_entries_page", limit: 1 }
							: { id, type: "get_branch_entries_page", limit: 1, before, leafId },
					),
				);
				await vi.waitFor(() => expect(getResponse(id).success).toBe(true));

				const page = getResponse(id).data as PageData;
				expect(page.entries.map((entry) => entry.id)).toEqual([entryIds[entryIds.length - index - 1]]);
				if (index < 63) {
					if (!page.nextCursor || page.leafId === null) {
						throw new Error("Expected a cursor for the next long-branch page");
					}
					before = page.nextCursor;
					leafId = page.leafId;
				}
			}

			expect(getBranch).not.toHaveBeenCalled();
			expect(getEntry.mock.calls.length).toBeLessThan(200);
		} finally {
			getBranch.mockRestore();
			getEntry.mockRestore();
			cleanup();
		}
	});

	it("keeps aggregate pages below the serialized response target", async () => {
		const harness = await createHarness();
		const entryIds: string[] = [];
		const content = "x".repeat(4 * 1024 * 1024);
		for (let index = 0; index < 9; index++) {
			entryIds.push(harness.sessionManager.appendMessage({ role: "user", content, timestamp: index }));
		}
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "aggregate", type: "get_branch_entries_page", limit: 256 }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));
			expect(Buffer.byteLength(rpcIo.outputLines[0]!)).toBeLessThanOrEqual(
				BRANCH_PAGE_SERIALIZED_RESPONSE_TARGET_BYTES,
			);

			let leafId: string | null;
			let nextCursor: string | undefined;
			{
				const page = getResponse("aggregate").data as PageData;
				expect(page.entries.map((entry) => entry.id)).toEqual(entryIds.slice(2));
				expect(page.complete).toBe(false);
				leafId = page.leafId;
				nextCursor = page.nextCursor;
			}
			expect(nextCursor).toBe(entryIds[2]);
			if (!nextCursor || leafId === null) {
				throw new Error("Expected a cursor for the remaining aggregate page");
			}

			rpcIo.outputLines = [];
			const finalPage = await requestBranchEntriesPage(lineHandler, "aggregate-final", {
				limit: 256,
				before: nextCursor,
				leafId,
			});
			expect(finalPage.entries.map((entry) => entry.id)).toEqual(entryIds.slice(0, 2));
			expect(finalPage.complete).toBe(true);
			expect(finalPage).not.toHaveProperty("nextCursor");
		} finally {
			cleanup();
		}
	});

	it("returns a small error for a branch entry over the serialized response target", async () => {
		const harness = await createHarness();
		harness.sessionManager.appendMessage({
			role: "user",
			content: "x".repeat(BRANCH_PAGE_SERIALIZED_RESPONSE_TARGET_BYTES),
			timestamp: 1,
		});
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "oversized", type: "get_branch_entries_page", limit: 1 }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));
			expect(Buffer.byteLength(rpcIo.outputLines[0]!)).toBeLessThan(1024);
			expect(getResponse("oversized")).toMatchObject({
				success: false,
				error: "Branch entry exceeds the 32 MiB serialized response target",
			});
			expect(getResponse("oversized")).not.toHaveProperty("data");
		} finally {
			cleanup();
		}
	});

	it("releases issued cursor state after a completed branch drain", async () => {
		const harness = await createHarness();
		harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 0 });
		for (let index = 1; index <= 16; index++) {
			harness.sessionManager.appendMessage({ role: "user", content: `entry ${index}`, timestamp: index });
		}
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "leaf", timestamp: 17 });
		const { lineHandler, cleanup } = await startRpcMode(harness);
		const getEntry = vi.spyOn(harness.sessionManager, "getEntry");
		try {
			const firstPage = await requestBranchEntriesPage(lineHandler, "release-first", { limit: 6, leafId });
			if (!firstPage.nextCursor) {
				throw new Error("Expected an issued branch cursor");
			}
			const completedPage = await requestBranchEntriesPage(lineHandler, "release-complete", {
				limit: 256,
				before: firstPage.nextCursor,
				leafId,
			});
			expect(completedPage.complete).toBe(true);

			getEntry.mockClear();
			await requestBranchEntriesPage(lineHandler, "release-validate", {
				limit: 1,
				before: firstPage.nextCursor,
				leafId,
			});
			expect(getEntry.mock.calls.length).toBeGreaterThan(3);
		} finally {
			getEntry.mockRestore();
			cleanup();
		}
	});

	it("evicts the oldest abandoned leaf cursor state after 32 leaves", async () => {
		const harness = await createHarness();
		let branchPoint = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 0 });
		for (let index = 1; index <= 16; index++) {
			branchPoint = harness.sessionManager.appendMessage({
				role: "user",
				content: `entry ${index}`,
				timestamp: index,
			});
		}
		const leafIds: string[] = [];
		for (let index = 0; index < 33; index++) {
			harness.sessionManager.branch(branchPoint);
			leafIds.push(
				harness.sessionManager.appendMessage({ role: "user", content: `leaf ${index}`, timestamp: index + 17 }),
			);
		}

		const { lineHandler, cleanup } = await startRpcMode(harness);
		const getEntry = vi.spyOn(harness.sessionManager, "getEntry");
		try {
			const issuedCursors: Array<{ leafId: string; cursor: string }> = [];
			for (let index = 0; index < leafIds.length; index++) {
				const leafId = leafIds[index]!;
				const page = await requestBranchEntriesPage(lineHandler, `issued-${index}`, { limit: 6, leafId });
				if (!page.nextCursor) {
					throw new Error("Expected an abandoned branch cursor");
				}
				issuedCursors.push({ leafId, cursor: page.nextCursor });
			}

			const newest = issuedCursors.at(-1)!;
			getEntry.mockClear();
			await requestBranchEntriesPage(lineHandler, "lru-newest", {
				limit: 1,
				before: newest.cursor,
				leafId: newest.leafId,
			});
			expect(getEntry.mock.calls.length).toBe(3);

			getEntry.mockClear();
			const oldest = issuedCursors[0]!;
			await requestBranchEntriesPage(lineHandler, "lru-oldest", {
				limit: 1,
				before: oldest.cursor,
				leafId: oldest.leafId,
			});
			expect(getEntry.mock.calls.length).toBeGreaterThan(3);
		} finally {
			getEntry.mockRestore();
			cleanup();
		}
	});

	it("rejects invalid limits and unknown leaf or cursor IDs", async () => {
		const harness = await createHarness();
		harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "leaf", timestamp: 2 });
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "zero", type: "get_branch_entries_page", limit: 0 }));
			lineHandler(JSON.stringify({ id: "fraction", type: "get_branch_entries_page", limit: 1.5 }));
			lineHandler(JSON.stringify({ id: "unsafe", type: "get_branch_entries_page", limit: 9007199254740992 }));
			lineHandler(JSON.stringify({ id: "too-large", type: "get_branch_entries_page", limit: 257 }));
			lineHandler(JSON.stringify({ id: "leaf", type: "get_branch_entries_page", limit: 1, leafId: "missing" }));
			lineHandler(
				JSON.stringify({ id: "cursor", type: "get_branch_entries_page", limit: 1, leafId, before: "missing" }),
			);
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(6));

			for (const id of ["zero", "fraction", "unsafe", "too-large"]) {
				const response = getResponse(id);
				expect(response).toMatchObject({
					id,
					command: "get_branch_entries_page",
					success: false,
					error: "limit must be a safe integer between 1 and 256",
				});
			}
			expect(getResponse("leaf")).toMatchObject({ success: false, error: "Leaf not found: missing" });
			expect(getResponse("cursor")).toMatchObject({ success: false, error: "Cursor not found in branch: missing" });
		} finally {
			cleanup();
		}
	});

	it("rejects a self-parent cycle while building an initial page", async () => {
		const harness = await createHarness();
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "self", timestamp: 1 });
		const leaf = harness.sessionManager.getEntry(leafId);
		if (!leaf) {
			throw new Error("Expected the page leaf");
		}
		leaf.parentId = leafId;
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "self-cycle", type: "get_branch_entries_page", limit: 1, leafId }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));
			expect(getResponse("self-cycle")).toMatchObject({
				success: false,
				error: "Session branch contains a parent cycle",
			});
		} finally {
			cleanup();
		}
	});

	it("rejects a parent cycle while walking an initial page", async () => {
		const harness = await createHarness();
		const rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "leaf", timestamp: 2 });
		const root = harness.sessionManager.getEntry(rootId);
		if (!root) {
			throw new Error("Expected the page root");
		}
		root.parentId = leafId;
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "initial-cycle", type: "get_branch_entries_page", limit: 3, leafId }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));
			expect(getResponse("initial-cycle")).toMatchObject({
				success: false,
				error: "Session branch contains a parent cycle",
			});
		} finally {
			cleanup();
		}
	});

	it("rejects a parent cycle across issued page cursors", async () => {
		const harness = await createHarness();
		const aId = harness.sessionManager.appendMessage({ role: "user", content: "A", timestamp: 1 });
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "B", timestamp: 2 });
		const a = harness.sessionManager.getEntry(aId);
		if (!a) {
			throw new Error("Expected cycle entry A");
		}
		a.parentId = leafId;
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			const firstPage = await requestBranchEntriesPage(lineHandler, "cycle-first", { limit: 1, leafId });
			expect(firstPage.entries.map((entry) => entry.id)).toEqual([leafId]);
			if (!firstPage.nextCursor) {
				throw new Error("Expected first cycle cursor");
			}

			const secondPage = await requestBranchEntriesPage(lineHandler, "cycle-second", {
				limit: 1,
				before: firstPage.nextCursor,
				leafId,
			});
			expect(secondPage.entries.map((entry) => entry.id)).toEqual([aId]);
			if (!secondPage.nextCursor) {
				throw new Error("Expected second cycle cursor");
			}

			lineHandler(
				JSON.stringify({
					id: "cycle-third",
					type: "get_branch_entries_page",
					limit: 1,
					before: secondPage.nextCursor,
					leafId,
				}),
			);
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(3));
			expect(getResponse("cycle-third")).toMatchObject({
				success: false,
				error: "Session branch contains a parent cycle",
			});
		} finally {
			cleanup();
		}
	});
	it("rejects a parent cycle while validating a cursor ancestry", async () => {
		const harness = await createHarness();
		const rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const leafId = harness.sessionManager.appendMessage({ role: "user", content: "leaf", timestamp: 2 });
		const cursorId = harness.sessionManager.appendMessage({ role: "user", content: "cursor", timestamp: 3 });
		const root = harness.sessionManager.getEntry(rootId);
		if (!root) {
			throw new Error("Expected the page root");
		}
		root.parentId = leafId;
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(
				JSON.stringify({
					id: "ancestry-cycle",
					type: "get_branch_entries_page",
					limit: 1,
					leafId,
					before: cursorId,
				}),
			);
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));
			expect(getResponse("ancestry-cycle")).toMatchObject({
				success: false,
				error: "Session branch contains a parent cycle",
			});
		} finally {
			cleanup();
		}
	});

	it("returns a complete empty page for an empty session", async () => {
		const harness = await createHarness();
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "empty", type: "get_branch_entries_page", limit: 1 }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));

			expect(getResponse("empty")).toEqual({
				id: "empty",
				type: "response",
				command: "get_branch_entries_page",
				success: true,
				data: { entries: [], leafId: null, complete: true },
			});
		} finally {
			cleanup();
		}
	});

	it("marks an exact-limit page ending at the root complete", async () => {
		const harness = await createHarness();
		const rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const { lineHandler, cleanup } = await startRpcMode(harness);
		try {
			lineHandler(JSON.stringify({ id: "root", type: "get_branch_entries_page", limit: 1 }));
			await vi.waitFor(() => expect(rpcIo.outputLines).toHaveLength(1));

			const page = getResponse("root").data as PageData;
			expect(page.entries.map((entry) => entry.id)).toEqual([rootId]);
			expect(page.complete).toBe(true);
			expect(page).not.toHaveProperty("nextCursor");
		} finally {
			cleanup();
		}
	});

	it("sends the explicit branch page request from RpcClient", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_branch_entries_page",
			success: true,
			data: { entries: [], leafId: "leaf", complete: true },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			const responseWithData = response as { data: T };
			return responseWithData.data;
		};

		const result = await client.getBranchEntriesPage({ limit: 12, before: "cursor", leafId: "leaf" });

		expect(send).toHaveBeenCalledWith({
			type: "get_branch_entries_page",
			limit: 12,
			before: "cursor",
			leafId: "leaf",
		});
		expect(result).toEqual({ entries: [], leafId: "leaf", complete: true });
	});
});
