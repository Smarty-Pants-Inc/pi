import { replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentLane, EventListener, HarnessEvent, LaneSnapshot, WatchHandle } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import type { TranscriptState } from "../src/experimental/services/transcript.ts";
import { createTranscriptService } from "../src/experimental/services/transcript-provider.ts";

function laneSnapshot(tipId: string | null = null): LaneSnapshot {
	return {
		lane: "main",
		transcript: [],
		tipId,
		configuration: {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			activeToolNames: [],
		},
		stats: {
			messageCount: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		operation: null,
		queues: [],
		faulted: false,
	};
}

describe("Transcript service", () => {
	test("publishes coherent state and rebases after navigation", async () => {
		let listener: EventListener | undefined;
		const replacement = laneSnapshot("replacement-tip");
		const resnapshot = vi.fn(async () => replacement);
		const unsubscribe = vi.fn();
		const handle: WatchHandle<LaneSnapshot> = {
			snapshot: laneSnapshot(),
			start(next) {
				listener = next;
			},
			resnapshot,
			unsubscribe,
		};
		const lane = { watch: async () => handle } as unknown as AgentLane;
		const runtime = createTranscriptService(lane, replicatedState);
		const states: TranscriptState[] = [];
		runtime.service.state.subscribe((value) => {
			if (value.snapshot !== null) states.push(value);
		});
		await runtime.activate();

		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({ snapshot: { lane: "main", operation: null }, event: null });
		await listener?.({ type: "run_start", lane: "main", runId: "run-1", startedAt: 1 }, BACKGROUND_CONTEXT);
		expect(states).toHaveLength(2);
		expect(states[1]).toMatchObject({
			snapshot: { operation: { id: "run-1" } },
			event: { type: "run_start", runId: "run-1" },
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
			{ type: "tool_start", lane: "main", runId: "run-1", turnId: "turn-1", toolCallId: "call-2", toolName: "read", args: {} } as unknown as HarnessEvent,
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
		const settled = (states.at(-1)?.snapshot?.operation as { runningTools?: { toolCallId: string; result?: { details?: object } }[] })
			?.runningTools?.find((tool) => tool.toolCallId === "call-2")?.result?.details;
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
