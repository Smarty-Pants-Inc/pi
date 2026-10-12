import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type {
	ExtensionAPI,
	ReplacedSessionContext,
	SendUserMessageResult,
} from "../../../src/core/extensions/types.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const extensionPath = "/extensions/replacement-metadata.ts";

describe("#7883 / pi#187 round 3 replacement metadata contexts", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.session.waitForIdle();
			harness.cleanup();
		}
	});

	// #7883 / pi#187 SEC P1: every replacement command uses the same fresh-context send route.
	it.each(
		(["newSession", "fork", "switchSession"] as const).flatMap((flow) =>
			[false, true].map((handled) => [flow, handled] as const),
		),
	)("stamps %s withSession input as extension (handled=%s)", async (flow, handled) => {
		let runtime: AgentSessionRuntime;
		let receipt: SendUserMessageResult | undefined;
		let fresh: ReplacedSessionContext | undefined;
		let originalFile = "";
		const construct = async (sessionManager?: SessionManager): Promise<Harness> => {
			const harness = await createHarness({
				persistSession: true,
				sessionManager,
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					{
						path: extensionPath,
						factory: (pi) => {
							pi.on("input", (event, ctx) => {
								expect(ctx).not.toHaveProperty("sendUserMessage");
								if (handled && event.text === "replacement input") return { action: "handled" };
							});
							pi.registerCommand("replace", {
								handler: async (_args, ctx) => {
									expect(ctx).not.toHaveProperty("sendUserMessage");
									const withSession = async (receiving: ReplacedSessionContext) => {
										fresh = receiving;
										await Promise.resolve();
										receipt = await receiving.sendUserMessage("replacement input", { metadata: { flow } });
									};
									if (flow === "newSession") await ctx.newSession({ withSession });
									else if (flow === "fork")
										await ctx.fork(ctx.sessionManager.getLeafId()!, { position: "at", withSession });
									else await ctx.switchSession(originalFile, { withSession });
								},
							});
						},
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("reply")]);
			return harness;
		};
		const initial = await construct();
		const servicesFor = (harness: Harness) => ({
			cwd: harness.tempDir,
			agentDir: initial.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		});
		runtime = new AgentSessionRuntime(initial.session, servicesFor(initial), async ({ sessionManager }) => {
			const receiving = await construct(sessionManager);
			return {
				session: receiving.session,
				services: servicesFor(receiving),
				diagnostics: [],
				extensionsResult: receiving.session.resourceLoader.getExtensions(),
			};
		});
		const rebind = async (session: AgentSession) =>
			session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: (options) => runtime.newSession(options),
					fork: (id, options) => runtime.fork(id, options),
					switchSession: (file, options) => runtime.switchSession(file, options),
					navigateTree: (id, options) => session.navigateTree(id, options),
					reload: () => session.reload(),
				},
			});
		runtime.setRebindSession(rebind);
		await rebind(initial.session);
		await initial.session.prompt("seed");
		originalFile = initial.session.sessionFile!;
		await initial.session.prompt("/replace");
		await runtime.session.waitForIdle();
		expect(fresh).toBeDefined();
		expect(receipt).toMatchObject({
			status: handled ? "handled" : "turnStarted",
			metadata: { flow },
			metadataSource: { kind: "extension", extensionPath },
		});
		if (!handled)
			expect(runtime.session.sessionManager.getEntry(receipt!.entryId!)).toMatchObject({
				metadataSource: { kind: "extension", extensionPath },
			});
		await expect(fresh!.sendUserMessage("outside fresh context", { metadata: {} })).rejects.toMatchObject({
			code: "INPUT_METADATA_SOURCE_MISMATCH",
		});
	});

	// #7883 / pi#187 SEC P1: a fresh-context object is not a transferable extension identity.
	it("rejects borrowed replacement contexts and contexts created without a binding", async () => {
		let a: ExtensionAPI | undefined;
		let b: ExtensionAPI | undefined;
		let receiving: ReplacedSessionContext | undefined;
		let borrowed: Promise<SendUserMessageResult> | undefined;
		let session: AgentSession;
		const harness = await createHarness({
			extensionFactories: [
				{
					path: "/extensions/A.ts",
					factory: (pi) => {
						a = pi;
						pi.events.on("capture-context", () => {
							receiving = session.createReplacedSessionContext();
						});
					},
				},
				{
					path: "/extensions/B.ts",
					factory: (pi) => {
						b = pi;
						pi.events.on("borrow-context", () => {
							borrowed = receiving!.sendUserMessage("borrowed input", { metadata: {} });
						});
					},
				},
			],
		});
		harnesses.push(harness);
		session = harness.session;
		a!.events.emit("capture-context", undefined);
		b!.events.emit("borrow-context", undefined);
		await expect(borrowed).rejects.toMatchObject({ code: "INPUT_METADATA_SOURCE_MISMATCH" });
		await expect(
			session.createReplacedSessionContext().sendUserMessage("unbound input", { metadata: {} }),
		).rejects.toMatchObject({ code: "INPUT_METADATA_SOURCE_MISMATCH" });
		expect(session.inputAdmissionCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
