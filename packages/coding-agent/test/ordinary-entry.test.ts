import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { bindOrdinaryOptions, OrdinaryOwnerContext } from "../src/core/ordinary-owner-context.ts";
import {
	captureOrdinaryRequestPair as originalCapture,
	consumeOrdinaryPairedInput as originalConsume,
} from "../src/core/ordinary-request-pair.ts";
import {
	assertOrdinaryOwner,
	captureOrdinaryRequestPair,
	consumeOrdinaryPairedInput,
	ordinaryApplicationPath,
} from "../src/ordinary.ts";

// Source identity and refusal checks only. No native receiving, grant or package installation.
test("ordinary exports the original paired registry functions and its own application path", () => {
	expect(captureOrdinaryRequestPair).toBe(originalCapture);
	expect(consumeOrdinaryPairedInput).toBe(originalConsume);
	expect(ordinaryApplicationPath).toBe(fileURLToPath(new URL("../src/ordinary.ts", import.meta.url)));
});

test("a copied owner prototype cannot bind runtime options", () => {
	const forged = Object.create(OrdinaryOwnerContext.prototype) as OrdinaryOwnerContext;
	expect(() => assertOrdinaryOwner(forged)).toThrow();
	expect(() => bindOrdinaryOptions({}, forged)).toThrow();
});

test("an extension importing the public ordinary subpath receives the original consumer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ordinary-entry-"));
	try {
		const entry = join(directory, "identity.ts");
		// ponytail: registered renderers are now source-bound wrappers (pi#187), so hand the imported
		// function reference back through a test-only global instead of the renderer registry.
		await writeFile(
			entry,
			`
import { consumeOrdinaryPairedInput } from "@earendil-works/pi-coding-agent/ordinary";
export default function(pi) {
	globalThis.__piOrdinaryIdentityProbe = consumeOrdinaryPairedInput;
}
`,
		);
		const loaded = await loadExtensions([entry], directory);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		expect((globalThis as { __piOrdinaryIdentityProbe?: unknown }).__piOrdinaryIdentityProbe).toBe(originalConsume);
		loaded.runtime.invalidate();
	} finally {
		delete (globalThis as { __piOrdinaryIdentityProbe?: unknown }).__piOrdinaryIdentityProbe;
		await rm(directory, { recursive: true, force: true });
	}
});
