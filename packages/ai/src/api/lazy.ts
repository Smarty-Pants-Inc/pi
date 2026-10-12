import { getRequestDiagnosticSecrets } from "../auth/oauth/credential-response.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream, protectAssistantMessageStream } from "../utils/event-stream.ts";
import { ModelsError, SafeSetupError } from "../utils/models-error.ts";

export { SafeSetupError } from "../utils/models-error.ts";

/** Classification itself is untrusted: instanceof and code access can invoke Proxy traps. */
export function requestSetupError(error: unknown, preserveCode = false): SafeSetupError {
	try {
		if (preserveCode && error instanceof SafeSetupError) return new SafeSetupError(error.code);
		if (error instanceof ModelsError) return new SafeSetupError("setup_ModelsError");
		if (error instanceof TypeError) return new SafeSetupError("setup_TypeError");
		if (error instanceof RangeError) return new SafeSetupError("setup_RangeError");
		if (error instanceof SyntaxError) return new SafeSetupError("setup_SyntaxError");
		if (error instanceof ReferenceError) return new SafeSetupError("setup_ReferenceError");
		if (error instanceof URIError) return new SafeSetupError("setup_URIError");
		if (error instanceof EvalError) return new SafeSetupError("setup_EvalError");
		if (error instanceof Error) return new SafeSetupError("setup_Error");
	} catch {
		// Never surface the trap's thrown value or attempt another classification.
	}
	return new SafeSetupError("setup_ThrownValue");
}

/**
 * Auth and request preparation fail with value-free `SafeSetupError` categories.
 * A provider's own setup error keeps its message: the stream's live-secret
 * protection masks it when it is pushed. A `ModelsError` can append a raw cause,
 * and other thrown values are untrusted, so both become fixed categories.
 */
function setupErrorText(error: unknown): string {
	try {
		if (error instanceof SafeSetupError) return new SafeSetupError(error.code).message;
		if (error instanceof Error && !(error instanceof ModelsError)) {
			const message = error.message;
			if (typeof message === "string" && message) return message;
		}
	} catch {
		// A Proxy trap or hostile accessor: fall through to a fixed category.
	}
	return requestSetupError(error).message;
}

function createSetupErrorMessage(model: Model<Api>, error: unknown, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: setupErrorText(error),
		timestamp,
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: (outer: AssistantMessageEventStream) => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const startedAt = Date.now();
	const outer = new AssistantMessageEventStream();

	// Setup can call `protectAssistantMessageStream(outer, ...)` once it has resolved request credentials,
	// so forwarded events of any provider implementation are masked here too.
	setup(outer)
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error, startedAt);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(model, async (outer) => {
				protectAssistantMessageStream(outer, getRequestDiagnosticSecrets(model, options));
				return (await load()).stream(model, context, options);
			}),
		streamSimple: (model, context, options) =>
			lazyStream(model, async (outer) => {
				protectAssistantMessageStream(outer, getRequestDiagnosticSecrets(model, options));
				return (await load()).streamSimple(model, context, options);
			}),
	};

	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async (outer) => {
				protectAssistantMessageStream(outer, getRequestDiagnosticSecrets(model, options));
				const implementation = await load();
				if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
