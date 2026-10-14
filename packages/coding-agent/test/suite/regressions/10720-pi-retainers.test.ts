import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.ts";
import { loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
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
	cleanup: () => void;
}> {
	initTheme("dark");
	const scratch = mkdtempSync(join(tmpdir(), "pi-retainer-"));
	const loader = createLoader(scratch);
	let current: Harness = await createHarness({
		cwd: scratch,
		resourceLoader: loader,
		settings: { compaction: { enabled: false } },
	});
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const next = await createHarness({
			cwd,
			sessionManager,
			sessionStartEvent,
			settings: { compaction: { enabled: false } },
		});
		current.cleanup();
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
	await runtime.newSession();
	return {
		first,
		runtime,
		cleanup: () => {
			// Keep the cached failure strings alive throughout the GC assertion.
			expect(diagnostics).toHaveLength(1);
			current.cleanup();
			rmSync(scratch, { recursive: true, force: true });
		},
	};
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
	it("detects in-place request-hook edits and sends them unchanged when they fit", async () => {
		const harness = await createHarness({
			prepareRequest: (request) => {
				const userMessage = request.context.messages.find((message) => message.role === "user");
				if (userMessage?.role === "user") userMessage.content = [{ type: "text", text: "hook-edited input" }];
			},
		});
		try {
			harness.setResponses([
				(context) => {
					const userMessage = context.messages.find((message) => message.role === "user");
					expect(userMessage).toMatchObject({
						role: "user",
						content: [{ type: "text", text: "hook-edited input" }],
					});
					return fauxAssistantMessage("reply");
				},
			]);
			await harness.session.prompt("original input");
			expect(await retainedRequestValue(harness.session, "canReproject")).toBe(false);
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

	it("caches formatted inline failure stacks rather than Error objects", async () => {
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
			expect(diagnostic).toContain("Error: cached failure");
			expect(diagnostic).toContain("10720-pi-retainers.test.ts:");
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
			await probe.runtime.dispose();
			probe.cleanup();
		}
	});
});
