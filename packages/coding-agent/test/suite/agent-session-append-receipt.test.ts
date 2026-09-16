import * as fs from "fs";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("fs", async (original) => {
	const actual = await original<typeof fs>();
	return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

describe("ordinary extension user append receipts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => { for (const harness of harnesses.splice(0)) harness.cleanup(); });

	it("returns this first user's file receipt before provider completion, not a foreign equal-text entry", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => SessionManager.create(directory, directory),
			extensionFactories: [(pi) => { api = pi; }],
		});
		harnesses.push(harness);
		const { session, sessionManager } = harness;
		const foreign = sessionManager.appendMessage({ role: "user", content: "equal", timestamp: 1 });
		const sessionId = session.sessionId;
		const pid = process.pid;
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		harness.setResponses([async () => { await held; return fauxAssistantMessage("done"); }]);
		try {
			expect(existsSync(session.sessionFile!)).toBe(false);
			const receipt = await api.sendUserMessageWithReceipt("equal");
			expect(receipt).toMatchObject({ status: "appended", sessionId, parentId: foreign, contentChanged: false });
			if (receipt.status !== "appended") throw new Error("Expected a real append");
			expect(receipt.entryId).not.toBe(foreign);
			const bytes = readFileSync(receipt.sessionFile!, "utf8");
			const entries = bytes.trim().split("\n").map((line) => JSON.parse(line));
			expect(entries.find((entry) => entry.id === receipt.entryId)).toEqual(sessionManager.getEntry(receipt.entryId));
			expect(entries.some((entry) => entry.message?.role === "assistant")).toBe(false);
			expect(session.sessionId).toBe(sessionId);
			expect(process.pid).toBe(pid);
		} finally { release(); await session.waitForIdle(); }
	});

	it("does not erase a successful append when the provider later fails", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => SessionManager.create(directory, directory),
			settings: { retry: { enabled: false } },
			extensionFactories: [(pi) => { api = pi; }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic provider failure" })]);
		const receipt = await api.sendUserMessageWithReceipt("saved before provider");
		await harness.session.waitForIdle();
		expect(receipt.status).toBe("appended");
		if (receipt.status !== "appended") throw new Error("Expected append");
		expect(readFileSync(receipt.sessionFile!, "utf8")).toContain(`"id":"${receipt.entryId}"`);
		expect(harness.sessionManager.getEntry(receipt.entryId)).toBeDefined();
		expect(harness.session.messages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(true);
	});

	it.each(["input", "message_end"] as const)("marks %s transformations rather than claiming exact original content", async (stage) => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => SessionManager.create(directory, directory),
			extensionFactories: [(pi) => {
				api = pi;
				if (stage === "input") pi.on("input", () => ({ action: "transform", text: "changed" }));
				else pi.on("message_end", (event) => {
					if (event.message.role === "user") return { message: { ...event.message, content: [{ type: "text", text: "changed" }] } };
				});
			}],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const receipt = await api.sendUserMessageWithReceipt("original");
		await harness.session.waitForIdle();
		expect(receipt).toMatchObject({ status: "appended", contentChanged: true });
		if (receipt.status !== "appended") throw new Error("Expected append");
		expect(harness.sessionManager.getEntry(receipt.entryId)).toMatchObject({ message: { content: [{ type: "text", text: "changed" }] } });
	});

	it("reports handled input without crediting a foreign equal-text append", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => SessionManager.create(directory, directory),
			extensionFactories: [(pi) => { api = pi; pi.on("input", () => ({ action: "handled" })); }],
		});
		harnesses.push(harness);
		const foreign = harness.sessionManager.appendMessageWithReceipt({ role: "user", content: "equal", timestamp: 1 });
		const before = readFileSync(foreign.sessionFile!);
		expect(await api.sendUserMessageWithReceipt("equal")).toMatchObject({ status: "handled" });
		expect(readFileSync(foreign.sessionFile!)).toEqual(before);
		expect(harness.sessionManager.getEntries()).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("returns not_written on real EACCES, with no provider call or indexed user", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => {
				const file = join(directory, "native.jsonl");
				writeFileSync(file, "");
				return SessionManager.open(file);
			},
			extensionFactories: [(pi) => { api = pi; }],
		});
		harnesses.push(harness);
		const file = harness.session.sessionFile!;
		const before = readFileSync(file);
		let calls = 0;
		harness.setResponses([() => { calls++; return fauxAssistantMessage("must not run"); }]);
		chmodSync(file, 0o400);
		try {
			const receipt = await api.sendUserMessageWithReceipt("do not acknowledge");
			await harness.session.waitForIdle();
			expect(receipt.status).toBe("not_written");
			expect(readFileSync(file)).toEqual(before);
			expect(harness.sessionManager.getBranch()).toEqual([]);
			expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
			expect(calls).toBe(0);
		} finally { chmodSync(file, 0o600); }
	});

	it("reports partial append as unknown and retains bytes without another write", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => {
				const file = join(directory, "native.jsonl");
				writeFileSync(file, "");
				return SessionManager.open(file);
			},
			extensionFactories: [(pi) => { api = pi; }],
		});
		harnesses.push(harness);
		const file = harness.session.sessionFile!;
		const before = readFileSync(file);
		vi.mocked(fs.writeSync).mockImplementationOnce(() => {
			fs.appendFileSync(file, "partial");
			throw new Error("injected partial append");
		});
		const receipt = await api.sendUserMessageWithReceipt("uncertain");
		await harness.session.waitForIdle();
		expect(receipt.status).toBe("unknown");
		expect(readFileSync(file)).toEqual(Buffer.concat([before, Buffer.from("partial")]));
		expect(harness.sessionManager.getBranch()).toEqual([]);
		expect(harness.sessionManager.getPersistenceError()?.outcome).toBe("unknown");
		const next = await api.sendUserMessageWithReceipt("must not dispatch");
		expect(next.status).toBe("unknown");
		expect(readFileSync(file)).toEqual(Buffer.concat([before, Buffer.from("partial")]));
	});

	it.each(["steer", "followUp"] as const)("correlates delivered %s input through the real native queue", async (deliverAs) => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			sessionManager: (directory) => SessionManager.create(directory, directory),
			extensionFactories: [(pi) => { api = pi; }],
		});
		harnesses.push(harness);
		let entered!: () => void, release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { release = resolve; });
		harness.setResponses([async () => { entered(); await held; return fauxAssistantMessage("first done"); }, fauxAssistantMessage("second done")]);
		const first = harness.session.prompt("equal");
		try {
			await started;
			const pending = api.sendUserMessageWithReceipt("equal", { deliverAs });
			release();
			const receipt = await pending;
			expect(receipt).toMatchObject({ status: "appended", contentChanged: false });
			if (receipt.status !== "appended") throw new Error("Expected queued append");
			const users = harness.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
			expect(users).toHaveLength(2);
			expect(users[1].id).toBe(receipt.entryId);
			expect(users[0].id).not.toBe(receipt.entryId);
		} finally { release(); await first; }
	});

	it("keeps queued correlation and reports cleared input without a receipt or resend", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({ extensionFactories: [(pi) => { api = pi; }] });
		harnesses.push(harness);
		let entered!: () => void, release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { release = resolve; });
		harness.setResponses([async () => { entered(); await held; return fauxAssistantMessage("done"); }]);
		const first = harness.session.prompt("first");
		try {
			await started;
			const queued = api.sendUserMessageWithReceipt("queued", { deliverAs: "followUp" });
			// No input hook is installed: queue insertion occurs before the call returns.
			expect(harness.session.clearQueue().followUp).toEqual(["queued"]);
			expect(await queued).toMatchObject({ status: "not_written" });
		} finally { release(); await first; }
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
	});
});
