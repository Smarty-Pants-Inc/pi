import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage } from "../src/providers/faux.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// smarty-dev#5822 / T-C1: direct lifecycle callbacks, including non-stream fetch/cancel.
it("publishes only status across faux submission, deferred fetch and cancellation", async () => {
	const core = createFauxCore({});
	const model = core.getModel();
	const context = normalizeContext({ messages: [] });
	const received: unknown[][] = [];
	const onResponse = (...args: unknown[]) => {
		received.push(JSON.parse(JSON.stringify(args)));
	};
	core.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("cancelled")]);
	const submitted = await core.streamSimple(model, context, { deferred: true, onResponse }).result();
	if (!submitted.deferred) throw new Error("expected deferred handle");
	const ready = await core.fetchDeferred(model, submitted.deferred, { onResponse }).result();
	expect(ready.stopReason).toBe("stop");
	expect(ready.content).toEqual([{ type: "text", text: "ready" }]);
	const pending = await core.streamSimple(model, context, { deferred: true, onResponse }).result();
	if (!pending.deferred) throw new Error("expected deferred handle");
	await core.cancelDeferred(model, pending.deferred, { onResponse });
	expect(core.state.deferredFetchCount).toBe(1);
	expect(core.state.cancelledDeferred).toEqual([pending.deferred]);
	expect(received).toEqual(Array.from({ length: 4 }, () => [{ status: 200 }]));
});

describe("T-C1 faux callback awaiting", () => {
	it("does not consume a queued response when the response observer fails", async () => {
		const core = createFauxCore({});
		core.setResponses([fauxAssistantMessage("ready")]);
		const result = await core
			.streamSimple(core.getModel(), normalizeContext({ messages: [] }), {
				onResponse: async () => {
					await Promise.resolve();
					throw new Error("observer failed");
				},
			})
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(core.state.callCount).toBe(1);
	});
});
