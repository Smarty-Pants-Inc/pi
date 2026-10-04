import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Container, type TerminalColors, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialSynchronizationError } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	initTheme,
	setTerminalColorScheme,
	setTerminalColors,
	type TerminalTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";
import { offlineClipboardImage, offlineRadiusSession } from "./fixtures/131-r3-ui-offline-extension.ts";

const clipboard = vi.hoisted(() => ({ files: vi.fn(), image: vi.fn(), text: vi.fn() }));
const mcp = vi.hoisted(() => ({
	load: vi.fn(() => {
		throw new Error("MCP_DISABLED");
	}),
	add: vi.fn(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({
	readClipboardFilePaths: clipboard.files,
	readClipboardText: clipboard.text,
	copyToClipboard: vi.fn(),
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: clipboard.image,
	extensionForImageMimeType: () => "png",
}));
vi.mock("../src/extensions/mcp/config.ts", () => ({ loadMcpConfig: mcp.load, addMcpServerConfig: mcp.add }));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof fs>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock("node:crypto", async (original) => {
	const actual = await original<typeof crypto>();
	return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

// No constructor/startup, network, HOME mutation or filesystem cleanup. Exercise the real receivers.
interface ModeProbe {
	chatContainer: Container;
	editorContainer: Container;
	editor: { insertTextAtCursor: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn>; setFocus: ReturnType<typeof vi.fn> };
	showError: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showStatus(message: string): void;
	handleClipboardPaste(): Promise<void>;
	showLoginDialog(provider: string, name: string): Promise<void>;
	runtimeHost: {
		session: {
			model: { provider: string; id: string; api: string };
			modelRuntime: {
				login: ReturnType<typeof vi.fn>;
				getAvailableSnapshot: ReturnType<typeof vi.fn>;
				refresh: ReturnType<typeof vi.fn>;
			};
			setModel: ReturnType<typeof vi.fn>;
			settingsManager: { getOrCreateDeviceId(): string };
		};
	};
	completeProviderAuthentication(
		provider: string,
		name: string,
		method: "oauth",
		previous: { provider: string; id: string; api: string },
	): Promise<void>;
	showSelector: ReturnType<typeof vi.fn>;
}
function modeProbe(): ModeProbe {
	const mode = Object.create(InteractiveMode.prototype) as ModeProbe;
	Object.assign(mode, {
		chatContainer: new Container(),
		editorContainer: new Container(),
		editor: { insertTextAtCursor: vi.fn() },
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateAvailableProviderCount: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		checkDaxnutsEasterEgg: vi.fn(),
		showSelector: vi.fn(),
		runtimeHost: {
			session: {
				...offlineRadiusSession(),
				setModel: vi.fn(async () => {}),
				modelRuntime: {
					login: vi.fn(async () => {}),
					getAvailableSnapshot: vi.fn(() => [{ provider: "radius", id: "balanced" }]),
					refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
				},
			},
		},
	});
	return mode;
}
beforeEach(() => {
	vi.clearAllMocks();
	clipboard.files.mockResolvedValue(null);
	clipboard.image.mockResolvedValue(offlineClipboardImage);
	clipboard.text.mockResolvedValue("text-control");
	initTheme("dark");
});
afterEach(() => {
	vi.restoreAllMocks();
	setTerminalColors({});
	setTerminalColorScheme(undefined);
	initTheme("dark");
});

describe("PR #131 round-3 interactive boundaries", () => {
	// PR #131 F06: private TMPDIR is only the test sandbox; assert product-requested leaf mode and actual directory mode.
	it("F06 requests private storage and exclusive leaves under umask 022", async () => {
		const oldMask = process.umask(0o022);
		try {
			const mode = modeProbe();
			await mode.handleClipboardPaste();
			expect(mode.showError).not.toHaveBeenCalled();
			const leaf = mode.editor.insertTextAtCursor.mock.calls[0][0] as string;
			expect(fs.statSync(leaf).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(leaf)).mode & 0o777).toBe(0o700);
			expect(path.dirname(leaf)).not.toBe(os.tmpdir());
			expect(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[2]).toEqual({ mode: 0o600, flag: "wx" });
		} finally {
			process.umask(oldMask);
		}
	});
	// PR #131 F06: a colliding leaf must never truncate accepted clipboard data or be admitted to the editor.
	it("F06 refuses a repeated leaf without overwriting or editor admission", async () => {
		vi.mocked(crypto.randomUUID).mockReturnValue("00000000-0000-4000-8000-000000000006");
		const mode = modeProbe();
		await mode.handleClipboardPaste();
		const leaf = mode.editor.insertTextAtCursor.mock.calls[0][0] as string;
		clipboard.image.mockResolvedValue({ bytes: new Uint8Array([9]), mimeType: "image/png" });
		await mode.handleClipboardPaste();
		expect(mode.showError).toHaveBeenCalledOnce();
		expect(mode.editor.insertTextAtCursor).toHaveBeenCalledOnce();
		expect([...fs.readFileSync(leaf)]).toEqual([1, 2, 3]);
	});
	it("keeps filename and text paste without image spills", async () => {
		const mode = modeProbe();
		clipboard.files.mockResolvedValue(["/offline/control.png"]);
		await mode.handleClipboardPaste();
		expect(clipboard.image).not.toHaveBeenCalled();
		expect(mode.editor.insertTextAtCursor).toHaveBeenLastCalledWith("/offline/control.png");
		clipboard.files.mockResolvedValue(null);
		clipboard.image.mockResolvedValue(null);
		await mode.handleClipboardPaste();
		expect(mode.editor.insertTextAtCursor).toHaveBeenLastCalledWith("text-control");
		expect(fs.writeFileSync).not.toHaveBeenCalled();
	});
	// PR #131 F21: A/chat/B must remain A/chat/B after colors rebuild; only adjacent B/C coalesce.
	it("F21 preserves each historical status through recoloring", () => {
		const mode = modeProbe();
		mode.showStatus("status-A");
		mode.chatContainer.render(100);
		mode.chatContainer.addChild(new Text("chat-control"));
		mode.showStatus("status-B");
		const before = mode.chatContainer.render(100).join("\n");
		expect(before).toContain("status-A");
		expect(before).toContain("status-B");
		mode.showStatus("status-C");
		initTheme("light");
		mode.chatContainer.invalidate();
		const after = mode.chatContainer.render(100).join("\n");
		expect(after).toContain("status-A");
		expect(after).toContain("chat-control");
		expect(after).toContain("status-C");
		expect(after).not.toContain("status-B");
		expect(mode.chatContainer.children).toHaveLength(5);
	});
	// PR #131 F22: committed system / other preview / late terminal / apply or cancel.
	it.each(["apply", "cancel"])("F22 retains preview across terminal updates until %s", async (finish) => {
		let late: ((colors: TerminalColors) => void) | undefined;
		let appearance: ((scheme: TerminalTheme) => void) | undefined;
		const ui = {
			invalidate: vi.fn(),
			requestRender: vi.fn(),
			setTerminalColorSchemeNotifications: vi.fn(),
			onTerminalColorSchemeChange: (listener: typeof appearance) => {
				appearance = listener;
				return () => {
					appearance = undefined;
				};
			},
			queryTerminalColors: vi.fn(async (options: { onLateReply?: typeof late }) => {
				late = options.onLateReply;
				return {};
			}),
		} as unknown as TUI;
		const settings = SettingsManager.inMemory({ theme: "system" });
		const controller = new InteractiveThemeController(ui, {
			getSettingsManager: () => settings,
			showError: vi.fn(),
			onChanged: vi.fn(),
		});
		try {
			controller.applyFromSettings();
			await controller.waitForTerminalColors();
			controller.preview("dark");
			expect(theme.name).toBe("dark");
			late?.({ background: { r: 250, g: 250, b: 250 } });
			expect(theme.name).toBe("dark");
			appearance?.("light");
			await controller.waitForTerminalColors();
			expect(theme.name).toBe("dark");
			expect(controller.getThemeSelection()).toBe("system");
			if (finish === "apply") controller.setThemeSetting("dark");
			else controller.preview("system"); // Existing selector cancellation restores its original setting.
			await controller.waitForTerminalColors();
			late?.({ background: { r: 20, g: 20, b: 20 } });
			expect(theme.name).toBe(finish === "apply" ? "dark" : "system");
			expect(controller.getThemeSelection()).toBe(finish === "apply" ? "dark" : "system");
		} finally {
			controller.dispose();
		}
	});
	// PR #131 F22: implicit system is also a committed selection, not the preview's active name.
	it("F22 keeps implicit system committed while a preview is active", async () => {
		let late: ((colors: TerminalColors) => void) | undefined;
		const ui = {
			invalidate: vi.fn(),
			requestRender: vi.fn(),
			setTerminalColorSchemeNotifications: vi.fn(),
			onTerminalColorSchemeChange: () => () => {},
			queryTerminalColors: async (options: { onLateReply?: typeof late }) => {
				late = options.onLateReply;
				return {};
			},
		} as unknown as TUI;
		const controller = new InteractiveThemeController(ui, {
			getSettingsManager: () => SettingsManager.inMemory(),
			showError: vi.fn(),
			onChanged: vi.fn(),
		});
		try {
			controller.applyFromSettings();
			await controller.waitForTerminalColors();
			controller.preview("light");
			expect(controller.getThemeSelection()).toBe("system");
			late?.({ background: { r: 20, g: 20, b: 20 } });
			expect(theme.name).toBe("light");
			controller.preview("system");
			expect(theme.name).toBe("system");
			expect(theme.appearance).toBe("dark");
		} finally {
			controller.dispose();
		}
	});
	// PR #131 F25: successful ordinary OAuth must not enter any dormant MCP admission.
	it("F25 completes Radius OAuth with zero MCP config or selector effects", async () => {
		const mode = modeProbe();
		const completed = vi.spyOn(mode, "completeProviderAuthentication");
		await mode.showLoginDialog("radius", "Radius");
		await new Promise<void>((resolve) => setImmediate(resolve)); // Join post-login refresh and timer retirement.
		expect(mode.runtimeHost.session.setModel).toHaveBeenCalledWith(
			{ provider: "radius", id: "balanced" },
			{ persist: true },
		);
		expect(mode.runtimeHost.session.modelRuntime.refresh).toHaveBeenCalledOnce();
		expect(mode.chatContainer.render(100).join("\n")).toContain("Logged in to Radius. Selected balanced.");
		expect(mode.runtimeHost.session.modelRuntime.login).toHaveBeenCalledOnce();
		expect(completed).toHaveBeenCalledWith("radius", "Radius", "oauth", mode.runtimeHost.session.model);
		expect(mcp.load).not.toHaveBeenCalled();
		expect(mcp.add).not.toHaveBeenCalled();
		expect(mode.showSelector).not.toHaveBeenCalled();
		expect(mode.showError).not.toHaveBeenCalled();
	});
	it("distinguishes committed Radius credentials with synchronization failure from authentication failure", async () => {
		const mode = modeProbe();
		mode.runtimeHost.session.modelRuntime.login.mockRejectedValueOnce(
			new CredentialSynchronizationError("radius", "login", undefined, { cause: new Error("offline-sync-failure") }),
		);
		await mode.showLoginDialog("radius", "Radius");
		expect(mode.showError).toHaveBeenCalledWith(
			expect.stringContaining("Logged in to Radius, but local model state could not be synchronized"),
		);
		expect(mode.showError).not.toHaveBeenCalledWith(expect.stringContaining("Failed to login"));
		expect(mcp.load).not.toHaveBeenCalled();
		expect(mode.showSelector).not.toHaveBeenCalled();
	});
	it("reports actual Radius authentication failure without success or MCP effects", async () => {
		const mode = modeProbe();
		mode.runtimeHost.session.modelRuntime.login.mockRejectedValueOnce(new Error("offline-auth-failure"));
		await mode.showLoginDialog("radius", "Radius");
		expect(mode.showError).toHaveBeenCalledWith("Failed to login to Radius: offline-auth-failure");
		expect(mode.runtimeHost.session.modelRuntime.refresh).not.toHaveBeenCalled();
		expect(mcp.load).not.toHaveBeenCalled();
	});
});
