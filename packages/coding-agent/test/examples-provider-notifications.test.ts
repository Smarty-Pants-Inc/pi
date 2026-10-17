import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import debugProvider from "../examples/extensions/debug-provider.ts";
import providerPayload from "../examples/extensions/provider-payload.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionCommandContext, ExtensionFactory } from "../src/core/extensions/types.ts";

vi.mock("node:fs", async (original) => ({
	...(await original<typeof fs>()),
	appendFileSync: vi.fn(),
}));

async function load(factory: ExtensionFactory) {
	const runtime = createExtensionRuntime();
	const appendEntry = vi.fn();
	runtime.appendEntry = appendEntry;
	const extension = await loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime);
	// These examples only use cwd and the two UI methods in their command handlers.
	const context = {
		cwd: process.cwd(),
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionCommandContext;
	return { extension, context, appendEntry };
}

async function emit(extension: Extension, context: ExtensionCommandContext, type: string, fields: object = {}) {
	for (const handler of extension.handlers.get(type) ?? []) {
		await handler({ type, ...fields }, context);
	}
}

// pi#280 / smarty-dev#3155: actual example factories must consume the value-free host boundary.
describe("provider notification examples", () => {
	it("captures notification types when enabled, not removed raw data", async () => {
		const { extension, context, appendEntry } = await load(debugProvider);
		const command = extension.commands.get("debug-provider");
		expect(command).toBeDefined();
		await command!.handler("on", context);
		await emit(extension, context, "turn_start");
		await emit(extension, context, "provider_stream_event");
		await emit(extension, context, "provider_stream_event");
		await emit(extension, context, "message_end", {
			message: { role: "assistant", provider: "faux", api: "faux", model: "faux-1" },
		});
		await emit(extension, context, "turn_end");
		expect(appendEntry).toHaveBeenCalledExactlyOnceWith("debug-provider-events", {
			provider: "faux",
			api: "faux",
			model: "faux-1",
			events: [{ type: "provider_stream_event" }, { type: "provider_stream_event" }],
		});
	});

	it("does not persist notifications when capture is disabled", async () => {
		const { extension, context, appendEntry } = await load(debugProvider);
		await emit(extension, context, "turn_start");
		await emit(extension, context, "provider_stream_event");
		await emit(extension, context, "message_end", { message: { role: "assistant" } });
		await emit(extension, context, "turn_end");
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("logs response status without removed response headers", async () => {
		vi.mocked(fs.appendFileSync).mockClear();
		const { extension, context } = await load(providerPayload);
		await emit(extension, context, "after_provider_response", { status: 200 });
		expect(fs.appendFileSync).toHaveBeenCalledExactlyOnceWith(expect.any(String), "[200]\n\n", "utf8");
	});

	it("handles a status-free response notification and retains request-payload logging", async () => {
		vi.mocked(fs.appendFileSync).mockClear();
		const { extension, context } = await load(providerPayload);
		await emit(extension, context, "after_provider_response");
		expect(fs.appendFileSync).toHaveBeenNthCalledWith(1, expect.any(String), "[unknown]\n\n", "utf8");
		await emit(extension, context, "before_provider_request", { payload: { temperature: 0 } });
		expect(fs.appendFileSync).toHaveBeenNthCalledWith(
			2,
			expect.any(String),
			`${JSON.stringify({ temperature: 0 }, null, 2)}\n\n`,
			"utf8",
		);
	});
});
