import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Stable rejection codes for native user-input admission and replacement. */
export type InputAdmissionErrorCode =
	| "INPUT_ADMISSION_BUSY"
	| "INPUT_ADMISSION_FENCED"
	| "INPUT_ADMISSION_DISPOSED"
	| "INPUT_ADMISSION_ABORTED"
	| "INPUT_ADMISSION_SHUTDOWN";

/** An authoritative refusal: retry replacement, or recover input; never assume acceptance. */
export class InputAdmissionError extends Error {
	readonly code: InputAdmissionErrorCode;
	/** Acknowledged input this refusal returns to the caller; it was not and will not be replayed. */
	readonly recoveredInput?: AgentMessage[];

	constructor(
		code: InputAdmissionErrorCode,
		detail: string,
		options?: { cause?: unknown; recoveredInput?: AgentMessage[] },
	) {
		super(`${code}: ${detail}`, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "InputAdmissionError";
		this.code = code;
		if (options?.recoveredInput) this.recoveredInput = options.recoveredInput;
	}
}
