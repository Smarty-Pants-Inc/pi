import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// smarty-dev#3200: interactive fallback is visible, not just persisted in the session.
describe("interactive retry fallback", () => {
	it("immediately shows both model names", async () => {
		const view = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof view, event: AgentSessionEvent): Promise<void>;
			}
		).handleEvent;
		await handleEvent.call(view, {
			type: "auto_retry_fallback",
			fromModel: "faux/primary",
			toModel: "faux/alternate",
			attempt: 2,
			errorMessage: "stream disconnected before completion",
		});
		expect(view.showWarning).toHaveBeenCalledWith("Failed over from faux/primary to faux/alternate after 2 retries");
		expect(view.ui.requestRender).toHaveBeenCalled();
	});
});
