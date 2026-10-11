/*
 * pi#193 CODE P1: the plain JSONL proof below runs the built CLI in print mode.
 * Owned ordinary startup needs a live owner/admission: --owner-host-profile
 * requires terminal stdin/stdout and rejects print mode or additional arguments.
 * Keep the owned-journal component tests; they do not prove ordinary CLI admission.
 * Named E2E plan: fleet canary crash/reload proof under a smarty-dev#8356-style
 * follow-up, using admitted ordinary startup and the same first-delta/pre-delta gates.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
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

function checkEntries(entries: SessionEntry[], boundary: string, expectedPrompt = prompt): void {
	const users = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
	expect(users).toHaveLength(1);
	expect(users[0]).toMatchObject({ message: { content: [{ type: "text", text: expectedPrompt }] } });
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

// pi#193 CODE P1 / smarty-code#1681: exercise argv, models.json, HTTP streaming,
// extension loading and print-mode persistence through the built real entry point.
describe.skipIf(process.platform === "win32")("built CLI first-turn crash durability: plain JSONL", () => {
	test.for(["first-delta", "before-delta"] as const)(
		"SIGKILL at %s reloads only committed history",
		{ timeout: 30_000 },
		async (boundary) => {
			const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
			expect(existsSync(cli), "Build the real CLI with npm run build before running this test").toBe(true);
			const directory = scratch();
			const agentDir = join(directory, "agent");
			const sessionDir = join(directory, "sessions");
			mkdirSync(agentDir);
			mkdirSync(sessionDir);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
			);
			const partial = "CLI partial reply must never enter history";
			const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
			let sentDeltas = 0;
			const server = createServer((request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					requests.push({ method: request.method, url: request.url, body });
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					response.flushHeaders();
					if (boundary === "first-delta") {
						response.write(
							`data: ${JSON.stringify({ id: "first-turn", object: "chat.completion.chunk", created: 1, model: "crash-model", choices: [{ index: 0, delta: { role: "assistant", content: partial }, finish_reason: null }] })}\n\n`,
						);
						sentDeltas++;
					}
					// No completion, EOF or later delta: only the parent can release the stream.
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Expected local HTTP server address");
				writeFileSync(
					join(agentDir, "models.json"),
					JSON.stringify({
						providers: {
							"first-turn-cli": {
								baseUrl: `http://127.0.0.1:${address.port}/v1`,
								api: "openai-completions",
								apiKey: "offline-test-only",
								models: [{ id: "crash-model", reasoning: false, contextWindow: 32000, maxTokens: 1024 }],
							},
						},
					}),
				);
				const child = spawn(
					process.execPath,
					[
						cli,
						"--offline",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-context-files",
						"--no-tools",
						"--extension",
						fileURLToPath(new URL("../fixtures/first-turn-cli-extension.ts", import.meta.url)),
						"--session-dir",
						sessionDir,
						"--model",
						"first-turn-cli/crash-model",
						"-p",
						"hello",
					],
					{
						cwd: directory,
						env: {
							PATH: process.env.PATH,
							HOME: directory,
							USERPROFILE: directory,
							TMPDIR: directory,
							PI_CODING_AGENT_DIR: agentDir,
							PI_OFFLINE: "1",
							PI_NO_LOCAL_LLM: "1",
							AWS_EC2_METADATA_DISABLED: "true",
						},
						stdio: ["ignore", "ignore", "pipe"],
					},
				);
				children.add(child);
				let stderr = "";
				child.stderr!.setEncoding("utf8");
				child.stderr!.on("data", (chunk: string) => {
					stderr += chunk;
				});
				const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code, signal) => {
						children.delete(child);
						resolve({ code, signal });
					});
				});
				const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
				try {
					let file = "";
					let bytes = Buffer.alloc(0);
					// Bounded polling synchronizes on complete disk records, never elapsed time.
					// The pre-delta variant also waits for the server to accept and hold the request.
					await vi.waitFor(
						() => {
							expect(children.has(child), stderr).toBe(true);
							expect(requests, stderr).toHaveLength(1);
							const files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
							expect(files, stderr).toHaveLength(1);
							file = join(sessionDir, files[0]);
							bytes = readFileSync(file);
							expect(bytes.at(-1)).toBe(10);
							const rows = bytes
								.toString("utf8")
								.trimEnd()
								.split("\n")
								.map((line): FileEntry => JSON.parse(line));
							expect(rows[0]).toMatchObject({ type: "session", version: 3, cwd: directory });
							checkEntries(rows.slice(1) as SessionEntry[], boundary, "hello");
						},
						{ timeout: 15_000, interval: 10 },
					);
					expect(sentDeltas).toBe(boundary === "first-delta" ? 1 : 0);
					expect(requests[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
					expect(JSON.parse(requests[0].body)).toMatchObject({
						model: "crash-model",
						stream: true,
						messages: expect.arrayContaining([
							expect.objectContaining({ role: "user", content: [{ type: "text", text: "hello" }] }),
						]),
					});
					expect(child.kill("SIGKILL")).toBe(true);
					expect(await closed, stderr).toEqual({ code: null, signal: "SIGKILL" });
					expect(readFileSync(file)).toEqual(bytes);
					const opened = SessionManager.open(file);
					checkEntries(opened.getEntries(), boundary, "hello");
					expect(opened.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(
						boundary === "first-delta" ? 1 : 0,
					);
					expect(opened.buildSessionContext().messages.filter((message) => message.role !== "system")).toEqual([
						expect.objectContaining({ role: "user", content: [{ type: "text", text: "hello" }] }),
					]);
					expect(readFileSync(file, "utf8")).not.toContain(partial);
					expect(readFileSync(file)).toEqual(bytes);
				} finally {
					clearTimeout(timeout);
					if (children.has(child)) child.kill("SIGKILL");
					await closed;
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
	);
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
					// ponytail: loaded merge-queue runners took >30 s to compile this addon (pi#193, queue draft #196);
					// generous bounds keep the Linux native evidence unskipped instead of flaking.
					const available = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 30_000 });
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
						{ encoding: "utf8", timeout: 180_000 },
					);
					expect(compiled.error).toBeUndefined();
					expect(compiled.status, compiled.stderr).toBe(0);
				}, 240_000);
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
