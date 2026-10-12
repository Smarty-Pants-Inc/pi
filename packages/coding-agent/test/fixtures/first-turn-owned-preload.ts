import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// smarty-code#1681: test-process-only construction seam. The real OwnedJournal,
// SessionOwnership and SessionManager persistence bodies remain intact; only host construction and
// the unbound SDK's owned-manager refusal are bypassed for the storage probe.
// This is not a fleet OrdinaryOwnerContext or a host/admission qualification.
const effectsUrl = new URL("../../src/core/owner-effects.ts", import.meta.url).href;
const managerUrl = new URL("../../src/core/session-manager.ts", import.meta.url).href;

registerHooks({
	load(url, context, nextLoad) {
		if (url !== effectsUrl && url !== managerUrl) return nextLoad(url, context);
		let source = readFileSync(new URL(url), "utf8");
		if (url === effectsUrl) {
			source += `
export function firstTurnStorageHost(native, directory) {
	const storage = Object.create(native);
	storage.acquire = (_host, _lock, name, existing) => native.open(directory, name, existing);
	// C open already holds exclusion and checked the prior producer/acknowledged
	// record. There are no effect groups in this isolated storage fixture.
	storage.recoveryStatus = () => ({ needed: false });
	storage.quarantine = () => undefined;
	return new OwnerHost(constructionKey,
		{ storage: { root: directory, journalBytes: 16777216 },
		  limits: { closeTimeoutMs: 30000 }, sandbox: { toolRoot: directory } },
		"0".repeat(64), storage, {});
}
`;
		} else {
			const guard = "if (manager.#ownedJournal) {";
			if (source.split(guard).length !== 2) throw new Error("First-turn storage probe refusal seam changed");
			source = source.replace(guard, "if (false) {");
		}
		return { source, format: "module-typescript", shortCircuit: true };
	},
});
