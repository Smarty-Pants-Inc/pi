import * as nodeFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFs>();
	return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

// smarty-dev#2153 / #1998: both bash spill paths must ignore a permissive caller umask.
// Native Windows has different temp-directory and permission contracts; symlinks may require privileges.
describe.skipIf(process.platform === "win32")("private bash full output files", () => {
	let root: string;
	let previousUmask: number;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-bash-private-output-"));
		previousUmask = process.umask(0o002);
		vi.stubEnv("TMPDIR", root);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		process.umask(previousUmask);
		rmSync(root, { recursive: true, force: true });
	});

	async function runBash(kind: string, operations: BashOperations, signal?: AbortSignal) {
		if (kind === "executor") {
			return (await executeBashWithOperations("fake", root, operations, { signal })).fullOutputPath;
		}
		const tool = wrapToolDefinition(createBashToolDefinition(root, { operations }));
		return (await tool.execute("private-bash", { command: "fake" }, signal)).details?.fullOutputPath;
	}

	for (const kind of ["tool", "executor"]) {
		it.each(["lines", "bytes"])(`${kind} saves complete %s output with mode 0600 under umask 002`, async (limit) => {
			const text = limit === "lines" ? "fake row\n".repeat(3000) : `${"x".repeat(DEFAULT_MAX_BYTES + 1)}\n`;
			const paths = [];
			for (let i = 0; i < 2; i++) {
				const path = await runBash(kind, {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from(text));
						return { exitCode: 0 };
					},
				});
				if (!path) throw new Error("No bash spill file");
				paths.push(path);
				// No polling: a completed tool must have flushed its full output.
				expect(readFileSync(path, "utf8")).toBe(text);
				expect(statSync(path).mode & 0o777).toBe(0o600);
			}
			expect(new Set(paths).size).toBe(2);
		});

		it(`${kind} reports an existing symlink without overwriting its target`, async () => {
			const victim = join(root, "fake-victim");
			writeFileSync(victim, "fake sentinel");
			const createWriteStream = vi.mocked(nodeFs.createWriteStream).getMockImplementation();
			if (!createWriteStream) throw new Error("No native createWriteStream implementation");
			vi.mocked(nodeFs.createWriteStream).mockImplementationOnce((path, options) => {
				if (typeof path !== "string") throw new Error("Expected a filename");
				symlinkSync(victim, path);
				return createWriteStream(path, options);
			});
			await expect(
				runBash(kind, {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("fake row\n".repeat(3000)));
						return { exitCode: 0 };
					},
				}),
			).rejects.toMatchObject({ code: "EEXIST" });
			expect(readFileSync(victim, "utf8")).toBe("fake sentinel");
		});

		it(`${kind} reports a stream open failure that occurs before execution completes`, async () => {
			const blocked = join(root, "not-a-directory");
			writeFileSync(blocked, "fake blocker");
			vi.stubEnv("TMPDIR", blocked);
			await expect(
				runBash(kind, {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("x".repeat(DEFAULT_MAX_BYTES + 1)));
						await new Promise((resolve) => setTimeout(resolve, 20));
						return { exitCode: 0 };
					},
				}),
			).rejects.toMatchObject({ code: "ENOTDIR" });
		});
	}
});

// smarty-dev#2153 / #1998: exclusive creation must protect existing regular files on every platform.
describe("portable bash full output files", () => {
	let root: string;
	let spillPaths: string[];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-bash-exclusive-output-"));
		spillPaths = [];
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const path of spillPaths) rmSync(path, { force: true });
		rmSync(root, { recursive: true, force: true });
	});

	for (const kind of ["tool", "executor"]) {
		it(`${kind} reports an existing regular file without overwriting it`, async () => {
			const createWriteStream = vi.mocked(nodeFs.createWriteStream).getMockImplementation();
			if (!createWriteStream) throw new Error("No native createWriteStream implementation");
			vi.mocked(nodeFs.createWriteStream).mockImplementationOnce((path, options) => {
				if (typeof path !== "string") throw new Error("Expected a filename");
				spillPaths.push(path);
				writeFileSync(path, "fake sentinel");
				return createWriteStream(path, options);
			});
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("fake row\n".repeat(3000)));
					return { exitCode: 0 };
				},
			};
			const run =
				kind === "executor"
					? executeBashWithOperations("fake", root, operations)
					: wrapToolDefinition(createBashToolDefinition(root, { operations })).execute("exclusive-bash", {
							command: "fake",
						});
			await expect(run).rejects.toMatchObject({ code: "EEXIST" });
			expect(spillPaths).toHaveLength(1);
			expect(readFileSync(spillPaths[0], "utf8")).toBe("fake sentinel");
		});
	}

	// PR #102: cancellation during the final stream join must not report successful execution.
	it("executor reports cancellation during the final full-output flush", async () => {
		const controller = new AbortController();
		const text = "fake row\n".repeat(3000);
		const createWriteStream = vi.mocked(nodeFs.createWriteStream).getMockImplementation();
		if (!createWriteStream) throw new Error("No native createWriteStream implementation");
		vi.mocked(nodeFs.createWriteStream).mockImplementationOnce((path, options) => {
			if (typeof path !== "string") throw new Error("Expected a filename");
			spillPaths.push(path);
			const stream = createWriteStream(path, options);
			stream.once("finish", () => controller.abort());
			return stream;
		});
		const result = await executeBashWithOperations(
			"fake",
			root,
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(text));
					expect(controller.signal.aborted).toBe(false);
					return { exitCode: 0 };
				},
			},
			{ signal: controller.signal },
		);
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBe(spillPaths[0]);
		expect(readFileSync(spillPaths[0], "utf8")).toBe(text);
	});
});
