import { EventEmitterAsyncResource } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensions,
} from "../../../src/core/extensions/loader.ts";
import type {
	ExtensionAPI,
	ProviderConfig,
	SendUserMessageResult,
	UserMessageMetadata,
} from "../../../src/core/extensions/types.ts";
import { UserMessageComponent } from "../../../src/modes/interactive/components/user-message.ts";
import { createHarness, type Harness } from "../harness.ts";

const extensionPath = "/extensions/fabric-metadata.ts";
const source = { kind: "extension", extensionPath };

describe("#7883 / pi#187 round 3 extension metadata entry points", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.session.waitForIdle();
			harness.cleanup();
		}
	});

	// #7883 / pi#187: real UI rendering used to submit extension-authored metadata as SDK input.
	it("stamps a user-message renderer send with its extension on receipt and persisted entry", async () => {
		let receipt: Promise<SendUserMessageResult> | undefined;
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				{
					path: extensionPath,
					factory: (pi) => {
						pi.registerUserMessageRenderer(() => {
							receipt = pi.sendUserMessage("renderer input", { metadata: { wakeCause: "render" } });
							return new Text("custom user text");
						});
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("renderer reply")]);
		const component = new UserMessageComponent("displayed input", undefined, 1, [], {
			renderer: harness.session.extensionRunner.getUserMessageRenderer(),
		});
		expect(component.render(80).join("\n")).toContain("custom user text");
		expect(receipt).toBeInstanceOf(Promise);
		const result = await receipt!;
		expect(result).toMatchObject({ status: "turnStarted", metadataSource: source });
		expect(harness.sessionManager.getEntry(result.entryId!)).toMatchObject({ metadataSource: source });
	});

	// #7883 / pi#187: asynchronous mesh work must inherit the extension's own initialization/event context.
	it.each(["factory", "event handler"] as const)(
		"preserves timer, promise and event-resource descendants of %s",
		async (origin) => {
			const release = Promise.withResolvers<void>();
			const delivered = [0, 1, 2].map(() => Promise.withResolvers<SendUserMessageResult>());
			let api: ExtensionAPI | undefined;
			const harness = await createHarness({
				extensionFactories: [
					{
						path: extensionPath,
						factory: (pi) => {
							api = pi;
							pi.on("input", () => ({ action: "handled" }));
							const schedule = () => {
								setTimeout(() => {
									void release.promise
										.then(() => pi.sendUserMessage("timer input", { metadata: {} }))
										.then(delivered[0]!.resolve, delivered[0]!.reject);
								}, 0);
								void release.promise
									.then(() => pi.sendUserMessage("promise input", { metadata: {} }))
									.then(delivered[1]!.resolve, delivered[1]!.reject);
								const emitter = new EventEmitterAsyncResource({ name: "extension-mesh" });
								emitter.on("wake", () => {
									void pi
										.sendUserMessage("event input", { metadata: {} })
										.then(delivered[2]!.resolve, delivered[2]!.reject);
								});
								void release.promise.then(() => {
									emitter.emit("wake");
									emitter.emitDestroy();
								});
							};
							if (origin === "factory") schedule();
							else
								pi.events.on("mesh-wake", async () => {
									await Promise.resolve();
									schedule();
								});
						},
					},
				],
			});
			harnesses.push(harness);
			if (origin === "event handler") api!.events.emit("mesh-wake", undefined);
			release.resolve();
			const receipts = await Promise.all(delivered.map(({ promise }) => promise));
			for (const receipt of receipts) expect(receipt).toMatchObject({ status: "handled", metadataSource: source });
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	// #7883 / pi#187: absent context must fail before all admission effects, not fall back to SDK.
	it("rejects captured extension metadata sends from a bare outside setImmediate", async () => {
		let api: ExtensionAPI | undefined;
		let inputs = 0;
		const delivered = Promise.withResolvers<SendUserMessageResult>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input", () => {
						inputs++;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const before = harness.sessionManager.getEntries();
		const rejected = expect(delivered.promise).rejects.toMatchObject({
			name: "UserMessageMetadataError",
			code: "INPUT_METADATA_SOURCE_MISMATCH",
		});
		setImmediate(() => {
			void api!.sendUserMessage("outside input", { metadata: {} }).then(delivered.resolve, delivered.reject);
		});
		await rejected;
		expect(inputs).toBe(0);
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #7883 / pi#187: bind module evaluation, not only the default exported factory.
	it("preserves the source of a timer scheduled by extension module evaluation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		harnesses.push(harness);
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<SendUserMessageResult>();
		const shared = globalThis as typeof globalThis & {
			pi187ModuleWake?: {
				release: Promise<void>;
				delivered: typeof delivered;
				api?: ExtensionAPI;
			};
		};
		shared.pi187ModuleWake = { release: release.promise, delivered };
		const file = join(harness.tempDir, "module-wake.ts");
		writeFileSync(
			file,
			`
const bridge = globalThis.pi187ModuleWake;
setTimeout(async () => {
  await bridge.release;
  bridge.api.sendUserMessage("module timer", { metadata: {} }).then(bridge.delivered.resolve, bridge.delivered.reject);
}, 0);
export default function (pi) { bridge.api = pi; }
`,
		);
		try {
			const runtime = createExtensionRuntime();
			const loaded = await loadExtensions([file], harness.tempDir, createEventBus(), runtime);
			expect(loaded.errors).toEqual([]);
			runtime.sendUserMessage = (content, options) => {
				if (!options?.metadata) throw new Error("Expected metadata options");
				return harness.session.sendUserMessage(
					content,
					options as typeof options & { metadata: UserMessageMetadata },
				);
			};
			release.resolve();
			expect(await delivered.promise).toMatchObject({ metadataSource: { kind: "extension", extensionPath: file } });
		} finally {
			release.resolve();
			delete shared.pi187ModuleWake;
		}
	});

	// #7883 / pi#187: exercise every stored callback field, not only action handlers.
	it("binds renderers, tool preparation/rendering, command completions and all provider methods", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		harnesses.push(harness);
		const runtime = createExtensionRuntime();
		runtime.sendUserMessage = (content, options) => {
			if (!options?.metadata) throw new Error("Expected metadata options");
			return harness.session.sendUserMessage(content, options as typeof options & { metadata: UserMessageMetadata });
		};
		const stop = new Error("callback completed");
		let receipt: Promise<SendUserMessageResult> | undefined;
		let expectedReceiver: object | undefined;
		let originalNative: Provider | undefined;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				function submit(this: unknown): never {
					if (expectedReceiver) expect(this).toBe(expectedReceiver);
					receipt = pi.sendUserMessage("callback input", { metadata: {} });
					throw stop;
				}
				pi.registerTool({
					name: "bound",
					label: "bound",
					description: "bound",
					parameters: {},
					execute: submit,
					prepareArguments: submit,
					prepareLoadout: submit,
					renderCall: submit,
					renderResult: submit,
				});
				pi.registerCommand("bound", { handler: submit, getArgumentCompletions: submit });
				pi.registerShortcut("ctrl+shift+x", { handler: submit });
				pi.registerFlag("bound", { type: "boolean", default: true });
				pi.registerMessageRenderer("bound", submit);
				pi.registerEntryRenderer("bound", submit);
				pi.registerUserMessageRenderer(submit);
				pi.registerMarkdownTransformer(submit);
				pi.on("agent_start", submit);
				pi.registerToolRenderer(() => ({ renderCall: submit, renderResult: submit }));
				pi.registerToolRenderer(submit);
				pi.registerVirtualModel({ provider: "bound", id: "virtual", name: "bound", route: submit });
				const legacy: ProviderConfig = {
					streamSimple: submit,
					refreshModels: submit,
					images: { "bound-images": { generateImages: submit } },
					classifiers: { "bound-classifier": { classify: submit } },
					oauth: { name: "bound", login: submit, refreshToken: submit, getApiKey: submit, modifyModels: submit },
				};
				pi.registerProvider("bound-legacy", legacy);
				const native: Provider = {
					id: "bound-native",
					name: "bound-native",
					auth: {
						apiKey: { name: "bound", login: submit, check: submit, resolve: submit },
						oauth: { name: "bound", login: submit, refresh: submit, toAuth: submit },
					},
					getModels: submit,
					getAllModels: submit,
					refreshModels: submit,
					filterModels: submit,
					filterAllModels: submit,
					stream: submit,
					streamSimple: submit,
					fetchDeferred: submit,
					cancelDeferred: submit,
					generateImages: submit,
					classify: submit,
				};
				originalNative = native;
				pi.registerProvider(native);
			},
			harness.tempDir,
			createEventBus(),
			runtime,
			extensionPath,
		);
		const legacy = runtime.pendingProviderRegistrations[0]!.config;
		const native = runtime.pendingNativeProviderRegistrations[0]!.provider;
		runtime.createContext = () => harness.session.extensionRunner.createContext();
		const resolver = extension.toolRenderers![0]!;
		const resolved = resolver("bound", () => undefined)!;
		const groups: object[] = [
			extension.tools.get("bound")!.definition,
			extension.commands.get("bound")!,
			extension.shortcuts.get("ctrl+shift+x")!,
			resolved,
			legacy,
			legacy.oauth!,
			legacy.images!["bound-images"]!,
			legacy.classifiers!["bound-classifier"]!,
			native,
			native.auth.apiKey!,
			native.auth.oauth!,
		];
		const callbacks: Array<{ name: string; callback: (...args: never[]) => unknown }> = [];
		for (const group of groups) {
			for (const [name, value] of Object.entries(group)) {
				if (typeof value === "function") callbacks.push({ name, callback: value as (...args: never[]) => unknown });
			}
		}
		for (const [name, callback] of [
			["message renderer", extension.messageRenderers.get("bound")!],
			["entry renderer", extension.entryRenderers!.get("bound")!],
			["user renderer", extension.userMessageRenderer!],
			["markdown transformer", extension.markdownTransformer!],
			["event handler", extension.handlers.get("agent_start")![0]!],
			["tool renderer resolver", extension.toolRenderers![1]!],
			["virtual-model route", runtime.pendingVirtualModelRegistrations[0]!.definition.route],
		] as const)
			callbacks.push({ name, callback: callback as (...args: never[]) => unknown });
		expect(callbacks).toHaveLength(42);
		for (const { name, callback } of callbacks) {
			receipt = undefined;
			expectedReceiver = name === "getModels" ? originalNative : undefined;
			expect(() => callback.call(name === "getModels" ? native : undefined), name).toThrow(stop);
			expect(receipt, name).toBeInstanceOf(Promise);
			expect(await receipt!, name).toMatchObject({ status: "handled", metadataSource: source });
		}
		expect(harness.faux.state.callCount).toBe(0);
	});
});
