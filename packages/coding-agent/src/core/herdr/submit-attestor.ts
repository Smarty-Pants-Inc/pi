/**
 * Editor-submit attestation (smarty-dev#2636, #1515 editor-submit seam).
 *
 * `capture` runs synchronously inside the editor's submit handler, before any await: it closes the
 * byte interval at the Enter's own byte end and sends the cut. The receipt resolves within the
 * admission wait (1 s); a slow or failed answer delivers the turn as `terminal`, never late-labelled.
 * The cut is sent for every submit, tainted or not, so the next interval starts clean.
 */
import { randomBytes } from "node:crypto";
import { captureKeyboardTurnReceipt, captureTerminalSubmitReceipt, type TurnReceipt } from "../turn-receipts.ts";
import type { EpochByteCounter } from "./epoch-bytes.ts";
import { attestedPrincipal, type HerdrEpoch } from "./input-consumer.ts";

export const ADMISSION_WAIT_MS = 1000;

export interface SubmitOptions {
	/** The draft was not purely typed or pasted, or a custom editor was in use. */
	readonly tainted: boolean;
	/** `discard` for built-in and extension slash commands and `!cmd`: they close the interval only. */
	readonly kind: "submit" | "discard";
}

export class SubmitAttestor {
	private readonly counter: EpochByteCounter;
	private readonly epoch: HerdrEpoch;
	private readonly waitMs: number;
	private seq = 0;

	constructor(counter: EpochByteCounter, epoch: HerdrEpoch, waitMs = ADMISSION_WAIT_MS) {
		this.counter = counter;
		this.epoch = epoch;
		this.waitMs = waitMs;
	}

	/** `offset`: the terminal's epoch byte offset at the submit key, undefined outside an epoch. */
	capture(offset: number | undefined, options: SubmitOptions): Promise<TurnReceipt> {
		const token = randomBytes(16).toString("hex");
		const receivedAt = new Date().toISOString();
		const terminal = () => captureTerminalSubmitReceipt(token);
		const cut = offset === undefined ? undefined : this.counter.cut(offset);
		if (!cut) return Promise.resolve(terminal());
		this.seq += 1;
		const answer = this.epoch.cut({ seq: this.seq, token, cut: cut.cut, digest: cut.digest, kind: options.kind });
		if (options.tainted || options.kind === "discard") return Promise.resolve(terminal());
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(terminal()), this.waitMs);
			answer.then(
				(result) => {
					clearTimeout(timer);
					const principal = attestedPrincipal(result);
					resolve(principal ? captureKeyboardTurnReceipt(principal.smartyId, token, receivedAt) : terminal());
				},
				() => {
					clearTimeout(timer);
					resolve(terminal());
				},
			);
		});
	}
}
