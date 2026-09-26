// Regression tests for smarty-dev#977: an edit followed by bash in one message saw an empty file.
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	agentLoop,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const fsControl = vi.hoisted(() => ({ failRename: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return {
		...actual,
		rename: async (from: string, to: string) => {
			if (fsControl.failRename) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
			return actual.rename(from, to);
		},
	};
});

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** Run one assistant message holding `toolCalls`, then stop. */
async function runBatch(tools: AgentTool<any>[], toolCalls: AssistantMessage["content"]): Promise<void> {
	const context: AgentContext = { messages: [], tools };
	const prompt: AgentMessage = { role: "user", content: "go", timestamp: Date.now() };
	let call = 0;
	const stream = agentLoop([prompt], context, { model, convertToLlm: (m) => m as never }, undefined, () => {
		const s = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(e) => e.type === "done" || e.type === "error",
			(e) => {
				if (e.type === "done") return e.message;
				throw new Error("unexpected event");
			},
		);
		const message =
			call++ === 0 ? assistant(toolCalls, "toolUse") : assistant([{ type: "text", text: "ok" }], "stop");
		queueMicrotask(() => s.push({ type: "done", reason: message.stopReason as "stop", message }));
		return s;
	});
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
}

describe("edit/write atomic and sequential (smarty-dev#977)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-977-"));
		fsControl.failRename = false;
	});

	afterEach(() => {
		fsControl.failRename = false;
		rmSync(dir, { recursive: true, force: true });
	});

	it("a bash-like call in the same message as edit sees the new content", async () => {
		const file = join(dir, "a.txt");
		writeFileSync(file, "old\n");
		const seen: string[] = [];
		const bashLike: AgentTool<any> = {
			name: "bash",
			label: "bash",
			description: "reads the file",
			parameters: Type.Object({}),
			async execute() {
				seen.push(readFileSync(file, "utf-8"));
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		await runBatch(
			[createEditTool(dir), bashLike],
			[
				{
					type: "toolCall",
					id: "e",
					name: "edit",
					arguments: { path: file, edits: [{ oldText: "old", newText: "new" }] },
				},
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
			],
		);
		expect(seen).toEqual(["new\n"]);
	});

	it("a batch without edit or write still runs in parallel", async () => {
		const file = join(dir, "a.txt");
		writeFileSync(file, "x\n");
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((r) => {
			releaseFirst = r;
		});
		const order: string[] = [];
		const slow: AgentTool<any> = {
			name: "slow",
			label: "slow",
			description: "waits",
			parameters: Type.Object({}),
			async execute() {
				order.push("slow:start");
				await firstBlocked;
				order.push("slow:end");
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const readTool = createReadTool(dir);
		const read: typeof readTool = {
			...readTool,
			async execute(id, params, signal, onUpdate) {
				order.push("read");
				releaseFirst();
				return readTool.execute(id, params, signal, onUpdate);
			},
		};
		await runBatch(
			[slow, read],
			[
				{ type: "toolCall", id: "s", name: "slow", arguments: {} },
				{ type: "toolCall", id: "r", name: "read", arguments: { path: file } },
			],
		);
		expect(order.slice(0, 2)).toEqual(["slow:start", "read"]);
	});

	it("edit and write are marked sequential", () => {
		expect(createEditTool(dir).executionMode).toBe("sequential");
		expect(createWriteTool(dir).executionMode).toBe("sequential");
	});

	it("edit of a large file leaves no temp file and keeps mode 0755", async () => {
		const file = join(dir, "big.sh");
		const body = "line of text\n".repeat(400_000);
		writeFileSync(file, `#!/bin/sh\n${body}`);
		chmodSync(file, 0o755);
		await createEditTool(dir).execute("e", { path: file, edits: [{ oldText: "#!/bin/sh", newText: "#!/bin/bash" }] });
		expect(readFileSync(file, "utf-8")).toBe(`#!/bin/bash\n${body}`);
		expect(statSync(file).mode & 0o777).toBe(0o755);
		expect(readdirSync(dir)).toEqual(["big.sh"]);
	});

	it("write creates a new file and leaves no temp file", async () => {
		const file = join(dir, "sub", "new.txt");
		await createWriteTool(dir).execute("w", { path: file, content: "hello" });
		expect(readFileSync(file, "utf-8")).toBe("hello");
		expect(readdirSync(join(dir, "sub"))).toEqual(["new.txt"]);
	});

	it("a symlink target stays a symlink and the real file gets the content", async () => {
		mkdirSync(join(dir, "real"));
		const real = join(dir, "real", "r.txt");
		const link = join(dir, "link.txt");
		writeFileSync(real, "one\n");
		symlinkSync(real, link);
		await createEditTool(dir).execute("e", { path: link, edits: [{ oldText: "one", newText: "two" }] });
		expect((await fsPromises.lstat(link)).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf-8")).toBe("two\n");
		await createWriteTool(dir).execute("w", { path: link, content: "three\n" });
		expect((await fsPromises.lstat(link)).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf-8")).toBe("three\n");
		expect(readdirSync(join(dir, "real"))).toEqual(["r.txt"]);
	});

	it("a non-regular target is written in place, not replaced (review F1)", async () => {
		const socketPath = join(dir, "s.sock");
		const link = join(dir, "s.link");
		const server = createServer();
		await new Promise<void>((r) => server.listen(socketPath, r));
		symlinkSync(socketPath, link);
		try {
			// fs.writeFile rejects a socket; the old write did the same.
			await expect(createWriteTool(dir).execute("w", { path: socketPath, content: "x" })).rejects.toThrow();
			await expect(createWriteTool(dir).execute("w", { path: link, content: "x" })).rejects.toThrow();
			expect((await fsPromises.lstat(socketPath)).isSocket()).toBe(true);
			expect((await fsPromises.lstat(link)).isSymbolicLink()).toBe(true);
			expect(readdirSync(dir).sort()).toEqual(["s.link", "s.sock"]);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("a filename near the 255-byte limit still works (review F2)", async () => {
		const name = `${"n".repeat(250)}.txt`;
		const file = join(dir, name);
		writeFileSync(file, "a\n");
		await createEditTool(dir).execute("e", { path: file, edits: [{ oldText: "a", newText: "b" }] });
		await createWriteTool(dir).execute("w", { path: file, content: "c\n" });
		expect(readFileSync(file, "utf-8")).toBe("c\n");
		expect(readdirSync(dir)).toEqual([name]);
	});

	it("a failing write leaves the original intact and no temp file", async () => {
		const file = join(dir, "keep.txt");
		writeFileSync(file, "original\n");
		fsControl.failRename = true;
		await expect(
			createEditTool(dir).execute("e", { path: file, edits: [{ oldText: "original", newText: "changed" }] }),
		).rejects.toThrow("injected rename failure");
		await expect(createWriteTool(dir).execute("w", { path: file, content: "changed\n" })).rejects.toThrow(
			"injected rename failure",
		);
		expect(readFileSync(file, "utf-8")).toBe("original\n");
		expect(readdirSync(dir)).toEqual(["keep.txt"]);
	});
});
