import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

type JsonlLineReaderOptions = {
	getMaxBufferedBytes?: () => number | undefined;
	onBufferOverflow?: () => void;
};

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing. A buffer limit drops unframed input before
 * invoking its overflow callback.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: JsonlLineReaderOptions = {},
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let bufferedBytes = 0;
	let stopped = false;
	const trackBufferedBytes = options.getMaxBufferedBytes !== undefined;

	const resetBuffer = () => {
		buffer = "";
		bufferedBytes = 0;
	};

	const exceedsBufferLimit = (additionalBytes = 0) => {
		const maxBufferedBytes = options.getMaxBufferedBytes?.();
		if (maxBufferedBytes === undefined || bufferedBytes + additionalBytes <= maxBufferedBytes) return false;
		stopped = true;
		resetBuffer();
		options.onBufferOverflow?.();
		return true;
	};

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		if (stopped) return;
		const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		const value = typeof chunk === "string" ? chunk : decoder.write(chunk);
		buffer += value;
		if (trackBufferedBytes) {
			bufferedBytes += chunkBytes;
		}

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				break;
			}

			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (trackBufferedBytes) {
				bufferedBytes = Math.max(0, bufferedBytes - Buffer.byteLength(line) - 1);
			}
			emitLine(line);
		}

		if (trackBufferedBytes) {
			exceedsBufferLimit();
		}
	};

	const onEnd = () => {
		if (stopped) return;
		buffer += decoder.end();
		if (exceedsBufferLimit()) return;
		if (buffer.length > 0) {
			const line = buffer;
			resetBuffer();
			emitLine(line);
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
