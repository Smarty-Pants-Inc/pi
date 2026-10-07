import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedJournal } from "../../src/core/owner-effects.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

// Control-flow fixture, not native owner qualification. The actual faux harness,
// AgentSession, captured appenders, owned materialization and reopen all run.
const ports = vi.hoisted(() => ({ terminal: false }));
vi.mock("../../src/core/owner-effects.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isOwnedTerminalWrite: () => ports.terminal,
	OwnedJournal: class {
		file = "/synthetic/provenance.jsonl";
		sessionId = "owned";
		initialHeader = {
			type: "session",
			version: 3,
			id: "owned",
			cwd: "/synthetic",
			timestamp: "2020-01-01T00:00:00.000Z",
		};
		bytes = Buffer.alloc(0);
		static assertOriginal() {}
		assertActive() {}
		assertWritable() {}
		read() {
			return this.bytes;
		}
		commit(bytes: Buffer) {
			this.bytes = Buffer.from(bytes);
			return { bytes: bytes.length, sha256: "synthetic" };
		}
		async commitTerminalAsync(bytes: Buffer) {
			return this.commit(bytes);
		}
		quarantine() {
			throw new Error("unexpected quarantine");
		}
	},
}));
vi.mock("../../src/core/ordinary-tools.ts", () => ({ createOrdinaryToolDefinitions: () => ({}) }));
vi.mock("../../src/core/ordinary-owner-context.ts", () => {
	const owner = {
		assertActive() {},
		assertSubmission() {},
		assertSessionStart() {},
		assertCompactionIdle() {},
		assertNativeTokenReservation() {},
		bindSessionAdmission() {},
		interruptAutomaticCapture() {},
		stopAutomatic() {},
		operationalAudit: { session() {} },
		owner: {
			async terminal(action: () => Promise<void>) {
				const previous = ports.terminal;
				ports.terminal = true;
				try {
					await action();
				} finally {
					ports.terminal = previous;
				}
			},
		},
		requestProvenance: {
			async prompt(action: (token: object) => Promise<void>) {
				await action({});
			},
			async run(_token: object | undefined, action: () => Promise<void>) {
				await action();
			},
		},
	};
	return {
		assertOrdinaryRuntime() {},
		ordinaryOwnerOf: (value: object) => ("agent" in value && "sessionManager" in value ? owner : undefined),
	};
});
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
type JournalFixture = OwnedJournal & { bytes: Buffer };
// pi#95: owned terminal scheduling must not restamp admitted custom/user input.
describe("owned session receipt delivery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
		vi.restoreAllMocks();
		ports.terminal = false;
	});
	it.each(["immediate", "nextTurn", "triggered", "context-only", "steer", "followUp"] as const)(
		"retains owned %s custom receipt and reopens unchanged",
		async (route) => {
			const started = gate();
			const release = gate();
			const journal = Reflect.construct(OwnedJournal, []) as JournalFixture;
			const manager = SessionManager.openOwned("/synthetic", journal);
			vi.spyOn(SessionManager, "create").mockReturnValueOnce(manager);
			const h = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						pi.on("agent_start", async () => {
							started.release();
							await release.promise;
						});
					},
				],
			});
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(first);
			let run: Promise<void> | undefined;
			if (route === "context-only" || route === "steer" || route === "followUp") {
				run = h.session.prompt("running");
				await started.promise;
			}
			const sent = h.session.sendCustomMessage(
				{ customType: route, content: "same", display: false },
				{
					triggerTurn: route === "triggered" || route === "steer" || route === "followUp",
					...(route === "nextTurn" || route === "steer" || route === "followUp" ? { deliverAs: route } : {}),
				},
			);
			vi.setSystemTime(later);
			release.release();
			await sent;
			await run;
			if (route === "immediate" || route === "nextTurn") await h.session.prompt("flush");
			const entry = manager.getEntries().find((value) => value.type === "custom_message");
			expect(entry).toMatchObject({ provenance: { receivedAt: first, channel: "terminal" } });
			const reopenedJournal = Reflect.construct(OwnedJournal, []) as JournalFixture;
			reopenedJournal.bytes = journal.bytes;
			expect(SessionManager.openOwned("/synthetic", reopenedJournal).getEntry(entry!.id)).toEqual(entry);
			const users = manager
				.getEntries()
				.filter((value) => value.type === "message" && value.message.role === "user");
			expect(users).toHaveLength(route === "triggered" ? 0 : 1);
			for (const user of users)
				expect(user).toMatchObject({
					provenance: {
						channel: "terminal",
						receivedAt: route === "immediate" || route === "nextTurn" ? later : first,
					},
				});
		},
	);
});
