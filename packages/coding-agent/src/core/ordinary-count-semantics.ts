import type { OrdinaryOwnerRecord } from "./ordinary-owner-policy.ts";

/** Independently admitted CI evidence for this exact application/provider/model.
 * Not an endpoint capability inferred from an HTTP success or integer response.
 * The named contract covers ALL inputs accepted by the pinned application’s
 * Responses projection, including tools, media, reasoning and structured output. */
export interface CountSemantics {
	readonly version: 1;
	readonly kind: "responses-count-semantics";
	readonly status: "qualified" | "unknown" | "unsupported";
	readonly contract: "responses-static-input-v1";
	readonly applicationSha256: string;
	readonly provider: string;
	readonly wireModel: string;
	readonly inferenceUrl: string;
	readonly countUrl: string;
	readonly purpose: string;
	readonly account: string;
	readonly notBeforeMs: number;
	readonly expiresMs: number;
	readonly evidenceSha256: string | null;
	readonly contextTokens: number | null;
	readonly maxOutputTokens: number | null;
}

/** Caller must first check the descriptor-held artifact against the protected
 * decision's semantics SHA. Parsing alone does not admit this statement. */
export function parseCountSemantics(bytes: Uint8Array, record: OrdinaryOwnerRecord): Readonly<CountSemantics> {
	if (!bytes.length || bytes.length > 65536 || !record.provider.count) throw new Error("OWNER_COUNT_SEMANTICS_SCOPE");
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	const keys = [
		"version",
		"kind",
		"status",
		"contract",
		"applicationSha256",
		"provider",
		"wireModel",
		"inferenceUrl",
		"countUrl",
		"purpose",
		"account",
		"notBeforeMs",
		"expiresMs",
		"evidenceSha256",
		"contextTokens",
		"maxOutputTokens",
	];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		`${JSON.stringify(value, null, 2)}\n` !== text
	)
		throw new Error("OWNER_COUNT_SEMANTICS_SHAPE");
	const v = value as Record<string, unknown>;
	const p = record.provider,
		count = p.count!;
	if (
		v.version !== 1 ||
		v.kind !== "responses-count-semantics" ||
		v.contract !== "responses-static-input-v1" ||
		!["qualified", "unknown", "unsupported"].includes(String(v.status)) ||
		v.applicationSha256 !== record.application.sha256 ||
		v.provider !== p.provider ||
		v.wireModel !== p.wireModel ||
		v.inferenceUrl !== p.url ||
		v.countUrl !== count.url ||
		v.purpose !== count.purpose ||
		v.account !== count.account ||
		typeof v.notBeforeMs !== "number" ||
		typeof v.expiresMs !== "number" ||
		!Number.isSafeInteger(v.notBeforeMs) ||
		!Number.isSafeInteger(v.expiresMs) ||
		v.notBeforeMs <= 0 ||
		v.expiresMs <= v.notBeforeMs ||
		(v.contextTokens !== null &&
			(typeof v.contextTokens !== "number" ||
				!Number.isSafeInteger(v.contextTokens) ||
				v.contextTokens <= 0 ||
				v.contextTokens > 2_000_000)) ||
		(v.maxOutputTokens !== null &&
			(typeof v.maxOutputTokens !== "number" ||
				!Number.isSafeInteger(v.maxOutputTokens) ||
				v.maxOutputTokens <= 0 ||
				v.maxOutputTokens > 2_000_000)) ||
		(v.evidenceSha256 !== null &&
			(typeof v.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.evidenceSha256))) ||
		(v.status === "qualified" &&
			(v.evidenceSha256 === null ||
				typeof v.contextTokens !== "number" ||
				typeof v.maxOutputTokens !== "number" ||
				v.contextTokens < p.contextTokens ||
				v.maxOutputTokens < p.outputTokens ||
				v.maxOutputTokens > v.contextTokens))
	)
		throw new Error("OWNER_COUNT_SEMANTICS_SCOPE");
	return Object.freeze(value as CountSemantics);
}

export function assertCountSemantics(value: Readonly<CountSemantics> | undefined, now: number): void {
	if (!value || value.status !== "qualified") throw new Error("OWNER_COUNT_SEMANTICS_UNQUALIFIED");
	if (!Number.isSafeInteger(now) || now < value.notBeforeMs || now >= value.expiresMs)
		throw new Error("OWNER_COUNT_SEMANTICS_STALE");
}
