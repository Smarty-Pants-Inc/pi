import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	test("accepts a maximum-sized record followed by LF", async () => {
		const line = "x".repeat(16);
		const lines: string[] = [];
		let overflows = 0;
		const stream = Readable.from([Buffer.from(`${line}\n`)]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (received) => lines.push(received), {
			getMaxBufferedBytes: () => 16,
			onBufferOverflow: () => {
				overflows++;
			},
		});

		await done;

		expect(lines).toEqual([line]);
		expect(overflows).toBe(0);
	});

	test("accepts multiple complete records in one bounded chunk", async () => {
		const lines = ["a".repeat(16), "b".repeat(16)];
		const received: string[] = [];
		let overflows = 0;
		const stream = Readable.from([Buffer.from(`${lines.join("\n")}\n`)]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => received.push(line), {
			getMaxBufferedBytes: () => 16,
			onBufferOverflow: () => {
				overflows++;
			},
		});

		await done;

		expect(received).toEqual(lines);
		expect(overflows).toBe(0);
	});

	test("drops an oversized unterminated record before emitting it", async () => {
		const lines: string[] = [];
		let overflows = 0;
		const stream = Readable.from([Buffer.from('{"payload":"xxxxxxxx'), Buffer.from('{"a":1}\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => lines.push(line), {
			getMaxBufferedBytes: () => 16,
			onBufferOverflow: () => {
				overflows++;
			},
		});

		await done;

		expect(lines).toEqual([]);
		expect(overflows).toBe(1);
	});
});
