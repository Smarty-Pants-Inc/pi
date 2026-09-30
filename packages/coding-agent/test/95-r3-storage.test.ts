// pi#95 R3: writable setup and inspection must not confer provenance authority.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../src/core/agent-session-runtime.ts";
import { isColdEntry } from "../src/core/session-lazy-entries.ts";
import { type FileEntry, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { getTurnProvenance, type TurnProvenance } from "../src/core/turn-provenance.ts";
import type { ExtensionAPI } from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});
const channels = ["keyboard", "voice", "fabric"] as const;
function record(channel: (typeof channels)[number]): TurnProvenance {
	return {
		v: 1,
		turnId: "3f1c2a7e-0000-4000-8000-000000000000",
		receivedAt: "2026-09-30T00:00:00.000Z",
		channel,
		...(channel === "fabric"
			? { sender: { id: "session:host", kind: "main" as const, verified: "mesh" as const }, via: "steer" as const }
			: {
					principal: {
						id: "host",
						binding: channel === "keyboard" ? ("herdr-client" as const) : ("voice-call" as const),
					},
				}),
	};
}
function disk(file: string): SessionEntry[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as FileEntry)
		.filter((entry): entry is SessionEntry => entry.type !== "session");
}
function turns(entries: SessionEntry[]): SessionEntry[] {
	return entries.filter(
		(entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"),
	);
}
function persisted(manager: SessionManager): SessionEntry[][] {
	const file = manager.getSessionFile()!;
	return [disk(file), SessionManager.open(file, manager.getSessionDir()).getEntries()];
}
async function runtimeForSetup() {
	const harness = await createHarness({ persistSession: true });
	cleanups.push(harness.cleanup);
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
	const runtime = new AgentSessionRuntime(harness.session, services, factory);
	cleanups.push(() => runtime.dispose());
	return { harness, runtime };
}

describe("pi#95 R3 storage trust boundary", () => {
	for (const channel of channels) {
		it(`public runtime newSession setup refuses ${channel} on both append APIs at first assistant flush`, async () => {
			const { harness, runtime } = await runtimeForSetup();
			const forged = record(channel);
			await runtime.newSession({
				setup: async (manager) => {
					// Extra JS arguments must not acquire authority after the typed API removes them.
					Reflect.apply(manager.appendMessage, manager, [
						{ role: "user", content: "setup user", timestamp: 1 },
						forged,
					]);
					Reflect.apply(manager.appendCustomMessageEntry, manager, [
						"setup custom",
						"setup custom",
						false,
						undefined,
						forged,
					]);
					expect(existsSync(manager.getSessionFile()!)).toBe(false);
				},
			});
			harness.setResponses([fauxAssistantMessage("flush")]);
			await runtime.session.prompt("host flush", { source: "rpc" });
			const manager = runtime.session.sessionManager;
			for (const entries of persisted(manager)) {
				const supplied = turns(entries).slice(0, 2).map(getTurnProvenance);
				expect(supplied.map((value) => value?.channel)).toEqual(["terminal", "terminal"]);
				for (const value of supplied) {
					expect(value?.principal).toBeUndefined();
					expect(value?.sender).toBeUndefined();
					expect(value?.turnId).not.toBe(forged.turnId);
				}
			}
		});
	}

	for (const state of ["fresh", "reopened", "cold"] as const) {
		for (const api of ["getEntry", "getEntries"] as const) {
			for (const kind of ["message", "custom_message"] as const) {
				for (const mutation of ["replace", "nested"] as const) {
					it(`${state} ${api} ${kind}: ${mutation} cannot forge fork JSONL`, () => {
						const root = mkdtempSync(join(tmpdir(), "pi-95-storage-"));
						cleanups.push(() => rmSync(root, { recursive: true, force: true }));
						const original = record("keyboard");
						const entry: SessionEntry =
							kind === "message"
								? {
										type: "message",
										id: "turn",
										parentId: null,
										timestamp: original.receivedAt,
										message: { role: "user", content: "x".repeat(4096), timestamp: 1 },
										provenance: original,
									}
								: {
										type: "custom_message",
										id: "turn",
										parentId: null,
										timestamp: original.receivedAt,
										customType: "host",
										content: "x".repeat(4096),
										display: false,
										provenance: original,
									};
						const initial: FileEntry[] = [
							{ type: "session", version: 3, id: "test-session", timestamp: original.receivedAt, cwd: root },
							entry,
						];
						const file = join(root, "source.jsonl");
						writeFileSync(file, `${initial.map((value) => JSON.stringify(value)).join("\n")}\n`);
						let manager =
							state === "fresh"
								? SessionManager.inMemory(root, undefined, initial)
								: SessionManager.open(file, root);
						const assistantId = manager.appendMessage(fauxAssistantMessage("host reply"));
						if (state === "cold") {
							manager.appendCompaction("summary", assistantId, 10);
							for (let i = 0; i < 105; i++) manager.appendCustomEntry("padding", i);
							manager = SessionManager.open(file, root);
							expect(isColdEntry(manager.getEntry("turn")!)).toBe(true);
						}
						const view =
							api === "getEntry"
								? manager.getEntry("turn")!
								: manager.getEntries().find((value) => value.id === "turn")!;
						if (view.type !== "message" && view.type !== "custom_message") throw new Error("missing turn");
						if (mutation === "replace") view.provenance = record("fabric");
						else {
							try {
								Object.assign(view.provenance!.principal!, { id: "attacker" });
							} catch {
								/* Frozen snapshots also satisfy the boundary. */
							}
						}
						const expected = record("keyboard");
						expect.soft(getTurnProvenance(manager.getEntry("turn")!)).toEqual(expected);
						if (state === "fresh") {
							// Materialize the in-memory session in JSONL to exercise the same reopen/fork path.
							writeFileSync(
								file,
								`${[manager.getHeader(), ...manager.getEntries()].map((value) => JSON.stringify(value)).join("\n")}\n`,
							);
						}
						const forkFile = manager.createBranchedSession(assistantId);
						if (forkFile) {
							for (const entries of persisted(manager))
								expect(getTurnProvenance(entries.find((value) => value.id === "turn")!)).toEqual(expected);
						}
						const reloaded = SessionManager.open(file, root);
						const reloadFork = reloaded.createBranchedSession(assistantId)!;
						expect(getTurnProvenance(disk(reloadFork).find((value) => value.id === "turn")!)).toEqual(expected);
						expect(getTurnProvenance(SessionManager.open(reloadFork, root).getEntry("turn")!)).toEqual(expected);
					});
				}
			}
		}
	}

	for (const api of ["getEntry", "getEntries"] as const) {
		it(`cold ${api}: lazy provenance getter cannot share the JSONL read cache`, () => {
			const root = mkdtempSync(join(tmpdir(), "pi-95-storage-lazy-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const original = { ...record("fabric"), historicalMetadata: "x".repeat(4096) };
			const file = join(root, "source.jsonl");
			const header = { type: "session", version: 3, id: "lazy-session", timestamp: original.receivedAt, cwd: root };
			const entry = {
				type: "custom_message",
				id: "turn",
				parentId: null,
				timestamp: original.receivedAt,
				customType: "host",
				content: "historical",
				display: false,
				provenance: original,
			};
			writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
			let manager = SessionManager.open(file, root);
			const assistantId = manager.appendMessage(fauxAssistantMessage("reply"));
			manager.appendCompaction("summary", assistantId, 10);
			for (let i = 0; i < 105; i++) manager.appendCustomEntry("padding", i);
			manager = SessionManager.open(file, root);
			const view =
				api === "getEntry" ? manager.getEntry("turn")! : manager.getEntries().find((value) => value.id === "turn")!;
			expect(isColdEntry(view)).toBe(true);
			expect(Object.getOwnPropertyDescriptor(view, "provenance")?.get).toBeTypeOf("function");
			if (view.type !== "custom_message") throw new Error("missing custom turn");
			Object.assign(view.provenance!.sender!, { id: "attacker" });
			expect.soft(getTurnProvenance(manager.getEntry("turn")!)).toEqual(original);
			const fork = manager.createBranchedSession(assistantId)!;
			expect(getTurnProvenance(disk(fork).find((value) => value.id === "turn")!)).toEqual(original);
			expect(getTurnProvenance(SessionManager.open(fork, root).getEntry("turn")!)).toEqual(original);
		});
	}

	for (const channel of channels) {
		it(`legitimate harness ${channel} delivery retains its record through JSONL and reopen`, async () => {
			let api!: ExtensionAPI;
			const harness: Harness = await createHarness({
				persistSession: true,
				inputAttestation: { attest: () => ({ principal: "host" }) },
				settings: {
					turnProvenance: { voiceExtensions: ["<inline:trusted>"], fabricExtensions: ["<inline:trusted>"] },
				},
				extensionFactories: [
					{
						name: "trusted",
						factory: (value) => {
							api = value;
						},
					},
				],
			});
			cleanups.push(harness.cleanup);
			await harness.session.bindExtensions({ mode: "tui" });
			harness.setResponses([fauxAssistantMessage("reply")]);
			if (channel === "keyboard") await harness.session.prompt("attested input");
			else {
				const claim =
					channel === "voice"
						? { channel: "voice" as const, principal: { id: "host" } }
						: { channel: "fabric" as const, sender: record("fabric").sender!, via: "steer" as const };
				api.sendMessage({ customType: "trusted", content: "custom", display: false }, { provenance: claim });
				api.sendUserMessage("trusted input", { provenance: claim });
				await vi.waitFor(() => expect(turns(harness.sessionManager.getEntries())).toHaveLength(2));
				await harness.session.agent.waitForIdle();
			}
			const records = turns(harness.sessionManager.getEntries()).map(getTurnProvenance);
			expect(records.map((value) => value?.channel)).toEqual(
				channel === "keyboard" ? [channel] : [channel, channel],
			);
			for (const entries of persisted(harness.sessionManager))
				expect(turns(entries).map(getTurnProvenance)).toEqual(records);
		});
	}
});
