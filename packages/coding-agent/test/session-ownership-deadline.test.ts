import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OwnerAdmission, OwnerHost, OwnedProcessPoll, OwnedProcessRequest } from "../src/core/owner-effects.ts";
import { SessionOwnership } from "../src/core/session-ownership.ts";

// RUN06: inert lifecycle ordering only. These substitutes are NOT an admitted
// native owner, tree-retirement proof, filesystem custody or timing qualification.
const f = vi.hoisted(() => ({
	now: 0,
	seal: vi.fn<() => Promise<void>>(), quarantine: vi.fn(), release: vi.fn(), cancel: vi.fn(),
	stop: vi.fn(), poll: vi.fn<() => OwnedProcessPoll>(), retire: vi.fn(), complete: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
	setTimeout: (ms: number, value?: unknown, options?: { signal: AbortSignal }) => {
		if (!options) return Promise.resolve(value); // Inert process-loop yield only.
		return new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, ms, value);
			options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
		});
	},
}));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	captureOrdinaryClockObservation: (_meaning: string, invoke: () => unknown) => ({ value: invoke(), observation: {} }),
}));
vi.mock("../src/core/session-manager.ts", () => ({
	persistOwnedTerminalSession: async () => {},
	SessionManager: class {
		static inMemory() { return { getHeader: () => ({ id: "inert", timestamp: "2026-09-20T00:00:00Z" }) }; }
		static openOwned() { return { persistCurrent() {} }; }
	},
}));
vi.mock("../src/core/owner-effects.ts", () => ({
	OwnedJournal: class {
		static acquire() { return new this(); }
		inspectResources() {}
		inspectPermission() {}
		assertActive() {}
		activate() {}
		seal = f.seal;
		quarantine = f.quarantine;
		release = f.release;
		cancelLifecycle = f.cancel;
		terminal(invoke: () => unknown) { return invoke(); }
		beginOperation() { return { check() {}, bindProcess() {}, complete: f.complete }; }
		prepareProcess() {
			return { dispatch: () => 71, stop: f.stop, poll: f.poll, retire: f.retire, write: () => 0 };
		}
	},
}));
const host = { profile: { limits: { closeTimeoutMs: 100, processTimeoutMs: 800, outputBytes: 1024 } } } as unknown as OwnerHost;
const request: OwnedProcessRequest = { command: "inert", argv0: "inert", args: [], cwd: "/", environment: [], roots: [], readOnly: true };
const status = (drained: boolean): OwnedProcessPoll => ({
	dispatched: true, drained, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), execError: Buffer.alloc(0),
	code: 0, signal: 0, error: 0, sampleExpired: false,
});
function owner() {
	const value = SessionOwnership.create(host, "/inert");
	// Only admission is substituted; the actual private run/close implementation runs.
	value.activate({} as OwnerAdmission);
	return value;
}
beforeEach(() => {
	vi.resetAllMocks(); f.now = 0;
	f.seal.mockResolvedValue(undefined);
	f.stop.mockResolvedValue(undefined);
	f.complete.mockResolvedValue(undefined);
	vi.spyOn(performance, "now").mockImplementation(() => f.now);
});
afterEach(() => vi.restoreAllMocks());

describe("original close budget", () => {
	test("seal time is not followed by a fresh close interval", async () => {
		f.seal.mockImplementation(async () => { f.now = 100; });
		const value = owner();
		await expect(value.close()).rejects.toThrow();
		expect(value.phase).toBe("quarantined");
		expect(f.release).not.toHaveBeenCalled();
	});
	test("synchronous terminal persistence cannot beat an expired timer by microtasks", async () => {
		const value = owner();
		await expect(value.close({ persist: () => { f.now = 100; } })).rejects.toThrow();
		expect(f.release).not.toHaveBeenCalled();
	});
	test("late release remains unknown and is never replayed or followed by a journal write", async () => {
		f.release.mockImplementation(() => { f.now = 100; });
		const value = owner(), first = value.close();
		expect(value.close()).toBe(first);
		await expect(first).rejects.toThrow("OWNER_CLOSE_NOT_SETTLED");
		expect(value.phase).toBe("quarantined");
		expect(f.release).toHaveBeenCalledTimes(1);
		expect(f.quarantine).not.toHaveBeenCalled();
		expect(f.cancel).toHaveBeenCalledTimes(1);
	});
	test("original seal error stays first when the remaining interval expires", async () => {
		const original = new Error("original seal error");
		f.seal.mockImplementation(() => { f.now = 100; throw original; });
		await expect(owner().close()).rejects.toMatchObject({ cause: original });
	});
});

describe("original process stop budget", () => {
	test("drained poll crossing the sample deadline cannot beat the timer callback", async () => {
		f.poll.mockImplementationOnce(() => { f.now = 801; return status(true); });
		await expect(owner().runProcess(request)).rejects.toThrow("OWNER_PROCESS_FAILED");
		expect(f.stop).toHaveBeenCalledTimes(1);
		expect(f.retire).toHaveBeenCalledTimes(1);
	});
	test("the native sample deadline refuses even when the JS clock has not advanced", async () => {
		f.poll.mockReturnValueOnce({ ...status(true), sampleExpired: true });
		await expect(owner().runProcess(request)).rejects.toThrow("OWNER_PROCESS_FAILED");
		expect(f.stop).toHaveBeenCalledTimes(1);
	});
	test("late native effect completion remains quarantined rather than returning process success", async () => {
		const original = new Error("OWNER_LIFECYCLE_UNKNOWN");
		f.poll.mockReturnValueOnce(status(true));
		f.complete.mockRejectedValueOnce(original);
		const value = owner();
		await expect(value.runProcess(request)).rejects.toBe(original);
		expect(value.phase).toBe("quarantined");
		expect(f.complete).toHaveBeenCalledTimes(1);
		expect(f.release).not.toHaveBeenCalled();
	});
	test("delayed proved drain inside the received close interval still retires once", async () => {
		f.poll.mockImplementationOnce(() => { f.now = 800; return status(false); })
			.mockImplementationOnce(() => { f.now = 899; return status(true); });
		await expect(owner().runProcess(request, { timeoutMs: 800 })).rejects.toThrow("OWNER_PROCESS_FAILED");
		// Timeout remains the process outcome; actual timely retirement is separate.
		expect(f.stop).toHaveBeenCalledTimes(1);
		expect(f.retire).toHaveBeenCalledTimes(1);
		expect(f.quarantine).not.toHaveBeenCalled();
	});
	for (const drained of [false, true]) {
		test(`original-bound exhaustion refuses even when poll returns drained=${drained}`, async () => {
			f.poll.mockImplementationOnce(() => { f.now = 800; return status(false); })
				.mockImplementationOnce(() => { f.now = 900; return status(drained); });
			const value = owner();
			await expect(value.runProcess(request)).rejects.toThrow("OWNER_PROCESS_FAILED");
			expect(f.retire).not.toHaveBeenCalled();
			expect(f.stop).toHaveBeenCalledTimes(1);
			expect(value.phase).toBe("quarantined");
		});
	}
	test("non-ESRCH stop failure remains in the failed result despite later drain", async () => {
		const denied = Object.assign(new Error("stop EPERM"), { code: "EPERM" });
		f.stop.mockImplementation(() => { throw denied; });
		f.poll.mockImplementationOnce(() => { f.now = 800; return status(false); })
			.mockImplementationOnce(() => status(true));
		const value = owner();
		await expect(value.runProcess(request)).rejects.toMatchObject({ errors: expect.arrayContaining([denied]) });
		expect(value.phase).toBe("quarantined");
		expect(f.stop).toHaveBeenCalledTimes(1);
	});
});

// Source ordering guard only; this does not exercise N-API allocation or GC.
test("native receipt data precedes release dispatch and one-use acceptance", () => {
	const source = readFileSync(new URL("../native/owner-effects/owner-lifecycle.h", import.meta.url), "utf8");
	const start = source.indexOf("static napi_value lifecycle_accept(");
	const end = source.indexOf("static napi_value lifecycle_prepare(", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const accept = source.slice(start, end);
	const prepared = accept.indexOf("napi_define_properties(env, result, 1, &returned_next)");
	const dispatch = accept.indexOf("napi_queue_async_work(env, successor->work)");
	const accepted = accept.indexOf("task->accepted = true;");
	expect(prepared).toBeGreaterThanOrEqual(0);
	expect(dispatch).toBeGreaterThan(prepared);
	expect(accepted).toBeGreaterThan(dispatch);
	expect(accept.indexOf("napi_delete_reference(env, task->receipt)")).toBeGreaterThan(accepted);
	expect(accept.indexOf("!lifecycle_live(task) || (successor && !lifecycle_live(successor))")).toBeGreaterThan(prepared);
	expect(accept).not.toContain("napi_set_named_property");
	expect(accept).toContain("task->error = ENOMEM;");
	expect(accept).toContain("owner->uncertain = owner->sealed = true;");
	expect(source.slice(end)).toContain("if (status == napi_ok && !predecessor) status = napi_queue_async_work");
	expect(source.slice(end)).toContain("predecessor->deadline < deadline");
});

test("terminal append uses a captured serialized private route", () => {
	const manager = readFileSync(new URL("../src/core/session-manager.ts", import.meta.url), "utf8");
	const agent = readFileSync(new URL("../src/core/agent-session.ts", import.meta.url), "utf8");
	expect(manager).toContain("const ownedTerminalAppenders = new WeakMap<SessionManager, OwnedTerminalAppender>()");
	expect(manager).toContain("#ownedTerminalTail: Promise<void> = Promise.resolve();");
	expect(manager).toContain("await this.#ownedJournal.commitTerminalAsync(bytes);");
	expect(manager).toContain("this.#ownedTerminalTail = run.then(() => undefined);");
	expect(agent).toContain("await this._flushPendingBashMessagesOwnedTerminal();");
	expect(agent).toContain("await this._flushPendingCustomMessagesOwnedTerminal();");
	expect(agent).toContain("await appendOwnedTerminalMessage(this.sessionManager, event.message)");
	expect(agent).toContain("await appendOwnedTerminalCustomMessage(");
	expect(agent).toContain("Leave the failed message and suffix retained");
	expect(manager).toContain("nativeWriteAccepted: true");
	expect(manager).toContain("OWNER_TERMINAL_INDEX_UNKNOWN");
	expect(manager).toContain("#terminalIndexFailure");
	expect(agent).toContain("OWNER_SETTLEMENT_FAILED");
	const sense = readFileSync(new URL("../src/core/ordinary-sense.ts", import.meta.url), "utf8");
	expect(sense).toContain("await appendOwnedTerminalEntry(manager, \"smarty-sense:ordinary-retention-v1\"");
	expect(sense).toContain("await persistOwnedTerminalSession(manager);");
});

test("release preparation consumes admission descriptors before receipt acceptance", () => {
	const source = readFileSync(new URL("../native/owner-effects/owner-lifecycle.h", import.meta.url), "utf8");
	const start = source.indexOf("if (task->action == OE_LIFECYCLE_RELEASE_PREPARE)");
	const end = source.indexOf("if (task->action == OE_LIFECYCLE_RELEASE_COMMIT)", start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const prepare = source.slice(start, end);
	const consumed = prepare.indexOf("owner->admission->commands[i].fd = -1;");
	expect(consumed).toBeGreaterThanOrEqual(0);
	expect(prepare.indexOf("lifecycle_result(task, close(fd))", consumed)).toBeGreaterThan(consumed);
	expect(prepare).toContain("if (!lifecycle_live(task)) return;");
	expect(prepare).not.toContain("lock_roundtrip(host, 2,");
});

test("native reply and holder join use the same absolute monotonic deadline", () => {
	const source = readFileSync(new URL("../native/owner-effects/owner-effects.c", import.meta.url), "utf8");
	expect(source).not.toContain("pthread_join(");
	expect(source).toContain("pthread_clockjoin_np(holder->thread, NULL, CLOCK_MONOTONIC, &until)");
	expect(source).toContain("receive_reply(holder->control, &reply, deadline)");
	expect(source).toContain("reply.closed && join_holder(holder, deadline)");
	const lifecycle = readFileSync(new URL("../native/owner-effects/owner-lifecycle.h", import.meta.url), "utf8");
	expect(lifecycle).toContain("atomic_compare_exchange_strong(&owner->close_deadline, &absent, deadline)");
});
