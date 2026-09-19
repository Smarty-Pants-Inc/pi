import { loadOwnedSenseExtension } from "./extensions/loader.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import { assertOrdinaryOwner, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import type { ResourceLoader } from "./resource-loader.ts";

/** Fixed admitted host resources. This does not enumerate project/global packages
 * and cannot hydrate missing modules. Definition discovery remains Sense's job. */
export async function createOrdinaryResourceLoader(context: OrdinaryOwnerContext): Promise<ResourceLoader> {
	assertOrdinaryOwner(context);
	const extensions: LoadExtensionsResult = await loadOwnedSenseExtension(context);
	context.assertActive();
	return {
		getExtensions: () => {
			context.assertActive();
			return extensions;
		},
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {
			throw new Error("OWNER_RESOURCE_SCOPE");
		},
		reload: async () => {
			throw new Error("OWNER_RESOURCE_RELOAD_REQUIRES_RECEIVING");
		},
	};
}
