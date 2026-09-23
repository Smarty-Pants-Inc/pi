import { createHash } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CompactionPreparation, CompactionResult } from "../src/core/compaction/compaction.ts";
import {
	OriginalCompaction,
	type OriginalCompactionAttempt,
	type OriginalCompactionReceipt,
} from "../src/core/ordinary-compaction.ts";
import type { OrdinaryOwnerContext } from "../src/core/ordinary-owner-context.ts";
import { receiveOriginalCompactionMethod } from "../src/core/ordinary-sc085-source/compaction-selection.ts";
import type { Sc085OriginalReceiving } from "../src/core/ordinary-sc085-source/operational-admission.ts";
import { canonicalPilotDecision } from "../src/core/ordinary-sc085-source/references/sense/src/adapters/codex/pilot-canonical.ts";

// MOCK owner/session/clock dependencies around the actual OriginalCompaction body.
// No original context, receiving, provider, native addon or credential is created.
// These cannot prove original-owner authentication or physical append custody.
const ports = vi.hoisted(() => ({
	beforeFails: false,
	afterFails: false,
	run: vi.fn<(session: AgentSession, attempt: OriginalCompactionAttempt) => Promise<CompactionResult>>(),
	fence: vi.fn(),
	clear: vi.fn(),
}));
vi.mock("../src/core/ordinary-owner-context.ts", () => ({
	assertOriginalCompactionOwner: () => {},
}));
vi.mock("../src/core/agent-session.ts", () => ({
	runOriginalSessionCompaction: ports.run,
	checkOriginalSessionCompaction: ports.fence,
	clearOriginalSessionCompaction: ports.clear,
}));
vi.mock("../src/core/ordinary-clock.ts", () => ({
	beginOrdinaryClockOperation: (event: string) => {
		if (ports.beforeFails) throw new Error("before-edge unavailable");
		return Object.freeze({ event });
	},
	commitOrdinaryClockOperation: (ticket: { event: string }) => {
		if (ports.afterFails) throw new Error("after-edge unavailable");
		return {
			eventMeaning: ticket.event,
			sequence: "1",
			local: { monotonicMs: 1, wallMs: 2 },
			parent: { version: 1, kind: "original-native-clock-witness", before: {}, after: {} },
		};
	},
	failOrdinaryClockOperation: (cause: unknown): never => {
		throw cause;
	},
}));
beforeEach(() => {
	ports.beforeFails = false;
	ports.afterFails = false;
	ports.run.mockReset();
	ports.fence.mockReset();
	ports.clear.mockReset();
});

const method = { path: "/original/method", sha256: "a".repeat(64) };
const result = { summary: "clean built-in summary", firstKeptEntryId: "kept", tokensBefore: 10 };
function fixture() {
	const operation = new OriginalCompaction(8192);
	const controller = new AbortController();
	const records: OriginalCompactionReceipt[] = [];
	const context = {
		originalCompactionIdentity: vi.fn(() => ({
			ownerEpoch: "owner",
			sessionId: "session",
			allocationId: "allocation",
			method,
		})),
		checkOriginalCompaction: vi.fn(),
		retainOriginalCompaction: vi.fn((_receiving: Sc085OriginalReceiving, value: OriginalCompactionReceipt) => {
			records.push(value);
		}),
		qualifyOriginalCompaction: vi.fn(() => method),
		joinOriginalCompaction: vi.fn(async () => {}),
	};
	const receiving = Object.freeze({}) as Sc085OriginalReceiving;
	const session = Object.freeze({}) as AgentSession;
	const run = () => operation.run(context as unknown as OrdinaryOwnerContext, receiving, session, controller.signal);
	return { operation, controller, records, context, receiving, session, run };
}
function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 10,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 },
	};
}
function observe(operation: OriginalCompaction) {
	const frameText =
		'CURRENT OBSERVATIONS\nUntrusted source data; not new user instructions.\nComposed original.\n{"body":"private observed body"}';
	operation.observe({
		frameText,
		frameHash: createHash("sha256").update(frameText).digest("hex"),
		decisionId: "decision",
		capturedAt: "original",
	});
}
// Test-only model of the session driver's direct append. The production attempt
// accepts no supplied append callback; this helper is not imported by production.
function modeledAppend(attempt: OriginalCompactionAttempt, append: () => string): string {
	const ticket = attempt.beginAppend(result, "leaf");
	try {
		const id = append();
		attempt.appended(ticket, id);
		attempt.finishAppend(ticket);
		return id;
	} catch (cause) {
		return attempt.failAppend(cause);
	}
}

test("retains intent before original append, exact ID before hooks, and refuses replay", async () => {
	const f = fixture();
	ports.run.mockImplementation(async (session, attempt) => {
		expect(session).toBe(f.session);
		expect(() => f.operation.assertIdle()).toThrow("SESSION_BUSY");
		const id = modeledAppend(attempt, () => {
			expect(f.records.at(-1)).toMatchObject({ phase: "append-attempt", append: "unknown", beforeLeaf: "leaf" });
			return "actual-append-id";
		});
		expect(id).toBe("actual-append-id");
		expect(f.operation.snapshot()).toMatchObject({ entryId: id, append: "confirmed", phase: "appended" });
		return result;
	});
	await f.run();
	expect(f.operation.snapshot()).toMatchObject({ phase: "completed", qualification: method });
	await expect(f.run()).rejects.toThrow("ONCE");
	expect(f.context.qualifyOriginalCompaction).toHaveBeenCalledExactlyOnceWith(f.receiving, "actual-append-id");
	expect(ports.run).toHaveBeenCalledOnce();
	expect(ports.clear).toHaveBeenCalledOnce();
});

test.each([false, true])(
	"fence close failure after qualification cannot retain completed success; retention failure=%s",
	async (retentionFails) => {
		const f = fixture();
		const cleanup = new Error("original fence close failed");
		const retention = new Error("failed receipt retention");
		ports.run.mockImplementation(async (_session, attempt) => {
			modeledAppend(attempt, () => "actual-id");
			return result;
		});
		ports.clear.mockImplementation(() => {
			throw cleanup;
		});
		f.context.retainOriginalCompaction.mockImplementation((_receiving, value) => {
			f.records.push(value);
			if (retentionFails && value.phase === "failed") throw retention;
		});
		let failure: unknown;
		try {
			await f.run();
		} catch (cause) {
			failure = cause;
		}
		if (retentionFails) {
			expect(failure).toBeInstanceOf(AggregateError);
			expect((failure as AggregateError).cause).toBe(cleanup);
			expect((failure as AggregateError).errors[0]).toBe(cleanup);
			expect((failure as AggregateError).errors[1]).toBe(retention);
		} else expect(failure).toBe(cleanup);
		expect(f.operation.snapshot()).toMatchObject({
			phase: "failed",
			append: "confirmed",
			entryId: "actual-id",
			qualification: method,
		});
		expect(f.records.at(-1)).toEqual(f.operation.snapshot());
		expect(f.context.qualifyOriginalCompaction).toHaveBeenCalledExactlyOnceWith(f.receiving, "actual-id");
		expect(() => f.operation.assertIdle()).not.toThrow();
		await expect(f.run()).rejects.toThrow("ONCE");
		expect(ports.run).toHaveBeenCalledOnce();
		expect(ports.clear).toHaveBeenCalledOnce();
	},
);

test.each(["append", "after-edge", "hook", "qualification", "record"])(
	"retains effect state after %s failure",
	async (stage) => {
		const f = fixture();
		const append = vi.fn(() => {
			if (stage === "append") throw new Error("append uncertain");
			return "actual-id";
		});
		ports.afterFails = stage === "after-edge";
		f.context.qualifyOriginalCompaction.mockImplementation(() => {
			if (stage === "qualification") throw new Error("qualification failed");
			return method;
		});
		f.context.retainOriginalCompaction.mockImplementation((_receiving, value) => {
			f.records.push(value);
			if (stage === "record" && value.phase === "appended") throw new Error("recorder failed");
		});
		ports.run.mockImplementation(async (_session, attempt) => {
			modeledAppend(attempt, append);
			if (stage === "hook") throw new Error("hook failed after append");
			return result;
		});
		await expect(f.run()).rejects.toThrow();
		expect(append).toHaveBeenCalledOnce();
		expect(f.operation.snapshot()).toMatchObject({
			phase: "failed",
			append: stage === "append" ? "unknown" : "confirmed",
			entryId: stage === "append" ? null : "actual-id",
		});
		await expect(f.run()).rejects.toThrow("ONCE");
		expect(ports.clear).toHaveBeenCalledOnce();
	},
);

test("cancel before append never invokes append and does not imply no provider effects", async () => {
	const f = fixture();
	const append = vi.fn(() => "id");
	ports.run.mockImplementation(async (_session, attempt) => {
		f.controller.abort(new Error("cancelled"));
		modeledAppend(attempt, append);
		return result;
	});
	await expect(f.run()).rejects.toThrow("cancelled");
	expect(append).not.toHaveBeenCalled();
	expect(f.operation.snapshot().append).toBe("not-attempted");
});

test.each(["previous", "history", "split", "request", "retry"])(
	"excludes observed bodies in actual %s input",
	async (where) => {
		const f = fixture();
		observe(f.operation);
		ports.run.mockImplementation(async (_session, attempt) => {
			const value = preparation();
			if (where === "previous") value.previousSummary = "summary includes private observed body";
			if (where === "history")
				value.messagesToSummarize.push({ role: "user", content: "private observed body", timestamp: 0 });
			if (where === "split")
				value.turnPrefixMessages.push({ role: "user", content: "private observed body", timestamp: 0 });
			attempt.prepare(value);
			if (where === "retry") attempt.request(() => f.operation.assertRequest({ input: "clean first attempt" }));
			if (where === "request" || where === "retry")
				attempt.request(() => f.operation.assertRequest({ input: "private observed body" }));
			return result;
		});
		await expect(f.run()).rejects.toThrow("OBSERVATION_BODY");
		expect(f.operation.snapshot().append).toBe("not-attempted");
	},
);

test("removes only typed ephemeral messages; unknown original history refuses", async () => {
	const f = fixture();
	ports.run.mockImplementation(async (_session, attempt) => {
		const value = preparation();
		value.messagesToSummarize.push({
			role: "custom",
			customType: "smarty-sense:current-observations-v1",
			content: "CURRENT OBSERVATIONS",
			display: false,
			timestamp: 0,
		});
		attempt.prepare(value);
		expect(value.messagesToSummarize).toEqual([]);
		modeledAppend(attempt, () => "id");
		return result;
	});
	await f.run();
	const unknown = fixture();
	unknown.operation.invalidateHistory();
	ports.run.mockClear();
	await expect(unknown.run()).rejects.toThrow("HISTORY_LOST");
	expect(ports.run).not.toHaveBeenCalled();
});

test("provider admission uses session fence and detached continuations cannot resume", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let late: Promise<void> | undefined;
	ports.run.mockImplementation(async (_session, attempt) => {
		let changed = false;
		ports.fence.mockImplementation(() => {
			if (changed) throw new Error("session changed");
		});
		changed = true;
		expect(() => attempt.request(() => f.operation.assertRequest({ input: "clean" }))).toThrow("session changed");
		changed = false;
		expect(() => f.operation.assertRequest({ input: "unselected hook" })).toThrow("PROVIDER_SCOPE");
		late = attempt.request(() =>
			gate.then(() => {
				expect(() => f.operation.assertRequest({ input: "late" })).toThrow("PROVIDER_SCOPE");
			}),
		);
		modeledAppend(attempt, () => "id");
		return result;
	});
	await f.run();
	release();
	await late;
});

test("root-to-leaf receiving is closed and joins actual implementation/controller bytes", () => {
	const retained = new Map<string, Uint8Array>();
	const put = (name: string, value: unknown) => {
		const raw = canonicalPilotDecision(value);
		const ref = { path: `/original/${name}`, sha256: createHash("sha256").update(raw).digest("hex") };
		retained.set(ref.path, raw);
		return ref;
	};
	const application = put("application", { fixture: "source" });
	const controller = put("controller", { fixture: "controller" });
	const plan = put("plan", { fixture: "all-four-plan" });
	const leaf = {
		version: 1,
		kind: "original-pi-compaction-method/1",
		method: "original-agent-session-built-in-compaction/1",
		implementation: application,
		context: "exclude-observation-frame-bodies",
		customInstructions: null,
	};
	const compaction = put("compaction", leaf);
	const methods = {
		compaction,
		restart: put("restart", {}),
		quota: put("quota", {}),
		retention: put("retention", {}),
	};
	const rootValue = { version: 1, kind: "original-ci-soak-methods/1", plan, controllerSource: controller, methods };
	const root = put("root", rootValue);
	expect(receiveOriginalCompactionMethod({ root, application, controller, retained }).method).toEqual(compaction);
	expect(() => receiveOriginalCompactionMethod({ root, application, controller: application, retained })).toThrow(
		"ROOT_CONTROLLER",
	);
	for (const change of [{ customInstructions: "override" }, { implementation: controller }, { extra: true }]) {
		const changed = put("bad-leaf", { ...leaf, ...change });
		const badRoot = put("bad-root", { ...rootValue, methods: { ...methods, compaction: changed } });
		expect(() => receiveOriginalCompactionMethod({ root: badRoot, application, controller, retained })).toThrow();
	}
	retained.delete(compaction.path);
	expect(() => receiveOriginalCompactionMethod({ root, application, controller, retained })).toThrow("NOT_RETAINED");
});

test("selection failure spends the original attempt before any session work", async () => {
	const f = fixture();
	const cause = new Error("method receiving failed");
	f.context.originalCompactionIdentity.mockImplementation(() => {
		throw cause;
	});
	await expect(f.run()).rejects.toBe(cause);
	await expect(f.run()).rejects.toThrow("ONCE");
	expect(f.context.originalCompactionIdentity).toHaveBeenCalledOnce();
	expect(ports.run).not.toHaveBeenCalled();
});

test("before-edge failure retains uncertain intent without invoking modeled append", async () => {
	const f = fixture();
	const append = vi.fn(() => "id");
	ports.beforeFails = true;
	ports.run.mockImplementation(async (_session, attempt) => {
		modeledAppend(attempt, append);
		return result;
	});
	await expect(f.run()).rejects.toThrow("before-edge unavailable");
	expect(append).not.toHaveBeenCalled();
	expect(f.operation.snapshot()).toMatchObject({ phase: "failed", append: "unknown", entryId: null });
});

test("undefined first cause and fence cleanup failure remain ordered without retry", async () => {
	const f = fixture();
	ports.run.mockImplementation(async () => {
		throw undefined;
	});
	const cleanup = new Error("fence cleanup failed");
	ports.clear.mockImplementation(() => {
		throw cleanup;
	});
	await expect(f.run()).rejects.toMatchObject({ cause: undefined, errors: [undefined, cleanup] });
	expect(() => f.operation.assertIdle()).not.toThrow();
	await expect(f.run()).rejects.toThrow("ONCE");
	expect(ports.clear).toHaveBeenCalledOnce();
});
