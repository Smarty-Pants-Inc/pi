import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type PromptOptions } from "../../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../src/core/agent-session-runtime.ts";
import type { BoundaryResult, ExtensionFactory } from "../../src/core/extensions/index.ts";
import { HOST_CAPABILITIES } from "../../src/core/host-capabilities.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const gatesToRelease: Array<() => void> = [];

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	gatesToRelease.push(release);
	return { promise, release };
}

// smarty-dev#3048: native accounting must bracket earlier handlers and the actual enqueue boundary.
describe("native input admission v1", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	afterEach(async () => {
		for (const release of gatesToRelease.splice(0)) release();
		for (const session of sessions.splice(0).reverse()) {
			await session.abort();
			session.clearQueue();
			session.dispose();
		}
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.session.abort();
			harness.session.clearQueue();
			harness.cleanup();
		}
	});

	async function setup(extensionFactories: ExtensionFactory[] = [], persistSession = false) {
		const harness = await createHarness({
			extensionFactories,
			persistSession,
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		return harness;
	}

	async function runtimeFor(harness: Harness, extensionFactories: ExtensionFactory[] = []) {
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const extensionsResult = await createTestExtensionsResult(extensionFactories, cwd);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "faux-key",
					streamFn: streamSimple,
					convertToLlm,
					initialState: { model: harness.getModel(), tools: [] },
				}),
				cwd,
				sessionManager,
				sessionStartEvent,
				settingsManager: harness.settingsManager,
				modelRuntime: harness.session.modelRuntime,
				resourceLoader,
			});
			sessions.push(session);
			return { session, extensionsResult, services: { ...services, cwd, resourceLoader }, diagnostics: [] };
		};
		return new AgentSessionRuntime(harness.session, services, factory);
	}

	it.each(["prompt", "steer", "followUp", "sendUserMessage"] as const)(
		"counts %s synchronously before an earlier handler",
		async (entry) => {
			const held = gate();
			const h = await setup([
				(pi) => {
					pi.on("input", async () => {
						await held.promise;
						return { action: "handled" };
					});
				},
			]);
			const input = h.session[entry]("held");
			expect(h.session.inputAdmissionCount).toBe(1);
			expect(h.session.pendingMessageCount).toBe(1);
			expect(h.session.isPromptPending).toBe(true);
			expect(h.session.isIdle).toBe(false);
			let idle = false;
			const wait = h.session.waitForIdle().then(() => {
				idle = true;
			});
			await Promise.resolve();
			expect(idle).toBe(false);
			held.release();
			await input;
			await wait;
			expect(h.session.inputAdmissionCount).toBe(0);
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.isIdle).toBe(true);
		},
	);

	it("tracks concurrent input independently through handled short-circuit and transformed images", async () => {
		const first = gate();
		const second = gate();
		const seen: string[] = [];
		const images: ImageContent[] = [{ type: "image", data: "original", mimeType: "image/png" }];
		const replacement: ImageContent[] = [{ type: "image", data: "replacement", mimeType: "image/jpeg" }];
		const h = await setup([
			(pi) => {
				pi.on("input", async (event) => {
					await (event.text === "handled" ? first.promise : second.promise);
					return event.text === "handled"
						? { action: "handled" }
						: { action: "transform", text: "transformed", images: replacement };
				});
			},
			(pi) => {
				pi.on("input", (event) => {
					seen.push(event.text);
				});
			},
		]);
		const handled = h.session.steer("handled");
		const transformed = h.session.followUp("transform", images);
		expect(h.session.inputAdmissionCount).toBe(2);
		first.release();
		await handled;
		expect(h.session.inputAdmissionCount).toBe(1);
		expect(h.session.isIdle).toBe(false);
		expect(seen).toEqual([]);
		second.release();
		await transformed;
		expect(seen).toEqual(["transformed"]);
		expect(h.session.inputAdmissionCount).toBe(0);
		expect(h.session.pendingMessageCount).toBe(1);
		expect(h.session.agent.peekQueuedMessages()).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "transformed" }, ...replacement] },
		]);
		expect(h.session.clearQueue()).toEqual({ steering: [], followUp: ["transformed"] });
	});

	it("reports handler exceptions, continues, and releases admission at actual enqueue", async () => {
		const held = gate();
		const errors: string[] = [];
		const h = await setup([
			(pi) => {
				pi.on("input", async () => {
					await held.promise;
					throw new Error("hook failure");
				});
			},
		]);
		h.session.extensionRunner.onError((event) => {
			errors.push(event.error);
		});
		const input = h.session.steer("survives exception");
		expect(h.session.inputAdmissionCount).toBe(1);
		held.release();
		await input;
		expect(errors).toContain("hook failure");
		expect(h.session.inputAdmissionCount).toBe(0);
		expect(h.session.getSteeringMessages()).toEqual(["survives exception"]);
	});

	it.each(["prompt", "steer", "followUp", "sendUserMessage"] as const)(
		"abort rejects held %s and late completion cannot enqueue",
		async (entry) => {
			const held = gate();
			const h = await setup([
				(pi) => {
					pi.on("input", async () => {
						await held.promise;
						return { action: "transform", text: "too late" };
					});
				},
			]);
			const input = h.session[entry]("held");
			const result = input.then(
				() => ({ success: true }),
				(error: unknown) => ({ error }),
			);
			await h.session.abort();
			const outcome = await Promise.race([
				result,
				new Promise<"pending">((resolve) => {
					setTimeout(() => resolve("pending"), 100);
				}),
			]);
			expect(outcome).toMatchObject({
				error: expect.objectContaining({ message: expect.stringContaining("INPUT_ADMISSION_ABORTED") }),
			});
			expect(h.session.isIdle).toBe(true);
			held.release();
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.agent.peekQueuedMessages()).toEqual([]);
			expect(getUserTexts(h)).toEqual([]);
		},
	);

	it.each(["new", "switch", "fork", "dispose", "direct-dispose"] as const)(
		"refuses %s while an earlier handler owns input, without losing later acknowledgement",
		async (operation) => {
			const held = gate();
			const h = await setup([
				(pi) => {
					pi.on("input", async () => {
						await held.promise;
						return { action: "continue" };
					});
				},
			]);
			const runtime = await runtimeFor(h);
			const input = h.session.followUp("must survive");
			if (operation === "direct-dispose") expect(() => h.session.dispose()).toThrow("INPUT_ADMISSION_BUSY");
			else {
				const replacement =
					operation === "new"
						? runtime.newSession()
						: operation === "switch"
							? runtime.switchSession("missing")
							: operation === "fork"
								? runtime.fork("missing")
								: runtime.dispose();
				await expect(replacement).rejects.toThrow("INPUT_ADMISSION_BUSY");
			}
			expect(runtime.session).toBe(h.session);
			expect(h.session.inputsFenced).toBe(false);
			held.release();
			await input;
			expect(h.session.getFollowUpMessages()).toEqual(["must survive"]);
			await expect(runtime.newSession()).rejects.toThrow("INPUT_ADMISSION_BUSY");
			expect(h.session.clearQueue().followUp).toEqual(["must survive"]);
			await runtime.newSession();
			await expect(h.session.followUp("stale")).rejects.toThrow("INPUT_ADMISSION_DISPOSED");
		},
	);

	it.each(["before-switch", "shutdown", "last-check"] as const)(
		"rejects arrivals during %s and keeps the fence through disposal",
		async (phase) => {
			const entered = gate();
			const held = gate();
			const extensions: ExtensionFactory[] = [
				(pi) => {
					const hold = async () => {
						entered.release();
						await held.promise;
					};
					if (phase === "before-switch") pi.on("session_before_switch", hold);
					else pi.on("session_shutdown", hold);
				},
			];
			const h = await setup(phase === "last-check" ? [] : extensions);
			const runtime = await runtimeFor(h);
			let lastArrival: Promise<unknown> | undefined;
			if (phase === "last-check")
				runtime.setBeforeSessionInvalidate(() => {
					// Receipt after the final extension check but before actual disposal.
					entered.release();
					lastArrival = h.session.followUp("last-gap").then(
						() => undefined,
						(error: unknown) => error,
					);
				});
			const replacement = phase === "before-switch" ? runtime.newSession() : runtime.dispose();
			await entered.promise;
			expect(h.session.inputsFenced).toBe(true);
			for (const entry of ["prompt", "steer", "followUp", "sendUserMessage"] as const) {
				await expect(h.session[entry]("late")).rejects.toThrow(/INPUT_ADMISSION_(FENCED|DISPOSED)/);
			}
			held.release();
			await replacement;
			if (lastArrival)
				expect(await lastArrival).toMatchObject({ message: expect.stringContaining("INPUT_ADMISSION_FENCED") });
			expect(h.session.inputsFenced).toBe(true);
			expect(h.session.agent.peekQueuedMessages()).toEqual([]);
			await expect(h.session.prompt("stale")).rejects.toThrow("INPUT_ADMISSION_DISPOSED");
		},
	);

	it("reopens on cancellation and cannot release another fence", async () => {
		const h = await setup([
			(pi) => {
				pi.on("session_before_switch", () => ({ cancel: true }));
			},
		]);
		const runtime = await runtimeFor(h);
		expect(await runtime.newSession()).toEqual({ cancelled: true });
		expect(h.session.inputsFenced).toBe(false);
		const releaseFirst = await h.session.fenceInputs();
		expect(h.session.inputsFenced).toBe(true);
		await expect(h.session.fenceInputs()).rejects.toThrow("INPUT_ADMISSION_FENCED");
		releaseFirst();
		const releaseSecond = await h.session.fenceInputs();
		releaseFirst();
		expect(h.session.inputsFenced).toBe(true);
		releaseSecond();
		await h.session.steer("retry works");
		expect(h.session.getSteeringMessages()).toEqual(["retry works"]);
	});

	it("reopens on a validation failure before disposal", async () => {
		const h = await setup();
		const runtime = await runtimeFor(h);
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
		expect(h.session.inputsFenced).toBe(false);
		await h.session.followUp("retry after failed replacement");
		expect(h.session.getFollowUpMessages()).toEqual(["retry after failed replacement"]);
	});

	it("exposes the host version and rejects fence acquisition while mode-owned TUI input waits", async () => {
		const h = await setup();
		expect(HOST_CAPABILITIES.inputAdmission).toBe(1);
		expect(h.session.capabilities.inputAdmission).toBe(1);
		let pending = true;
		await h.session.bindExtensions({ mode: "tui", hasPendingInput: () => pending });
		await expect(h.session.fenceInputs()).rejects.toThrow("INPUT_ADMISSION_BUSY");
		pending = false;
		const release = await h.session.fenceInputs();
		release();
	});

	it("counts image-bearing prompt through before_agent_start and releases at run dispatch", async () => {
		const held = gate();
		const started = gate();
		const h = await setup([
			(pi) => {
				pi.on("before_agent_start", async () => {
					started.release();
					await held.promise;
				});
			},
		]);
		h.setResponses([fauxAssistantMessage("done")]);
		const input = h.session.sendUserMessage([
			{ type: "text", text: "image prompt" },
			{
				type: "image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=",
				mimeType: "image/png",
			},
		]);
		await started.promise;
		expect(h.session.inputAdmissionCount).toBe(1);
		expect(h.session.isIdle).toBe(false);
		h.session.subscribe((event) => {
			if (event.type === "agent_start") expect(h.session.inputAdmissionCount).toBe(0);
		});
		held.release();
		await input;
		expect(getUserTexts(h)[0]).toContain("image prompt");
		expect(h.session.inputAdmissionCount).toBe(0);
	});

	it.each(["handled", "abort", "failure"] as const)(
		"settlement-deferred input stays admitted until %s, never acknowledged merely on scheduling",
		async (disposition) => {
			const settledStarted = gate();
			const settledHeld = gate();
			const h = await setup([
				(pi) => {
					pi.on("agent_settled", async () => {
						settledStarted.release();
						await settledHeld.promise;
					});
					if (disposition === "handled")
						pi.on("input", (event) => (event.text === "deferred" ? { action: "handled" } : undefined));
				},
			]);
			h.setResponses([fauxAssistantMessage("first")]);
			const run = h.session.prompt("start");
			await settledStarted.promise;
			const deferred = h.session.prompt("deferred");
			const result = deferred.then(
				() => ({ success: true }),
				(error: unknown) => ({ error }),
			);
			let completed = false;
			void result.then(() => {
				completed = true;
			});
			await Promise.resolve();
			expect(completed).toBe(false);
			expect(h.session.inputAdmissionCount).toBe(1);
			await expect(h.session.fenceInputs()).rejects.toThrow("INPUT_ADMISSION_BUSY");
			if (disposition === "abort") {
				await h.session.abort();
				expect(await result).toMatchObject({
					error: expect.objectContaining({ message: expect.stringContaining("INPUT_ADMISSION_ABORTED") }),
				});
				expect(h.session.inputAdmissionCount).toBe(0);
			} else if (disposition === "failure") {
				vi.spyOn(h.session.agent, "prompt").mockImplementation(() => {
					throw new Error("deferred dispatch failed");
				});
			}
			settledHeld.release();
			await run;
			expect(await result).toMatchObject(
				disposition === "handled" ? { success: true } : { error: expect.any(Error) },
			);
			expect(h.session.inputAdmissionCount).toBe(0);
			expect(getUserTexts(h)).toEqual(["start"]);
		},
	);

	it("shutdown closes native admission before abort and returns both complete queues before disposal", async () => {
		const held = gate();
		const h = await setup([
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === "held") await held.promise;
				});
			},
		]);
		const runtime = await runtimeFor(h);
		await h.session.steer("queued steer");
		await h.session.followUp("queued follow-up");
		const input = h.session.followUp("held").then(
			() => undefined,
			(error: unknown) => error,
		);
		const receipt = vi.fn();
		const disposing = runtime.dispose({ rejectQueuedInput: receipt });
		expect(h.session.inputsFenced).toBe(true);
		await expect(h.session.sendUserMessage("after shutdown fence")).rejects.toThrow("INPUT_ADMISSION_FENCED");
		expect(await input).toMatchObject({ message: expect.stringContaining("INPUT_ADMISSION_ABORTED") });
		await disposing;
		expect(receipt).toHaveBeenCalledOnce();
		expect(receipt.mock.calls[0]?.[0]).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "queued steer" }] },
			{ role: "user", content: [{ type: "text", text: "queued follow-up" }] },
		]);
		expect(h.session.isDisposed).toBe(true);
		held.release();
		expect(h.session.agent.getQueuedMessages()).toEqual([]);
	});

	it("a failed authoritative receipt cannot clear queued input or leave admission sealed", async () => {
		const h = await setup();
		await h.session.steer("not receipted");
		await expect(
			h.session.fenceInputs({
				rejectQueuedInput: () => {
					throw new Error("receipt failed");
				},
			}),
		).rejects.toThrow("receipt failed");
		expect(h.session.inputsFenced).toBe(false);
		expect(h.session.getSteeringMessages()).toEqual(["not receipted"]);
	});

	it("only acknowledges a prompt after native dispatch, not after a failed final dispatch check", async () => {
		const h = await setup();
		const preflight = vi.fn();
		const prompt = vi.spyOn(h.session.agent, "prompt").mockImplementation(() => {
			throw new Error("dispatch failed");
		});
		await expect(h.session.prompt("fail", { preflightResult: preflight })).rejects.toThrow("dispatch failed");
		expect(preflight).not.toHaveBeenCalledWith(true);
		expect(prompt).toHaveBeenCalledOnce();
		expect(h.session.inputAdmissionCount).toBe(0);
	});

	// smarty-dev#3048, PR #110 F2/S1: shutdown cancels non-dialog settlement, not just input.
	it("orderly shutdown cancels and joins held settlement before returning attached queues", async () => {
		const entered = gate();
		const held = gate();
		const h = await setup([
			(pi) => {
				pi.on("agent_settled", async () => {
					entered.release();
					await held.promise;
				});
			},
		]);
		h.setResponses([fauxAssistantMessage("done")]);
		const runtime = await runtimeFor(h);
		const run = h.session.prompt("start");
		await entered.promise;
		const image: ImageContent = { type: "image", data: "attachment", mimeType: "image/png" };
		await h.session.steer("undelivered", [image]);
		const receipt = vi.fn();
		await runtime.dispose({ rejectQueuedInput: receipt });
		await run;
		expect(h.session.isDisposed).toBe(true);
		expect(h.session.isSettling).toBe(false);
		expect(receipt.mock.calls[0]?.[0]).toEqual([
			expect.objectContaining({ content: [{ type: "text", text: "undelivered" }, image] }),
		]);
		held.release();
	});

	// smarty-dev#3048, PR #110 F3/S2: ownership covers factory, setup, rebind and callbacks.
	it.each(["factory", "setup", "rebind", "withSession"] as const)(
		"refuses overlapping lifecycle and external receiving input during %s",
		async (phase) => {
			const h = await setup();
			const runtime = await runtimeFor(h);
			const entered = gate();
			const held = gate();
			const hold = async () => {
				entered.release();
				await held.promise;
			};
			if (phase === "factory") {
				const factory = Reflect.get(runtime, "createRuntime") as CreateAgentSessionRuntimeFactory;
				Reflect.set(runtime, "createRuntime", async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
					await hold();
					return factory(options);
				});
			}
			if (phase === "rebind") runtime.setRebindSession(hold);
			const first = runtime.newSession({
				setup: phase === "setup" ? hold : undefined,
				withSession:
					phase === "withSession"
						? async (ctx) => {
								await ctx.sendUserMessage("callback-owned", { deliverAs: "followUp" });
								await hold();
							}
						: undefined,
			});
			await entered.promise;
			const receiving = runtime.session;
			await expect(runtime.dispose()).rejects.toThrow("INPUT_ADMISSION_BUSY");
			await expect(runtime.newSession()).rejects.toThrow("INPUT_ADMISSION_BUSY");
			if (phase !== "factory")
				await expect(receiving.followUp("external early")).rejects.toThrow("INPUT_ADMISSION_FENCED");
			held.release();
			await first;
			expect(runtime.session.isDisposed).toBe(false);
			expect(runtime.session.inputsFenced).toBe(false);
			if (phase === "withSession")
				expect(runtime.session.messages).toContainEqual(
					expect.objectContaining({ role: "user", content: [{ type: "text", text: "callback-owned" }] }),
				);
			await runtime.session.followUp("ready input");
			expect(runtime.session.getFollowUpMessages()).toContain("ready input");
		},
	);

	// smarty-dev#3048, PR #110 S4: terminal cancellation never publishes a late factory or leaves a receiving fence live.
	it.each(["factory", "publication", "setup", "rebind", "withSession"] as const)(
		"terminal shutdown cancels held %s and retires its receiving session",
		async (phase) => {
			const h = await setup();
			const runtime = await runtimeFor(h);
			const entered = gate(),
				held = gate(),
				finished = gate();
			const hold = async () => {
				entered.release();
				await held.promise;
			};
			const receipts: Array<{ messages: ReturnType<Agent["getQueuedMessages"]>; owner: AgentSession }> = [];
			let receiving: AgentSession | undefined;
			const factory = Reflect.get(runtime, "createRuntime") as CreateAgentSessionRuntimeFactory;
			Reflect.set(runtime, "createRuntime", async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				if (phase === "factory") await hold();
				const result = await factory(options);
				receiving = result.session;
				if (phase === "factory")
					await result.session.followUp("unpublished", [
						{ type: "image", data: "late-original", mimeType: "image/png" },
					]);
				if (phase === "publication") {
					const fence = result.session.fenceInputs.bind(result.session);
					let first = true;
					result.session.fenceInputs = async (fenceOptions) => {
						const release = await fence(fenceOptions);
						if (first) {
							first = false;
							entered.release();
							await held.promise;
						}
						return release;
					};
				}
				finished.release();
				return result;
			});
			if (phase === "rebind") runtime.setRebindSession(hold);
			const replacement = runtime
				.newSession({
					setup: phase === "setup" ? hold : undefined,
					withSession: phase === "withSession" ? hold : undefined,
				})
				.then(
					() => "completed",
					(error: unknown) => error,
				);
			await entered.promise;
			const shutdown = runtime
				.dispose({ terminal: true, rejectQueuedInput: (messages, owner) => receipts.push({ messages, owner }) })
				.then(
					() => "disposed",
					(error: unknown) => error,
				);
			// Publication fencing is native bounded work; release the artificial fence wait, not the extension holds.
			if (phase === "publication") held.release();
			const result = await Promise.race([
				shutdown,
				new Promise((resolve) => setTimeout(() => resolve("hung"), 150)),
			]);
			held.release();
			await finished.promise;
			await replacement;
			await vi.waitFor(() => expect(receiving?.isDisposed).toBe(true));
			expect(result).toBe("disposed");
			expect(runtime.inputsFenced).toBe(true);
			if (phase === "factory") {
				expect(runtime.session).toBe(h.session);
				expect(receipts).toEqual([
					{
						owner: receiving,
						messages: [
							expect.objectContaining({
								content: [
									{ type: "text", text: "unpublished" },
									{ type: "image", data: "late-original", mimeType: "image/png" },
								],
							}),
						],
					},
				]);
			}
			await expect(receiving!.followUp("late")).rejects.toThrow("INPUT_ADMISSION_DISPOSED");
		},
	);

	// smarty-dev#3048, PR #110 R2-1: a BUSY refusal cannot orphan the running settlement's controller.
	it("busy replacement still permits shutdown to cancel the original settlement", async () => {
		const entered = gate(),
			held = gate();
		const h = await setup([
			(pi) => {
				pi.on("agent_settled", async () => {
					entered.release();
					await held.promise;
				});
			},
		]);
		h.setResponses([fauxAssistantMessage("done")]);
		const runtime = await runtimeFor(h);
		const run = h.session.prompt("first");
		await entered.promise;
		await expect(runtime.newSession()).rejects.toThrow("INPUT_ADMISSION_BUSY");
		await h.session.followUp("attached", [{ type: "image", data: "original", mimeType: "image/png" }]);
		const receipt = vi.fn();
		const disposal = runtime.dispose({ rejectQueuedInput: receipt });
		const outcome = await Promise.race([
			disposal.then(() => "disposed"),
			new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 150)),
		]);
		held.release();
		await disposal;
		await run;
		expect(outcome).toBe("disposed");
		expect(receipt.mock.calls[0]?.[1]).toBe(h.session);
		expect(receipt.mock.calls[0]?.[0]).toEqual([
			expect.objectContaining({
				content: [
					{ type: "text", text: "attached" },
					{ type: "image", data: "original", mimeType: "image/png" },
				],
			}),
		]);
	});

	// smarty-dev#3048, PR #110 R2-5: the deferred submitter owns permission, not the draining run.
	it("awaited withSession input preserves its live permission across rebind settlement", async () => {
		const entered = gate(),
			held = gate();
		const h = await setup();
		h.setResponses([fauxAssistantMessage("first")]);
		const runtime = await runtimeFor(h, [
			(pi) => {
				pi.on("agent_settled", async () => {
					entered.release();
					await held.promise;
				});
				pi.on("input", (event) => (event.text === "second" ? { action: "handled" } : undefined));
			},
		]);
		let run: Promise<void> | undefined;
		runtime.setRebindSession(async (session) => {
			run = session.prompt("first");
			await entered.promise;
		});
		const callbackEntered = gate();
		const replacement = runtime.newSession({
			withSession: async (ctx) => {
				const input = ctx.sendUserMessage("second");
				callbackEntered.release();
				await input;
			},
		});
		await callbackEntered.promise;
		await expect(runtime.session.prompt("external")).rejects.toThrow("INPUT_ADMISSION_FENCED");
		held.release();
		await expect(replacement).resolves.toEqual({ cancelled: false });
		await run;
		expect(runtime.session.inputAdmissionCount).toBe(0);
	});
	// smarty-dev#3048 / PR #110 R3-2 (security R3-S2): cancellation rejects late proposals and continuation.
	it.each(["turn_end", "agent_before_settle"] as const)(
		"terminal cancellation discards late %s drafts and later handlers",
		async (boundary) => {
			const entered = gate(),
				held = gate(),
				finished = gate();
			const later = vi.fn();
			const h = await setup([
				(pi) => {
					const handler = async (): Promise<BoundaryResult> => {
						entered.release();
						await held.promise;
						finished.release();
						return {
							entries: [
								{
									type: "custom_message",
									customType: "late-boundary",
									content: "must not commit",
									display: false,
								},
							],
							continue: true,
						};
					};
					if (boundary === "turn_end") {
						pi.on("turn_end", handler);
						pi.on("turn_end", later);
					} else {
						pi.on("agent_before_settle", handler);
						pi.on("agent_before_settle", later);
					}
				},
			]);
			h.setResponses([fauxAssistantMessage("done")]);
			const runtime = await runtimeFor(h);
			const run = h.session.prompt("first");
			await entered.promise;
			const image: ImageContent = { type: "image", data: "original-boundary-queue", mimeType: "image/png" };
			await h.session.followUp("undelivered", [image]);
			const receipt = vi.fn();
			const disposal = runtime.dispose({ terminal: true, rejectQueuedInput: receipt });
			const result = await Promise.race([
				disposal.then(() => "disposed"),
				new Promise((resolve) => setTimeout(() => resolve("hung"), 150)),
			]);
			held.release();
			await finished.promise;
			await disposal;
			await run;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(result).toBe("disposed");
			expect(receipt.mock.calls[0]?.[0]).toEqual([
				expect.objectContaining({ content: [{ type: "text", text: "undelivered" }, image] }),
			]);
			expect(h.sessionManager.getEntries().some((entry) => JSON.stringify(entry).includes("late-boundary"))).toBe(
				false,
			);
			expect(later).not.toHaveBeenCalled();
			expect(getUserTexts(h)).toEqual(["first"]);
		},
	);

	// smarty-dev#3048 / PR #110 R3-9 (security R3-S1): a live settlement retains its controller across release.
	it.each([true, false])(
		"successful replacement fence preserves settlement cancellation (cancel: %s)",
		async (cancel) => {
			const runEntered = gate(),
				runHeld = gate(),
				switchEntered = gate(),
				switchHeld = gate(),
				settlementEntered = gate(),
				settlementHeld = gate();
			const h = await setup([
				(pi) => {
					pi.on("agent_start", async () => {
						runEntered.release();
						await runHeld.promise;
					});
					pi.on("session_before_switch", async () => {
						switchEntered.release();
						await switchHeld.promise;
						return { cancel };
					});
					pi.on("agent_settled", async () => {
						settlementEntered.release();
						await settlementHeld.promise;
					});
				},
			]);
			h.setResponses([fauxAssistantMessage("done")]);
			const runtime = await runtimeFor(h);
			const run = h.session.prompt("first");
			await runEntered.promise;
			const replacement = runtime.newSession().then(
				(value) => value,
				(error: unknown) => error,
			);
			await switchEntered.promise;
			runHeld.release();
			await settlementEntered.promise;
			switchHeld.release();
			expect(await replacement).toMatchObject(
				cancel ? { cancelled: true } : { message: expect.stringContaining("INPUT_ADMISSION_BUSY") },
			);
			const disposal = runtime.dispose({ terminal: true, rejectQueuedInput: () => {} });
			const result = await Promise.race([
				disposal.then(() => "disposed"),
				new Promise((resolve) => setTimeout(() => resolve("hung"), 150)),
			]);
			settlementHeld.release();
			await disposal;
			await run;
			expect(result).toBe("disposed");
		},
	);

	function createMode(h: Harness, runtime: AgentSessionRuntime) {
		const terminalCancellation = Reflect.get(InteractiveMode.prototype, "isTerminalRuntimeCancellation") as (
			this: unknown,
			error: unknown,
		) => boolean;
		const recover = Reflect.get(InteractiveMode.prototype, "handleInputAdmissionError") as (
			this: unknown,
			error: unknown,
		) => boolean;
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		let editorText = "";
		const submitEditorPrompt = Reflect.get(InteractiveMode.prototype, "submitEditorPrompt") as (
			this: unknown,
			text: string,
			behavior?: "steer" | "followUp",
		) => Promise<void>;
		const restoreRejectedInput = Reflect.get(InteractiveMode.prototype, "restoreRejectedInput") as (
			this: unknown,
			text: string,
		) => void;
		const checkShutdownRequested = Reflect.get(InteractiveMode.prototype, "checkShutdownRequested") as (
			this: unknown,
		) => Promise<void>;
		const promptWithRecoveredImages = Reflect.get(InteractiveMode.prototype, "promptWithRecoveredImages") as (
			this: unknown,
			text: string,
			options?: PromptOptions,
		) => Promise<void>;
		return {
			recoveredImages: new Map<string, ImageContent>(),
			prepareRecoveredInput: Reflect.get(InteractiveMode.prototype, "prepareRecoveredInput") as (
				text: string,
				images?: ImageContent[],
			) => { text: string; images: ImageContent[] | undefined; transferred: () => void },
			promptWithRecoveredImages(text: string, options?: PromptOptions) {
				return promptWithRecoveredImages.call(this, text, options);
			},
			session: h.session,
			runtimeHost: runtime,
			defaultEditor,
			editor: {
				setText: vi.fn((text: string) => {
					editorText = text;
				}),
				getText: () => editorText,
				addToHistory: vi.fn(),
			},
			submitEditorPrompt(text: string, behavior?: "steer" | "followUp") {
				return submitEditorPrompt.call(this, text, behavior);
			},
			restoreRejectedInput(text: string) {
				restoreRejectedInput.call(this, text);
			},
			checkShutdownRequested() {
				return checkShutdownRequested.call(this);
			},
			pendingUserInputs: [] as string[],
			showError: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal TUI error");
			}),
			isTerminalRuntimeCancellation(error: unknown): boolean {
				return terminalCancellation.call(this, error);
			},
			handleInputAdmissionError(error: unknown): boolean {
				return recover.call(this, error);
			},
			themeController: { disableAutoSync: vi.fn() },
			ui: { requestRender: vi.fn(), terminal: { drainInput: vi.fn(async () => {}) } },
			stop: vi.fn(),
			isShuttingDown: false,
			shutdownRequested: false,
			stagingAudit: () => {},
		};
	}

	it("TUI streaming submit survives a busy /new without a fatal exit or dropped acknowledgement", async () => {
		const runStarted = gate();
		const runHeld = gate();
		const inputStarted = gate();
		const inputHeld = gate();
		const h = await setup([
			(pi) => {
				pi.on("agent_start", async () => {
					runStarted.release();
					await runHeld.promise;
				});
				pi.on("input", async (event) => {
					if (event.text === "held TUI input") {
						inputStarted.release();
						await inputHeld.promise;
					}
				});
			},
		]);
		h.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("followed")]);
		const runtime = await runtimeFor(h);
		const mode = createMode(h, runtime);
		const install = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: unknown) => void;
		const clear = Reflect.get(InteractiveMode.prototype, "handleClearCommand") as (this: unknown) => Promise<void>;
		install.call(mode);
		const run = h.session.prompt("start");
		await runStarted.promise;
		const submit = mode.defaultEditor.onSubmit!("held TUI input");
		await inputStarted.promise;
		await clear.call(mode);
		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("INPUT_ADMISSION_BUSY"));
		expect(mode.handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(runtime.session).toBe(h.session);
		inputHeld.release();
		await submit;
		expect(h.session.getSteeringMessages()).toEqual(["held TUI input"]);
		runHeld.release();
		await run;
		expect(getUserTexts(h)).toContain("held TUI input");
	});

	it("TUI submit after the replacement fence stays in the editor with explicit rejection", async () => {
		const h = await setup();
		const runtime = await runtimeFor(h);
		const mode = createMode(h, runtime);
		const install = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: unknown) => void;
		install.call(mode);
		const release = await h.session.fenceInputs();
		await mode.defaultEditor.onSubmit!("late editor input");
		expect(mode.editor.setText).toHaveBeenCalledWith("late editor input");
		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("INPUT_ADMISSION_FENCED"));
		expect(mode.pendingUserInputs).toEqual([]);
		expect(h.session.inputAdmissionCount).toBe(0);
		release();
	});

	// smarty-dev#3048, PR #110 F6: rejection cannot overwrite a newer draft.
	it.each(["steer", "followUp"] as const)(
		"TUI %s recovery keeps both newer draft and rejected submission",
		async (behavior) => {
			const runStarted = gate(),
				runHeld = gate(),
				inputStarted = gate(),
				inputHeld = gate();
			const h = await setup([
				(pi) => {
					pi.on("agent_start", async () => {
						runStarted.release();
						await runHeld.promise;
					});
					pi.on("input", async (event) => {
						if (event.text === "submission-A") {
							inputStarted.release();
							await inputHeld.promise;
						}
					});
				},
			]);
			h.setResponses([fauxAssistantMessage("done")]);
			const runtime = await runtimeFor(h);
			const mode = createMode(h, runtime);
			const install = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: unknown) => void;
			const follow = Reflect.get(InteractiveMode.prototype, "handleFollowUp") as (this: unknown) => Promise<void>;
			install.call(mode);
			const run = h.session.prompt("start");
			await runStarted.promise;
			mode.editor.setText("submission-A");
			const submit = behavior === "steer" ? mode.defaultEditor.onSubmit!("submission-A") : follow.call(mode);
			await inputStarted.promise;
			mode.editor.setText("newer-draft-B");
			const abort = h.session.abort();
			await submit;
			expect(mode.editor.getText()).toBe("newer-draft-B\nsubmission-A");
			runHeld.release();
			await abort;
			await run;
		},
	);

	// smarty-dev#3048, PR #110 F6: Alt+Enter must share Enter's fence policy.
	it("TUI Alt+Enter keeps editor text during a replacement fence", async () => {
		const h = await setup();
		const runtime = await runtimeFor(h);
		const mode = createMode(h, runtime);
		mode.editor.setText("late-follow-up");
		const release = await h.session.fenceInputs();
		const follow = Reflect.get(InteractiveMode.prototype, "handleFollowUp") as (this: unknown) => Promise<void>;
		await follow.call(mode);
		expect(mode.editor.getText()).toBe("late-follow-up");
		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("INPUT_ADMISSION_FENCED"));
		release();
	});

	it("TUI mode-owned submitted input blocks /new before native prompt handoff", async () => {
		const h = await setup();
		const runtime = await runtimeFor(h);
		const mode = createMode(h, runtime);
		const install = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: unknown) => void;
		const clear = Reflect.get(InteractiveMode.prototype, "handleClearCommand") as (this: unknown) => Promise<void>;
		await h.session.bindExtensions({ mode: "tui", hasPendingInput: () => mode.pendingUserInputs.length > 0 });
		install.call(mode);
		await mode.defaultEditor.onSubmit!("pending editor handoff");
		await clear.call(mode);
		expect(runtime.session).toBe(h.session);
		expect(mode.pendingUserInputs).toEqual(["pending editor handoff"]);
		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("INPUT_ADMISSION_BUSY"));
		expect(mode.handleFatalRuntimeError).not.toHaveBeenCalled();
		mode.pendingUserInputs.length = 0;
	});

	it("TUI shutdown refuses admitted input before stopping the terminal", async () => {
		const held = gate();
		const h = await setup([
			(pi) => {
				pi.on("input", async () => {
					await held.promise;
				});
			},
		]);
		const runtime = await runtimeFor(h);
		const mode = createMode(h, runtime);
		const shutdown = Reflect.get(InteractiveMode.prototype, "shutdown") as (this: unknown) => Promise<void>;
		const input = h.session.followUp("pending quit");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			await shutdown.call(mode);
		} finally {
			exit.mockRestore();
		}
		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("INPUT_ADMISSION_BUSY"));
		expect(mode.stop).not.toHaveBeenCalled();
		expect(mode.ui.terminal.drainInput).not.toHaveBeenCalled();
		expect(mode.isShuttingDown).toBe(false);
		held.release();
		await input;
		expect(h.session.getFollowUpMessages()).toEqual(["pending quit"]);
	});

	it("TUI terminal-drain await is inside the native disposal fence", async () => {
		const entered = gate();
		const held = gate();
		const h = await setup();
		const runtime = await runtimeFor(h);
		const mode = createMode(h, runtime);
		mode.ui.terminal.drainInput.mockImplementation(async () => {
			entered.release();
			await held.promise;
		});
		const shutdown = Reflect.get(InteractiveMode.prototype, "shutdown") as (this: unknown) => Promise<void>;
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const quitting = shutdown.call(mode);
		try {
			await entered.promise;
			await expect(h.session.steer("late drain input")).rejects.toThrow("INPUT_ADMISSION_FENCED");
			held.release();
			await quitting;
			expect(mode.stop).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(0);
		} finally {
			held.release();
			await quitting;
			exit.mockRestore();
		}
	});

	it("releases extension command input when handled so the command can replace its session", async () => {
		const commandHarness = await setup([
			(pi) => {
				pi.registerCommand("replace", {
					handler: async (_args, ctx) => {
						await ctx.newSession();
					},
				});
			},
		]);
		const commandRuntime = await runtimeFor(commandHarness);
		await commandHarness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => commandHarness.session.waitForIdle(),
				newSession: (options) => commandRuntime.newSession(options),
				fork: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				reload: async () => {},
			},
		});
		await commandHarness.session.prompt("/replace");
		expect(commandRuntime.session).not.toBe(commandHarness.session);
		expect(commandHarness.session.inputAdmissionCount).toBe(0);
	});
});
