import { formatThrownValue } from "./diagnostics.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

const SETUP_MESSAGES = Object.freeze({
	auth: "Provider is not configured",
	provider: "Unknown provider",
	stream: "Provider has no API implementation",
	deferred: "Provider does not support deferred responses",
	not_chat: "Model is not a chat model",
	virtual_unrouted: "Virtual model must be routed before streaming",
	setup_ModelsError: "request setup failed: ModelsError",
	setup_TypeError: "request setup failed: TypeError",
	setup_RangeError: "request setup failed: RangeError",
	setup_SyntaxError: "request setup failed: SyntaxError",
	setup_ReferenceError: "request setup failed: ReferenceError",
	setup_URIError: "request setup failed: URIError",
	setup_EvalError: "request setup failed: EvalError",
	setup_Error: "request setup failed: Error",
	setup_ThrownValue: "request setup failed: ThrownValue",
});

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
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}
