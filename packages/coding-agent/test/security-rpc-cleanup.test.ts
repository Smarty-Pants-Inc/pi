import { expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./suite/harness.ts";

vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: () => {},
}));
vi.mock("../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: () => () => {},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

// Smarty-Pants-Inc/pi PR #131, security round 1: terminal session_shutdown must have a deadline.
it.each(["settled", "never-settling", "late-rejection"] as const)(
	"EOF disposes %s shutdown work with an honest exit disposition",
	async (kind) => {
		const beforeEnd = process.stdin.listeners("end");
		const beforeTerm = process.listeners("SIGTERM");
		const beforeHup = process.listeners("SIGHUP");
		let release!: () => void;
		let reject!: (reason: unknown) => void;
		const held = new Promise<void>((resolve, failed) => {
			release = resolve;
			reject = failed;
		});
		let accepted = false;
		let followingHandlerRan = false;
		let shutdownContext: { isIdle: () => boolean } | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", async (_event, ctx) => {
						accepted = true;
						shutdownContext = ctx;
						if (kind !== "settled") await held;
					});
					pi.on("session_shutdown", () => {
						followingHandlerRan = true;
					});
				},
			],
		});
		// Only cwd/agentDir are used by this terminal-only runtime; replacement is forbidden in this probe.
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.session.sessionManager.getCwd(),
				agentDir: "/unused",
			} as unknown as AgentSessionServices,
			async () => {
				throw new Error("Unexpected replacement");
			},
		);
		const disposed = vi.spyOn(harness.session, "dispose");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// RPC intentionally remains pending after mocked process.exit; observe terminal retirement below.
			void runRpcMode(runtime);
			await vi.waitFor(() =>
				expect(process.stdin.listeners("end").some((listener) => !beforeEnd.includes(listener))).toBe(true),
			);
			// Allow initial binding to finish before closing the transport.
			await new Promise((resolve) => setTimeout(resolve, 20));
			const eof = process.stdin.listeners("end").find((listener) => !beforeEnd.includes(listener));
			if (!eof) throw new Error("Missing EOF handler");
			eof.call(process.stdin);
			await vi.waitFor(() => expect(accepted).toBe(true));
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(kind === "settled" ? 0 : 1), { timeout: 2200 });
			expect(disposed).toHaveBeenCalledOnce();
			expect(followingHandlerRan).toBe(kind === "settled");
			expect(harness.session.shutdownSignal.aborted).toBe(true);
			if (kind !== "settled") {
				expect(diagnostic).toHaveBeenCalledWith(
					"RPC session cleanup incomplete: unfinished shutdown work abandoned before process retirement",
				);
			}
			expect(() => shutdownContext?.isIdle()).toThrow(/stale/i);
			if (kind === "late-rejection") {
				reject(new Error("Late handler failure"));
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(exit).toHaveBeenCalledOnce();
			}
		} finally {
			release();
			await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 2200 });
			harness.cleanup();
			disposed.mockRestore();
			exit.mockRestore();
			diagnostic.mockRestore();
			for (const listener of process.stdin.listeners("end"))
				if (!beforeEnd.includes(listener)) process.stdin.off("end", listener as () => void);
			for (const listener of process.listeners("SIGTERM"))
				if (!beforeTerm.includes(listener)) process.off("SIGTERM", listener);
			for (const listener of process.listeners("SIGHUP"))
				if (!beforeHup.includes(listener)) process.off("SIGHUP", listener);
		}
	},
	10000,
);
