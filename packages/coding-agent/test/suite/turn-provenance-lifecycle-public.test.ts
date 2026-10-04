import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const first = "2026-10-01T12:00:00.000Z";
const later = "2026-10-01T12:01:00.000Z";
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function receipt(entry: unknown) {
	return (entry as { provenance: { turnId: string; receivedAt: string; channel: string } }).provenance;
}

// pi#95: supported session sends capture occurrence facts, never identity claims.
describe("public session turn receipts", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	it.each(["steer", "followUp"] as const)("retains streaming custom %s receipt", async (deliverAs) => {
		const started = gate();
		const release = gate();
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
		const run = h.session.prompt("running");
		await started.promise;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.sendCustomMessage({ customType: "streaming", content: "same", display: false }, { deliverAs });
		vi.setSystemTime(later);
		release.release();
		await run;
		const entries = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(entries).toHaveLength(1);
		expect(receipt(entries[0])).toMatchObject({ receivedAt: first, channel: "terminal" });
		expect(SessionManager.open(h.session.sessionFile!).getEntry(entries[0].id)).toEqual(entries[0]);
	});
	it("captures custom before getters and separates repeated frozen public sends", async () => {
		const h = await createHarness({ persistSession: true });
		harnesses.push(h);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		const claimed = { v: 1, turnId: "caller", receivedAt: "caller", channel: "fabric", sender: { id: "claimed" } };
		const message = Object.freeze({
			get customType() {
				vi.setSystemTime(later);
				return "repeated";
			},
			content: "same",
			display: false,
			details: { provenance: claimed },
			provenance: claimed,
		});
		await h.session.sendCustomMessage(message);
		await h.session.sendCustomMessage(message);
		h.setResponses([fauxAssistantMessage("flush")]);
		await h.session.prompt("flush");
		const entries = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(entries.map((entry) => receipt(entry).receivedAt)).toEqual([first, later]);
		expect(receipt(entries[0]).turnId).not.toBe(receipt(entries[1]).turnId);
		for (const entry of entries) {
			expect(Object.keys(receipt(entry))).toEqual(["v", "turnId", "receivedAt", "channel"]);
			expect(receipt(entry).channel).toBe("terminal");
			expect(entry.details).toEqual({ provenance: claimed });
		}
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toEqual(entries);
	});
	it("consumes a bound custom publication before raw same-object replay", async () => {
		const h = await createHarness({ persistSession: true });
		harnesses.push(h);
		let published: AgentMessage | undefined;
		h.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "custom") published = event.message;
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.sendCustomMessage({ customType: "replay", content: "same", display: false });
		vi.setSystemTime(later);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.agent.prompt(published!);
		const entries = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(entries.map((entry) => receipt(entry).receivedAt)).toEqual([first, later]);
		expect(receipt(entries[0]).turnId).not.toBe(receipt(entries[1]).turnId);
		expect(
			SessionManager.open(h.session.sessionFile!)
				.getEntries()
				.filter((entry) => entry.type === "custom_message"),
		).toEqual(entries);
	});
	it("keeps the receipt when message_end intentionally replaces user content", async () => {
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						vi.setSystemTime(later);
						return { message: { ...event.message, content: "replacement", timestamp: 1 } };
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		await h.session.prompt("original");
		const entry = h.sessionManager
			.getEntries()
			.find((value) => value.type === "message" && value.message.role === "user");
		expect(entry).toMatchObject({
			message: { content: "replacement", timestamp: 1 },
			provenance: { receivedAt: first },
		});
	});
	it("labels raw receipt time as first harness observation after a held start hook", async () => {
		const started = gate();
		const release = gate();
		const h = await createHarness({
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
		h.setResponses([fauxAssistantMessage("done")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(first);
		const run = h.session.agent.prompt({ role: "user", content: "raw", timestamp: 1 });
		await started.promise;
		vi.setSystemTime(later);
		release.release();
		await run;
		const entry = h.sessionManager
			.getEntries()
			.find((value) => value.type === "message" && value.message.role === "user");
		expect(receipt(entry)).toMatchObject({ receivedAt: later, channel: "terminal" });
	});
});
