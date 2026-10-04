import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../agent/src/types.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { BoundaryContextPreview, ExtensionFactory, SessionBoundaryDraft } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

async function makeRunner(manager: SessionManager, factory: ExtensionFactory) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		factory,
		process.cwd(),
		createEventBus(),
		runtime,
		"<inline:independent-audit>",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), manager, {} as ModelRegistry);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	return { runner, errors };
}
function preview(manager: SessionManager, pending: AgentMessage[]): BoundaryContextPreview {
	const messages = manager.buildSessionContext().messages;
	return {
		contextEntries: manager.buildSessionProjection().entries,
		contextMessages: messages,
		llmMessages: messages as BoundaryContextPreview["llmMessages"],
		pendingMessages: structuredClone(pending),
		canContinue: pending.length > 0,
	};
}

// PR #131: AU-CV-P2 regression controls from the independent audit.
describe("independent boundary refusal variants", () => {
	for (const mutation of ["canonical", "pending", "preview"] as const) {
		it.each([null, {}, "malformed"])(
			`never admits stale ${mutation} preview after malformed %j`,
			async (malformed) => {
				const manager = SessionManager.inMemory(process.cwd());
				const pending: AgentMessage[] = [];
				const admissions: Array<{ observed: BoundaryContextPreview; expected: BoundaryContextPreview }> = [];
				let canonicalRevision = 0;
				const { runner, errors } = await makeRunner(manager, (pi) => {
					pi.on("agent_before_settle", (event) => {
						if (mutation === "canonical") {
							manager.appendMessage({ role: "user", content: "arrived-before-repair", timestamp: 1 });
							canonicalRevision = manager.revision();
						} else if (mutation === "pending") {
							pending.push({ role: "user", content: "queued-before-repair", timestamp: 1 });
						} else {
							event.context.llmMessages.push({
								role: "user",
								content: "poisoned-projection-only",
								timestamp: 1,
							});
							event.context.canContinue = true;
						}
						return { entries: malformed as unknown as SessionBoundaryDraft[] };
					});
					pi.on("agent_before_settle", (event) => {
						admissions.push({
							observed: structuredClone(event.context),
							expected: structuredClone(preview(manager, pending)),
						});
						return { entries: [] };
					});
				});
				let refusal: string | null = null;
				let result: unknown;
				try {
					result = await runner.emitBoundary(
						{ type: "agent_before_settle", outcome: "completed" },
						(entries) => {
							if (!Array.isArray(entries)) throw new Error("Boundary entries must be an array");
							return preview(manager, pending);
						},
						() => pending,
					);
				} catch (error) {
					refusal = error instanceof Error ? error.message : String(error);
				}
				console.log(
					`AUDIT_RECEIPT ${JSON.stringify({ mutation, malformed, canonicalRevision, admissions, refusal, errors, result })}`,
				);
				// A refusal is safe. A repair may proceed, but it must not admit stale or poisoned context.
				for (const admission of admissions) expect(admission.observed).toEqual(admission.expected);
			},
		);
	}

	it.each(["canonical", "pending"] as const)("refreshes valid proposals after %s mutation", async (mutation) => {
		const manager = SessionManager.inMemory(process.cwd());
		const pending: AgentMessage[] = [];
		const observations: BoundaryContextPreview[] = [];
		const { runner, errors } = await makeRunner(manager, (pi) => {
			pi.on("agent_before_settle", () => {
				if (mutation === "canonical")
					manager.appendMessage({ role: "user", content: "arrived-valid", timestamp: 1 });
				else pending.push({ role: "user", content: "queued-valid", timestamp: 1 });
				return { entries: [] };
			});
			pi.on("agent_before_settle", (event) => {
				observations.push(structuredClone(event.context));
			});
		});
		const result = await runner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			() => preview(manager, pending),
			() => pending,
		);
		expect(observations).toEqual([preview(manager, pending)]);
		expect(result.valid).toBe(true);
		expect(errors).toEqual([]);
	});

	it.each([null, {}, "malformed"])("unrepaired %j never becomes an accepted proposal", async (malformed) => {
		const manager = SessionManager.inMemory(process.cwd());
		const { runner, errors } = await makeRunner(manager, (pi) => {
			pi.on("agent_before_settle", () => ({
				entries: malformed as unknown as SessionBoundaryDraft[],
				continue: true,
			}));
		});
		const result = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, () =>
			preview(manager, []),
		);
		expect(result).toMatchObject({ valid: false, entries: [], continue: false });
		expect(errors).toEqual(["Invalid boundary entries: Boundary entries must be an array"]);
	});

	it("owner abort still refuses the next handler after invalid proposal", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		const owner = new AbortController();
		const reason = new Error("private-audit-owner-abort");
		let admitted = 0;
		const { runner } = await makeRunner(manager, (pi) => {
			pi.on("agent_before_settle", () => {
				owner.abort(reason);
				return { entries: null as unknown as SessionBoundaryDraft[] };
			});
			pi.on("agent_before_settle", () => {
				admitted++;
				return { entries: [] };
			});
		});
		await expect(
			runner.emitBoundary(
				{ type: "agent_before_settle", outcome: "completed" },
				() => preview(manager, []),
				undefined,
				owner.signal,
			),
		).rejects.toBe(reason);
		expect(admitted).toBe(0);
	});

	it("unstable canonical state still refuses admission within eight builds", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		let admitted = 0;
		let builds = 0;
		const { runner } = await makeRunner(manager, (pi) => {
			pi.on("agent_before_settle", () => {
				admitted++;
			});
		});
		await expect(
			runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, () => {
				builds++;
				const built = preview(manager, []);
				manager.appendCustomEntry("changing-during-build");
				return built;
			}),
		).rejects.toThrow("Boundary context changed during 8 consecutive builds; dispatch refused");
		expect(builds).toBe(8);
		expect(admitted).toBe(0);
	});
});
