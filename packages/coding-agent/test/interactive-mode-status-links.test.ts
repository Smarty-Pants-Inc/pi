import { Container, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const url = "https://github.com/Smarty-Pants-Inc/pi/pull/35/files?diff=split#diff-0123456789abcdef";
const link = `\x1b]8;;${url}\x1b\\`;

function render(method: "showStatus" | "showWarning" | "showError", hyperlinks: boolean): string {
	initTheme("dark");
	setCapabilities({ images: null, trueColor: false, hyperlinks });
	const fakeThis = { chatContainer: new Container(), ui: { requestRender: vi.fn() }, outputPad: 1 };
	const show = Reflect.get(InteractiveMode.prototype, method) as (this: typeof fakeThis, message: string) => void;
	show.call(fakeThis, `Open ${url}.`);
	return fakeThis.chatContainer.render(40).join("\n");
}

describe("InteractiveMode status links", () => {
	afterEach(() => resetCapabilitiesCache());

	test.each(["showStatus", "showWarning", "showError"] as const)(
		"%s keeps the full URL target on every wrapped row when hyperlinks are on",
		(method) => {
			const rows = render(method, true)
				.split("\n")
				.filter((row) => row.includes("\x1b]8;;h"));
			expect(rows.length).toBeGreaterThan(1);
			for (const row of rows) expect(row).toContain(link);
		},
	);

	test("prints plain URLs when hyperlinks are off", () => {
		expect(render("showStatus", false)).not.toContain("\x1b]8;");
	});
});
