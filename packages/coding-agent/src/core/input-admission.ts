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

	constructor(code: InputAdmissionErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "InputAdmissionError";
		this.code = code;
	}
}
