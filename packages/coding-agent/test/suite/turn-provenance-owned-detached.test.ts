import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { OwnedJournal } from "../../src/core/owner-effects.ts";
import { getInputReceipt, promptReceived, receiveInput } from "../../src/core/received-input.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getTurnProvenance } from "../../src/core/turn-provenance.ts";
import { captureKeyboardTurnReceipt, receiptRecord } from "../../src/core/turn-receipts.ts";
import { createHarness, type Harness } from "./harness.ts";

// Control-flow fixture, as in turn-provenance-lifecycle-owned.test.ts: the owned terminal
// write is queued, so it serializes after the persistence-boundary check.
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
		append(suffix: Buffer) {
			this.bytes = Buffer.concat([this.bytes, suffix]);
		}
		async appendTerminalAsync(suffix: Buffer) {
			this.append(suffix);
		}
		currentReceipt() {
			return { bytes: this.bytes.length, sha256: "synthetic" };
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

type JournalFixture = OwnedJournal & { bytes: Buffer };
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()!.cleanup();
	vi.restoreAllMocks();
	ports.terminal = false;
});

function userMessage(event: AgentSessionEvent, type: "message_start" | "message_end"): AgentMessage | undefined {
	return event.type === type && event.message.role === "user" ? event.message : undefined;
}

async function ownedUserEntry(token: string, listener: (event: AgentSessionEvent) => void | Promise<void>) {
	const journal = Reflect.construct(OwnedJournal, []) as JournalFixture;
	const manager = SessionManager.openOwned("/synthetic", journal);
	vi.spyOn(SessionManager, "create").mockReturnValueOnce(manager);
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	h.session.subscribe(listener);
	const input = receiveInput(
		"typed by paul",
		undefined,
		captureKeyboardTurnReceipt("paul", token, new Date().toISOString()),
	);
	const before = receiptRecord(getInputReceipt(input));
	await promptReceived(h.session, input);
	// Reopen the journal bytes: this is what was serialized, not an in-memory object.
	const reopenedJournal = Reflect.construct(OwnedJournal, []) as JournalFixture;
	reopenedJournal.bytes = journal.bytes;
	const entry = SessionManager.openOwned("/synthetic", reopenedJournal)
		.getEntries()
		.find((value) => value.type === "message" && value.message.role === "user");
	const message = entry?.type === "message" ? entry.message : undefined;
	return { before, message, provenance: getTurnProvenance(entry!) };
}

// pi#160 review: the owned-terminal write is queued; an async listener that mutates after a
// microtask must not change what is persisted with the keyboard receipt.
it("persists the checked copy, not the live message, when an async listener mutates after the check", async () => {
	const token = "a".repeat(32);
	let mutated = false;
	const { before, message, provenance } = await ownedUserEntry(token, async (event) => {
		const live = userMessage(event, "message_end");
		if (live?.role !== "user") return;
		await Promise.resolve();
		live.content = [{ type: "text", text: "rewritten after the check" }];
		mutated = true;
	});
	expect(mutated).toBe(true);
	expect(JSON.stringify(message)).not.toContain("rewritten after the check");
	expect(message).toMatchObject({ role: "user", content: [{ type: "text", text: "typed by paul" }] });
	expect(provenance).toEqual(before);
	expect(provenance).toMatchObject({ channel: "keyboard", principal: { id: "paul" } });
});

it("persists the checked copy when an async listener edits a content block in place after the check", async () => {
	const token = "b".repeat(32);
	const { before, message, provenance } = await ownedUserEntry(token, async (event) => {
		const live = userMessage(event, "message_end");
		if (live?.role !== "user" || !Array.isArray(live.content)) return;
		await Promise.resolve();
		const block = live.content[0];
		if (block?.type === "text") block.text = `${block.text}, then edited`;
	});
	expect(JSON.stringify(message)).not.toContain("then edited");
	expect(provenance).toEqual(before);
});

it("drops to terminal when an async listener mutates before the boundary, and persists the changed text", async () => {
	const token = "c".repeat(32);
	const { before, message, provenance } = await ownedUserEntry(token, async (event) => {
		const live = userMessage(event, "message_start");
		if (live?.role !== "user") return;
		await Promise.resolve();
		live.content = [{ type: "text", text: "rewritten before the boundary" }];
	});
	expect(JSON.stringify(message)).toContain("rewritten before the boundary");
	expect(provenance).toMatchObject({ turnId: before.turnId, channel: "terminal", submissionToken: token });
	expect(provenance).not.toHaveProperty("principal");
});

it("a getter-based content cannot change what is persisted after the check", async () => {
	const token = "d".repeat(32);
	let reads = 0;
	const { message, provenance } = await ownedUserEntry(token, (event) => {
		const live = userMessage(event, "message_start");
		if (live?.role !== "user") return;
		const block = { type: "text" as const, text: "" };
		// Alternates on every read, so any second read after the check would see different text.
		Object.defineProperty(block, "text", {
			enumerable: true,
			get: () => (reads++ % 2 === 0 ? "typed by paul" : "smuggled by getter"),
		});
		live.content = [block];
	});
	expect(reads).toBeGreaterThan(0);
	const text = message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
	expect(text?.type === "text" ? text.text : undefined).toMatch(/^(typed by paul|smuggled by getter)$/);
	// Keyboard only if the persisted text is exactly the attested text.
	if (provenance?.channel === "keyboard") expect(JSON.stringify(message)).not.toContain("smuggled");
	else expect(provenance).toMatchObject({ channel: "terminal", submissionToken: token });
});
