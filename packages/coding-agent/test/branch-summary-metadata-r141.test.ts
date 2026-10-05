import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import { repairModel, repairSession } from "./repair-r141-support.ts";

// PR #141 cut #7: served identity and safe transformation diagnostics travel with summary usage.
it("carries served B metadata through helper and persisted navigation summary", async () => {
	const response = fauxAssistantMessage("synthetic branch summary");
	response.provider = "served-provider-B";
	response.model = "served-model-B";
	response.diagnostics = [
		{ type: "api_input_transformations", timestamp: 1, details: { removed: ["synthetic-field"] } },
	];
	response.usage = {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
	};
	const streamFn: StreamFn = () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: structuredClone(response) });
		return stream;
	};
	const { session, manager, runtime } = await repairSession(
		new Agent({ initialState: { model: repairModel }, streamFn }),
	);
	vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "synthetic-auth" }, source: "runtime" });
	const target = manager.appendMessage({ role: "user", content: "initial branch", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("exploration"));
	manager.appendMessage({ role: "user", content: "abandoned input", timestamp: 2 });
	session.refreshContext();
	const expected = {
		provider: response.provider,
		model: response.model,
		diagnostics: response.diagnostics,
		usage: response.usage,
	};
	const result = await generateBranchSummary(manager.getBranch().slice(1), {
		model: repairModel,
		signal: new AbortController().signal,
		streamFn,
	});
	expect(result).toMatchObject(expected);
	const navigation = await session.navigateTree(target, { summarize: true });
	expect(navigation.cancelled).toBe(false);
	expect(navigation.summaryEntry).toMatchObject(expected);
	expect(manager.getEntry(navigation.summaryEntry!.id)).toMatchObject(expected);
	expect(session.getSessionStats().cost).toBeCloseTo(0.3);
});
