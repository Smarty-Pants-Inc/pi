import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import type * as NodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

	// Regression tests for smarty-dev#10875 and pi#227: SMARTY_JITI_CACHE_DIR is used only when it is an
	// absolute, existing, non-symlink directory with safe leaf ownership and mode; otherwise fsCache falls back to true.
	// Temp directories live in a private mkdtemp root inside the process TMPDIR and are intentionally not deleted.
	describe("SMARTY_JITI_CACHE_DIR validation (pi#227)", () => {
		const posix = typeof process.getuid === "function" && process.platform !== "win32";
		const isRoot = posix && process.getuid!() === 0;
		let root: string;
		let originalCacheDir: string | undefined;

		const makeDir = (name: string, mode: number): string => {
			const dir = join(root, name);
			mkdirSync(dir);
			chmodSync(dir, mode);
			return dir;
		};

		const loadWithCacheDir = async (
			value: string | undefined,
		): Promise<{ fsCache: unknown; warnings: Array<{ path: string; warning: string }> }> => {
			if (value === undefined) delete process.env.SMARTY_JITI_CACHE_DIR;
			else process.env.SMARTY_JITI_CACHE_DIR = value;
			const before = state.createJiti.mock.calls.length;
			const result = await loadExtensions(["/cache-probe.ts"], "/");
			expect(result.errors).toEqual([]);
			expect(state.createJiti.mock.calls.length).toBe(before + 1);
			return {
				fsCache: (state.createJiti.mock.calls.at(-1)![1] as JitiOptionsProbe).fsCache,
				warnings: result.warnings ?? [],
			};
		};

		const fsCacheFor = async (value: string | undefined): Promise<unknown> => (await loadWithCacheDir(value)).fsCache;

		beforeEach(() => {
			originalCacheDir = process.env.SMARTY_JITI_CACHE_DIR;
			root = realpathSync(mkdtempSync(join(tmpdir(), "pi-227-jiti-cache-")));
		});

		afterEach(() => {
			if (originalCacheDir === undefined) delete process.env.SMARTY_JITI_CACHE_DIR;
			else process.env.SMARTY_JITI_CACHE_DIR = originalCacheDir;
		});

		it("uses an absolute 0700 directory owned by the current user", async () => {
			const dir = makeDir("owned", 0o700);
			expect(await fsCacheFor(dir)).toBe(dir);
		});

		it("defaults to true when unset or empty", async () => {
			expect(await loadWithCacheDir(undefined)).toEqual({ fsCache: true, warnings: [] });
			expect(await loadWithCacheDir("")).toEqual({ fsCache: true, warnings: [] });
		});

		// First bad-value case in this file: the one-time per-process fallback warning is consumed here.
		it("falls back to true for a relative path and warns once without the configured value", async () => {
			const configured = "pi-227-relative-cache-value";
			makeDir(configured, 0o700);
			const cwd = process.cwd();
			try {
				process.chdir(root);
				const first = await loadWithCacheDir(configured);
				expect(first.fsCache).toBe(true);
				expect(first.warnings).toEqual([{ path: "", warning: expect.stringContaining("relative") }]);
				expect(first.warnings[0].warning).not.toContain(configured);

				const second = await loadWithCacheDir(configured);
				expect(second).toEqual({ fsCache: true, warnings: [] });
			} finally {
				process.chdir(cwd);
			}
		});

		it("falls back to true for a missing directory", async () => {
			expect(await fsCacheFor(join(root, "missing"))).toBe(true);
		});

		it("falls back to true for a symlink to a valid directory", async () => {
			const target = makeDir("target", 0o700);
			const link = join(root, "link");
			symlinkSync(target, link, "dir");
			expect(await fsCacheFor(link)).toBe(true);
		});

		// Regression test for pi#227: a trailing slash must not make lstat follow the final symlink.
		it("falls back to true for a symlink given with a trailing slash", async () => {
			const target = makeDir("slash-target", 0o700);
			const link = join(root, "slash-link");
			symlinkSync(target, link, "dir");
			expect(await fsCacheFor(`${link}/`)).toBe(true);
		});

		it.skipIf(!posix)("falls back to true for a 0777 directory (POSIX only)", async () => {
			expect(await fsCacheFor(makeDir("world-writable", 0o777))).toBe(true);
		});

		it.skipIf(!posix)("falls back to true for a 0775 directory (POSIX only)", async () => {
			expect(await fsCacheFor(makeDir("group-writable", 0o775))).toBe(true);
		});

		// Changing a directory owner to another UID requires root; non-root runners skip this case.
		it.skipIf(!isRoot)("falls back to true for a 0700 directory owned by another UID (root only)", async () => {
			const dir = makeDir("foreign-owner", 0o700);
			chownSync(dir, 65534, 65534);
			expect(await fsCacheFor(dir)).toBe(true);
		});
	});

	// Regression test for smarty-dev#10875: a shared cache must not change composition identity.
	it("keeps owner-sense module loading uncached", async () => {
		const originalCacheDir = process.env.SMARTY_JITI_CACHE_DIR;
		process.env.SMARTY_JITI_CACHE_DIR = realpathSync(mkdtempSync(join(tmpdir(), "pi-227-composition-")));
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
