import type { WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createOutputFileStream } from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

/** Raw bytes of the start of the output kept in the full-output log. */
export const FULL_OUTPUT_HEAD_BYTES = 4 * 1024 * 1024;
/** Raw bytes of the end of the output kept in the full-output log. */
export const FULL_OUTPUT_TAIL_BYTES = 4 * 1024 * 1024;

export interface FullOutputTruncation {
	/** Raw bytes the command produced. */
	totalBytes: number;
	/** Raw bytes left out of the full-output log between its head and tail. */
	omittedBytes: number;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	/** Present only when the full-output log omits part of the output. */
	fullOutputTruncation?: FullOutputTruncation;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved. The temp file is capped: it streams the first
 * {@link FULL_OUTPUT_HEAD_BYTES} raw bytes, keeps the last
 * {@link FULL_OUTPUT_TAIL_BYTES} in memory, and writes them on close after a
 * marker naming the omitted byte count. Output that fits both is written
 * byte-identically.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileCompletion: Promise<Error | undefined> | undefined;
	/** Raw bytes routed to the log so far (head written plus tail candidates). */
	private logRoutedBytes = 0;
	private logHead: Buffer | undefined;
	private logTail: Buffer | undefined;
	private logTailBytes = 0;
	private logTailNext = 0;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFilePath || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.routeToLog(data);
		} else if (data.length > 0) {
			// Copy so a small view cannot pin a larger input buffer.
			this.rawChunks.push(Buffer.from(data));
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		const fullOutputTruncation = this.getFullOutputTruncation();
		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
			...(fullOutputTruncation ? { fullOutputTruncation } : {}),
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		const truncation = this.getFullOutputTruncation();
		if (!stream.destroyed) {
			if (this.logHead) stream.write(this.logHead.subarray(0, this.logRoutedBytes));
			if (truncation) {
				stream.write(
					`\n\n[... ${truncation.omittedBytes} bytes omitted from this log (output was ${truncation.totalBytes} bytes; first ${FULL_OUTPUT_HEAD_BYTES} and last ${FULL_OUTPUT_TAIL_BYTES} bytes kept) ...]\n\n`,
				);
			}
			if (this.logTail) {
				const start = this.logTailBytes === FULL_OUTPUT_TAIL_BYTES ? this.logTailNext : 0;
				stream.write(this.logTail.subarray(start, this.logTailBytes));
				if (start > 0) stream.write(this.logTail.subarray(0, start));
			}
		}
		this.logHead = undefined;
		this.logTail = undefined;
		this.logTailBytes = 0;
		stream.end();
		const error = await this.tempFileCompletion;
		if (error) throw error;
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker. When the log itself omits bytes, the
	 * result is truncated and the omitted count refers to the original raw output.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.tempFilePath) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		const file = await open(this.tempFilePath, "r");
		try {
			const size = (await file.stat()).size;
			const logTruncation = this.getFullOutputTruncation();
			if (size <= maxBytes) {
				const content = new TextDecoder().decode(await file.readFile());
				return { content, truncated: logTruncation !== undefined };
			}
			let headBytes = Math.floor(maxBytes / 2);
			let tailBytes = maxBytes - headBytes;
			if (logTruncation) {
				// Read only the kept head and tail, never the log's marker.
				headBytes = Math.min(headBytes, FULL_OUTPUT_HEAD_BYTES, size);
				tailBytes = Math.min(tailBytes, FULL_OUTPUT_TAIL_BYTES, size - headBytes);
			}
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = (logTruncation ? logTruncation.totalBytes : size) - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes ||
			this.totalDecodedBytes > this.maxBytes ||
			this.totalLines > this.maxLines ||
			// Bound bytes and chunk metadata even when the display limits are huge.
			this.totalRawBytes > FULL_OUTPUT_HEAD_BYTES ||
			this.rawChunks.length >= 1024
		);
	}

	private getFullOutputTruncation(): FullOutputTruncation | undefined {
		const omittedBytes = this.totalRawBytes - FULL_OUTPUT_HEAD_BYTES - FULL_OUTPUT_TAIL_BYTES;
		if (!this.tempFilePath || omittedBytes <= 0) return undefined;
		return { totalBytes: this.totalRawBytes, omittedBytes };
	}

	/** Fixed buffers bound payload and object overhead, including millions of tiny source chunks. */
	private routeToLog(data: Buffer): void {
		if (data.length === 0) return;
		let rest = data;
		const headRoom = FULL_OUTPUT_HEAD_BYTES - this.logRoutedBytes;
		if (headRoom > 0) {
			const head = rest.subarray(0, headRoom);
			this.logHead ??= Buffer.allocUnsafe(FULL_OUTPUT_HEAD_BYTES);
			head.copy(this.logHead, this.logRoutedBytes);
			rest = rest.subarray(head.length);
			if (head.length === headRoom) {
				this.tempFileStream?.write(this.logHead);
				this.logHead = undefined;
			}
		}
		this.logRoutedBytes += data.length;
		if (rest.length === 0) return;
		this.logTail ??= Buffer.allocUnsafe(FULL_OUTPUT_TAIL_BYTES);
		if (rest.length >= FULL_OUTPUT_TAIL_BYTES) {
			rest.copy(this.logTail, 0, rest.length - FULL_OUTPUT_TAIL_BYTES);
			this.logTailBytes = FULL_OUTPUT_TAIL_BYTES;
			this.logTailNext = 0;
			return;
		}
		const first = Math.min(rest.length, FULL_OUTPUT_TAIL_BYTES - this.logTailNext);
		rest.copy(this.logTail, this.logTailNext, 0, first);
		if (first < rest.length) rest.copy(this.logTail, 0, first);
		this.logTailNext = (this.logTailNext + rest.length) % FULL_OUTPUT_TAIL_BYTES;
		this.logTailBytes = Math.min(this.logTailBytes + rest.length, FULL_OUTPUT_TAIL_BYTES);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		const { path, stream } = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFilePath = path;
		this.tempFileStream = stream;
		// Capture even early open errors, then report them when the caller closes the file.
		this.tempFileCompletion = finished(this.tempFileStream).then(
			() => undefined,
			(error: Error) => error,
		);
		const chunks = this.rawChunks;
		this.rawChunks = [];
		for (const chunk of chunks) {
			this.routeToLog(chunk);
		}
	}
}
