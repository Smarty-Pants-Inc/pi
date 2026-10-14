import * as nodeFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { removeOutputDirectory } from "../src/utils/output-files.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFs>();
	return {
		...actual,
		createWriteStream: vi.fn(actual.createWriteStream),
		openSync: vi.fn(actual.openSync),
		// Record cleanup calls instead of executing deletion paths locally (#4664).
		rmSync: vi.fn(),
		unlinkSync: vi.fn(),
	};
});

interface OpenFailure {
	path?: string;
	error?: unknown;
}

/** Run the next spill-file open after `prepare(path)`, recording the native exclusive-open error. */
function failNextOpen(prepare: (path: string) => void): OpenFailure {
	const failure: OpenFailure = {};
	const openSync = vi.mocked(nodeFs.openSync).getMockImplementation();
	if (!openSync) throw new Error("No native openSync implementation");
	vi.mocked(nodeFs.openSync).mockImplementationOnce((path, flags, mode) => {
		if (typeof path !== "string") throw new Error("Expected a filename");
		failure.path = path;
		prepare(path);
		try {
			return openSync(path, flags, mode);
		} catch (error) {
			failure.error = error;
			throw error;
		}
	});
	return failure;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
	return out;
}

async function runVisible(kind: string, root: string, operations: BashOperations) {
	const streamed: unknown[] = [];
	const result =
		kind === "executor"
			? await executeBashWithOperations("fake", root, operations, { onChunk: (chunk) => streamed.push(chunk) })
			: await wrapToolDefinition(createBashToolDefinition(root, { operations })).execute(
					"exclusive-bash",
					{ command: "fake" },
					undefined,
					// A provisional path can precede the async failure; check streamed text and final metadata.
					(update) => streamed.push(update.content),
				);
	return { result, visible: collectStrings([result, streamed]).join("\n") };
}

/** smarty-dev#11307 P2-SEC-1: the failed log's pathname stays out of results, metadata and streams. */
function expectRedactedOpenFailure(failure: OpenFailure, visible: string): void {
	if (!failure.path) throw new Error("No spill-file open");
	expect(failure.error).toBeInstanceOf(Error);
	// The native error object itself is not mutated.
	expect(failure.error).toMatchObject({ code: "EEXIST", path: failure.path });
	expect(failure.error).toHaveProperty("message", expect.stringContaining(failure.path));
	expect(visible).toContain("EEXIST");
	expect(visible).toContain("[output log]");
	expect(visible).not.toContain(failure.path);
}

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
		removeOutputDirectory();
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
		it.each(["lines", "bytes"])(
			`${kind} saves complete %s output read-only (0400) under umask 002`,
			async (limit) => {
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
					// pi#203 R2: read-only, so later appends cannot grow the bounded output directory.
					expect(statSync(path).mode & 0o777).toBe(0o400);
				}
				expect(new Set(paths).size).toBe(2);
				// pi#203 CI: a killed process never runs its exit cleanup, so the owner's plain rm -rf
				// (test.sh, the CI runner) must be able to remove the output directory.
				const directory = dirname(paths[0]);
				// Owner write/search permissions permit cleanup; no real deletion is needed to prove it.
				expect(statSync(directory).mode & 0o700).toBe(0o700);
			},
		);

		// smarty-dev#11307: an unavailable log must not replace the command result.
		it(`${kind} omits a failed symlink log without overwriting its target`, async () => {
			const victim = join(root, "fake-victim");
			writeFileSync(victim, "fake sentinel");
			// The spill file is created with a synchronous exclusive open (pi#203 R3).
			const failure = failNextOpen((path) => symlinkSync(victim, path));
			const { result, visible } = await runVisible(kind, root, {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("fake row\n".repeat(3000)));
					return { exitCode: 0 };
				},
			});
			expect(result).not.toHaveProperty("fullOutputPath", expect.any(String));
			expect(result).not.toHaveProperty("details.fullOutputPath", expect.any(String));
			expectRedactedOpenFailure(failure, visible);
			expect(readFileSync(victim, "utf8")).toBe("fake sentinel");
		});

		it(`${kind} omits a failed log when opening it fails before execution completes`, async () => {
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
			).resolves.toBeUndefined();
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
		removeOutputDirectory();
		rmSync(root, { recursive: true, force: true });
	});

	for (const kind of ["tool", "executor"]) {
		it(`${kind} preserves the command result and an existing regular file`, async () => {
			const failure = failNextOpen((path) => {
				spillPaths.push(path);
				writeFileSync(path, "fake sentinel");
			});
			const { result, visible } = await runVisible(kind, root, {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("fake row\n".repeat(3000)));
					return { exitCode: 0 };
				},
			});
			expectRedactedOpenFailure(failure, visible);
			expect(result).toMatchObject(kind === "executor" ? { exitCode: 0 } : { structuredContent: { exit_code: 0 } });
			expect(result).not.toHaveProperty("fullOutputPath", expect.any(String));
			expect(result).not.toHaveProperty("details.fullOutputPath", expect.any(String));
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
