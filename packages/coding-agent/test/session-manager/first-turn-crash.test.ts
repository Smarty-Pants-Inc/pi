import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type FileEntry,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../../src/core/session-manager.ts";

const fixture = fileURLToPath(new URL("../fixtures/first-turn-child.ts", import.meta.url));
const resolver = new URL("../../src/experimental/source-resolver.ts", import.meta.url).href;
const ownedPreload = new URL("../fixtures/first-turn-owned-preload.ts", import.meta.url).href;
const roots: string[] = [];
const children = new Set<ChildProcess>();
const boundaries = ["first-delta", "before-delta", "completed", "pre-delta-entry"] as const;
const prompt = "Keep this first user message across a crash.";
const reply = "A genuine faux-provider streamed reply with several text deltas.";
let addon = "";
let nativeUnavailable: string | undefined;

interface Receipt {
	type: "ready";
	file: string;
	header: SessionHeader;
	providerCalls: number;
	deltaCount?: number;
	entries?: SessionEntry[];
	context?: AgentMessage[];
	messages?: AgentMessage[];
	reconstructedMarkers?: number;
	streaming?: boolean;
}

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-first-turn-"));
	roots.push(directory);
	return directory;
}

function start(storage: string, boundary: string, directory: string, file = "") {
	const child = spawn(
		process.execPath,
		[
			"--import",
			resolver,
			...(storage === "owned" ? ["--import", ownedPreload] : []),
			fixture,
			storage,
			boundary,
			directory,
			file ? "reopen" : "write",
			file,
			addon,
		],
		{
			cwd: directory,
			env: {
				PATH: process.env.PATH,
				HOME: directory,
				TMPDIR: directory,
				PI_OFFLINE: "1",
				PI_NO_LOCAL_LLM: "1",
			},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		},
	);
	children.add(child);
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			children.delete(child);
			resolve({ code, signal });
		});
	});
	const ready = new Promise<Receipt>((resolve, reject) => {
		child.once("message", (message: Receipt) => resolve(message));
		child.once("error", reject);
		child.once("close", (code, signal) =>
			reject(new Error(`Child exited before receipt: ${code}/${signal}\n${stderr}`)),
		);
	});
	// Finite process deadline even when a fixture fails before reporting a gate.
	const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
	void closed.finally(() => clearTimeout(timeout)).catch(() => {});
	return { child, ready, closed, stderr: () => stderr };
}

function checkEntries(entries: SessionEntry[], boundary: string): void {
	const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
	expect(users).toHaveLength(1);
	expect(users[0]).toMatchObject({ message: { content: [{ type: "text", text: prompt }] } });
	const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === "reply-began");
	expect(markers).toHaveLength(boundary === "first-delta" || boundary === "completed" ? 1 : 0);
	if (markers.length) {
		expect(markers[0]).toMatchObject({ data: { version: 1, turn: 1 } });
		expect(markers[0]).not.toHaveProperty("message");
		expect(markers[0]).not.toHaveProperty("content");
	}
	expect(entries.filter((entry) => entry.type === "custom" && entry.customType === "pre-delta")).toHaveLength(
		boundary === "pre-delta-entry" ? 1 : 0,
	);
	const assistants = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
	expect(assistants).toHaveLength(boundary === "completed" ? 1 : 0);
	if (assistants.length) {
		expect(assistants[0]).toMatchObject({
			message: { content: [{ type: "text", text: reply }], stopReason: "stop" },
		});
	}
	// Exact parent chain and IDs, not just parseable marker data.
	for (const [index, entry] of entries.entries()) expect(entry.parentId).toBe(index ? entries[index - 1].id : null);
	expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
}

afterAll(async () => {
	// Always reap children, including assertion failures at a held stream event.
	await Promise.all(
		[...children].map(async (child) => {
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			child.kill("SIGKILL");
			await closed;
		}),
	);
	for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

// smarty-code#1681: real SIGKILL/reload, not graceful abort or a mocked filesystem.
// Native owned storage is Linux-only. Plain JSONL also runs on other Unix hosts.
for (const storage of ["plain", "owned"] as const) {
	describe.skipIf(process.platform === "win32" || (storage === "owned" && process.platform !== "linux"))(
		`fresh first-turn crash durability: ${storage}`,
		() => {
			if (storage === "owned") {
				beforeAll(() => {
					const headers =
						process.env.PI_APPEND_NODE_HEADERS ??
						[
							join(dirname(process.execPath), "../include/node"),
							join(homedir(), ".cache/node-gyp", process.versions.node, "include/node"),
							"/usr/include/node",
						].find((path) => existsSync(join(path, "node_api.h")));
					// Match the existing native append probe: portable unit runs may lack
					// a C toolchain/Node headers. Linux native evidence must run unskipped.
					if (!headers) {
						nativeUnavailable = "Node headers unavailable; set PI_APPEND_NODE_HEADERS";
						return;
					}
					const compiler = process.env.PI_APPEND_CC ?? "cc";
					const available = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 5000 });
					if (available.error || available.status !== 0) {
						nativeUnavailable = `Native probe compiler unavailable: ${compiler}`;
						return;
					}
					addon = join(scratch(), "first-turn.node");
					const compiled = spawnSync(
						compiler,
						[
							"-std=c11",
							"-shared",
							"-fPIC",
							"-O1",
							"-ffunction-sections",
							"-fdata-sections",
							"-pthread",
							"-I",
							headers,
							fileURLToPath(new URL("../fixtures/first-turn-native.c", import.meta.url)),
							"-Wl,--gc-sections",
							"-o",
							addon,
						],
						{ encoding: "utf8", timeout: 30_000 },
					);
					expect(compiled.error).toBeUndefined();
					expect(compiled.status, compiled.stderr).toBe(0);
				});
			}
			// smarty-code#1681 acceptance (a), (b), (c), plus the pre-delta custom-entry seam.
			test.for(boundaries)(
				"SIGKILL at %s retains native history without replay",
				{ timeout: 30_000 },
				async (boundary, context) => {
					if (storage === "owned" && nativeUnavailable) context.skip(nativeUnavailable);
					const directory = scratch();
					const writer = start(storage, boundary, directory);
					try {
						const receipt = await writer.ready;
						expect(receipt.type).toBe("ready");
						expect(receipt.providerCalls).toBe(1);
						expect(receipt.deltaCount).toBe(
							boundary === "first-delta" ? 1 : boundary === "completed" ? Math.ceil(reply.length / 4) : 0,
						);
						// Inspect disk BEFORE killing; no in-memory manager can satisfy this.
						const bytes = readFileSync(receipt.file);
						expect(bytes.at(-1)).toBe(10);
						const rows = bytes
							.toString("utf8")
							.trimEnd()
							.split("\n")
							.map((line): FileEntry => JSON.parse(line));
						expect(rows[0]).toEqual(receipt.header);
						const entries = rows.slice(1) as SessionEntry[];
						checkEntries(entries, boundary);
						expect(writer.child.kill("SIGKILL")).toBe(true);
						expect(await writer.closed).toEqual({ code: null, signal: "SIGKILL" });
						expect(readFileSync(receipt.file)).toEqual(bytes);
						// Both the plain reader and the native owned reader see the same file.
						expect(loadEntriesFromFile(receipt.file)).toEqual(rows);
						if (storage === "plain") {
							const opened = SessionManager.open(receipt.file);
							expect(opened.getHeader()).toEqual(receipt.header);
							expect(opened.getEntries()).toEqual(entries);
						}
						const reader = start(storage, boundary, directory, receipt.file);
						try {
							const reloaded = await reader.ready;
							expect(await reader.closed, reader.stderr()).toEqual({ code: 0, signal: null });
							expect(reloaded.header).toEqual(receipt.header);
							expect(reloaded.entries).toEqual(entries);
							expect(reloaded.providerCalls).toBe(0);
							expect(reloaded.streaming).toBe(false);
							expect(reloaded.reconstructedMarkers).toBe(
								boundary === "first-delta" || boundary === "completed" ? 1 : 0,
							);
							expect(reloaded.messages).toEqual(reloaded.context);
							expect(reloaded.context?.filter((message) => message.role !== "system")).toHaveLength(
								boundary === "completed" ? 2 : 1,
							);
							expect(readFileSync(receipt.file)).toEqual(bytes);
						} finally {
							if (children.has(reader.child)) {
								reader.child.kill("SIGKILL");
								await reader.closed;
							}
						}
					} finally {
						if (children.has(writer.child)) {
							writer.child.kill("SIGKILL");
							await writer.closed;
						}
					}
				},
			);
		},
	);
}
