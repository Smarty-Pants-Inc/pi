import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundaryContextPreview } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

type BoundaryInternals = {
	_createBoundaryPreviewManager: (...args: unknown[]) => unknown;
	_buildBoundaryContext: (...args: unknown[]) => unknown;
	_commitBoundaryDrafts: (...args: unknown[]) => unknown;
	_refreshFinalizedContext: (...args: unknown[]) => unknown;
};

const emptyPreview = (): BoundaryContextPreview => ({
	contextEntries: [],
	contextMessages: [],
	llmMessages: [],
	pendingMessages: [],
	canContinue: false,
});

// smarty-dev#2177: empty observer boundaries must not construct full-history managers or commit.
describe("session boundary allocation churn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses canonical previews once per boundary and skips empty commits/refreshes", async () => {
		const seen: BoundaryContextPreview[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					for (let i = 0; i < 8; i++)
						pi.on("turn_end", (event) => {
							seen.push(event.context);
						});
					for (let i = 0; i < 2; i++)
						pi.on("agent_before_settle", (event) => {
							seen.push(event.context);
						});
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as BoundaryInternals;
		const previewManagers = vi.spyOn(internals, "_createBoundaryPreviewManager");
		const builds = vi.spyOn(internals, "_buildBoundaryContext");
		const commits = vi.spyOn(internals, "_commitBoundaryDrafts");
		const refreshes = vi.spyOn(internals, "_refreshFinalizedContext");
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("request");
		expect(previewManagers).not.toHaveBeenCalled();
		expect(commits).not.toHaveBeenCalled();
		expect(refreshes).not.toHaveBeenCalled();
		expect(builds).toHaveBeenCalledTimes(3);
		expect(seen).toHaveLength(10);
		for (let i = 0; i < 8; i++) expect(seen[i]).toBe(seen[0]);
		expect(seen[9]).toBe(seen[8]);
		expect(JSON.stringify(seen[0].contextMessages)).toBe(
			JSON.stringify(harness.sessionManager.buildSessionProjection().messages),
		);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("rebuilds for nested in-place draft mutations but not nonempty observers", async () => {
		const observations: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (event) => {
						event.entries.push({ type: "custom", customType: "draft", data: { value: 1 } });
					});
					pi.on("agent_before_settle", () => undefined);
					pi.on("agent_before_settle", (event) => {
						const draft = event.entries[0];
						if (draft.type !== "custom") throw new Error("missing draft");
						(draft.data as { value: number }).value = 2;
					});
					pi.on("agent_before_settle", (event) => {
						observations.push(event.context.contextEntries.at(-1)?.sourceEntry);
					});
				},
			],
		});
		harnesses.push(harness);
		const build = vi.fn(emptyPreview);
		await harness.session.extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, build);
		expect(build).toHaveBeenCalledTimes(3);
		expect(observations).toHaveLength(1);
	});

	it("rebuilds after canonical appends and queue changes even when results are omitted", async () => {
		const pending: AgentMessage[] = [];
		const observations: number[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						harness.sessionManager.appendCustomEntry("canonical");
					});
					pi.on("agent_before_settle", (event) => {
						observations.push(event.context.contextEntries.length);
						pending.push({ role: "user", content: "queued", timestamp: 1 });
					});
					pi.on("agent_before_settle", (event) => {
						observations.push(event.context.pendingMessages.length);
					});
				},
			],
		});
		harnesses.push(harness);
		const build = vi.fn(() => ({
			...emptyPreview(),
			contextEntries: harness.sessionManager.buildSessionProjection().entries,
			pendingMessages: pending.slice(),
		}));
		await harness.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			build,
			() => pending.slice(),
		);
		expect(build).toHaveBeenCalledTimes(3);
		expect(observations).toEqual([1, 1]);
	});

	it("preserves mutations before exceptions and repairs invalid proposals", async () => {
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (event) => {
						event.entries.push({ type: "context_edit", targetId: "missing", replacement: null });
						throw new Error("handler failed");
					});
					pi.on("agent_before_settle", () => ({ entries: [] }));
					pi.on("agent_before_settle", () => undefined);
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const build = vi.fn((entries: unknown[]) => {
			if (entries.length > 0) throw new Error("invalid draft");
			return emptyPreview();
		});
		const result = await harness.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			build,
		);
		expect(build).toHaveBeenCalledTimes(3);
		expect(errors).toEqual(["handler failed", "Invalid boundary entries: invalid draft"]);
		expect(result).toMatchObject({ valid: true, entries: [], continue: false });
	});
});
