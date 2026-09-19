import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "./agent-session-services.ts";
import {
	assertOrdinaryOwner,
	bindOrdinaryOptions,
	type OrdinaryOwnerContext,
	ordinaryOwnerOf,
} from "./ordinary-owner-context.ts";
import type { OrdinaryOperationalHooks } from "./ordinary-sense.ts";

export type {
	OrdinaryOperationalCore,
	OrdinaryOperationalExecutor,
	OrdinaryOperationalHooks,
} from "./ordinary-sense.ts";

/** The real ordinary factory closes over the received original owner. It never
 * obtains authority from the mutable current session or a replacement target. */
export async function createOrdinaryRuntime(
	owner: OrdinaryOwnerContext,
	agentDir: string,
	operational?: OrdinaryOperationalHooks,
): Promise<AgentSessionRuntime> {
	assertOrdinaryOwner(owner);
	const original = owner.owner;
	try {
		const createRuntime: CreateAgentSessionRuntimeFactory = owner.bindFactory(async (target) => {
			owner.assertActive();
			if (
				ordinaryOwnerOf(target) !== owner ||
				target.sessionManager !== original.manager ||
				target.cwd !== original.manager.getCwd() ||
				target.agentDir !== agentDir
			)
				throw new Error("OWNER_RUNTIME_OWNERSHIP");
			const services = await original.within(() =>
				createAgentSessionServices(
					bindOrdinaryOptions(
						{
							cwd: target.cwd,
							agentDir,
						},
						owner,
					),
				),
			);
			owner.assertActive();
			const allowed = owner.decision.record.provider;
			const model = services.modelRuntime.getModel(allowed.provider, allowed.model);
			if (!model || model.api !== allowed.api) throw new Error("OWNER_MODEL_UNAVAILABLE");
			const created = await original.within(() =>
				createAgentSessionFromServices(
					bindOrdinaryOptions(
						{
							services,
							sessionManager: original.manager,
							model,
							tools: ["read", "write", "edit", "sense"],
							sessionStartEvent: target.sessionStartEvent,
						},
						owner,
					),
				),
			);
			owner.assertActive();
			return { ...created, services, diagnostics: services.diagnostics };
		}, operational);
		return await createAgentSessionRuntime(
			createRuntime,
			bindOrdinaryOptions(
				{
					cwd: original.manager.getCwd(),
					agentDir,
					sessionManager: original.manager,
				},
				owner,
			),
		);
	} catch (error) {
		try {
			await owner.close();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "OWNER_RUNTIME_CREATION_FAILED");
		}
		throw error;
	}
}
