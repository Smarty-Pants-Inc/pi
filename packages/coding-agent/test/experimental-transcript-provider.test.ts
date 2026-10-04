import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { createTranscriptServiceFacet } from "../src/experimental/services/transcript-provider.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

describe("Transcript service", () => {
	test("replicates the conversation view as it changes", async () => {
		const { conversation, close } = await openFauxConversation([fauxAssistantMessage("answer")]);
		const views: ConversationView[] = [];
		const consumer = defineFacet({
			id: "test-transcript-consumer",
			setup(env) {
				const transcript = env.use(Transcript);
				env.onActivate(() => env.own(transcript.state.subscribe((value) => void views.push(value))));
			},
		});
		const host = await createFacetHost({
			facets: [await createTranscriptServiceFacet(conversation, BACKGROUND_CONTEXT), consumer],
		});

		await listener?.(
			{
				type: "entry_added",
				lane: "main",
				entry: {
					id: "entry-1",
					parentId: null,
					seq: 1,
					timestamp: 2,
					type: "message",
					message: { role: "user", content: "hello", timestamp: 2 },
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(states.at(-1)).toMatchObject({
			snapshot: { tipId: "entry-1", transcript: [{ id: "entry-1" }] },
			event: { type: "entry_added" },
		});

		// smarty-dev#890: a tool result with `details: undefined` still reaches subscribers.
		await listener?.(
			{
				type: "tool_end",
				lane: "main",
				runId: "run-1",
				toolCallId: "call-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "file" }], details: undefined },
				isError: false,
				endedAt: 2,
			} as unknown as HarnessEvent,
			BACKGROUND_CONTEXT,
		);
		expect(states.at(-1)).toMatchObject({ event: { type: "tool_end", toolCallId: "call-1" } });
		expect(states.at(-1)?.event).not.toHaveProperty("result.details");

		// pi#51 review: an own `__proto__` key from JSON.parse stays a key (in the event and the settled
		// tool), next to a dropped undefined property; it must not become the copy's prototype.
		const details = JSON.parse('{"__proto__":{"marker":"kept"},"other":1}') as Record<string, unknown>;
		(details as Record<string, unknown>).gone = undefined;
		await listener?.(
			{
				type: "tool_start",
				lane: "main",
				runId: "run-1",
				turnId: "turn-1",
				toolCallId: "call-2",
				toolName: "read",
				args: {},
			} as unknown as HarnessEvent,
			BACKGROUND_CONTEXT,
		);
		await listener?.(
			{
				type: "tool_end",
				lane: "main",
				runId: "run-1",
				turnId: "turn-1",
				toolCallId: "call-2",
				toolName: "read",
				result: { content: [{ type: "text", text: "file" }], details },
				isError: false,
				terminate: false,
				endedAt: 2,
			} as unknown as HarnessEvent,
			BACKGROUND_CONTEXT,
		);
		const published = (states.at(-1)?.event as { result?: { details?: Record<string, unknown> } }).result?.details;
		expect(published && Object.hasOwn(published, "__proto__")).toBe(true);
		expect(published && Object.getPrototypeOf(published)).toBe(Object.prototype);
		expect(published).not.toHaveProperty("gone");
		const settled = (
			states.at(-1)?.snapshot?.operation as {
				runningTools?: { toolCallId: string; result?: { details?: object } }[];
			}
		)?.runningTools?.find((tool) => tool.toolCallId === "call-2")?.result?.details;
		expect(settled && Object.hasOwn(settled, "__proto__")).toBe(true);

		const navigation: HarnessEvent = {
			type: "navigation_end",
			lane: "main",
			runId: "navigation-1",
			status: "completed",
			fromTipId: "entry-1",
			tipId: "replacement-tip",
			endedAt: 3,
		};
		await listener?.(navigation, BACKGROUND_CONTEXT);
		await vi.waitFor(() => expect(states.at(-1)?.event).toBeNull());
		expect(states.at(-2)).toMatchObject({
			snapshot: { tipId: "entry-1" },
			event: { type: "navigation_end" },
		});
		expect(states.at(-1)).toMatchObject({ snapshot: { tipId: "replacement-tip" }, event: null });
		expect(runtime.service.state.value).toMatchObject({ snapshot: { tipId: "replacement-tip" }, event: null });
		expect(resnapshot).toHaveBeenCalledOnce();

		await runtime.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
