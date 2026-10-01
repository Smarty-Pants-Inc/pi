import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JitiOptions } from "jiti";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
		createJiti: vi.fn((_id: unknown, options: JitiOptions) => ({
			options: { ...options, transform: (input: { source: string }) => ({ code: input.source }) },
			evalModule: vi.fn(async () => ({ default: () => {} })),
		})),
	};
});

vi.mock("jiti/static", () => {
	state.jitiModuleLoads++;
	return { createJiti: state.createJiti };
});

vi.mock("../../../src/core/extensions/virtual-modules.ts", () => {
	state.virtualModulesLoads++;
	return {
		VIRTUAL_MODULES: {
			typebox: {},
			"@earendil-works/pi-coding-agent": {},
		},
	};
});

import { loadExtensions } from "../../../src/core/extensions/loader.ts";

interface JitiOptionsProbe {
	alias?: unknown;
	tryNative?: boolean;
	tsconfigPaths?: boolean;
	virtualModules?: Record<string, unknown>;
}

afterAll(() => {
	if (state.originalGetBuiltinModule) {
		Object.defineProperty(process, "getBuiltinModule", state.originalGetBuiltinModule);
	}
});

const directories: string[] = [];
afterEach(() => {
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("Node SEA extension loading", () => {
	// Regression test for #8237 and #9540.
	it("loads jiti and bundled virtual modules only when importing an extension", async () => {
		expect(state.jitiModuleLoads).toBe(0);
		expect(state.virtualModulesLoads).toBe(0);

		// pi#95 R6: SEA also evaluates the bytes from an opened real extension file.
		const root = mkdtempSync(join(tmpdir(), "pi-sea-loader-"));
		directories.push(root);
		const file = join(root, "extension.ts");
		writeFileSync(file, "export default function() {}");
		const result = await loadExtensions([file], root);

		expect(result.errors).toEqual([]);
		expect(state.jitiModuleLoads).toBe(1);
		expect(state.virtualModulesLoads).toBe(1);
		expect(result.extensions).toHaveLength(1);
		expect(state.createJiti).toHaveBeenCalledOnce();

		const options = state.createJiti.mock.calls[0][1] as JitiOptionsProbe;
		// Both runtimes now disable native-first loading. SEA still uses the static loader
		// and embedded modules, without the source runtime's tsconfig path resolution.
		expect(options.tryNative).toBe(false);
		expect(options.tsconfigPaths).toBeUndefined();
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules?.typebox).toBeDefined();
		expect(options.virtualModules?.["@earendil-works/pi-coding-agent"]).toBeDefined();
	});
});
