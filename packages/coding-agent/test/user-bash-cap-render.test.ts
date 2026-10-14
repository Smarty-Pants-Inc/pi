/**
 * User bash (`!`) output whose full-output log was capped must say so in the UI and in the
 * LLM text, instead of claiming the log holds the full output.
 */
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { BashResult } from "../src/core/bash-executor.ts";
import { type BashExecutionMessage, bashExecutionToText } from "../src/core/messages.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const MiB = 1024 * 1024;
const CAP = { totalBytes: 20 * MiB, omittedBytes: 12 * MiB };
const LOG_PATH = "/tmp/pi-bash-capped.log";

function tuiStub(): TUI {
	const stub = {
		terminal: { columns: 400, rows: 24 },
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return stub as unknown as TUI;
}

function renderText(component: BashExecutionComponent): string {
	return stripAnsi(component.render(400).join("\n"));
}

function completedComponent(capped: boolean, expanded: boolean): BashExecutionComponent {
	const component = new BashExecutionComponent("yes | head", tuiStub());
	component.appendOutput(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
	component.setComplete(0, false, { truncated: true } as never, LOG_PATH, capped ? CAP : undefined);
	component.setExpanded(expanded);
	return component;
}

describe("user bash capped output log rendering", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	for (const expanded of [false, true]) {
		it(`capped log warning (${expanded ? "expanded" : "collapsed"})`, () => {
			const text = renderText(completedComponent(true, expanded));
			expect(text).toContain("Capped log");
			expect(text).toContain(`omits ${12 * MiB} of ${20 * MiB} bytes`);
			expect(text).toContain("keeps first and last 4.0MB");
			expect(text).toContain(LOG_PATH);
			expect(text).not.toContain("Full output");
			// Output tail still displayed.
			expect(text).toContain("line 39");
		});

		it(`uncapped log keeps Full output label (${expanded ? "expanded" : "collapsed"})`, () => {
			const text = renderText(completedComponent(false, expanded));
			expect(text).toContain(`Output truncated. Full output: ${LOG_PATH}`);
			expect(text).not.toContain("Capped log");
			expect(text).toContain("line 39");
		});
	}

	it("bashExecutionToText describes capped and uncapped logs", () => {
		const base: BashExecutionMessage = {
			role: "bashExecution",
			command: "big",
			output: "tail",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: LOG_PATH,
			timestamp: 1,
		};
		// Round-trip through JSON like a persisted session entry.
		const restored = JSON.parse(JSON.stringify({ ...base, fullOutputTruncation: CAP })) as BashExecutionMessage;
		expect(restored.fullOutputTruncation).toEqual(CAP);
		const capped = bashExecutionToText(restored);
		expect(capped).toContain(`omits ${12 * MiB} of ${20 * MiB} bytes`);
		expect(capped).toContain("keeps first and last 4.0MB");
		expect(capped).not.toContain("Full output");
		expect(bashExecutionToText(base)).toContain(`[Output truncated. Full output: ${LOG_PATH}]`);
	});

	// smarty-dev#11307 F2: a restored session must feed cap metadata to the real component.
	it("restores the cap warning through InteractiveMode's message bootstrap", () => {
		const components: BashExecutionComponent[] = [];
		const context = {
			ui: tuiStub(),
			outputPad: 1,
			chatContainer: { addChild: (component: BashExecutionComponent) => components.push(component) },
		};
		const message: BashExecutionMessage = {
			role: "bashExecution",
			command: "big",
			output: "tail",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: LOG_PATH,
			fullOutputTruncation: CAP,
			timestamp: 1,
		};
		const addMessage = (
			InteractiveMode.prototype as unknown as { addMessageToChat: (message: BashExecutionMessage) => void }
		).addMessageToChat;
		addMessage.call(context, JSON.parse(JSON.stringify(message)) as BashExecutionMessage);
		const text = renderText(components[0]);
		expect(text).toContain("Capped log");
		expect(text).toContain(`omits ${CAP.omittedBytes} of ${CAP.totalBytes} bytes`);
		expect(text).toContain(LOG_PATH);
		expect(text).not.toContain("Full output");
	});

	// Exercise both live receiving paths, not just the component setter in isolation.
	it.each([
		{ extension: false, capped: true },
		{ extension: true, capped: true },
		{ extension: false, capped: false },
		{ extension: true, capped: false },
	])("live receiver extension=$extension capped=$capped", async ({ extension, capped }) => {
		const components: BashExecutionComponent[] = [];
		const result: BashResult = {
			output: "tail",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: LOG_PATH,
			...(capped ? { fullOutputTruncation: CAP } : {}),
		};
		const session = {
			extensionRunner: { emitUserBash: async () => (extension ? { result } : undefined) },
			sessionManager: { getCwd: () => process.cwd() },
			isDisposed: false,
			inputsFenced: false,
			isStreaming: false,
			shutdownSignal: new AbortController().signal,
			recordBashResult: () => {},
			executeBash: async (_command: string, onChunk: (text: string) => void) => {
				onChunk(result.output);
				return result;
			},
		};
		const context = {
			session,
			ui: tuiStub(),
			outputPad: 1,
			chatContainer: { addChild: (component: BashExecutionComponent) => components.push(component) },
			showError: (message: string) => {
				throw new Error(message);
			},
		};
		const handle = (InteractiveMode.prototype as unknown as { handleBashCommand: (command: string) => Promise<void> })
			.handleBashCommand;
		await handle.call(context, "big");
		const text = renderText(components[0]);
		expect(text).toContain(LOG_PATH);
		if (capped) {
			expect(text).toContain(`omits ${CAP.omittedBytes} of ${CAP.totalBytes} bytes`);
			expect(text).not.toContain("Full output");
		} else {
			expect(text).toContain("Full output");
			expect(text).not.toContain("Capped log");
		}
	});

	it("_appendBashResult copies fullOutputTruncation into the session message", () => {
		const appended: BashExecutionMessage[] = [];
		const fakeSession = {
			_inputsDisposed: false,
			isStreaming: false,
			sessionManager: { appendMessage: (m: BashExecutionMessage) => appended.push(m) },
			_refreshFinalizedContext: () => {},
		};
		const append = (AgentSession.prototype as unknown as Record<string, (...args: unknown[]) => void>)
			._appendBashResult;
		const capped: BashResult = {
			output: "tail",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: LOG_PATH,
			fullOutputTruncation: CAP,
		};
		const uncapped: BashResult = { ...capped, fullOutputTruncation: undefined };
		append.call(fakeSession, "big", capped);
		append.call(fakeSession, "small", uncapped);
		expect(appended[0].fullOutputTruncation).toEqual(CAP);
		expect(appended[1].fullOutputTruncation).toBeUndefined();
		expect(appended[1].fullOutputPath).toBe(LOG_PATH);
	});
});
