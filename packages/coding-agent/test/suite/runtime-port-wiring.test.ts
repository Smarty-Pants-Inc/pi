import {
	type ClassifierModel,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	type ImageModel,
	lazyStream,
	type ModelsRequestTransforms,
	normalizeContext,
	ProviderRequestLimitError,
	type ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";
import { afterEach, describe, expect, it } from "vitest";
import { type BashExecutionMessage, bashExecutionToText, convertToLlm } from "../../src/core/messages.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const operations = [
	"stream",
	"complete",
	"streamSimple",
	"completeSimple",
	"streamDeferred",
	"fetchDeferred",
	"cancelDeferred",
	"generateImages",
	"classify",
] as const;
type Operation = (typeof operations)[number];
type AttemptOptions = Pick<ProviderRequestOptions, "beforeProviderRequest" | "signal" | "maxRetries">;

function createBudget(limit: number, order: string[] = []) {
	const cancellation = new AbortController();
	let requests = 0;
	const guard: NonNullable<ModelRuntime["providerRequestGuard"]> = {
		signal: cancellation.signal,
		beforeProviderRequest: () => {
			order.push("guard");
			if (requests >= limit) {
				const error = new ProviderRequestLimitError(requests, limit);
				cancellation.abort(error);
				throw error;
			}
			requests++;
		},
	};
	return {
		guard,
		cancellation,
		get requests() {
			return requests;
		},
	};
}

// The faux adapter deliberately has no physical-request admission. These synthetic transports
// use the real AI retry helper, so a runtime-only counter or a missing forwarded hook fails here.
async function createPortHarness(harnesses: Harness[]) {
	const harness = await createHarness({ settings: { retry: { enabled: false }, compaction: { enabled: false } } });
	harnesses.push(harness);
	const runtime = harness.modelRuntime;
	const faux = fauxProvider({ provider: "runtime-port-wiring" });
	const chat = faux.getModel();
	const image: ImageModel<string> = { ...chat, id: "image", type: "image", output: ["image"] };
	const classifier: ClassifierModel<string> = { ...chat, id: "classifier", type: "classifier" };
	const attempts: string[] = [];
	const observed: Array<{ kind: string; options: AttemptOptions | undefined }> = [];
	let failures = 0;

	async function attempt<T>(kind: string, options: AttemptOptions | undefined, run: () => T | Promise<T>): Promise<T> {
		observed.push({ kind, options });
		return retryProviderRequest(
			async () => {
				attempts.push(kind);
				if (failures > 0) {
					failures--;
					throw Object.assign(new Error("Synthetic 503"), {
						status: 503,
						headers: new Headers({ "retry-after-ms": "0" }),
					});
				}
				return run();
			},
			{ ...options, maxRetries: options?.maxRetries ?? 2 },
		);
	}

	runtime.registerNativeProvider(
		createProvider({
			id: chat.provider,
			auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "synthetic-secret" } }) } },
			models: [chat, image, classifier],
			api: {
				stream: (model, context, options) =>
					lazyStream(model, async () =>
						attempt("stream", options, () => faux.provider.stream(model, context, options)),
					),
				streamSimple: (model, context, options) =>
					lazyStream(model, async () =>
						attempt("streamSimple", options, () => faux.provider.streamSimple(model, context, options)),
					),
				fetchDeferred: (model, _handle, options) =>
					lazyStream(model, async () =>
						attempt("fetchDeferred", options, () =>
							faux.provider.streamSimple(model, normalizeContext({ messages: [] }), options),
						),
					),
				cancelDeferred: (_model, _handle, options) => attempt("cancelDeferred", options, () => undefined),
			},
			images: {
				[image.api]: {
					generateImages: (model, _context, options) =>
						attempt("generateImages", options, () => ({
							api: model.api,
							provider: model.provider,
							model: model.id,
							output: [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }],
							stopReason: "stop" as const,
							timestamp: 0,
						})),
				},
			},
			classifiers: {
				[classifier.api]: {
					classify: (model, _context, options) =>
						attempt("classify", options, () => ({
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: { approved: { type: "bool" as const, probability: 0.9 } },
							stopReason: "stop" as const,
							timestamp: 0,
						})),
				},
			},
		}),
	);
	await runtime.refresh({ allowNetwork: false, providers: [chat.provider] });
	faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("synthetic success")));
	return {
		harness,
		runtime,
		faux,
		chat,
		image,
		classifier,
		attempts,
		observed,
		failNextAttempts(count: number) {
			failures = count;
		},
	};
}

type PortHarness = Awaited<ReturnType<typeof createPortHarness>>;

async function dispatch(port: PortHarness, operation: Operation, options?: AttemptOptions & ModelsRequestTransforms) {
	const { runtime, chat } = port;
	const context = { messages: [] };
	const handle = { provider: chat.provider, modelId: chat.id, api: chat.api, id: "synthetic-deferred" };
	switch (operation) {
		case "stream":
			return runtime.stream(chat, context, { ...options }).result();
		case "complete":
			return runtime.complete(chat, context, { ...options });
		case "streamSimple":
			return runtime.streamSimple(chat, context, options).result();
		case "completeSimple":
			return runtime.completeSimple(chat, context, options);
		case "streamDeferred":
			return runtime.streamDeferred(chat, handle, options).result();
		case "fetchDeferred":
			return runtime.fetchDeferred(chat, handle, options);
		case "cancelDeferred":
			await runtime.cancelDeferred(chat, handle, options);
			return { stopReason: "stop" as const };
		case "generateImages":
			return runtime.generateImages(port.image, { input: [] }, options);
		case "classify":
			return runtime.classify(
				port.classifier,
				{
					state: {},
					questions: {
						approved: { type: "bool", instructions: "Approve?", criteria: { true: "yes", false: "no" } },
					},
				},
				options,
			);
	}
}

describe("runtime port physical request wiring", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it.each(operations)("%s admits within limit, blocks excess, and permits unguarded requests", async (operation) => {
		const port = await createPortHarness(harnesses);
		const order: string[] = [];
		const budget = createBudget(1, order);
		const caller = new AbortController();
		const options = {
			signal: caller.signal,
			beforeProviderRequest: () => {
				order.push("caller");
			},
		};
		port.runtime.providerRequestGuard = budget.guard;

		expect((await dispatch(port, operation, options)).stopReason).toBe("stop");
		expect(port.attempts).toHaveLength(1);
		expect(budget.requests).toBe(1);
		expect(order).toEqual(["guard", "caller"]);
		const effective = port.observed[0].options?.signal;
		expect(effective).toBeDefined();
		expect(effective).not.toBe(caller.signal);
		expect(effective?.aborted).toBe(false);

		if (operation === "cancelDeferred") {
			await expect(dispatch(port, operation, options)).rejects.toThrow("Provider request limit reached (1/1)");
		} else {
			expect((await dispatch(port, operation, options)).stopReason).toBe("error");
		}
		expect(port.attempts).toHaveLength(1);
		expect(budget.requests).toBe(1);
		expect(order).toEqual(["guard", "caller", "guard"]);
		expect(effective?.aborted).toBe(true);
		expect(effective?.reason).toBe(budget.cancellation.signal.reason);
		expect(caller.signal.aborted).toBe(false);

		port.runtime.providerRequestGuard = undefined;
		expect((await dispatch(port, operation, options)).stopReason).toBe("stop");
		expect(port.attempts).toHaveLength(2);
		expect(port.observed.at(-1)?.options?.signal).toBe(caller.signal);
		expect(port.observed.at(-1)?.options?.beforeProviderRequest).toBe(options.beforeProviderRequest);
		expect(order).toEqual(["guard", "caller", "guard", "caller"]);
	});

	it.each(operations)("%s counts physical retries, not just logical requests", async (operation) => {
		const port = await createPortHarness(harnesses);
		const order: string[] = [];
		const budget = createBudget(2, order);
		port.runtime.providerRequestGuard = budget.guard;
		port.failNextAttempts(2);
		const options = {
			maxRetries: 5,
			beforeProviderRequest: () => {
				order.push("caller");
			},
		};

		if (operation === "cancelDeferred") {
			await expect(dispatch(port, operation, options)).rejects.toThrow("Provider request limit reached (2/2)");
		} else {
			expect((await dispatch(port, operation, options)).stopReason).toBe("error");
		}
		expect(port.attempts).toHaveLength(2);
		expect(budget.requests).toBe(2);
		expect(order).toEqual(["guard", "caller", "guard", "caller", "guard"]);
		expect(port.observed[0].options?.signal).toBe(budget.guard.signal);
	});

	it("carries the shared guard on the AgentSession stream path and leaves the unguarded path usable", async () => {
		const port = await createPortHarness(harnesses);
		const budget = createBudget(1);
		const { session } = port.harness;
		session.agent.streamFunction = port.runtime.streamSimple.bind(port.runtime);
		await session.setModel(port.chat);
		port.runtime.providerRequestGuard = budget.guard;
		await session.prompt("guarded synthetic prompt");
		expect(getMessageText(session.messages.at(-1))).toBe("synthetic success");
		expect(budget.requests).toBe(1);
		port.runtime.providerRequestGuard = undefined;
		await session.prompt("unguarded synthetic prompt");
		expect(getMessageText(session.messages.at(-1))).toBe("synthetic success");
		expect(port.attempts).toEqual(["streamSimple", "streamSimple"]);
	});

	it.each(["completeSimple", "generateImages", "classify", "cancelDeferred"] as const)(
		"%s masks caller failures without rolling back consumed admission",
		async (operation) => {
			const port = await createPortHarness(harnesses);
			const budget = createBudget(1);
			port.runtime.providerRequestGuard = budget.guard;
			const options = {
				beforeProviderRequest: () => {
					throw new Error("synthetic refusal synthetic-secret", { cause: new Error("nested synthetic-secret") });
				},
			};
			let errorMessage: string | undefined;
			if (operation === "cancelDeferred") {
				try {
					await dispatch(port, operation, options);
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					errorMessage = error.message;
					expect(error.cause).toBeUndefined();
				}
			} else {
				const response = await dispatch(port, operation, options);
				expect(response.stopReason).toBe("error");
				if ("errorMessage" in response && typeof response.errorMessage === "string") {
					errorMessage = response.errorMessage;
				}
			}
			expect(errorMessage).toContain("synthetic refusal");
			expect(errorMessage).not.toContain("synthetic-secret");
			expect(budget.requests).toBe(1);
			expect(port.attempts).toEqual([]);
		},
	);

	it("allows a retried faux response to finish when the physical budget is sufficient", async () => {
		const port = await createPortHarness(harnesses);
		const budget = createBudget(2);
		port.runtime.providerRequestGuard = budget.guard;
		port.failNextAttempts(1);
		const response = await port.runtime.completeSimple(port.chat, { messages: [] });
		expect(response.stopReason).toBe("stop");
		expect(getMessageText(response)).toBe("synthetic success");
		expect(port.attempts).toHaveLength(2);
		expect(port.faux.state.callCount).toBe(1);
		expect(budget.requests).toBe(2);
		expect(budget.guard.signal.aborted).toBe(false);
	});

	it.each(["guard", "caller"] as const)("%s cancellation reaches transport only", async (source) => {
		const port = await createPortHarness(harnesses);
		const budget = createBudget(2);
		const caller = new AbortController();
		port.runtime.providerRequestGuard = budget.guard;
		expect((await dispatch(port, "completeSimple", { signal: caller.signal })).stopReason).toBe("stop");
		const effective = port.observed[0].options?.signal;
		const cancellation = source === "guard" ? budget.cancellation : caller;
		const other = source === "guard" ? caller : budget.cancellation;
		const reason = new Error("synthetic cancellation");
		cancellation.abort(reason);
		expect(effective?.aborted).toBe(true);
		expect(effective?.reason).toBe(reason);
		expect(other.signal.aborted).toBe(false);
	});

	it("does not admit a physical attempt when the shared signal was already aborted", async () => {
		const port = await createPortHarness(harnesses);
		const budget = createBudget(1);
		budget.cancellation.abort(new ProviderRequestLimitError(1, 1));
		port.runtime.providerRequestGuard = budget.guard;
		expect((await dispatch(port, "completeSimple")).stopReason).toBe("error");
		expect(port.attempts).toEqual([]);
		expect(budget.requests).toBe(0);
	});

	it("captures the guard before asynchronous auth/header preparation, without charging preparation", async () => {
		const port = await createPortHarness(harnesses);
		const original = createBudget(1);
		const replacement = createBudget(1);
		port.runtime.providerRequestGuard = original.guard;
		const response = await dispatch(port, "completeSimple", {
			transformHeaders: async (headers) => {
				expect(original.requests).toBe(0);
				port.runtime.providerRequestGuard = replacement.guard;
				return headers;
			},
		});
		expect(response.stopReason).toBe("stop");
		expect(original.requests).toBe(1);
		expect(replacement.requests).toBe(0);
	});

	it("routes once without leaking virtual-provider credentials to the physical provider", async () => {
		const port = await createPortHarness(harnesses);
		const budget = createBudget(1);
		port.runtime.providerRequestGuard = budget.guard;
		port.runtime.registerVirtualModel({
			provider: "virtual-port-wiring",
			id: "route",
			name: "Route",
			route: () => ({ model: port.chat, thinkingLevel: "off" }),
		});
		// Registration refreshes availability asynchronously; finish the current snapshot before routing (#3155).
		await port.runtime.refresh({ allowNetwork: false });
		expect(port.runtime.hasConfiguredAuth(port.chat.provider)).toBe(true);
		// Observe the actual physical request, not a separate auth lookup.
		port.faux.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBe("synthetic-secret");
				expect(options?.headers?.["X-Virtual"]).toBeUndefined();
				expect(options?.env?.VIRTUAL_SECRET).toBeUndefined();
				return fauxAssistantMessage("physical auth");
			},
		]);
		const virtual = port.runtime.getModel("virtual-port-wiring", "route")!;
		const response = await port.runtime.completeSimple(
			virtual,
			{ messages: [] },
			{ apiKey: "virtual-secret", headers: { "X-Virtual": "private" }, env: { VIRTUAL_SECRET: "private" } },
		);
		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(getMessageText(response)).toBe("physical auth");
		expect(port.faux.state.callCount).toBe(1);
		expect(budget.requests).toBe(1);
		expect(port.attempts).toEqual(["streamSimple"]);
	});

	it("keeps model policy refusal ahead of admission and provider dispatch", async () => {
		const port = await createPortHarness(harnesses);
		const budget = createBudget(1);
		port.runtime.providerRequestGuard = budget.guard;
		port.harness.settingsManager.applyOverrides({ modelPolicy: { allow: [] } });
		const dispose = port.runtime.addModelPolicy(port.harness.settingsManager);
		expect(() => port.runtime.streamSimple(port.chat, { messages: [] })).toThrow("not allowed by modelPolicy.allow");
		expect(budget.requests).toBe(0);
		expect(port.observed).toEqual([]);
		dispose();
		expect((await dispatch(port, "completeSimple")).stopReason).toBe("stop");
	});
});

describe("runtime port bash output notices", () => {
	const harnesses: Harness[] = [];
	const base: BashExecutionMessage = {
		role: "bashExecution",
		command: "synthetic",
		output: "preview",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
	};
	const truncation = { totalBytes: 4096, omittedBytes: 2048 };

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("renders an error-only output-log notice without claiming that a full log exists", () => {
		const message: BashExecutionMessage = { ...base, fullOutputError: "write failed for [output log]" };
		const text = bashExecutionToText(message);
		expect(text).toBe(
			"Ran `synthetic`\n```\npreview\n```\n\n[Output log unavailable: write failed for [output log]]",
		);
		expect(getMessageText(convertToLlm([message])[0])).toBe(text);
		expect(
			bashExecutionToText({
				...message,
				truncated: true,
				fullOutputPath: "stale.log",
				fullOutputTruncation: truncation,
			}),
		).toBe(text);
		expect(convertToLlm([{ ...message, excludeFromContext: true }])).toEqual([]);
	});

	it("preserves normal full and capped output-log text and metadata", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		for (const fullOutputTruncation of [undefined, truncation]) {
			harness.session.recordBashResult("synthetic", {
				output: "preview",
				exitCode: 0,
				cancelled: false,
				truncated: true,
				fullOutputPath: "synthetic.log",
				fullOutputTruncation,
			});
			const message = harness.session.messages.at(-1);
			if (message?.role !== "bashExecution") throw new Error("Missing bash message");
			expect(message.fullOutputPath).toBe("synthetic.log");
			expect(message.fullOutputTruncation).toEqual(fullOutputTruncation);
			expect(message.fullOutputError).toBeUndefined();
			const expected = fullOutputTruncation
				? "Output truncated. Capped log omits 2048 of 4096 bytes (2.0KB of 4.0KB); keeps first and last 1.0KB: synthetic.log"
				: "Output truncated. Full output: synthetic.log";
			expect(bashExecutionToText(message)).toBe(`Ran \`synthetic\`\n\`\`\`\npreview\n\`\`\`\n\n[${expected}]`);
		}
	});

	// Requires the companion AgentSession._appendBashResult hunk, owned by the parent.
	it("retains error-only metadata through AgentSession recording, persistence, and context rendering", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.recordBashResult("synthetic", {
			output: "preview",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputError: "write failed for [output log]",
		});
		const message = harness.session.messages.at(-1);
		if (message?.role !== "bashExecution") throw new Error("Missing bash message");
		expect(message.fullOutputError).toBe("write failed for [output log]");
		const entry = harness.sessionManager.getEntries().at(-1);
		if (entry?.type !== "message" || entry.message.role !== "bashExecution") {
			throw new Error("Missing persisted bash message");
		}
		expect(entry.message.fullOutputError).toBe(message.fullOutputError);
		expect(getMessageText(convertToLlm(harness.session.messages).at(-1))).toContain(
			"[Output log unavailable: write failed for [output log]]",
		);
	});
});
