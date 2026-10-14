import type * as nodeFs from "node:fs";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type * as outputAccumulator from "../src/core/tools/output-accumulator.ts";
import { FULL_OUTPUT_HEAD_BYTES, FULL_OUTPUT_TAIL_BYTES } from "../src/core/tools/output-accumulator.ts";
import { truncateTail } from "../src/core/tools/truncate.ts";

vi.mock("../src/core/tools/output-accumulator.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof outputAccumulator>();
	const head = 32 * 1024;
	const tail = 32 * 1024;
	return {
		...actual,
		FULL_OUTPUT_HEAD_BYTES: head,
		FULL_OUTPUT_TAIL_BYTES: tail,
		OutputAccumulator: class extends actual.OutputAccumulator {
			constructor(options: outputAccumulator.OutputAccumulatorOptions) {
				super({ ...options, fullOutputHeadBytes: head, fullOutputTailBytes: tail });
			}
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFs>();
	return { ...actual, rmSync: vi.fn(), unlinkSync: vi.fn() };
});

const CHUNK_BYTES = 8 * 1024;
const TOTAL_BYTES = 48 * CHUNK_BYTES;

/** Chunk i is one ASCII letter ending in a newline, so head and tail are easy to rebuild. */
function chunk(i: number): Buffer {
	const buffer = Buffer.alloc(CHUNK_BYTES, 65 + (i % 26));
	buffer[CHUNK_BYTES - 1] = 0x0a;
	return buffer;
}

function expectedLog(): Buffer {
	const head = Buffer.concat(Array.from({ length: FULL_OUTPUT_HEAD_BYTES / CHUNK_BYTES }, (_, i) => chunk(i)));
	const tailChunks = FULL_OUTPUT_TAIL_BYTES / CHUNK_BYTES;
	const tail = Buffer.concat(
		Array.from({ length: tailChunks }, (_, i) => chunk(TOTAL_BYTES / CHUNK_BYTES - tailChunks + i)),
	);
	const omitted = TOTAL_BYTES - FULL_OUTPUT_HEAD_BYTES - FULL_OUTPUT_TAIL_BYTES;
	const marker = `\n\n[... ${omitted} bytes omitted from this log (output was ${TOTAL_BYTES} bytes; first ${FULL_OUTPUT_HEAD_BYTES} and last ${FULL_OUTPUT_TAIL_BYTES} bytes kept) ...]\n\n`;
	return Buffer.concat([head, Buffer.from(marker), tail]);
}

function streaming(abort?: AbortController): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			for (let i = 0; i < TOTAL_BYTES / CHUNK_BYTES; i++) onData(chunk(i));
			if (abort) {
				abort.abort();
				throw new Error("aborted");
			}
			return { exitCode: 0 };
		},
	};
}

// smarty-dev#11307: interactive and RPC `!` commands share the bash tool's output cap.
// Logs remain in the process-owned output directory until process exit.
describe("user bash full-output log cap", () => {
	const root = tmpdir();

	function expectNotice(output: string, path: string) {
		const omitted = TOTAL_BYTES - FULL_OUTPUT_HEAD_BYTES - FULL_OUTPUT_TAIL_BYTES;
		expect(output).toContain(`[Output log capped: ${omitted} of ${TOTAL_BYTES} bytes omitted from ${path}]`);
	}

	it("keeps exact head, marker and tail of an over-cap stream and reports it in the output text", async () => {
		const result = await executeBashWithOperations("fake", root, streaming());
		const path = result.fullOutputPath;
		if (!path) throw new Error("No full output path");
		expect(statSync(path).size).toBeLessThanOrEqual(FULL_OUTPUT_HEAD_BYTES + FULL_OUTPUT_TAIL_BYTES + 256);
		expect(readFileSync(path).equals(expectedLog())).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.exitCode).toBe(0);
		expectNotice(result.output, path);
		expect(result.fullOutputTruncation).toEqual({
			totalBytes: TOTAL_BYTES,
			omittedBytes: TOTAL_BYTES - FULL_OUTPUT_HEAD_BYTES - FULL_OUTPUT_TAIL_BYTES,
		});
	});

	// Audit finding 1: a backend that emits over-cap output and then fails must still report the cap.
	it("keeps the original error and adds the cap when the backend fails after over-cap output", async () => {
		const cause = new Error("socket reset");
		const original = Object.assign(new Error("remote disconnect", { cause }), { code: "ECONNRESET" });
		const error = await executeBashWithOperations("fake", root, {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 0; i < TOTAL_BYTES / CHUNK_BYTES; i++) onData(chunk(i));
				throw original;
			},
		}).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBe(original);
		expect(original.cause).toBe(cause);
		expect(original.code).toBe("ECONNRESET");
		expect(original.message.startsWith("remote disconnect\n\n")).toBe(true);
		const path = /omitted from (\S+)\]/.exec(original.message)?.[1];
		if (!path) throw new Error("No full output path in error");
		expectNotice(original.message, path);
		expect(readFileSync(path).equals(expectedLog())).toBe(true);
	});

	it("rethrows an uncapped backend failure unchanged", async () => {
		const original = new Error("remote disconnect");
		const error = await executeBashWithOperations("fake", root, {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("hello\n"));
				throw original;
			},
		}).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBe(original);
		expect(original.message).toBe("remote disconnect");
	});

	it("keeps the cap and notice when the command is cancelled", async () => {
		const abort = new AbortController();
		const result = await executeBashWithOperations("fake", root, streaming(abort), { signal: abort.signal });
		const path = result.fullOutputPath;
		if (!path) throw new Error("No full output path");
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(readFileSync(path).equals(expectedLog())).toBe(true);
		expectNotice(result.output, path);
	});

	it("logs sanitized output and streams the same sanitized chunks", async () => {
		const chunks: string[] = [];
		const line = "\x1b[31mred\x1b[0m\r\n";
		const block = line.repeat(300);
		const result = await executeBashWithOperations(
			"fake",
			root,
			{
				exec: async (_command, _cwd, { onData }) => {
					// An escape sequence and a UTF-8 character split across chunks.
					onData(Buffer.from("start \x1b[3"));
					onData(Buffer.from("2mgreen\x1b[0m \xc3", "latin1"));
					onData(Buffer.from([0xa9, 0x0a]));
					for (let i = 0; i < 20; i++) onData(Buffer.from(block));
					return { exitCode: 0 };
				},
			},
			{ onChunk: (text) => chunks.push(text) },
		);
		const path = result.fullOutputPath;
		if (!path) throw new Error("No full output path");
		const expected = `start green \u00e9\n${"red\n".repeat(6000)}`;
		expect(chunks.join("")).toBe(expected);
		expect(readFileSync(path, "utf8")).toBe(expected);
		expect(result.output).not.toContain("Output log capped");
		expect(result.output).toBe(truncateTail(expected).content);
	});

	it("leaves small output unchanged without a log", async () => {
		const result = await executeBashWithOperations("fake", root, {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("hello\n"));
				return { exitCode: 0 };
			},
		});
		expect(result).toEqual({
			output: "hello\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: undefined,
		});
	});
});
