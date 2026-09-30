import { Container, type Spacer, Text, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, stopThemeWatcher, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

type StatusHost = {
	chatContainer: Container;
	ui: TUI;
	lastStatusSpacer?: Spacer;
	lastStatusText?: ThemedText;
	lastStatusState?: { message: string };
};

const showStatus = (
	InteractiveMode as unknown as { prototype: { showStatus(this: StatusHost, message: string): void } }
).prototype.showStatus;

afterEach(() => {
	stopThemeWatcher();
	initTheme("dark");
});

// smarty-dev#2241 A15: render real ThemedText components after the theme controller invalidates them.
describe("security: historical status messages", () => {
	it("keeps nonadjacent statuses distinct through preview, selection, and invalidation", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chatContainer = new Container();
		ui.addChild(chatContainer);
		const host: StatusHost = { ui, chatContainer };
		const settings = SettingsManager.inMemory({ theme: "dark" });
		const controller = new InteractiveThemeController(ui, {
			getSettingsManager: () => settings,
			showError: (message) => {
				throw new Error(message);
			},
			onChanged: () => {},
		});
		try {
			showStatus.call(host, "FIRST_STATUS");
			const first = host.lastStatusText!;
			expect(first).toBeInstanceOf(ThemedText);
			expect(first.render(120).join("\n")).toContain("FIRST_STATUS");
			chatContainer.addChild(new Text("INTERVENING_CHAT", 1, 0));
			showStatus.call(host, "SECOND_STATUS");
			const second = host.lastStatusText!;
			expect(second).not.toBe(first);
			expect(chatContainer.children).toHaveLength(5);

			controller.preview("light");
			expect(theme.name).toBe("light");
			expect(first.render(120).join("\n")).toContain(theme.fg("dim", "FIRST_STATUS"));
			expect(first.render(120).join("\n")).not.toContain("SECOND_STATUS");
			expect(second.render(120).join("\n")).toContain("SECOND_STATUS");

			expect(controller.setThemeName("dark")).toEqual({ success: true });
			ui.invalidate();
			expect(first.render(120).join("\n")).toContain(theme.fg("dim", "FIRST_STATUS"));
			expect(second.render(120).join("\n")).toContain(theme.fg("dim", "SECOND_STATUS"));
		} finally {
			controller.dispose();
			ui.stop();
		}
	});

	it("coalesces adjacent updates without changing an earlier historical component", () => {
		initTheme("dark");
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chatContainer = new Container();
		ui.addChild(chatContainer);
		const host: StatusHost = { ui, chatContainer };
		try {
			showStatus.call(host, "OLD_ADJACENT_STATUS");
			const first = host.lastStatusText!;
			first.render(120);
			showStatus.call(host, "LATEST_ADJACENT_STATUS");
			expect(host.lastStatusText).toBe(first);
			expect(chatContainer.children).toHaveLength(2);
			expect(first.render(120).join("\n")).toContain("LATEST_ADJACENT_STATUS");
			chatContainer.addChild(new Text("INTERVENING_CHAT", 1, 0));
			showStatus.call(host, "NEW_HISTORICAL_STATUS");
			showStatus.call(host, "NEW_COALESCED_STATUS");
			ui.invalidate();
			expect(chatContainer.children).toHaveLength(5);
			expect(first.render(120).join("\n")).toContain("LATEST_ADJACENT_STATUS");
			expect(first.render(120).join("\n")).not.toContain("OLD_ADJACENT_STATUS");
			expect(first.render(120).join("\n")).not.toContain("NEW_COALESCED_STATUS");
			expect(host.lastStatusText!.render(120).join("\n")).toContain("NEW_COALESCED_STATUS");
		} finally {
			ui.stop();
		}
	});
});
