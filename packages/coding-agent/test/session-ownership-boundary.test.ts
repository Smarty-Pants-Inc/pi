import * as fs from "node:fs";
import type { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentSession, type AgentSessionConfig } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { OwnedJournal, OwnerAdmission, OwnerHost, openReleaseFile } from "../src/core/owner-effects.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { currentSessionOwnership, ownershipOf, SessionOwnership } from "../src/core/session-ownership.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

// Negative construction/ordering only. No native owner, grant or mocked native
// success. Incomplete runtime dependencies must never reach an effect.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));
afterEach(() => vi.restoreAllMocks());

function forgedManager(): SessionManager {
	return Object.assign(Object.create(SessionManager.prototype), { assertUnownedRuntime() {} }) as SessionManager;
}

describe("native custody construction boundary", () => {
	test("release-file read failure retains the primary cause and one close attempt", () => {
		const primary = new Error("synthetic read failure");
		const cleanup = new Error("synthetic close failure");
		vi.spyOn(fs, "lstatSync").mockReturnValue({ isDirectory: () => true, uid: 0, mode: 0o755 } as ReturnType<
			typeof fs.lstatSync
		>);
		vi.spyOn(fs, "openSync").mockReturnValue(71);
		vi.spyOn(fs, "fstatSync").mockReturnValue({
			isFile: () => true,
			uid: 0,
			mode: 0o644,
			nlink: 1,
			size: 1,
		} as ReturnType<typeof fs.fstatSync>);
		vi.spyOn(fs, "readFileSync").mockImplementation(() => {
			throw primary;
		});
		const close = vi.spyOn(fs, "closeSync").mockImplementation(() => {
			throw cleanup;
		});
		let failure: unknown;
		try {
			openReleaseFile("/synthetic/release", 1024);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
		expect((failure as AggregateError).cause).toBe(primary);
		expect(close).toHaveBeenCalledExactlyOnceWith(71);
	});
	test("rejects structural and prototyped journals before caller accessors", () => {
		let called = 0;
		for (const supplied of [{}, Object.create(OwnedJournal.prototype)]) {
			Object.defineProperty(supplied, "file", {
				get: () => {
					called++;
					throw new Error("caller accessor");
				},
			});
			expect(() => SessionManager.openOwned("/synthetic", supplied as OwnedJournal)).toThrow(
				"OWNED_JOURNAL_REQUIRED",
			);
		}
		expect(called).toBe(0);
	});

	test("rejects forged construction keys and host identities", () => {
		for (const construct of [OwnedJournal, OwnerHost, OwnerAdmission, SessionOwnership]) {
			expect(() => Reflect.construct(construct, [Symbol("forged"), {}, {}, {}, {}])).toThrow(
				"OWNER_NATIVE_CONSTRUCTION",
			);
		}
		const supplied = Object.create(OwnerHost.prototype) as OwnerHost;
		expect(() => OwnedJournal.acquire(supplied, "synthetic", "2026-09-14_synthetic.jsonl", false)).toThrow(
			"OWNER_NATIVE_HOST_REQUIRED",
		);
		expect(() =>
			supplied.admit({} as OwnedJournal, { roots: [], commands: [], effects: [], provider: null }),
		).toThrow("OWNER_NATIVE_HOST_REQUIRED");
	});

	test("unowned data and shadow fields cannot enroll custody or select owned persistence", () => {
		const a = SessionManager.inMemory("/synthetic");
		const b = SessionManager.inMemory("/synthetic", { id: a.getSessionId() });
		expect(ownershipOf(a)).toBeUndefined();
		expect(ownershipOf(b)).toBeUndefined();
		expect(currentSessionOwnership()).toBeUndefined();
		expect(Object.hasOwn(a, "ownedJournal")).toBe(false);
		Object.defineProperty(a, "ownedJournal", {
			get() {
				throw new Error("shadow custody accessed");
			},
		});
		expect(() => a.assertUnownedRuntime()).not.toThrow();
		expect(() => a.persistCurrent()).toThrow("OWNED_JOURNAL_REQUIRED");
	});
});

function hookBoundary() {
	const hook = vi.fn<(stage: string) => void>();
	const dispose = vi.fn();
	const factory = vi.fn(async () => {
		throw new Error("unexpected factory");
	});
	const holder = {
		sessionManager: SessionManager.inMemory(process.cwd()),
		extensionRunner: {
			hasHandlers: () => true,
			emit: async (event: { type: string }) => {
				hook(event.type);
			},
		},
		abort: async () => {
			hook("abort");
		},
		dispose,
	} as unknown as AgentSession;
	const runtime = new AgentSessionRuntime(
		holder,
		{ cwd: process.cwd(), agentDir: "/synthetic" } as AgentSessionServices,
		factory,
	);
	const substitutedAccess = vi.fn(() => {
		throw new Error("substituted object accessed");
	});
	const replacementDispose = vi.fn();
	const replacement = {
		get sessionManager() {
			return substitutedAccess();
		},
		get extensionRunner() {
			return substitutedAccess();
		},
		dispose: replacementDispose,
	};
	return { hook, dispose, factory, holder, runtime, substitutedAccess, replacement, replacementDispose };
}

describe("hook-time runtime identity", () => {
	for (const operation of ["new", "fork"] as const) {
		for (const mutation of ["session", "manager"] as const) {
			test(`${operation} rejects ${mutation} replacement inside the awaited before hook`, async () => {
				const fixture = hookBoundary();
				const mkdir = vi.spyOn(fs, "mkdirSync");
				fixture.hook.mockImplementation(() => {
					if (mutation === "session") Reflect.set(fixture.runtime, "_session", fixture.replacement);
					else
						Object.defineProperty(fixture.holder, "sessionManager", {
							value: {
								get getSessionDir() {
									return fixture.substitutedAccess();
								},
								get getEntry() {
									return fixture.substitutedAccess();
								},
							},
						});
				});
				await expect(
					operation === "new" ? fixture.runtime.newSession() : fixture.runtime.fork("entry"),
				).rejects.toThrow("OWNER_RUNTIME_SESSION_CHANGED");
				expect(fixture.substitutedAccess).not.toHaveBeenCalled();
				expect(fixture.factory).not.toHaveBeenCalled();
				expect(mkdir).not.toHaveBeenCalled();
				expect(fixture.dispose).not.toHaveBeenCalled();
				expect(fixture.replacementDispose).not.toHaveBeenCalled();
			});
		}
	}

	for (const stage of ["abort", "session_shutdown", "invalidate"] as const) {
		test(`teardown rejects replacement during ${stage} without disposing it`, async () => {
			const fixture = hookBoundary();
			const swap = () => {
				Reflect.set(fixture.runtime, "_session", fixture.replacement);
			};
			fixture.hook.mockImplementation((seen) => {
				if (seen === stage) swap();
			});
			if (stage === "invalidate") fixture.runtime.setBeforeSessionInvalidate(swap);
			await expect(fixture.runtime.newSession()).rejects.toThrow("OWNER_RUNTIME_SESSION_CHANGED");
			expect(fixture.substitutedAccess).not.toHaveBeenCalled();
			expect(fixture.factory).not.toHaveBeenCalled();
			expect(fixture.dispose).not.toHaveBeenCalled();
			expect(fixture.replacementDispose).not.toHaveBeenCalled();
		});
	}

	test("quit shutdown cannot dispose a hook-installed replacement", async () => {
		const fixture = hookBoundary();
		fixture.hook.mockImplementation(() => {
			Reflect.set(fixture.runtime, "_session", fixture.replacement);
		});
		await expect(fixture.runtime.dispose()).rejects.toThrow("OWNER_RUNTIME_SESSION_CHANGED");
		expect(fixture.substitutedAccess).not.toHaveBeenCalled();
		expect(fixture.dispose).not.toHaveBeenCalled();
		expect(fixture.replacementDispose).not.toHaveBeenCalled();
	});
});

describe("unbound runtime refusal ordering", () => {
	test("SDK ignores a forged instance guard and refuses before options access", async () => {
		const cwd = vi.fn(() => {
			throw new Error("options accessed before fence");
		});
		await expect(
			createAgentSession({
				sessionManager: forgedManager(),
				get cwd() {
					return cwd();
				},
			}),
		).rejects.toThrow("OWNER_RUNTIME_MANAGER_REQUIRED");
		expect(cwd).not.toHaveBeenCalled();
	});

	test("AgentSession ignores forged guard before hooks or agent access", () => {
		const agent = vi.fn(() => {
			throw new Error("agent accessed before fence");
		});
		const config = {
			sessionManager: forgedManager(),
			get agent() {
				return agent();
			},
		} as unknown as AgentSessionConfig;
		expect(() => new AgentSession(config)).toThrow("OWNER_RUNTIME_MANAGER_REQUIRED");
		expect(agent).not.toHaveBeenCalled();
	});

	test("runtime refuses forged manager before factory and filesystem checks", async () => {
		const manager = forgedManager();
		const factory = vi.fn(async () => {
			throw new Error("factory called before fence");
		});
		await expect(
			createAgentSessionRuntime(factory, { sessionManager: manager, cwd: "/synthetic", agentDir: "/synthetic" }),
		).rejects.toThrow("OWNER_RUNTIME_MANAGER_REQUIRED");
		expect(
			() =>
				new AgentSessionRuntime({ sessionManager: manager } as AgentSession, {} as AgentSessionServices, factory),
		).toThrow("OWNER_RUNTIME_MANAGER_REQUIRED");
		expect(factory).not.toHaveBeenCalled();
	});

	test("SDK retains one validated manager across option mutation and getter alternation", async () => {
		const manager = SessionManager.inMemory("/synthetic");
		const stop = new Error("reached original manager without runtime construction");
		vi.spyOn(manager, "buildSessionContext").mockImplementation(() => {
			throw stop;
		});
		let reads = 0;
		let selected = manager;
		const options: CreateAgentSessionOptions = {
			get sessionManager() {
				reads++;
				return selected;
			},
			get cwd() {
				selected = forgedManager();
				return "/synthetic";
			},
			agentDir: "/synthetic",
			modelRuntime: {} as ModelRuntime,
			settingsManager: {} as SettingsManager,
			resourceLoader: {} as ResourceLoader,
		};
		await expect(createAgentSession(options)).rejects.toBe(stop);
		expect(reads).toBe(1);
	});

	test("AgentSession reads manager once before an agent getter mutates configuration", () => {
		const manager = SessionManager.inMemory("/synthetic");
		let reads = 0;
		let selected = manager;
		const stop = new Error("stop before hooks");
		const config = {
			get sessionManager() {
				reads++;
				return selected;
			},
			get agent() {
				selected = forgedManager();
				return {} as Agent;
			},
			get settingsManager() {
				throw stop;
			},
		} as unknown as AgentSessionConfig;
		expect(() => new AgentSession(config)).toThrow(stop);
		expect(reads).toBe(1);
	});

	test("factory receives the exact captured manager despite option mutation", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		let reads = 0;
		let selected = manager;
		const stop = new Error("stop inside inert factory");
		const factory = vi.fn(async (input: { sessionManager: SessionManager }) => {
			expect(input.sessionManager).toBe(manager);
			expect(Object.isFrozen(input)).toBe(true);
			throw stop;
		});
		await expect(
			createAgentSessionRuntime(factory, {
				get sessionManager() {
					reads++;
					return selected;
				},
				get cwd() {
					selected = forgedManager();
					return process.cwd();
				},
				agentDir: "/synthetic",
			}),
		).rejects.toBe(stop);
		expect(reads).toBe(1);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	test("replacement fence cannot be shadowed on the runtime instance", async () => {
		const holder = { sessionManager: SessionManager.inMemory(process.cwd()) } as AgentSession;
		const factory = vi.fn(async () => {
			throw new Error("factory reached");
		});
		const runtime = new AgentSessionRuntime(holder, {} as AgentSessionServices, factory);
		Object.defineProperty(runtime, "assertUnownedRuntime", { value() {} });
		Object.defineProperty(holder, "sessionManager", { value: forgedManager() });
		await expect(runtime.newSession()).rejects.toThrow("OWNER_RUNTIME_MANAGER_REQUIRED");
		expect(factory).not.toHaveBeenCalled();
	});
});
