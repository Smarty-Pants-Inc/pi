// Value-free callbacks run outside the projector; never pass raw events, headers, models or exceptions.
import type { AssistantMessage, ProviderResponse, ProviderStreamNotification, StreamOptions } from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "./diagnostics.ts";
import { validHttpStatus } from "./recovery.ts";

export const PROVIDER_STREAM_OBSERVER_ERROR = "provider_stream_observer_error";
export const PROVIDER_STREAM_OBSERVER_FAILED = "Provider stream observer failed";
export const PROVIDER_RESPONSE_OBSERVER_FAILED = "Provider response observer failed";
export function providerResponse(status: unknown): ProviderResponse {
	const valid = validHttpStatus(status);
	return valid === undefined ? {} : { status: valid };
}
export function providerStreamNotification(): ProviderStreamNotification {
	return { type: "provider_stream_event" };
}
export function markProviderStreamObserverFailure(output: AssistantMessage): void {
	appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic(PROVIDER_STREAM_OBSERVER_ERROR));
	output.recovery = { retryable: false };
}
/** Response observation shares the stream observer's terminal, non-replayable recovery. */
export async function notifyProviderResponse(
	options: Pick<StreamOptions, "onResponse"> | undefined,
	output: AssistantMessage,
	status: unknown,
): Promise<void> {
	if (!options?.onResponse) return;
	try {
		await options.onResponse(providerResponse(status));
	} catch {
		markProviderStreamObserverFailure(output);
		throw new Error(PROVIDER_RESPONSE_OBSERVER_FAILED);
	}
}
export async function notifyProviderStreamEvent(
	options: Pick<StreamOptions, "onProviderStreamEvent"> | undefined,
	output: AssistantMessage,
): Promise<void> {
	if (!options?.onProviderStreamEvent) return;
	try {
		await options.onProviderStreamEvent(providerStreamNotification());
	} catch {
		markProviderStreamObserverFailure(output);
		throw new Error(PROVIDER_STREAM_OBSERVER_FAILED);
	}
}
