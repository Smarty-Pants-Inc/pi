import { tmpdir } from "node:os";
import type { Component, EditorComponent, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import type { ExternalEditorResult } from "../src/modes/interactive/external-editor.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

const externalEditor = vi.hoisted(() => ({ run: vi.fn<() => Promise<ExternalEditorResult>>() }));
vi.mock("../src/modes/interactive/external-editor.ts", () => ({ editInExternalEditor: externalEditor.run }));

type Mode = {
	ui: TUI;
	editor: EditorComponent;
	editorContainer: Container;
	createExtensionUIContext(): ExtensionUIContext;
	showThinkingSelector(): void;
	showSelector(create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void }): void;
	disposeActiveSelector(): void;
	handleOpenExternalEditor(): Promise<void>;
	cancelUIHolds(): void;
};

const modes: Mode[] = [];

function createMode(): Mode {
	const editor = Object.assign(new Text("", 0, 0), {
		getText: () => "draft",
		setText: vi.fn(),
		handleInput: vi.fn(),
	}) as unknown as EditorComponent;
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		ui: createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: tmpdir(),
			terminal: new VirtualTerminal(),
		}),
		editor,
		editorContainer,
		uiHolds: new Set<{ reason: "custom" | "editor"; cancel?: () => void }>(),
		keybindings: new KeybindingsManager(),
		runtimeHost: {
			session: {
				settingsManager: { getExternalEditorCommand: () => "fake-editor", getDefaultThinkingLevel: () => "off" },
				thinkingLevel: "off",
				getAvailableThinkingLevels: () => ["off", "low"],
			},
		},
		selectThinkingLevel: vi.fn(),
	}) as Mode;
	modes.push(mode);
	return mode;
}

describe("host UI hold state (smarty-dev#2440, smarty-code#870)", () => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => {
		for (const mode of modes.splice(0)) mode.ui.stop();
		vi.restoreAllMocks();
		externalEditor.run.mockReset();
	});

	it("exposes a synchronous query on the extension UI", () => {
		const ui = createMode().createExtensionUIContext();
		expect(typeof ui.holdState).toBe("function");
		expect(ui.holdState()).toBeUndefined();
	});

	it("reports host-owned dialogs through every extension context", async () => {
		const mode = createMode();
		const harness = await createHarness();
		try {
			await harness.session.bindExtensions({ uiContext: mode.createExtensionUIContext(), mode: "tui" });
			const first = harness.session.extensionRunner.createContext();
			const second = harness.session.extensionRunner.createContext();
			expect(first.ui.holdState()).toBeUndefined();
			mode.showThinkingSelector();
			expect(first.ui.holdState()).toBe("dialog");
			expect(second.ui.holdState()).toBe("dialog");
			mode.editorContainer.children[0].handleInput?.("\x1b");
			expect(first.ui.holdState()).toBeUndefined();
			expect(second.ui.holdState()).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it.each(["close", "cancel", "error"])("tracks a native dialog through %s", (exit) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		let finish = () => {};
		const component = new Text("native dialog");
		mode.showSelector((done) => {
			finish = done;
			return {
				component,
				focus: component,
				dispose:
					exit === "error"
						? () => {
								throw new Error("dispose failed");
							}
						: undefined,
			};
		});
		expect(ui.holdState()).toBe("dialog");
		if (exit === "error") expect(finish).toThrow("dispose failed");
		else finish(); // Both submit and Escape call this shared completion callback.
		expect(ui.holdState()).toBeUndefined();
	});

	it("tracks native thinking selection and Escape cancellation", () => {
		for (const key of ["\r", "\x1b"]) {
			const mode = createMode();
			const ui = mode.createExtensionUIContext();
			mode.showThinkingSelector();
			expect(ui.holdState()).toBe("dialog");
			mode.editorContainer.children[0].handleInput?.(key);
			expect(ui.holdState()).toBeUndefined();
		}
	});

	it("clears a failed native dialog mount", () => {
		const mode = createMode();
		vi.spyOn(mode.ui, "setFocus").mockImplementationOnce(() => {
			throw new Error("mount failed");
		});
		expect(() => mode.showThinkingSelector()).toThrow("mount failed");
		expect(mode.createExtensionUIContext().holdState()).toBeUndefined();
	});

	it("does not hold after native dialog construction fails", () => {
		const mode = createMode();
		expect(() =>
			mode.showSelector(() => {
				throw new Error("factory failed");
			}),
		).toThrow("factory failed");
		expect(mode.createExtensionUIContext().holdState()).toBeUndefined();
	});

	it.each(["select", "confirm", "input", "editor"] as const)(
		"tracks an extension %s dialog on submit and cancel",
		async (kind) => {
			for (const key of ["\r", "\x1b"]) {
				const mode = createMode();
				const ui = mode.createExtensionUIContext();
				const pending =
					kind === "select"
						? ui.select("Pick", ["choice"])
						: kind === "confirm"
							? ui.confirm("Confirm", "Continue?")
							: kind === "input"
								? ui.input("Input")
								: ui.editor("Edit", "draft");
				expect(ui.holdState()).toBe("dialog");
				mode.editorContainer.children[0].handleInput?.(key);
				await pending;
				expect(ui.holdState()).toBeUndefined();
			}
		},
	);

	it.each(["select", "input"] as const)("clears an extension %s dialog on abort and timeout", async (kind) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		const controller = new AbortController();
		const pending =
			kind === "select"
				? ui.select("Pick", ["choice"], { signal: controller.signal })
				: ui.input("Input", undefined, { signal: controller.signal });
		expect(ui.holdState()).toBe("dialog");
		controller.abort();
		await pending;
		expect(ui.holdState()).toBeUndefined();
		const timed =
			kind === "select"
				? ui.select("Pick", ["choice"], { timeout: 1 })
				: ui.input("Input", undefined, { timeout: 1 });
		expect(ui.holdState()).toBe("dialog");
		await timed;
		expect(ui.holdState()).toBeUndefined();
	});

	it.each(["select", "input", "editor"] as const)("clears a failed extension %s mount", async (kind) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		vi.spyOn(mode.ui, "setFocus").mockImplementationOnce(() => {
			throw new Error("mount failed");
		});
		const pending =
			kind === "select" ? ui.select("Pick", ["choice"]) : kind === "input" ? ui.input("Input") : ui.editor("Edit");
		await expect(pending).rejects.toThrow("mount failed");
		expect(ui.holdState()).toBeUndefined();
	});

	it.each([false, true])("tracks custom UI including its async factory (overlay=%s)", async (overlay) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		let finish!: (value: string | undefined) => void;
		let mount!: (component: Component) => void;
		const pending = ui.custom<string | undefined>(
			(_tui, _theme, _keys, done) => {
				finish = done;
				return new Promise<Component>((resolve) => {
					mount = resolve;
				});
			},
			{ overlay },
		);
		expect(ui.holdState()).toBe("custom");
		mount(new Text("custom screen"));
		await Promise.resolve();
		expect(ui.holdState()).toBe("custom");
		finish("done");
		expect(await pending).toBe("done");
		expect(ui.holdState()).toBeUndefined();
		const cancelled = ui.custom<string | undefined>(
			(_tui, _theme, _keys, done) => {
				finish = done;
				return new Text("custom screen");
			},
			{ overlay },
		);
		await Promise.resolve();
		expect(ui.holdState()).toBe("custom");
		finish(undefined);
		await cancelled;
		expect(ui.holdState()).toBeUndefined();
	});

	it.each([false, true])("clears custom UI on factory and mounting errors (overlay=%s)", async (overlay) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		await expect(
			ui.custom(
				() => {
					throw new Error("factory failed");
				},
				{ overlay },
			),
		).rejects.toThrow("factory failed");
		expect(ui.holdState()).toBeUndefined();
		await expect(
			ui.custom(
				async () => {
					throw new Error("async factory failed");
				},
				{ overlay },
			),
		).rejects.toThrow("async factory failed");
		expect(ui.holdState()).toBeUndefined();
		if (!overlay) {
			vi.spyOn(mode.ui, "setFocus").mockImplementationOnce(() => {
				throw new Error("mount failed");
			});
		}
		const pending = overlay
			? ui.custom(() => new Text("custom"), {
					overlay,
					onHandle: () => {
						throw new Error("mount failed");
					},
				})
			: ui.custom(() => new Text("custom"));
		await expect(pending).rejects.toThrow("mount failed");
		expect(ui.holdState()).toBeUndefined();
	});

	it("keeps overlapping custom holds independent and clears reset-cancelled factories", async () => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		let finishFirst!: () => void;
		let finishSecond!: () => void;
		const first = ui.custom<void>(
			(_tui, _theme, _keys, done) => {
				finishFirst = done;
				return new Text("first");
			},
			{ overlay: true },
		);
		const second = ui.custom<void>(
			(_tui, _theme, _keys, done) => {
				finishSecond = done;
				return new Text("second");
			},
			{ overlay: true },
		);
		await Promise.resolve();
		finishSecond();
		await second;
		expect(ui.holdState()).toBe("custom");
		finishFirst();
		await first;
		expect(ui.holdState()).toBeUndefined();
		let mount!: (component: Component & { dispose(): void }) => void;
		const pending = ui.custom(
			() =>
				new Promise<Component & { dispose(): void }>((resolve) => {
					mount = resolve;
				}),
		);
		expect(ui.holdState()).toBe("custom");
		mode.cancelUIHolds();
		await pending;
		const dispose = vi.fn();
		mount(Object.assign(new Text("late"), { dispose }));
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledOnce();
		expect(ui.holdState()).toBeUndefined();
	});

	it("preserves a native hold when a custom factory fails", async () => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		mode.showThinkingSelector();
		await expect(
			ui.custom(() => {
				expect(ui.holdState()).toBe("custom");
				throw new Error("factory failed");
			}),
		).rejects.toThrow("factory failed");
		expect(ui.holdState()).toBe("dialog");
		mode.editorContainer.children[0].handleInput?.("\x1b");
		expect(ui.holdState()).toBeUndefined();
	});

	it("keeps hidden and out-of-order overlays held until their own completion", async () => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		let finishFirst!: () => void;
		let finishSecond!: () => void;
		let firstHandle: OverlayHandle | undefined;
		const first = ui.custom<void>(
			(_tui, _theme, _keys, done) => {
				finishFirst = done;
				return new Text("first");
			},
			{
				overlay: true,
				onHandle: (handle) => {
					firstHandle = handle;
				},
			},
		);
		const second = ui.custom<void>(
			(_tui, _theme, _keys, done) => {
				finishSecond = done;
				return new Text("second");
			},
			{ overlay: true },
		);
		await Promise.resolve();
		firstHandle?.setHidden(true);
		expect(ui.holdState()).toBe("custom");
		finishFirst();
		await first;
		expect(ui.holdState()).toBe("custom");
		finishSecond();
		await second;
		expect(ui.holdState()).toBeUndefined();
	});

	it("releases an immediately completed custom factory even if disposal throws", async () => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		const dispose = vi.fn(() => {
			throw new Error("dispose failed");
		});
		await ui.custom<void>((_tui, _theme, _keys, done) => {
			expect(ui.holdState()).toBe("custom");
			done();
			return Object.assign(new Text("custom"), { dispose });
		});
		await Promise.resolve();
		expect(dispose).toHaveBeenCalledOnce();
		expect(ui.holdState()).toBeUndefined();
	});

	it.each(["stop", "start"] as const)("releases external editor holds when terminal %s throws", async (method) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		externalEditor.run.mockResolvedValueOnce({ status: "failed" });
		vi.spyOn(mode.ui, method).mockImplementationOnce(() => {
			throw new Error("terminal failed");
		});
		await expect(mode.handleOpenExternalEditor()).rejects.toThrow("terminal failed");
		expect(ui.holdState()).toBeUndefined();
	});

	it.each(["complete", "failed", "throw"])("tracks the external editor through %s", async (exit) => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		let finish!: (result: ExternalEditorResult) => void;
		let fail!: (error: Error) => void;
		externalEditor.run.mockReturnValueOnce(
			new Promise<ExternalEditorResult>((resolve, reject) => {
				finish = resolve;
				fail = reject;
			}),
		);
		const pending = mode.handleOpenExternalEditor();
		expect(ui.holdState()).toBe("editor");
		if (exit === "throw") fail(new Error("editor failed"));
		else finish(exit === "complete" ? { status: "complete", content: "edited" } : { status: "failed" });
		if (exit === "throw") await expect(pending).rejects.toThrow("editor failed");
		else await pending;
		expect(ui.holdState()).toBeUndefined();
	});

	it.each(["complete", "failed", "throw"])(
		"keeps an external editor hold after its extension dialog is cancelled (%s)",
		async (exit) => {
			const mode = createMode();
			const ui = mode.createExtensionUIContext();
			let finish!: (result: ExternalEditorResult) => void;
			let fail!: (error: Error) => void;
			externalEditor.run.mockReturnValueOnce(
				new Promise<ExternalEditorResult>((resolve, reject) => {
					finish = resolve;
					fail = reject;
				}),
			);
			const dialog = ui.editor("Edit", "draft");
			const component = mode.editorContainer.children[0] as ExtensionEditorComponent;
			const pending = (
				component as unknown as { handleOpenExternalEditor(): Promise<void> }
			).handleOpenExternalEditor();
			component.handleInput("\x1b");
			await dialog;
			expect(ui.holdState()).toBe("editor");
			if (exit === "throw") fail(new Error("editor failed"));
			else finish(exit === "complete" ? { status: "complete", content: "edited" } : { status: "failed" });
			if (exit === "throw") await expect(pending).rejects.toThrow("editor failed");
			else await pending;
			expect(ui.holdState()).toBeUndefined();
		},
	);
});
