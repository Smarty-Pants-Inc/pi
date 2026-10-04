import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { CompactionCompletionContext } from "../src/core/extensions/types.ts";
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

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// pi#131 AU2-P2-01: EOF owns all continuations, but raw-session self-joins cannot block retirement forever.
it.each(["complete-wait", "complete-abort", "error-wait", "error-abort", "multi", "raw-wait", "raw-abort"] as const)(
	"EOF bounds compaction callback retirement: %s",
	async (kind) => {
		const beforeEnd = process.stdin.listeners("end");
		const beforeTerm = process.listeners("SIGTERM");
		const beforeHup = process.listeners("SIGHUP");
		const entered = deferred(),
			childEntered = deferred(),
			start = deferred(),
			rescue = deferred();
		const finished = deferred();
		const raw = kind.startsWith("raw");
		const failed = kind.startsWith("error");
		let joined = false,
			childJoined = false,
			shutdown = false;
		const joins: Promise<void>[] = [];
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) =>
						failed
							? { cancel: true }
							: { compaction: { summary: "rpc regression", firstKeptEntryId, tokensBefore } },
					);
					pi.on("session_shutdown", () => {
						shutdown = true;
					});
				},
			],
		});
		const runtime = new AgentSessionRuntime(
			h.session,
			{
				cwd: h.tempDir,
				agentDir: h.tempDir,
				modelRuntime: h.session.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("Unexpected replacement");
			},
		);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			// Observe mocked process retirement; runRpcMode intentionally stays pending after mocked exit.
			void runRpcMode(runtime);
			await vi.waitFor(() =>
				expect(process.stdin.listeners("end").some((listener) => !beforeEnd.includes(listener))).toBe(true),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const ctx = h.session.extensionRunner.createCommandContext();
			h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await h.session.prompt("one");
			await h.session.prompt("two");
			const callback = async (_result: unknown, owned: CompactionCompletionContext) => {
				entered.resolve();
				if (kind === "multi") {
					const child = async (_value: unknown, childOwned: CompactionCompletionContext) => {
						childEntered.resolve();
						await start.promise;
						const join = childOwned.waitForIdle().then(() => {
							childJoined = true;
						});
						joins.push(join);
						await join;
					};
					ctx.compact({ onComplete: child, onError: child });
					await start.promise;
				}
				const join = (
					raw
						? kind.endsWith("abort")
							? h.session.abort()
							: h.session.waitForIdle()
						: kind.endsWith("abort")
							? owned.abort()
							: owned.waitForIdle()
				).then(() => {
					joined = true;
				});
				joins.push(join);
				await Promise.race([join, rescue.promise]);
				finished.resolve();
			};
			ctx.compact(failed ? { onError: callback } : { onComplete: callback });
			await entered.promise;
			if (kind === "multi") {
				await childEntered.promise;
				start.resolve();
			}
			const eof = process.stdin.listeners("end").find((listener) => !beforeEnd.includes(listener));
			if (!eof) throw new Error("Missing EOF handler");
			const eofAt = Date.now();
			eof.call(process.stdin);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(raw ? 1 : 0), { timeout: 1500, interval: 10 });
			expect(Date.now() - eofAt).toBeLessThan(1300);
			expect(shutdown).toBe(!raw);
			expect(joined).toBe(!raw);
			if (kind === "multi") expect(childJoined).toBe(true);
			if (raw) {
				expect(h.session.isIdle).toBe(false);
				expect(diagnostic).toHaveBeenCalledWith(
					"RPC command shutdown incomplete: session or 0 operation(s) exceeded 1000 ms",
				);
			}
		} finally {
			start.resolve();
			rescue.resolve();
			await finished.promise;
			await Promise.all(joins);
			await h.session.waitForIdle();
			await runtime.dispose();
			h.cleanup();
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
