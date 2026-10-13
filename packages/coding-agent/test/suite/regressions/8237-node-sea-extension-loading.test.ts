import type * as NodeModule from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
	const originalGetBuiltinModule = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
	const getBuiltinModule = process.getBuiltinModule.bind(process);
	Object.defineProperty(process, "getBuiltinModule", {
		configurable: true,
		value: (id: string) => (id === "node:sea" ? { isSea: () => true } : getBuiltinModule(id)),
	});
	return {
		originalGetBuiltinModule,
		jitiModuleLoads: 0,
		virtualModulesLoads: 0,
		compositionReceiver: vi.fn(),
		composition: {} as Record<string, unknown>,
		owner: { manager: { getCwd: () => "/fixture" }, assertActive: vi.fn() },
		createJiti: vi.fn((_id: unknown, _options: unknown) => ({
			import: vi.fn(async () => () => {}),
			evalModule: vi.fn(() => {
				throw new Error("stop after owner-sense loader construction");
			}),
		})),
	};
});

vi.mock("jiti/static", () => {
	state.jitiModuleLoads++;
	return { createJiti: state.createJiti };
});

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeModule>();
	return {
		...actual,
		createRequire: () =>
			Object.assign(() => state.composition, { resolve: () => "/fixture/operational-composition.mjs" }),
	};
});

vi.mock("../../../src/core/session-ownership.ts", () => ({
	currentSessionOwnership: () => undefined,
	ownershipOf: () => state.owner,
}));

vi.mock("../../../src/core/ordinary-owner-context.ts", () => ({
	assertOrdinaryOwner: vi.fn(),
}));

vi.mock("../../../src/core/extensions/virtual-modules.ts", () => {
	state.virtualModulesLoads++;
	return {
		VIRTUAL_MODULES: {
			typebox: {},
			"@earendil-works/pi-coding-agent": {},
			"@earendil-works/pi-coding-agent/ordinary": {
				receiveOrdinaryOperationalCollector: state.compositionReceiver,
			},
		},
	};
});

import { loadExtensions, loadOwnedSenseExtension } from "../../../src/core/extensions/loader.ts";

interface JitiOptionsProbe {
	alias?: unknown;
	tryNative?: boolean;
	virtualModules?: Record<string, unknown>;
	fsCache?: boolean | string;
}

afterAll(() => {
	if (state.originalGetBuiltinModule) {
		Object.defineProperty(process, "getBuiltinModule", state.originalGetBuiltinModule);
	}
});

describe("Node SEA extension loading", () => {
	// Regression test for #8237 and #9540.
	it("loads jiti and bundled virtual modules only when importing an extension", async () => {
		expect(state.jitiModuleLoads).toBe(0);
		expect(state.virtualModulesLoads).toBe(0);

		const result = await loadExtensions(["/extension.ts"], "/");

		expect(result.errors).toEqual([]);
		expect(state.jitiModuleLoads).toBe(1);
		expect(state.virtualModulesLoads).toBe(1);
		expect(result.extensions).toHaveLength(1);
		expect(state.createJiti).toHaveBeenCalledOnce();

		const options = state.createJiti.mock.calls[0][1] as JitiOptionsProbe;
		// Source TypeScript also uses virtual modules, so tryNative: false is what
		// proves the compiled-binary branch took precedence over the source branch.
		expect(options.tryNative).toBe(false);
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules?.typebox).toBeDefined();
		expect(options.virtualModules?.["@earendil-works/pi-coding-agent"]).toBeDefined();
	});

	// Regression test for smarty-dev#10875.
	it("uses SMARTY_JITI_CACHE_DIR for ordinary extension imports and defaults to caching", async () => {
		const original = process.env.SMARTY_JITI_CACHE_DIR;
		try {
			process.env.SMARTY_JITI_CACHE_DIR = "/x";
			await loadExtensions(["/configured.ts"], "/");
			expect((state.createJiti.mock.calls.at(-1)![1] as JitiOptionsProbe).fsCache).toBe("/x");

			process.env.SMARTY_JITI_CACHE_DIR = "";
			await loadExtensions(["/empty.ts"], "/");
			expect((state.createJiti.mock.calls.at(-1)![1] as JitiOptionsProbe).fsCache).toBe(true);

			delete process.env.SMARTY_JITI_CACHE_DIR;
			await loadExtensions(["/default.ts"], "/");
			expect((state.createJiti.mock.calls.at(-1)![1] as JitiOptionsProbe).fsCache).toBe(true);
		} finally {
			if (original === undefined) delete process.env.SMARTY_JITI_CACHE_DIR;
			else process.env.SMARTY_JITI_CACHE_DIR = original;
		}
	});

	// Regression test for smarty-dev#10875: a shared cache must not change composition identity.
	it("keeps owner-sense module loading uncached", async () => {
		const originalCacheDir = process.env.SMARTY_JITI_CACHE_DIR;
		process.env.SMARTY_JITI_CACHE_DIR = "/x";
		const originalComposition = state.composition;
		state.composition = {
			receiveOrdinaryOperationalCollector: state.compositionReceiver,
			receiveOriginalOperationalCollector: vi.fn(),
		};
		const context = {
			owner: state.owner,
			decision: { record: { sense: { path: "/fixture/sense.ts" } } },
			holdSenseCompositionModule: vi.fn(),
			checkSenseCompositionModule: vi.fn(),
			within: <T>(action: () => T) => action(),
			assertActive: vi.fn(),
			readSenseEntry: () => "export default () => {}",
			assertSenseInstalled: vi.fn(),
		} as never;
		try {
			await expect(loadOwnedSenseExtension(context)).rejects.toThrow("stop after owner-sense loader construction");
			const options = state.createJiti.mock.calls.at(-1)![1] as JitiOptionsProbe;
			expect(options.fsCache).toBe(false);
		} finally {
			state.composition = originalComposition;
			if (originalCacheDir === undefined) delete process.env.SMARTY_JITI_CACHE_DIR;
			else process.env.SMARTY_JITI_CACHE_DIR = originalCacheDir;
		}
	});
});
