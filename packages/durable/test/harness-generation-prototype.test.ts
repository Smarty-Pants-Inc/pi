import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Models } from "@earendil-works/pi-ai";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";

// PR #107 F3: separate GenerationTask flushes must not recurse into inherited containers.
it("preserves provider reserved keys across actual generation flushes without prototype mutation", async () => {
	const marker = "pi107DurablePrototype";
	onTestFinished(() => {
		Reflect.deleteProperty(Object.prototype, marker);
	});
	const base = chatSetup();
	let flushes = 0;
	const argumentsByFlush = [
		{ stage: 1, constructor: "old", prototype: "old" },
		JSON.parse(
			`{"stage":2,"__proto__":{"${marker}":true},"constructor":{"prototype":{"${marker}":true}},"prototype":{"nested":1}}`,
		),
		{ stage: 3 },
	];
	const streamSimple: Models["streamSimple"] = () => {
		const events = async function* () {
			for (const [index, args] of argumentsByFlush.entries()) {
				const partial = fauxAssistantMessage([fauxToolCall("echo", args)], { stopReason: "pending" });
				yield { type: "start" as const, partial };
				await waitFor(() => flushes >= index + 1);
			}
		};
		return {
			[Symbol.asyncIterator]: events,
			result: async () => fauxAssistantMessage("done"),
		} as unknown as ReturnType<Models["streamSimple"]>;
	};
	const models = new Proxy(base.models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const { harness, root } = await openChat(new MemoryStorage(), { ...base, models });
	onTestFinished(() => harness.close(context));
	const observed: Record<string, unknown>[] = [];
	harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type !== "document" || change.record.kind !== "pi.live" || change.value === null) continue;
			const message = (change.value as { generation?: { message?: AssistantMessage } }).generation?.message;
			const call = message?.content[0];
			if (call?.type !== "toolCall") continue;
			observed.push(call.arguments);
			flushes++;
		}
	});
	harness.resume();
	const submission = await root.submit({ type: "input", content: "hi" }, context);
	expect(await submission.wait(context)).toMatchObject({ status: "done" });
	expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
	expect(observed).toEqual(argumentsByFlush);
	expect(Object.hasOwn(observed[1]!, "__proto__")).toBe(true);
	expect(Object.hasOwn(observed[2]!, "constructor")).toBe(false);
	expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
	expect(base.reports).toEqual([]);
});
