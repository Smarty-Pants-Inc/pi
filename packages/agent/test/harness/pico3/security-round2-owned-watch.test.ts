import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { onTestFinished, test } from "vitest";
import {
	applyEnvelope,
	type ConversationView,
	Harness,
	type JsonObject,
	MemoryStorage,
	withAbortSignal,
} from "../../../src/harness/pico3/index.ts";
import { track } from "../../../src/harness/pico3/legacy-tracker.ts";
import { ctx, fake, Gate, model } from "./helpers.ts";

const sentinel = "picoOwnedWatch2241";
const reserved = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"];

// #2241 / F15: exercise the exported Harness, actual generation commits, and conversation watch.
test("watched generation adds reserved own argument keys across separate commits without touching prototypes", async () => {
	const initial: JsonObject = { version: 1, ordinary: "before", remove: true, rows: [{ id: 1, text: "before" }] };
	const replacement = JSON.parse(
		'{"version":2,"ordinary":"after","__proto__":{"picoOwnedWatch2241":"fake-provider-data"},"constructor":{"prototype":{"value":2}},"prototype":{"value":3},"toString":{"value":4},"hasOwnProperty":{"value":5},"rows":[{"id":1,"text":"after","__proto__":{"picoOwnedWatch2241":"nested-fake-data"}},{"id":2,"text":"added"}]}',
	) as JsonObject;
	const unrelated = { local: "unchanged" };
	const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
	const unrelatedBefore = Object.getOwnPropertyDescriptors(unrelated);
	assert.equal(Object.hasOwn(Object.prototype, sentinel), false);
	const continueStream = new Gate();
	const finishStream = new Gate();
	const first = Promise.withResolvers<{ revision: number; args: JsonObject }>();
	const second = Promise.withResolvers<{ revision: number; args: JsonObject }>();
	const budget = withAbortSignal(AbortSignal.timeout(5000), ctx);
	const reports: unknown[] = [];
	const base = fake({ respond: () => ({ text: "finished" }) });
	let requests = 0;
	const h = await Harness.open(
		new MemoryStorage(),
		{
			models: {
				...base,
				async *stream(m, request, streamCtx): AsyncIterable<AssistantMessageEvent> {
					if (requests++ > 0) {
						yield* base.stream(m, request, streamCtx);
						return;
					}
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: m.api,
						provider: m.provider,
						model: m.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "pending",
						timestamp: 0,
					};
					yield { type: "start", partial };
					const call: ToolCall = { type: "toolCall", id: "owned-watch", name: "unoffered", arguments: initial };
					partial.content.push(call);
					yield { type: "toolcall_start", contentIndex: 0, partial };
					await continueStream.wait(streamCtx);
					call.arguments = replacement;
					yield { type: "toolcall_end", contentIndex: 0, toolCall: call, partial };
					await finishStream.wait(streamCtx);
					yield { type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } };
				},
			},
			root: { rewindable: { model } },
			onReport: (error) => reports.push(error),
		},
		budget,
	);
	onTestFinished(() => h.close(ctx));
	const root = await h.root(budget);
	const watch = await root.watch(budget);
	let folded = watch.view;
	watch.start((envelope) => {
		folded = applyEnvelope(folded, envelope);
		const call = folded.turn?.message?.content[0];
		if (call?.type !== "toolCall") return;
		const args = call.arguments as JsonObject;
		if (args.version === 1) first.resolve({ revision: envelope.revision, args: structuredClone(args) });
		if (args.version === 2) second.resolve({ revision: envelope.revision, args: structuredClone(args) });
	});
	h.resume();
	const input = await root.send({ content: "fake reserved arguments" }, budget);
	const before = await first.promise;
	assert.deepEqual(before.args, initial);
	for (const key of reserved) assert.equal(Object.hasOwn(before.args, key), false);
	continueStream.open();
	const after = await second.promise;
	assert.ok(after.revision > before.revision, "the argument snapshots came from separate generation commits");
	assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore, "process prototype unchanged");
	assert.equal(
		Reflect.get(unrelated, sentinel),
		undefined,
		"provider data cannot become inherited by unrelated objects",
	);
	assert.deepEqual(Object.getOwnPropertyDescriptors(unrelated), unrelatedBefore);
	assert.equal(Object.getPrototypeOf(unrelated), Object.prototype);
	assert.deepEqual(after.args, replacement);
	for (const key of reserved) assert.equal(Object.hasOwn(after.args, key), true, `${key} preserved as own data`);
	assert.equal(Object.getPrototypeOf(after.args), Object.prototype);
	assert.equal(Object.hasOwn(after.args, "remove"), false);
	const fresh = await root.watch(budget);
	assert.deepEqual(folded, fresh.view);
	fresh.stop();
	assert.equal(watch.closed, false);
	assert.deepEqual(reports, []);
	finishStream.open();
	assert.equal((await input.wait(budget)).status, "done");
	await root.waitForIdle(budget);
	assert.equal(folded.turn, undefined, "optional turn is removed after final settlement");
	assert.deepEqual(reports, []);
	watch.stop();
});

// #2241 / F15: own reserved keys must also be editable/deletable in every shared record/array merge.
test("watched plugin projections edit and delete reserved own keys and synchronize ordinary arrays", async () => {
	const reports: unknown[] = [];
	const h = await Harness.open(
		new MemoryStorage(),
		{ models: fake({ respond: () => ({ text: "unused" }) }), onReport: (error) => reports.push(error) },
		ctx,
	);
	onTestFinished(() => h.close(ctx));
	const namespace = h.namespace(
		"owned.watch",
		{ sticky: { data: {} as JsonObject } },
		{ view: (slice) => slice.data },
	);
	const root = await h.root(ctx);
	const watch = await root.watch(ctx);
	let folded: ConversationView = watch.view;
	watch.start((envelope) => {
		folded = applyEnvelope(folded, envelope);
	});
	const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
	const values: JsonObject[] = [
		{ ordinary: "initial", rows: [{ id: 1, remove: true, text: "initial" }] },
		JSON.parse(
			'{"ordinary":"added","__proto__":{"picoOwnedWatch2241":true},"constructor":{"prototype":{"x":1}},"prototype":{"x":2},"toString":{"x":3},"hasOwnProperty":{"x":4},"rows":[{"id":1,"text":"edited","__proto__":{"x":1}},{"id":2,"text":"append"}]}',
		) as JsonObject,
		JSON.parse(
			'{"ordinary":"edited","__proto__":{"picoOwnedWatch2241":false,"added":1},"constructor":{"prototype":{"x":2}},"prototype":{"x":3},"toString":{"x":4},"hasOwnProperty":{"x":5},"rows":[{"id":1,"text":"edited-again"}]}',
		) as JsonObject,
		{
			ordinary: "deleted",
			rows: [
				{ id: 2, text: "replacement" },
				{ id: 3, text: "append" },
			],
		},
		{ rows: [] },
		{},
	];
	for (const data of values) {
		await root.commit((tx) => {
			tx.plugins(namespace).data = data;
		}, ctx);
		assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
		assert.deepEqual(folded.plugins[namespace.id], data);
		assert.equal(Object.getPrototypeOf(folded.plugins[namespace.id]), Object.prototype);
		const fresh = await root.watch(ctx);
		assert.deepEqual(folded, fresh.view);
		fresh.stop();
		assert.equal(watch.closed, false);
	}
	assert.deepEqual(reports, []);
	watch.stop();
});

// #2241: the compatibility adapter must retain Chord's own-key data placement, not prototype setters.
test("legacy tracker assigns reserved keys as own data without changing the inherited container", () => {
	const tracker = track({ args: {} as JsonObject });
	tracker.flush();
	const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
	const data = { [sentinel]: "fake-data" };
	const placement: JsonObject = { ["__proto__"]: data, constructor: { prototype: { value: 1 } } };
	for (const [key, value] of Object.entries(placement)) tracker.state.args[key] = value;
	tracker.flush();
	assert.equal(Object.hasOwn(tracker.target.args, "__proto__"), true);
	assert.deepEqual(tracker.target.args.__proto__, data);
	assert.deepEqual(tracker.target.args.constructor, { prototype: { value: 1 } });
	assert.equal(Object.getPrototypeOf(tracker.target.args), Object.prototype);
	assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});
