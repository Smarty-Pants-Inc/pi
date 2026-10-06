import { createHash, randomUUID } from "node:crypto";
import type { SubmitUserMessageOptions, UserMessageReceipt } from "./extensions/types.ts";

/** Keys are never evicted during a session, including across extension reloads. */
export const USER_MESSAGE_INGRESS_CAPACITY = 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ID_BYTES = 256;
const MAX_RESERVED_PAYLOAD_BYTES = 8 * 1024 * 1024;

type RejectionReason = NonNullable<UserMessageReceipt["reason"]>;

/** Private prompt admission observer; not an extension-provided callback. */
export interface UserMessageAdmission {
	readonly signal: AbortSignal;
	check(): void;
	accept(status: "accepted" | "queued"): void;
	refuse(reason: RejectionReason): void;
}

// Retain only bounded history, never the caller's unchecked request-generation echo.
type AdmissionOutcome =
	| { status: "rejected"; reason: RejectionReason }
	| { status: "accepted" | "queued"; admittedSessionGeneration: string };

interface Reservation {
	textFingerprint: Buffer;
	receipt: Promise<AdmissionOutcome>;
}

function receiptFor(outcome: AdmissionOutcome, requestGeneration: string, duplicate?: true): UserMessageReceipt {
	return {
		status: outcome.status,
		sessionGeneration: requestGeneration,
		...(outcome.status === "rejected"
			? { reason: outcome.reason }
			: duplicate
				? { admittedSessionGeneration: outcome.admittedSessionGeneration }
				: {}),
		...(duplicate ? { duplicate } : {}),
	};
}

function fingerprint(text: string): Buffer {
	// Preserve exact JS code units, including distinct unpaired surrogates.
	return createHash("sha256").update(text, "utf16le").digest();
}

/** Session-owned, bounded at-most-once reservations and generation fence. */
export class UserMessageIngress {
	private _generation = randomUUID();
	private generationCancellation = new AbortController();
	private readonly shutdownSignal: AbortSignal;
	private readonly reservations = new Map<string, Reservation>();
	private reservedPayloadBytes = 0;
	private closedReason?: RejectionReason;
	private suspensionDepth = 0;
	private runtimeAvailable = true;

	constructor(shutdownSignal: AbortSignal) {
		this.shutdownSignal = shutdownSignal;
	}

	get generation(): string {
		return this._generation;
	}

	assertOpen(): void {
		if (this.closedReason || this.shutdownSignal.aborted) throw new Error("User message ingress closed");
	}

	suspend(): void {
		this.suspensionDepth++;
		this.invalidate("session_changed");
	}

	resume(): void {
		if (this.suspensionDepth > 0) this.suspensionDepth--;
	}

	/** Failed reloads stay closed independently of active transition suspensions. */
	setRuntimeAvailable(available: boolean): void {
		this.runtimeAvailable = available;
	}

	invalidate(reason: "session_changed" | "shutting_down" | "no_session", close = false): void {
		const previous = this.generationCancellation;
		this._generation = randomUUID();
		this.generationCancellation = new AbortController();
		if (close) this.closedReason = reason;
		previous.abort(reason);
	}

	async submit(
		request: SubmitUserMessageOptions,
		run: (request: SubmitUserMessageOptions, admission: UserMessageAdmission) => Promise<void>,
	): Promise<UserMessageReceipt> {
		const requestGeneration = typeof request?.sessionGeneration === "string" ? request.sessionGeneration : "";
		const rejected = (reason: RejectionReason): UserMessageReceipt => ({
			status: "rejected",
			sessionGeneration: requestGeneration,
			reason,
		});
		if (
			!request ||
			typeof request.registrationEpoch !== "string" ||
			!request.registrationEpoch ||
			typeof request.requestId !== "string" ||
			!request.requestId ||
			typeof request.sessionGeneration !== "string" ||
			typeof request.text !== "string" ||
			request.deliverAs !== "followUp" ||
			request.expandPromptTemplates !== false
		) {
			return rejected("unsupported");
		}
		// Capture plain data before a hook can mutate the caller's object.
		request = { ...request };
		const textBytes = Buffer.byteLength(request.text, "utf8");
		const epochBytes = Buffer.byteLength(request.registrationEpoch, "utf8");
		const idBytes = Buffer.byteLength(request.requestId, "utf8");
		// Oversized correlation fields cannot be retained as a bounded key.
		if (epochBytes > MAX_ID_BYTES || idBytes > MAX_ID_BYTES) return rejected("admission_refused");
		const key = JSON.stringify([request.registrationEpoch, request.requestId]);
		const existing = this.reservations.get(key);
		if (existing) {
			if (!existing.textFingerprint.equals(fingerprint(request.text))) return rejected("payload_mismatch");
			return receiptFor(await existing.receipt, requestGeneration, true);
		}
		if (this.reservations.size >= USER_MESSAGE_INGRESS_CAPACITY) return rejected("admission_refused");

		const bytes = textBytes + epochBytes + idBytes;
		const withinPayloadBudget =
			textBytes <= MAX_TEXT_BYTES && this.reservedPayloadBytes + bytes <= MAX_RESERVED_PAYLOAD_BYTES;
		const generation = this.generation;
		const signal = AbortSignal.any([this.generationCancellation.signal, this.shutdownSignal]);
		let resolve!: (outcome: AdmissionOutcome) => void;
		const receipt = new Promise<AdmissionOutcome>((done) => {
			resolve = done;
		});
		let settled = false;
		const settle = (value: AdmissionOutcome) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", cancelled);
			resolve(value);
		};
		const cancelled = () =>
			settle({ status: "rejected", reason: this.shutdownSignal.aborted ? "shutting_down" : "session_changed" });
		// Reserve every bounded correlation key before lifecycle, size, or budget refusal.
		this.reservations.set(key, { textFingerprint: fingerprint(request.text), receipt });
		if (withinPayloadBudget) this.reservedPayloadBytes += bytes;
		signal.addEventListener("abort", cancelled, { once: true });

		let refusal: RejectionReason | undefined;
		if (this.shutdownSignal.aborted) refusal = "shutting_down";
		else if (this.closedReason) refusal = this.closedReason;
		else if (!this.runtimeAvailable || this.suspensionDepth > 0 || request.sessionGeneration !== this.generation) {
			refusal = "session_changed";
		} else if (!withinPayloadBudget) refusal = "admission_refused";
		if (refusal) {
			settle({ status: "rejected", reason: refusal });
			return receiptFor(await receipt, requestGeneration);
		}

		const admission: UserMessageAdmission = {
			signal,
			check: () => {
				signal.throwIfAborted();
				if (generation !== this.generation || this.closedReason) throw new Error("User message session changed");
			},
			accept: (status) => settle({ status, admittedSessionGeneration: generation }),
			refuse: (reason) => settle({ status: "rejected", reason }),
		};
		void run(request, admission).then(
			() => admission.refuse("admission_refused"),
			() => {
				if (signal.aborted) cancelled();
				else admission.refuse("admission_refused");
			},
		);
		return receiptFor(await receipt, requestGeneration);
	}
}
