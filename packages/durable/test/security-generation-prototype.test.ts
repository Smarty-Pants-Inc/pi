import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type Models,
} from "@earendil-works/pi-ai";
import { AssistantEntry, GenerationTask, LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

const MARKER = "piGenerationPrototypePollution2241";

// #2241: exercise two committed public GenerationTask flushes, not an extracted merge helper.
describe("generation partial prototype custody", () => {
	it.each([
		{
			name: "adds an own object-valued __proto__ without reusing Object.prototype",
			first: '{"path":"a","nested":{"text":"x"},"items":["a"],"remove":true}',
			second:
				'{"path":"ab","nested":{"text":"xy"},"items":["ab","b"],"__proto__":{"piGenerationPrototypePollution2241":"owned"},"constructor":{"prototype":{"data":"kept"}},"prototype":{"data":"kept"}}',
		},
		{
			name: "keeps ordinary growing arguments as streaming deltas",
			first: '{"path":"a","nested":{"text":"x"},"items":["a"],"remove":true}',
			second: '{"path":"ab","nested":{"text":"xy"},"items":["ab","b"]}',
		},
		{
			name: "retains and grows already-owned reserved JSON keys as data",
			first: '{"path":"a","__proto__":{"piGenerationPrototypePollution2241":"own"},"constructor":{"prototype":{"data":"k"}},"prototype":{"data":"k"}}',
			second:
				'{"path":"ab","__proto__":{"piGenerationPrototypePollution2241":"owned"},"constructor":{"prototype":{"data":"kept"}},"prototype":{"data":"kept"}}',
		},
	])("$name", async ({ first, second }) => {
		const prototype = Object.getPrototypeOf(Object.prototype);
		const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
		const setup = chatSetup();
		const stream = createAssistantMessageEventStream();
		let requests = 0;
		const streamSimple: Models["streamSimple"] = () => {
			requests++;
			return stream;
		};
		const models = new Proxy(setup.models, {
			get(target, property) {
				if (property === "streamSimple") return streamSimple;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const firstArguments = JSON.parse(first) as JsonObject;
		const secondArguments = JSON.parse(second) as JsonObject;
		const partials = [firstArguments, secondArguments].map((arguments_) =>
			fauxAssistantMessage([fauxToolCall("read", arguments_, { id: "call-2241" })], {
				stopReason: "pending",
				timestamp: 1,
			}),
		);
		const final = { ...partials[1]!, stopReason: "toolUse" as const };
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, { ...setup, models });
		const publications: LiveState[] = [];
		const unsubscribe = harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.kind !== "pi.live" || change.value === null) continue;
				const live = change.value as LiveState;
				if (live.generation?.message !== undefined) publications.push(live);
			}
		});
		try {
			expect(setup.registry.snapshot().task(GenerationTask.definition.name)).toBe(GenerationTask);
			expect(Object.hasOwn(Object.prototype, MARKER)).toBe(false);
			const record = await storage.findDocument(
				{ kind: "pi.live", scope: { kind: "conversation", conversationId: root.id } },
				"current",
				context,
			);
			expect(record).toBeDefined();
			harness.resume();
			const submission = await root.submit({ type: "input", content: "read arguments" }, context);
			await waitFor(() => requests === 1);
			const beforePartials = storage.commits.length;
			// Do not send the next partial until the preceding throttle flush actually commits.
			for (const [index, partial] of partials.entries()) {
				stream.push({ type: "start", partial });
				await waitFor(() => publications.length === index + 1);
				expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(descriptors);
				expect(Object.getPrototypeOf(Object.prototype)).toBe(prototype);
				expect(Object.hasOwn(Object.prototype, MARKER)).toBe(false);
				const call = publications[index]!.generation!.message!.content[0]!;
				if (call.type !== "toolCall") throw new Error("Expected a streamed tool call");
				const expectedArguments = index === 0 ? firstArguments : secondArguments;
				// Strict object equality treats an own constructor value as a type tag; compare JSON data instead.
				expect(JSON.stringify(call.arguments)).toBe(JSON.stringify(expectedArguments));
				expect(Object.getPrototypeOf(call.arguments)).toBe(Object.prototype);
				for (const key of ["__proto__", "constructor", "prototype"]) {
					expect(Object.hasOwn(call.arguments, key)).toBe(Object.hasOwn(expectedArguments, key));
				}
			}
			const partialWrites = storage.commits
				.slice(beforePartials)
				.flatMap((batch) =>
					batch.flatMap((write) =>
						write.type === "document.change" && write.id === record!.id ? [write.content] : [],
					),
				);
			expect(partialWrites).toHaveLength(2);
			expect(partialWrites.map((write) => write.kind)).toEqual(["delta", "delta"]);
			if (!Object.hasOwn(secondArguments, "__proto__")) {
				const secondWrite = partialWrites[1]!;
				if (secondWrite.kind !== "delta") throw new Error("Expected a streaming delta");
				expect(secondWrite.ops).toContainEqual([
					"a",
					["generation", "message", "content", 0, "arguments", "path"],
					"b",
				]);
			}
			stream.push({ type: "done", reason: "toolUse", message: final });
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
			const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const call = answer!.model![0]!;
			expect(JSON.stringify(call)).toBe(JSON.stringify(final));
			expect(requests).toBe(1);
			expect(publications).toHaveLength(2);
			const writes = storage.commits.flatMap((batch) =>
				batch.flatMap((write) =>
					write.type === "document.change" && write.id === record!.id ? [write.content.kind] : [],
				),
			);
			expect(writes.at(-1)).toBe("base");
			expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
			const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context);
			expect(tasks.items).toHaveLength(1);
			expect(tasks.items[0]!.kind).toBe(GenerationTask.definition.name);
			expect(tasks.items[0]!.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
			expect(setup.reports).toEqual([]);
			expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(descriptors);
			expect(Object.getPrototypeOf(Object.prototype)).toBe(prototype);
		} finally {
			// The parent's isolated before-fix probe may mutate the process prototype; restore it even on failure.
			stream.end(final);
			unsubscribe();
			try {
				await harness.close(context);
			} finally {
				for (const key of Reflect.ownKeys(Object.prototype)) {
					if (!Object.hasOwn(descriptors, key)) Reflect.deleteProperty(Object.prototype, key);
				}
				Object.defineProperties(Object.prototype, descriptors);
				Object.setPrototypeOf(Object.prototype, prototype);
			}
		}
	});
});
