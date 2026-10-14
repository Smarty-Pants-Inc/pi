import type * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, type BashToolDetails, createBashToolDefinition } from "../src/core/tools/bash.ts";
import type * as outputAccumulator from "../src/core/tools/output-accumulator.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const probe = vi.hoisted(() => ({
	stream: undefined as nodeFs.WriteStream | undefined,
	failure: undefined as Error | undefined,
	failOpen: false,
	removed: [] as string[],
}));

vi.mock("../src/core/tools/output-accumulator.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof outputAccumulator>();
	return {
		...actual,
		OutputAccumulator: class extends actual.OutputAccumulator {
			constructor(options: outputAccumulator.OutputAccumulatorOptions) {
				super({ ...options, fullOutputHeadBytes: 32 * 1024, fullOutputTailBytes: 32 * 1024 });
			}
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFs>();
	return {
		...actual,
		// Recorded-call probes only: never execute product deletion paths locally (#4664).
		rmSync: vi.fn(),
		unlinkSync: vi.fn((path: string) => probe.removed.push(path)),
		openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => {
			if (probe.failOpen) throw Object.assign(new Error("log creation denied"), { code: "EACCES" });
			return actual.openSync(...args);
		}),
		createWriteStream: vi.fn((...args: Parameters<typeof actual.createWriteStream>) => {
			const stream = actual.createWriteStream(...args);
			probe.stream = stream;
			const failure = probe.failure;
			if (failure) stream._write = (_chunk, _encoding, callback) => callback(failure);
			return stream;
		}),
	};
});

// smarty-dev#11307 / pi#248: log I/O is auxiliary and must not erase a completed command.
// Keep reason: quota/write failures are expensive or unsafe to reach through a live user flow.
describe("bash log failure preserves the command result", () => {
	for (const kind of ["tool", "executor"] as const) {
		for (const failureKind of ["quota", "write", "open"] as const) {
			it.each([0, 7])(
				`${kind} preserves output and exit %i after a ${failureKind} failure mid-command`,
				async (exitCode) => {
					probe.failure =
						failureKind === "open"
							? undefined
							: new Error(
									failureKind === "quota"
										? "output files would exceed 536870912 bytes for this session"
										: "log disk write failed",
								);
					probe.failOpen = failureKind === "open";
					const errorText = probe.failure?.message ?? "log creation denied";
					const removedBefore = probe.removed.length;
					const operations: BashOperations = {
						exec: async (_command, _cwd, { onData }) => {
							onData(Buffer.from(`${"before\n".repeat(12000)}`));
							const stream = probe.stream;
							if (!stream) throw new Error("Expected a log stream");
							await new Promise<void>((resolve) => stream.once("close", resolve));
							expect(stream.errored).toBeTruthy();
							// The command continues after the failed log has been removed.
							onData(Buffer.from("after log failure\n"));
							return { exitCode };
						},
					};
					try {
						if (kind === "executor") {
							const chunks: string[] = [];
							const result = await executeBashWithOperations("fake", tmpdir(), operations, {
								onChunk: (text) => chunks.push(text),
							});
							expect(result.exitCode).toBe(exitCode);
							expect(chunks.join("")).toContain(`Output log unavailable: ${errorText}`);
							expect(result.cancelled).toBe(false);
							expect(result.output).toContain("after log failure\n");
							expect(result.output).toContain(`Output log unavailable: ${errorText}`);
							expect(result.fullOutputError).toBe(errorText);
							expect(result.fullOutputPath).toBeUndefined();
							expect(result.fullOutputTruncation).toBeUndefined();
						} else {
							const tool = wrapToolDefinition(createBashToolDefinition(tmpdir(), { operations }));
							const result = await tool.execute("failed-log", { command: "fake" });
							const details = result.details as BashToolDetails;
							expect(result.isError ?? false).toBe(exitCode !== 0);
							expect(result.content[0]).toMatchObject({
								type: "text",
								text: expect.stringContaining("after log failure\n"),
							});
							expect(result.content[0]).toMatchObject({
								text: expect.stringContaining(`Output log unavailable: ${errorText}`),
							});
							expect(result.structuredContent).toMatchObject({
								exit_code: exitCode,
								output: expect.stringContaining("after log failure\n"),
								truncated: true,
								full_output_error: errorText,
							});
							expect(result.structuredContent).not.toHaveProperty("full_output_path");
							expect(details.fullOutputError).toBe(errorText);
							expect(details.fullOutputPath).toBeUndefined();
							expect(details.fullOutputTruncation).toBeUndefined();
						}
						if (failureKind !== "open") expect(probe.removed.length).toBe(removedBefore + 1);
					} finally {
						probe.failure = undefined;
						probe.failOpen = false;
					}
				},
			);
		}

		it.each(["aborted", "timeout:2", "backend disconnected"])(
			`${kind} preserves %s when the final log flush fails`,
			async (message) => {
				probe.failure = new Error("final log write failed");
				const controller = new AbortController();
				const original = Object.assign(new Error(message), { code: "ORIGINAL" });
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						// Below the injected head cap: the first write happens at close, after exec throws.
						onData(Buffer.from(`${"row\n".repeat(3000)}last output\n`));
						if (kind === "executor" && message === "aborted") controller.abort();
						throw original;
					},
				};
				try {
					const run =
						kind === "executor"
							? executeBashWithOperations("fake", tmpdir(), operations, { signal: controller.signal })
							: wrapToolDefinition(createBashToolDefinition(tmpdir(), { operations })).execute("failed-log", {
									command: "fake",
								});
					if (kind === "executor" && message === "aborted") {
						const result = await run;
						expect(result).toMatchObject({
							cancelled: true,
							exitCode: undefined,
							fullOutputError: "final log write failed",
						});
						expect(result).toHaveProperty("output", expect.stringContaining("last output\n"));
					} else {
						const error = await run.then(
							() => undefined,
							(caught: unknown) => caught,
						);
						expect(error).toBeInstanceOf(Error);
						expect((error as Error).message).toContain("Output log unavailable: final log write failed");
						if (kind === "tool" && message === "aborted") {
							expect((error as Error).message).toContain("last output\n");
							expect((error as Error).message).toContain("Command aborted");
						} else if (kind === "tool" && message === "timeout:2") {
							expect((error as Error).message).toContain("last output\n");
							expect((error as Error).message).toContain("Command timed out after 2 seconds");
						} else {
							expect(error).toBe(original);
							expect(original.code).toBe("ORIGINAL");
						}
					}
				} finally {
					probe.failure = undefined;
				}
			},
		);
	}
});
