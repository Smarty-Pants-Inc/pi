import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.ts";
import { loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { getInputReceipt, promptReceived, receiveInput } from "../../../src/core/received-input.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { getTurnProvenance } from "../../../src/core/turn-provenance.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../../src/core/turn-receipts.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";

const workerPath = fileURLToPath(new URL("../../../src/utils/image-resize-worker.ts", import.meta.url));

// smarty-dev#10720: inspect the actual request closure, not a second implementation of its snapshot.
async function retainedRequestValue(session: AgentSession, name: string): Promise<unknown> {
	const inspector = new Session();
	inspector.connect();
	Object.defineProperty(globalThis, "__piRetainerProjection", {
		value: session.agent.prepareRequest,
		configurable: true,
	});
	try {
		const { result } = await inspector.post("Runtime.evaluate", {
			expression: "globalThis.__piRetainerProjection",
			objectGroup: "pi-retainer-test",
		});
		const properties = await inspector.post("Runtime.getProperties", { objectId: result.objectId! });
		const scopesId = properties.internalProperties?.find((property) => property.name === "[[Scopes]]")?.value
			?.objectId;
		expect(scopesId).toBeDefined();
		const scopes = await inspector.post("Runtime.getProperties", { objectId: scopesId! });
		for (const scope of scopes.result) {
			if (!scope.value?.objectId) continue;
			const variables = await inspector.post("Runtime.getProperties", { objectId: scope.value.objectId });
			const snapshot = variables.result.find((variable) => variable.name === name);
			if (snapshot) return snapshot.value?.value;
		}
		throw new Error("Request projection snapshot was not found in its closure");
	} finally {
		Reflect.deleteProperty(globalThis, "__piRetainerProjection");
		await inspector.post("Runtime.releaseObjectGroup", { objectGroup: "pi-retainer-test" });
		inspector.disconnect();
	}
}

function userText(message: AgentMessage | undefined): string | undefined {
	if (message?.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

// pi#160 / #306 / smarty-dev#14893: read canonical stored input, not the mutable projection shell.
function storedUserMessage(harness: Harness): AgentMessage | undefined {
	const entry = harness.sessionManager
		.getEntries()
		.find((value) => value.type === "message" && value.message.role === "user");
	return entry?.type === "message" ? entry.message : undefined;
}

function createLoader(cwd: string): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [workerPath],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
}

// smarty-dev#10720: never retain old Harness objects or their cleanup closures during the GC assertion.
async function replacedSessionProbe(): Promise<{
	first: WeakRef<AgentSession>;
	runtime: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	initTheme("dark");
	const scratch = mkdtempSync(join(tmpdir(), "pi-retainer-"));
	const loader = createLoader(scratch);
	let current: Harness;
	try {
		current = await createHarness({
			cwd: scratch,
			resourceLoader: loader,
			settings: { compaction: { enabled: false } },
		});
	} catch (error) {
		rmSync(scratch, { recursive: true, force: true });
		throw error;
	}
	// Harness cleanup cancels its session; defer it until the runtime has published its replacement.
	let retired: Harness | undefined;
	const cleanupRetired = async () => {
		const outgoing = retired;
		retired = undefined;
		await outgoing?.cleanup();
	};
	const cleanupProbeResources = async () => {
		const outgoing = retired;
		retired = undefined;
		const active = current;
		const cleanups: Promise<void>[] = [active.cleanup()];
		if (outgoing && outgoing !== active) cleanups.push(outgoing.cleanup());
		const results = await Promise.allSettled(cleanups);
		rmSync(scratch, { recursive: true, force: true });
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	};
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const next = await createHarness({
			cwd,
			sessionManager,
			sessionStartEvent,
			settings: { compaction: { enabled: false } },
		});
		retired = current;
		current = next;
		return {
			session: next.session,
			extensionsResult: next.resourceLoader.getExtensions(),
			services: {
				cwd,
				agentDir: next.tempDir,
				modelRuntime: next.modelRuntime,
				settingsManager: next.settingsManager,
				resourceLoader: next.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const runtime = new AgentSessionRuntime(
		current.session,
		{
			cwd: scratch,
			agentDir: scratch,
			modelRuntime: current.modelRuntime,
			settingsManager: current.settingsManager,
			resourceLoader: current.resourceLoader,
			diagnostics: [],
		},
		factory,
	);
	try {
		// Load a misconfigured worker extension from an actual session callback, so a module-evaluation
		// Error can capture the outgoing session's async stack. Retain its cached diagnostics, not the
		// bound extension runtime (whose action callbacks intentionally point at the outgoing session).
		await current.session.reload();
		const diagnostics = loader.getExtensions().errors;
		expect(diagnostics).toHaveLength(1);
		expect(typeof diagnostics[0].error).toBe("string");
		current.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await current.session.prompt("first turn");
		await current.session.prompt("second turn");
		const first = new WeakRef(current.session);
		await runtime.newSession();
		await cleanupRetired();
		await runtime.newSession();
		await cleanupRetired();
		return {
			first,
			runtime,
			cleanup: async () => {
				// Keep the cached failure strings alive throughout the GC assertion.
				expect(diagnostics).toHaveLength(1);
				await cleanupProbeResources();
			},
		};
	} catch (error) {
		try {
			await cleanupProbeResources();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Retainer probe failed and cleanup was incomplete");
		}
		throw error;
	}
}

describe("Pi session retainers (smarty-dev#10720)", () => {
	it("retains a digest-sized request snapshot instead of the serialized transcript", async () => {
		let expected: string | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			prepareRequest: (request) => {
				const hash = createHash("sha256");
				for (const message of request.context.messages) {
					hash.update(JSON.stringify(message));
					hash.update("\0");
				}
				expected = hash.digest("base64");
			},
		});
		try {
			harness.setResponses([fauxAssistantMessage("reply")]);
			await harness.session.prompt("large input ".repeat(2000));
			const snapshot = await retainedRequestValue(harness.session, "canonicalMessagesDigest");
			expect(typeof snapshot).toBe("string");
			expect((snapshot as string).length).toBeLessThanOrEqual(44);
			expect(snapshot).toBe(expected);
		} finally {
			harness.cleanup();
		}
	});

	// #11897: in-place request-hook edits are not safe to discard after overflow.
	// pi#160: canonical stored history is frozen; the hook edits a mutable runtime copy.
	it("detects in-place request-hook edits and sends them unchanged when they fit", async () => {
		let hookSawFrozen: boolean | undefined;
		const harness = await createHarness({
			prepareRequest: (request) => {
				const userMessage = request.context.messages.find((message) => message.role === "user");
				hookSawFrozen = userMessage !== undefined && Object.isFrozen(userMessage);
				if (userMessage?.role === "user") userMessage.content = [{ type: "text", text: "hook-edited input" }];
			},
		});
		try {
			let providerRan = false;
			harness.setResponses([
				(context) => {
					providerRan = true;
					const userMessage = context.messages.find((message) => message.role === "user");
					expect(userMessage).toMatchObject({
						role: "user",
						content: [{ type: "text", text: "hook-edited input" }],
					});
					return fauxAssistantMessage("reply");
				},
			]);
			await harness.session.prompt("original input");
			expect(providerRan).toBe(true);
			expect(hookSawFrozen).toBe(false);
			expect(harness.session.getLastAssistantText()).toBe("reply");
			const stored = storedUserMessage(harness);
			expect(Object.isFrozen(stored)).toBe(true);
			expect(userText(stored)).toBe("original input");
			expect(await retainedRequestValue(harness.session, "canReproject")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	// pi#160: a nested in-place edit (content block text) is detected by the digest and never reaches history.
	it("detects nested in-place request-hook edits without touching frozen history", async () => {
		const harness = await createHarness({
			prepareRequest: (request) => {
				const userMessage = request.context.messages.find((message) => message.role === "user");
				if (userMessage?.role !== "user" || !Array.isArray(userMessage.content)) {
					throw new Error("Expected a user message with content blocks");
				}
				const block = userMessage.content[0];
				if (block?.type === "text") block.text = `${block.text}, nested edit`;
			},
		});
		try {
			let providerRan = false;
			harness.setResponses([
				(context) => {
					providerRan = true;
					const userMessage = context.messages.find((message) => message.role === "user");
					expect(userText(userMessage)).toBe("original input, nested edit");
					return fauxAssistantMessage("nested reply");
				},
			]);
			await harness.session.prompt("original input");
			expect(providerRan).toBe(true);
			expect(harness.session.getLastAssistantText()).toBe("nested reply");
			const stored = storedUserMessage(harness);
			expect(Object.isFrozen(stored)).toBe(true);
			expect(userText(stored)).toBe("original input");
			expect(await retainedRequestValue(harness.session, "canReproject")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	// pi#160 counterexample: a hook that leaves the request input untouched keeps it reprojectable.
	it("keeps untouched frozen projected input reprojectable", async () => {
		let expected: string | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			prepareRequest: (request) => {
				const hash = createHash("sha256");
				for (const message of request.context.messages) {
					hash.update(JSON.stringify(message));
					hash.update("\0");
				}
				expected = hash.digest("base64");
			},
		});
		try {
			let providerRan = false;
			harness.setResponses([
				() => {
					providerRan = true;
					return fauxAssistantMessage("untouched reply");
				},
			]);
			await harness.session.prompt("untouched input");
			expect(providerRan).toBe(true);
			const stored = storedUserMessage(harness);
			expect(Object.isFrozen(stored)).toBe(true);
			expect(userText(stored)).toBe("untouched input");
			expect(await retainedRequestValue(harness.session, "canReproject")).toBe(true);
			expect(await retainedRequestValue(harness.session, "canonicalMessagesDigest")).toBe(expected);
		} finally {
			harness.cleanup();
		}
	});

	// pi#160: a request-hook edit must not overwrite keyboard-attested stored text or its attribution.
	it("keeps keyboard-attested stored text and attribution when a request hook edits its copy", async () => {
		const harness = await createHarness({
			persistSession: true,
			prepareRequest: (request) => {
				const userMessage = request.context.messages.find((message) => message.role === "user");
				if (userMessage?.role === "user" && Array.isArray(userMessage.content)) {
					const block = userMessage.content[0];
					if (block?.type === "text") block.text = "rewritten by request hook";
				}
			},
		});
		try {
			let providerText: string | undefined;
			harness.setResponses([
				(context) => {
					providerText = userText(context.messages.find((message) => message.role === "user"));
					return fauxAssistantMessage("attested reply");
				},
			]);
			const token = "c".repeat(32);
			const input = receiveInput(
				"typed by paul",
				undefined,
				captureKeyboardTurnReceipt("paul", token, new Date().toISOString()),
			);
			const before = receiptRecord(getInputReceipt(input));
			await promptReceived(harness.session, input);
			expect(providerText).toBe("rewritten by request hook");
			const stored = storedUserMessage(harness);
			expect(Object.isFrozen(stored)).toBe(true);
			expect(userText(stored)).toBe("typed by paul");
			const entry = SessionManager.open(harness.sessionManager.getSessionFile()!)
				.getEntries()
				.find((value) => value.type === "message" && value.message.role === "user");
			expect(entry?.type === "message" ? userText(entry.message) : undefined).toBe("typed by paul");
			expect(getTurnProvenance(entry!)).toEqual(before);
			expect(getTurnProvenance(entry!)).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
			expect(await retainedRequestValue(harness.session, "canReproject")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	// pi#160 / #11897: an in-place one-shot request edit must not be discarded by overflow recovery.
	it("refuses overflowing request-hook edits without replaying or rebuilding their input", async () => {
		let preparations = 0;
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 100_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
				retry: { enabled: false },
			},
			prepareRequest: (request) => {
				preparations++;
				const userMessage = request.context.messages.findLast((message) => message.role === "user");
				if (userMessage?.role === "user") {
					userMessage.content = [{ type: "text", text: "one-shot request instruction" }];
				}
				return { model: { ...request.model, contextWindow: 16_000 } };
			},
		});
		try {
			harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(80_000), timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
			harness.session.refreshContext();
			harness.setResponses([fauxAssistantMessage("must not send after discarding the edit")]);
			await harness.session.prompt("original input");
			expect(preparations).toBe(1);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
			expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringMatching(/context exceeds window/i),
			});
			expect(await retainedRequestValue(harness.session, "canReproject")).toBe(false);
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("one-shot request instruction");
		} finally {
			harness.cleanup();
		}
	});

	it("leaves the snapshot undefined for unserializable metadata without blocking a fitting request", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		try {
			const details: { self?: unknown } = {};
			details.self = details;
			harness.sessionManager.appendCustomMessageEntry("opaque", "small context", false, details);
			harness.setResponses([fauxAssistantMessage("fitting reply")]);
			await harness.session.prompt("fitting input");
			expect(harness.session.getLastAssistantText()).toBe("fitting reply");
			expect(await retainedRequestValue(harness.session, "canonicalMessagesDigest")).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	// #11897: cached diagnostics retain only the message, not the Error or its stack.
	it("caches inline failure messages rather than Error objects or stacks", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		try {
			const loader = new DefaultResourceLoader({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				settingsManager: SettingsManager.inMemory(),
				extensionFactories: [
					() => {
						throw new Error("cached failure");
					},
				],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const diagnostic = loader.getExtensions().errors[0].error;
			expect(typeof diagnostic).toBe("string");
			expect(diagnostic).toBe("cached failure");
		} finally {
			harness.cleanup();
		}
	});

	it("does not throw a module-evaluation Error when the extension loader selects the worker", async () => {
		const result = await loadExtensionsCached([workerPath], process.cwd());
		expect(result.extensions).toEqual([]);
		expect(result.errors).toEqual([
			{ path: workerPath, error: `Extension does not export a valid factory function: ${workerPath}` },
		]);
	});

	it("still answers worker requests and formats request failures as strings", async () => {
		const worker = new Worker(new URL("../../../src/utils/image-resize-worker.ts", import.meta.url));
		try {
			const response = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
				worker.once("exit", (code) => reject(new Error(`Worker exited before replying: ${code}`)));
			});
			worker.postMessage({ invalid: true });
			expect(await response).toEqual({
				type: "pi:image-resize-response",
				error: "Invalid image resize worker request",
			});
		} finally {
			await worker.terminate();
		}
	});

	it.skipIf(!globalThis.gc)("collects the first AgentSession after two native new_session replacements", async () => {
		const probe = await replacedSessionProbe();
		try {
			// WeakRef.deref() keeps its target alive until the next job; do not dereference between GCs.
			for (let attempt = 0; attempt < 8; attempt++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				globalThis.gc!();
			}
			expect(probe.first.deref() === undefined).toBe(true);
			expect(probe.runtime.session.isDisposed).toBe(false);
		} finally {
			try {
				await probe.runtime.dispose();
			} finally {
				await probe.cleanup();
			}
		}
	});
});
