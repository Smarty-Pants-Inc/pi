import { SETUP_MESSAGES } from "../auth/oauth/credential-response.ts";

export { SETUP_MESSAGES } from "../auth/oauth/credential-response.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** No caller text is accepted, including extra arguments from JavaScript callers. */
export class SafeSetupError extends Error {
	readonly code: keyof typeof SETUP_MESSAGES;

	constructor(code: keyof typeof SETUP_MESSAGES) {
		const allowed = typeof code === "string" && Object.hasOwn(SETUP_MESSAGES, code) ? code : "setup_ThrownValue";
		super(SETUP_MESSAGES[allowed]);
		this.name = "SafeSetupError";
		this.code = allowed;
	}
}

/** Callers surface `error.message` only, so keep the underlying reason in it. */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = (cause instanceof Error ? cause.message || cause.name : String(cause)).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}
