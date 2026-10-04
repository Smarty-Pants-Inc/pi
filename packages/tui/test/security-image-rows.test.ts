import assert from "node:assert/strict";
import { it } from "node:test";
import { getKittyImagePlacementRows, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// pi#137 / smarty-dev#3535, security finding 13.
it("rejects infinite and unsafe unregistered Kitty placement rows", () => {
	for (const rows of ["9".repeat(400), "9007199254740992", "0"]) {
		assert.equal(getKittyImagePlacementRows(`\x1b_Ga=T,r=${rows};AAAA\x1b\\`), undefined);
	}
});

it("bounds unchanged hostile image coverage when only the row above changes", async () => {
	const previousPane = process.env.WEZTERM_PANE;
	process.env.WEZTERM_PANE = "1";
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const terminal = new VirtualTerminal(20, 4);
	const tui = new TuiAltScreen(terminal);
	let above = "before";
	let rows = "9007199254740991";
	tui.setLayoutRoot({ render: () => [above, `\x1b_Ga=T,r=${rows};AAAA\x1b\\`, "", "after"], invalidate: () => {} });
	try {
		tui.start();
		await terminal.waitForRender();
		above = "changed";
		tui.requestRender();
		await terminal.waitForRender();
		assert.equal(terminal.getViewport()[0]?.trimEnd(), "changed");
		rows = "9".repeat(400);
		tui.requestRender();
		await terminal.waitForRender();
		above = "again";
		tui.requestRender();
		await terminal.waitForRender();
		assert.equal(terminal.getViewport()[0]?.trimEnd(), "again");
	} finally {
		tui.stop();
		resetCapabilitiesCache();
		if (previousPane === undefined) delete process.env.WEZTERM_PANE;
		else process.env.WEZTERM_PANE = previousPane;
	}
});
