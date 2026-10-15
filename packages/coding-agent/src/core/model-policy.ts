import type { AnyModel } from "@earendil-works/pi-ai";

export interface ModelPolicySettings {
	/** Case-insensitive provider/model globs. Only * is special; an empty list denies all models. */
	allow: string[];
}

export type ModelPolicyTarget = Pick<AnyModel, "provider" | "id">;

/** A local policy refusal, before credentials or a provider request are resolved. */
export class ModelPolicyError extends Error {
	readonly provider: string;
	readonly modelId: string;

	constructor(model: ModelPolicyTarget) {
		super(`model ${model.provider}/${model.id} is not allowed by modelPolicy.allow`);
		this.name = "ModelPolicyError";
		this.provider = model.provider;
		this.modelId = model.id;
	}
}

/** Settings are not schema-validated on load: malformed policies fail closed. */
export function modelPolicyAllows(policy: unknown, model: ModelPolicyTarget): boolean {
	if (policy === undefined) return true;
	if (typeof policy !== "object" || policy === null || !("allow" in policy)) return false;
	const allow = policy.allow;
	if (!Array.isArray(allow) || !allow.every((pattern) => typeof pattern === "string")) return false;
	const reference = `${model.provider}/${model.id}`;
	return allow.some((pattern: string) => {
		const expression = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^(?:${expression})$`, "is").test(reference);
	});
}
