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
 *
 * The optional second `onLine` argument is the raw frame byte length, including a
 * terminating LF when present. It avoids charging decoded replacement text.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string, rawFramedByteLength?: number) => void,
	options: JsonlLineReaderOptions = {},
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let bufferedBytes = 0;
	let stopped = false;
	const completedLineByteLengths: number[] = [];
	let completedLineByteLengthIndex = 0;

	const resetBuffer = () => {
		buffer = "";
		bufferedBytes = 0;
	};

	const exceedsBufferLimit = () => {
		const maxBufferedBytes = options.getMaxBufferedBytes?.();
		if (maxBufferedBytes === undefined || bufferedBytes <= maxBufferedBytes) return false;
		stopped = true;
		resetBuffer();
		completedLineByteLengths.length = 0;
		completedLineByteLengthIndex = 0;
		options.onBufferOverflow?.();
		return true;
	};

	const onData = (chunk: string | Buffer) => {
		if (stopped) return;

		let start = 0;
		while (true) {
			const newlineIndex = typeof chunk === "string" ? chunk.indexOf("\n", start) : chunk.indexOf(0x0a, start);
			if (newlineIndex === -1) break;

			bufferedBytes +=
				typeof chunk === "string" ? Buffer.byteLength(chunk.slice(start, newlineIndex)) : newlineIndex - start;
			bufferedBytes++;
			completedLineByteLengths.push(bufferedBytes);
			bufferedBytes = 0;
			start = newlineIndex + 1;
		}
		bufferedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk.slice(start)) : chunk.byteLength - start;

		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;

			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			onLine(
				line.endsWith("\r") ? line.slice(0, -1) : line,
				completedLineByteLengths[completedLineByteLengthIndex++]!,
			);
		}
		if (completedLineByteLengthIndex === completedLineByteLengths.length) {
			completedLineByteLengths.length = 0;
			completedLineByteLengthIndex = 0;
		}

		exceedsBufferLimit();
	};

	const onEnd = () => {
		if (stopped) return;
		buffer += decoder.end();
		if (exceedsBufferLimit()) return;
		if (buffer.length > 0) {
			const line = buffer;
			const rawFramedByteLength = bufferedBytes;
			resetBuffer();
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line, rawFramedByteLength);
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
