import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { onTestFinished, test } from "vitest";
import { applyEnvelope } from "../../../src/harness/pico3/harness.ts";
import { collectWatch, ctx, fake, Gate, open } from "./helpers.ts";

// PR #107 F15: watched generation commits must preserve reserved provider keys as data.
test.each(["reserved containers", "reserved deletions"])(
	"watch merges %s without mutating the process prototype",
	async (scenario) => {
		const marker = "pi107PicoPrototype";
		onTestFinished(() => {
			Reflect.deleteProperty(Object.prototype, marker);
		});
		const reports: unknown[] = [];
		const gate = new Gate();
		const finalGate = new Gate();
		const initialArguments = JSON.parse('{"stage":1,"constructor":"old","prototype":"old","toString":"old"}');
		const nextArguments =
			scenario === "reserved containers"
				? JSON.parse(
						`{"stage":2,"__proto__":{"${marker}":true},"constructor":{"prototype":{"${marker}":true}},"prototype":{"nested":1}}`,
					)
				: { stage: 2 };
		const models = fake({ respond: () => ({ text: "unused" }) });
		models.stream = async function* (_model, _request, context) {
			const call = fauxToolCall("echo", initialArguments);
			const partial = fauxAssistantMessage([call]);
			yield { type: "start", partial };
			yield { type: "toolcall_start", contentIndex: 0, partial };
			await gate.wait(context);
			call.arguments = nextArguments;
			yield { type: "toolcall_end", contentIndex: 0, toolCall: call, partial };
			await finalGate.wait(context);
			yield { type: "done", reason: "stop", message: fauxAssistantMessage("done") };
		};
		const env = await open({ models, onReport: (error) => reports.push(error) });
		onTestFinished(() => env.close());
		const watch = await collectWatch(env.root);
		onTestFinished(watch.stop);
		let view = watch.view;
		const foldArguments = () => {
			for (const envelope of watch.envelopes.splice(0)) view = applyEnvelope(view, envelope);
			const call = view.turn?.message?.content[0];
			return call?.type === "toolCall" ? call.arguments : undefined;
		};
		const input = await env.root.send({ content: "hi" }, ctx);
		await gate.arrivals(1);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.deepEqual(foldArguments(), initialArguments);
		gate.open();
		await finalGate.arrivals(1);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(Object.hasOwn(Object.prototype, marker), false);
		assert.deepEqual(foldArguments(), nextArguments);
		assert.deepEqual(reports, []);
		const fresh = await collectWatch(env.root);
		fresh.stop();
		assert.deepEqual(view, fresh.view);
		finalGate.open();
		await input.wait(ctx);
		await env.root.waitForIdle(ctx);
	},
);
