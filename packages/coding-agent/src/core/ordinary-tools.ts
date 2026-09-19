import { assertOrdinaryOwner, bindOrdinaryOptions, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import { createEditToolDefinition } from "./tools/edit.ts";
import { createReadToolDefinition } from "./tools/read.ts";
import { createWriteToolDefinition } from "./tools/write.ts";

/** Private tool construction; tool names and ambient sessions cannot supply custody. */
export function createOrdinaryToolDefinitions(owner: OrdinaryOwnerContext, autoResizeImages: boolean) {
	assertOrdinaryOwner(owner);
	const cwd = owner.owner.manager.getCwd();
	return {
		read: createReadToolDefinition(cwd, bindOrdinaryOptions({ autoResizeImages }, owner)),
		edit: createEditToolDefinition(cwd, bindOrdinaryOptions({}, owner)),
		write: createWriteToolDefinition(cwd, bindOrdinaryOptions({}, owner)),
	};
}
