/**
 * Raw stdin bytes to parser text, with an exact byte offset (smarty-dev#2636).
 *
 * Problem: one read can hold `A`, Enter and `B`. A submit cut taken from the read's end would put B's
 * bytes in A's interval. So while a meter is attached, epoch bytes go to the parser one byte at a time
 * (characters are completed by a UTF-8 decoder): every sequence the parser emits synchronously ends
 * exactly at `offset`, and a timed-out flush ends at `offset` too, since all bytes fed so far are in it.
 */
import { StringDecoder } from "node:string_decoder";

/** Accounts raw bytes for one attested input epoch; the coding agent supplies it. */
export interface InputByteMeter {
	/** `preEpoch` bytes are outside any epoch; `epoch` bytes start at epoch offset `epochStart`. */
	push(chunk: Buffer): { preEpoch: Buffer; epoch: Buffer; epochStart: number };
	/** Bytes read before the terminal attached, in the same form. */
	takePending?(): { preEpoch: Buffer; epoch: Buffer; epochStart: number };
	/** The terminal stopped reading: the epoch is over. */
	end(): void;
}

export class MeteredInput {
	private readonly decoder = new StringDecoder("utf8");
	private readonly feed: (text: string) => void;
	private meter: InputByteMeter | undefined;
	private onUnmetered: (() => void) | undefined;
	private fed: number | undefined;

	constructor(feed: (text: string) => void) {
		this.feed = feed;
	}

	/** Epoch byte offset of all input given to the parser so far; undefined outside an epoch. */
	get offset(): number | undefined {
		return this.fed;
	}

	/**
	 * `onUnmetered` runs before `preEpoch` bytes reach the parser while a meter is attached: those bytes
	 * are in no attested interval, so the caller taints the draft they land in (pi#160 review).
	 */
	setMeter(meter: InputByteMeter | undefined, onUnmetered?: () => void): void {
		this.onUnmetered = onUnmetered;
		if (this.meter === meter) return;
		this.meter?.end();
		this.meter = meter;
		this.fed = undefined;
		const pending = meter?.takePending?.();
		if (pending) this.deliver(pending);
	}

	write(chunk: Buffer | string): void {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		if (!this.meter) {
			const text = this.decoder.write(bytes);
			if (text) this.feed(text);
			return;
		}
		this.deliver(this.meter.push(bytes));
	}

	private deliver(result: { preEpoch: Buffer; epoch: Buffer; epochStart: number }): void {
		if (result.preEpoch.length) {
			this.onUnmetered?.();
			const text = this.decoder.write(result.preEpoch);
			if (text) this.feed(text);
		}
		for (let i = 0; i < result.epoch.length; i++) {
			const text = this.decoder.write(result.epoch.subarray(i, i + 1));
			this.fed = result.epochStart + i + 1;
			if (text) this.feed(text);
		}
	}
}
