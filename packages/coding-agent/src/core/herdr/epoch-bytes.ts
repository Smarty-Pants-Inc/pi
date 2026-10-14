/**
 * Raw stdin byte accounting for one Herdr epoch (smarty-dev#2636, decision 1).
 *
 * Offsets count bytes after the marker `ESC _ herdr-epoch;<nonce> ESC \`, from 0. A cut is a byte
 * count: the interval is [prevCut, cut), the digest is lowercase hex SHA-256 of exactly those bytes.
 * Example: marker then `41 0d 42 0d` in one read gives cut 2 (`A\r`) then cut 4 (`B\r`); B never
 * lands in A's interval, however the read was chunked.
 *
 * While enrolling, input is held (bounded) until the nonce is known. Bytes before the marker belong to
 * no epoch: they are still delivered to the editor (callers taint the draft), never dropped.
 */
import { createHash } from "node:crypto";

const MAX_HELD_BYTES = 64 * 1024;
const MAX_INTERVAL_BYTES = 1024 * 1024;

export interface PushResult {
	/** Bytes outside any epoch, to deliver as ordinary (unattributable) input. */
	readonly preEpoch: Buffer;
	/** Epoch bytes to deliver, starting at epoch offset `epochStart`. */
	readonly epoch: Buffer;
	readonly epochStart: number;
}

export interface Cut {
	readonly cut: number;
	readonly digest: string;
}

type State = "off" | "holding" | "armed" | "epoch" | "dead";

const EMPTY = Buffer.alloc(0);

export function epochMarker(nonce: string): Buffer {
	return Buffer.from(`\x1b_herdr-epoch;${nonce}\x1b\\`, "latin1");
}

export class EpochByteCounter {
	private state: State = "off";
	private held: Buffer = EMPTY;
	private marker: Buffer = EMPTY;
	private total = 0;
	private prevCut = 0;
	private interval: Buffer[] = [];
	private intervalBytes = 0;

	/** Start holding input before the enroll request is sent. */
	hold(): void {
		if (this.state === "off") this.state = "holding";
	}

	/** The enroll answer arrived: look for the marker in held and later input. */
	arm(nonce: string): PushResult {
		if (this.state !== "holding") return this.result(EMPTY, EMPTY);
		this.marker = epochMarker(nonce);
		this.state = "armed";
		return this.scan();
	}

	/** Enrollment failed or timed out: release held input as ordinary input, no epoch. */
	abandon(): PushResult {
		const preEpoch = this.state === "holding" || this.state === "armed" ? this.held : EMPTY;
		this.held = EMPTY;
		this.state = "dead";
		return this.result(preEpoch, EMPTY);
	}

	get active(): boolean {
		return this.state === "epoch";
	}

	/** Epoch bytes seen so far. */
	get offset(): number {
		return this.total;
	}

	push(chunk: Buffer): PushResult {
		if (this.state === "off" || this.state === "dead") return this.result(chunk, EMPTY);
		if (this.state === "epoch") return this.count(EMPTY, chunk);
		this.held = Buffer.concat([this.held, chunk]);
		if (this.held.length > MAX_HELD_BYTES) return this.abandon();
		return this.state === "armed" ? this.scan() : this.result(EMPTY, EMPTY);
	}

	/**
	 * Close the interval at epoch offset `end` (exclusive byte count). Undefined when the epoch is not
	 * active, `end` is not ahead of the previous cut or beyond the bytes seen, or the interval overflowed.
	 */
	cut(end: number): Cut | undefined {
		if (this.state !== "epoch" || !Number.isSafeInteger(end) || end <= this.prevCut || end > this.total)
			return undefined;
		const bytes = Buffer.concat(this.interval);
		const take = end - this.prevCut;
		const digest = createHash("sha256").update(bytes.subarray(0, take)).digest("hex");
		const rest = bytes.subarray(take);
		this.interval = rest.length ? [Buffer.from(rest)] : [];
		this.intervalBytes = rest.length;
		this.prevCut = end;
		return { cut: end, digest };
	}

	/** End the epoch (release, suspend, TTY handover, poisoned answer). Later input is ordinary. */
	end(): void {
		this.state = "dead";
		this.interval = [];
		this.intervalBytes = 0;
	}

	private scan(): PushResult {
		const at = this.held.indexOf(this.marker);
		if (at < 0) return this.result(EMPTY, EMPTY);
		const preEpoch = this.held.subarray(0, at);
		const after = this.held.subarray(at + this.marker.length);
		this.held = EMPTY;
		this.state = "epoch";
		return this.count(preEpoch, after);
	}

	private count(preEpoch: Buffer, epoch: Buffer): PushResult {
		const epochStart = this.total;
		this.total += epoch.length;
		if (epoch.length) {
			this.interval.push(Buffer.from(epoch));
			this.intervalBytes += epoch.length;
			// Herdr keeps at most 1 MiB per interval too; beyond it no cut can be attested.
			if (this.intervalBytes > MAX_INTERVAL_BYTES) this.end();
		}
		return { preEpoch, epoch, epochStart };
	}

	private result(preEpoch: Buffer, epoch: Buffer): PushResult {
		return { preEpoch, epoch, epochStart: this.total };
	}
}
