import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi#137 / smarty-dev#3535, A15: real renderer, unchanged hostile image row, changed row above.
export default function proofWidget(pi: ExtensionAPI) {
	let above = "A15-before";
	let tui: { requestRender(): void } | undefined;
	pi.registerCommand("proof-image", {
		description: "Install the fullscreen image redraw starting state",
		handler: async (_args, ctx) => {
			ctx.ui.setWidget("proof-image", (renderer) => {
				tui = renderer;
				return {
					render: () => [above, "\x1b_Ga=T,r=9007199254740991;AAAA\x1b\\", "", "A15-after-image"],
					invalidate: () => {},
				};
			});
		},
	});
	pi.registerCommand("proof-redraw", {
		description: "Change only the row above the existing image",
		handler: async () => {
			above = "A15-changed";
			tui?.requestRender();
		},
	});
}
