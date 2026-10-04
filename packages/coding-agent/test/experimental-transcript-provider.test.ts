import { createFacetHost, defineFacet, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { appendToolResult } from "../../durable/src/harness/tool.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { createTranscriptServiceFacet } from "../src/experimental/services/transcript-provider.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

async function openTranscript() {
	const runtime = await openFauxConversation([fauxAssistantMessage("answer")]);
	const views: ConversationView[] = [];
	const consumer = defineFacet({
		id: "test-transcript-consumer",
		setup(env) {
			const transcript = env.use(Transcript);
			env.onActivate(() => env.own(transcript.state.subscribe((value) => void views.push(value))));
		},
	});
	const host = await createFacetHost({
		facets: [await createTranscriptServiceFacet(runtime.conversation, BACKGROUND_CONTEXT), consumer],
	});
	return { ...runtime, host, views };
}

describe("Transcript service", () => {
	test("replicates the conversation view as it changes and resets", async () => {
		const { conversation, close, host, views } = await openTranscript();
		try {
			expect(views[0]?.entries).toEqual([]);
			const submission = await conversation.submit({ type: "input", content: "question" }, BACKGROUND_CONTEXT);
			await submission.wait(BACKGROUND_CONTEXT);
			await expect.poll(() => views.at(-1)?.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
			await conversation.reset("replacement", BACKGROUND_CONTEXT);
			await expect.poll(() => views.at(-1)?.entries.map((entry) => entry.kind)).toEqual(["pi.reset"]);
		} finally {
			await host.dispose();
			await close();
		}
	});

	// smarty-dev#890 / pi#51: the durable transaction replaces the old lane-event sanitizer.
	test.each([false, true])("replicates normalized tool results (own prototype key: %s)", async (withDetails) => {
		const { harness, conversation, close, host, views } = await openTranscript();
		const details = JSON.parse('{"__proto__":{"marker":"kept"},"other":1}') as Record<string, JsonValue | undefined>;
		details.gone = undefined;
		try {
			const entry = await harness.commit(
				(tx) =>
					appendToolResult(
						tx,
						conversation.id,
						{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
						{
							content: [{ type: "text", text: "file" }],
							details: withDetails ? (details as JsonValue) : undefined,
						},
						2,
					),
				BACKGROUND_CONTEXT,
			);
			await expect.poll(() => views.at(-1)?.entries.at(-1)?.id).toBe(entry.id);
			for (const message of [entry.model?.[0], views.at(-1)?.entries.at(-1)?.model?.[0]]) {
				expect(message).toMatchObject({
					role: "toolResult",
					toolCallId: "call-1",
					content: [{ type: "text", text: "file" }],
				});
				if (!withDetails) expect(message).not.toHaveProperty("details");
				else {
					const copied = (message as ToolResultMessage).details as Record<string, JsonValue>;
					expect(Object.hasOwn(copied, "__proto__")).toBe(true);
					expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
					expect(copied.__proto__).toEqual({ marker: "kept" });
					expect(copied).not.toHaveProperty("gone");
				}
			}
		} finally {
			await host.dispose();
			await close();
		}
	});
});
