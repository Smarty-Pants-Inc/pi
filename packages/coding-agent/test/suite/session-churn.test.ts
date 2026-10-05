import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundaryContextPreview, SessionBoundaryDraft } from "../../src/core/extensions/types.ts";
import { convertToLlm } from "../../src/core/messages.ts";
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

	// smarty-dev#2177 / pi#94: a captured SDK manager can append context without boundary drafts.
	it.each(["user", "custom"] as const)(
		"continues after a captured manager appends canonical %s context",
		async (role) => {
			let requested = false;
			const requests: AgentMessage[][] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("agent_before_settle", () => {
							if (requested) return;
							requested = true;
							if (role === "user") {
								harness.sessionManager.appendMessage({ role, content: "canonical continuation", timestamp: 1 });
							} else {
								harness.sessionManager.appendCustomMessageEntry("canonical", "canonical continuation", false);
							}
							return { continue: true };
						});
					},
				],
			});
			harnesses.push(harness);
			const internals = harness.session as unknown as BoundaryInternals;
			const commits = vi.spyOn(internals, "_commitBoundaryDrafts");
			harness.setResponses([
				fauxAssistantMessage("first"),
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("start");
			expect(requests).toHaveLength(1);
			expect(requests[0].map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
			expect(JSON.stringify(requests[0].at(-1))).toContain("canonical continuation");
			expect(harness.session.getLastAssistantText()).toBe("second");
			expect(harness.eventsOfType("agent_start")).toHaveLength(2);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(commits).not.toHaveBeenCalled();
		},
	);

	// smarty-dev#2177 / pi#94: turn_end appends must reach a later draft-free continuation.
	it.each(["user", "custom"] as const)(
		"continues across boundaries after turn_end appends canonical %s context",
		async (role) => {
			let appended = false;
			let continued = false;
			const requests: AgentMessage[][] = [];
			const harness = await createHarness({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", () => {
							if (appended) return;
							appended = true;
							if (role === "user") {
								harness.sessionManager.appendMessage({
									role,
									content: "cross-boundary continuation",
									timestamp: 1,
								});
							} else {
								harness.sessionManager.appendCustomMessageEntry(
									"canonical",
									"cross-boundary continuation",
									false,
								);
							}
						});
						pi.on("agent_before_settle", () => {
							if (continued) return;
							continued = true;
							return { continue: true };
						});
					},
				],
			});
			harnesses.push(harness);
			const commits = vi.spyOn(harness.session as unknown as BoundaryInternals, "_commitBoundaryDrafts");
			harness.setResponses([
				fauxAssistantMessage("first"),
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("start");
			expect(requests).toHaveLength(1);
			expect(requests[0].map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
			expect(JSON.stringify(requests[0].at(-1))).toContain("cross-boundary continuation");
			expect(harness.session.getLastAssistantText()).toBe("second");
			expect(harness.eventsOfType("agent_start")).toHaveLength(2);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(commits).not.toHaveBeenCalled();
		},
	);

	// smarty-dev#2177 / pi#94: nested projection-local views are mutable, not canonical entries.
	it.each(
		(["truncate", "replace", "custom-context", "custom-llm", "summary-context", "summary-llm"] as const).flatMap(
			(mutation) => [false, true].map((throws) => ({ mutation, throws })),
		),
	)("restores nested $mutation views after a handler (throws: $throws)", async ({ mutation, throws }) => {
		const errors: string[] = [];
		const observations: BoundaryContextPreview[] = [];
		let canonical!: BoundaryContextPreview;
		let targetId!: string;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (event) => {
						const entry = event.context.contextEntries.find((entry) => entry.sourceEntry.id === targetId)!;
						if (mutation === "truncate") entry.messages.length = 0;
						else if (mutation === "replace") entry.messages = [];
						else if (mutation.endsWith("-llm")) {
							const message = event.context.llmMessages.at(-1)!;
							if (message.role !== "user" || typeof message.content === "string") {
								throw new Error("missing converted wrapper");
							}
							const part = message.content[0];
							if (part.type !== "text") throw new Error("missing converted text");
							part.text = "local inspection";
						} else {
							const message = entry.messages[0];
							if (message.role === "custom") message.content = "local inspection";
							else if (message.role === "compactionSummary") message.summary = "local inspection";
							else throw new Error("missing projected wrapper");
						}
						if (throws) throw new Error("failed after nested preview mutation");
					});
					pi.on("agent_before_settle", (event) => {
						observations.push(event.context);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const userId = harness.sessionManager.appendMessage({
			role: "user",
			content: "canonical contribution",
			timestamp: 1,
		});
		targetId = mutation.startsWith("custom")
			? harness.sessionManager.appendCustomMessageEntry("canonical", "canonical contribution", false)
			: mutation.startsWith("summary")
				? harness.sessionManager.appendCompaction("canonical summary", null, 10)
				: userId;
		const sourceBefore = structuredClone(harness.sessionManager.getEntry(targetId));
		const build = vi.fn(() => {
			const projection = harness.sessionManager.buildSessionProjection();
			const preview = {
				...emptyPreview(),
				contextEntries: projection.entries,
				contextMessages: projection.messages,
				llmMessages: convertToLlm(projection.messages),
			};
			canonical ??= structuredClone(preview);
			return preview;
		});
		const result = await harness.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			build,
		);
		expect(observations).toEqual([canonical]);
		expect(result.context).toEqual(canonical);
		expect(build).toHaveBeenCalledTimes(2);
		expect(harness.sessionManager.getEntry(targetId)).toEqual(sourceBefore);
		expect(errors).toEqual(throws ? ["failed after nested preview mutation"] : []);
	});

	// smarty-dev#2177 / pi#94: mutable preview arrays must not leak local inspection edits downstream.
	it.each(
		(["contextEntries", "contextMessages", "llmMessages", "pendingMessages"] as const).flatMap((key) =>
			[false, true].map((throws) => ({ key, throws })),
		),
	)("restores $key after a mutating handler (throws: $throws)", async ({ key, throws }) => {
		const errors: string[] = [];
		const observations: BoundaryContextPreview[] = [];
		let canonical!: BoundaryContextPreview;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (event) => {
						switch (key) {
							case "llmMessages":
								event.context.llmMessages.reverse();
								break;
							case "contextEntries":
								event.context.contextEntries.length = 0;
								break;
							case "contextMessages":
								event.context.contextMessages.splice(0, 1);
								break;
							case "pendingMessages":
								event.context.pendingMessages = [];
								break;
						}
						if (throws) throw new Error("failed after preview mutation");
					});
					pi.on("agent_before_settle", (event) => {
						observations.push(event.context);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		harness.sessionManager.appendMessage({ role: "system", content: "system", timestamp: 1 });
		harness.sessionManager.appendMessage({ role: "user", content: "user", timestamp: 2 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("assistant"));
		const build = vi.fn(() => {
			const projection = harness.sessionManager.buildSessionProjection();
			const preview = {
				contextEntries: projection.entries,
				contextMessages: projection.messages,
				llmMessages: convertToLlm(projection.messages),
				pendingMessages: [{ role: "user", content: "pending", timestamp: 3 } as AgentMessage],
				canContinue: true,
			};
			canonical = structuredClone(preview);
			return preview;
		});
		const result = await harness.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			build,
		);
		expect(observations).toEqual([canonical]);
		expect(observations[0].llmMessages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(result.context).toEqual(canonical);
		expect(build).toHaveBeenCalledTimes(2);
		expect(errors).toEqual(throws ? ["failed after preview mutation"] : []);
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

	// smarty-dev#2177 / pi#94: state can change while an asynchronous preview builder awaits.
	it.each([1, 2])("refreshes a preview captured before an await in build %i", async (pausedBuild) => {
		const pending: AgentMessage[] = [];
		const observations: BoundaryContextPreview[] = [];
		let capturePreview!: () => void;
		let releasePreview!: () => void;
		const captured = new Promise<void>((resolve) => {
			capturePreview = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releasePreview = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					if (pausedBuild === 2) {
						pi.on("agent_before_settle", () => ({
							entries: [{ type: "custom", customType: "draft" }],
						}));
					}
					pi.on("agent_before_settle", () => undefined);
					pi.on("agent_before_settle", (event) => {
						observations.push(event.context);
					});
				},
			],
		});
		harnesses.push(harness);
		let builds = 0;
		const build = vi.fn(async () => {
			const preview = {
				...emptyPreview(),
				contextEntries: harness.sessionManager.buildSessionProjection().entries,
				pendingMessages: pending.slice(),
				canContinue: pending.length > 0,
			};
			if (++builds === pausedBuild) {
				capturePreview();
				await release;
			}
			return preview;
		});
		const dispatch = harness.session.extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			build,
			() => pending,
		);
		await captured;
		const entryId = harness.sessionManager.appendCustomEntry("arrived-during-build");
		pending.push({ role: "user", content: "queued-during-build", timestamp: 1 });
		releasePreview();
		const result = await dispatch;
		expect(observations).toHaveLength(1);
		expect(observations[0].contextEntries.at(-1)?.sourceEntry.id).toBe(entryId);
		expect(observations[0].pendingMessages).toEqual(pending);
		expect(observations[0].canContinue).toBe(true);
		// smarty-dev#3048 / PR #116 R2-S3: accepted previews must detach handler-owned aliases.
		expect(result.context).toEqual(observations[0]);
		expect(result.context).not.toBe(observations[0]);
		expect(build).toHaveBeenCalledTimes(pausedBuild + 1);
	});

	// smarty-dev#2177 / pi#94: JavaScript extensions can return non-array proposals.
	it.each([null, {}, "malformed"])(
		"isolates malformed entries %j and preserves prior valid proposals for later handlers",
		async (malformed) => {
			const errors: string[] = [];
			let repaired = false;
			const kept: SessionBoundaryDraft = { type: "custom", customType: "preceding-valid", data: true };
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						// PR #141: malformed proposals are contained, not exposed for another handler to repair.
						pi.on("agent_before_settle", () => ({ entries: [kept], continue: true }));
						pi.on("agent_before_settle", () => ({ entries: malformed as unknown as SessionBoundaryDraft[] }));
						pi.on("agent_before_settle", (event) => {
							repaired = true;
							expect(event.entries).toEqual([kept]);
							expect(event.continue).toBe(true);
							return undefined;
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.extensionRunner.onError((error) => errors.push(error.error));
			const build = vi.fn((entries: SessionBoundaryDraft[]) => {
				if (!Array.isArray(entries)) throw new Error("Boundary entries must be an array");
				return emptyPreview();
			});
			const result = await harness.session.extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: "completed" },
				build,
			);
			expect(repaired).toBe(true);
			expect(errors).toEqual(["Invalid boundary entries: Boundary entries must be an array"]);
			expect(result).toMatchObject({ valid: true, entries: [kept], continue: true });
		},
	);

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
