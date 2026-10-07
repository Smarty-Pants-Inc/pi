import { redactOAuthDiagnostic } from "../auth/oauth/credential-response.ts";
import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { formatThrownValue } from "./diagnostics.ts";
import { ModelsError, SafeSetupError } from "./models-error.ts";

/** The type of a model. Models without `type` are chat models. */
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}

/** Runtime-checked model type narrowing, including legacy chat models without `type`. */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat")) {
		throw new SafeSetupError("not_chat");
	}
}

export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
}

export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	if (!isModelType(model, "classifier")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
	}
}

/** Error text for a public non-chat result or rejection, masked with the request's live credentials. */
function operationErrorMessage(error: unknown, secrets: readonly string[]): string {
	try {
		return redactOAuthDiagnostic(formatThrownValue(error), secrets);
	} catch {
		// A hostile thrown value must not escape through its own accessors.
		return "operation failed";
	}
}

/** Mask a provider's own error result; it can echo the request key or headers. */
export function protectOperationResult<T extends { errorMessage?: string }>(result: T, secrets: readonly string[]): T {
	if (typeof result?.errorMessage !== "string") return result;
	return { ...result, errorMessage: operationErrorMessage(result.errorMessage, secrets) };
}

/**
 * A rejection that crosses the public API: keep only the masked message and name,
 * never the raw error, its cause or other properties. Value-free setup errors pass through.
 */
export function protectOperationError(error: unknown, secrets: readonly string[]): Error {
	try {
		if (error instanceof SafeSetupError) return error;
		const safe = new Error(operationErrorMessage(error, secrets));
		if (error instanceof Error && typeof error.name === "string" && error.name !== "Error") {
			safe.name = redactOAuthDiagnostic(error.name, secrets);
		}
		return safe;
	} catch {
		return new Error("operation failed");
	}
}

export function imageErrorResult(
	model: ImageModel<ImageApi>,
	error: unknown,
	aborted = false,
	secrets: readonly string[] = [],
): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: operationErrorMessage(error, secrets),
		timestamp: Date.now(),
	};
}

export function classifierErrorResult(
	model: ClassifierModel<ClassifierApi>,
	error: unknown,
	aborted = false,
	secrets: readonly string[] = [],
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: operationErrorMessage(error, secrets),
		timestamp: Date.now(),
	};
}
