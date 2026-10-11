// Value-free provider callbacks (smarty-dev#5822 C1). Callbacks run outside the message projector, so they
// receive only Pi-owned values: a validated HTTP status and a fixed stream notification. No raw event, response
// header, model object or exception text reaches them.

import type { AssistantMessage, ProviderResponse, ProviderStreamNotification, StreamOptions } from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "./diagnostics.ts";
import { validHttpStatus } from "./recovery.ts";

/** Diagnostic type of a rejected stream observer. It is a control field: such a failure is never replayed. */
export const PROVIDER_STREAM_OBSERVER_ERROR = "provider_stream_observer_error";

/** Owned error text of a rejected stream observer; the observer's own exception text is never published. */
export const PROVIDER_STREAM_OBSERVER_FAILED = "Provider stream observer failed";

/** The response observation: the status only when it is an integer 100-599. */
export function providerResponse(status: unknown): ProviderResponse {
	const valid = validHttpStatus(status);
	return valid === undefined ? {} : { status: valid };
}

/** A fresh notification per call, so one observer cannot change what the next one receives. */
export function providerStreamNotification(): ProviderStreamNotification {
	return { type: "provider_stream_event" };
}

/** Record an observer rejection by its owned type only, without exception text, and make it non-retryable. */
export function markProviderStreamObserverFailure(output: AssistantMessage): void {
	appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic(PROVIDER_STREAM_OBSERVER_ERROR));
	output.recovery = { retryable: false };
}

/** Notify the observer of one parsed provider event. A rejection marks `output` and is rethrown. */
export async function notifyProviderStreamEvent(
	options: Pick<StreamOptions, "onProviderStreamEvent"> | undefined,
	output: AssistantMessage,
): Promise<void> {
	if (!options?.onProviderStreamEvent) return;
	try {
		await options.onProviderStreamEvent(providerStreamNotification());
	} catch (error) {
		markProviderStreamObserverFailure(output);
		throw new Error(PROVIDER_STREAM_OBSERVER_FAILED, { cause: error });
	}
}
