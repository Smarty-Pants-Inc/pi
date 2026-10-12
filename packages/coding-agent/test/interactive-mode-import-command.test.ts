import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
};

type ImportCommandContext = {
	clearStatusIndicator: () => void;
	runtimeHost: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	it("passes unquoted path to runtimeHost.importFromJsonl", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(importFromJsonl).toHaveBeenCalledWith("path/to/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	it("passes unquoted apostrophe path to runtimeHost.importFromJsonl unchanged", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		expect(importFromJsonl).toHaveBeenCalledWith("john's/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});

// pi#132 R4-4: the missing-cwd retry and the import submit share one cancellation boundary.
describe("InteractiveMode /import missing-cwd retry cancellation", () => {
	const prototype = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

	it.each(["cwd prompt", "retry"] as const)(
		"shutdown cancelling the held %s settles the submit without crash or shutdown self-join",
		async (held) => {
			const shutdown = new AbortController();
			const reason = new Error("SESSION_SHUTDOWN");
			const importFromJsonl = vi.fn(async (_path: string, cwd?: string) => {
				if (cwd === undefined)
					throw new MissingSessionCwdError({ sessionCwd: "/gone", fallbackCwd: "/here" } as never);
				shutdown.abort(reason);
				throw reason;
			});
			const uncaughtCrash = vi.fn();
			const handleFatalRuntimeError = vi.fn(async () => {
				throw new Error("unexpected fatal error");
			});
			const context = Object.create(
				InteractiveMode.prototype,
				Object.getOwnPropertyDescriptors({
					defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
					editor: { setText: vi.fn(), addToHistory: vi.fn() },
					runtimeHost: { inputsFenced: false, importFromJsonl },
					terminalShutdownRequested: false,
					isShuttingDown: true,
					// Delayed cleanup: shutdown has not completed and must not be awaited by the submit.
					shutdownCompletion: new Promise<void>(() => {}),
					session: { shutdownSignal: shutdown.signal },
					clearStatusIndicator: vi.fn(),
					showError: vi.fn(),
					showStatus: vi.fn(),
					showExtensionConfirm: vi.fn(async () => true),
					promptForMissingSessionCwd: vi.fn(async () => {
						if (held === "retry") return "/here";
						shutdown.abort(reason);
						throw reason;
					}),
					handleFatalRuntimeError,
					uncaughtCrash,
				}),
			);
			prototype.setupEditorSubmitHandler.call(context);
			const settled = await Promise.race([
				Promise.resolve(context.defaultEditor.onSubmit?.("/import /tmp/session.jsonl")).then(() => "settled"),
				new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
			]);
			expect(settled).toBe("settled");
			expect(handleFatalRuntimeError).not.toHaveBeenCalled();
			expect(uncaughtCrash).not.toHaveBeenCalled();
		},
	);
});
