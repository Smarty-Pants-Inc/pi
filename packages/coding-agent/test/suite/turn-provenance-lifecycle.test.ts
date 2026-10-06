import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const admitted = "2026-10-01T12:00:00.000Z";
const released = "2026-10-01T12:01:00.000Z";
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function turns(h: Harness) {
	return h.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"),
		);
}
function receipt(entry: unknown) {
	return (entry as { provenance?: { v: number; turnId: string; receivedAt: string; channel: string } }).provenance;
}

// pi#95 successor 1: terminal occurrence receipts, not identity claims.
describe("turn provenance lifecycle", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()!.cleanup();
	});
	it.each(["prompt", "steer", "followUp", "sendUserMessage"] as const)(
		"captures %s before input hooks and survives persist/reopen",
		async (route) => {
			const started = gate();
			const release = gate();
			const h = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							started.release();
							await release.promise;
							return { action: "transform", text: "transformed" };
						});
					},
				],
			});
			harnesses.push(h);
			h.setResponses([fauxAssistantMessage("done")]);
			if (route === "steer" || route === "followUp") {
				h.sessionManager.appendMessage(fauxAssistantMessage("previous"));
				h.session.refreshContext();
			}
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(admitted);
			const input = h.session[route]("original");
			await started.promise;
			vi.setSystemTime(released);
			release.release();
			await input;
			if (route === "steer" || route === "followUp") await h.session.agent.continue();
			const entries = turns(h);
			expect(entries).toHaveLength(1);
			expect(receipt(entries[0])).toMatchObject({ v: 1, receivedAt: admitted, channel: "terminal" });
			const path = h.session.sessionFile!;
			expect(readFileSync(path, "utf8")).toContain(admitted);
			expect(
				SessionManager.open(path)
					.getEntries()
					.find((entry) => entry.id === entries[0].id),
			).toEqual(entries[0]);
		},
	);
	it.each(["immediate", "nextTurn", "triggered", "context-only"] as const)(
		"retains %s custom receipt from send time",
		async (route) => {
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
			h.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("queued")]);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(admitted);
			let run: Promise<void> | undefined;
			if (route === "context-only") {
				run = h.session.prompt("running");
				await started.promise;
			}
			const sent = h.session.sendCustomMessage(
				{ customType: route, content: "same", display: false },
				{ triggerTurn: route === "triggered", ...(route === "nextTurn" ? { deliverAs: "nextTurn" } : {}) },
			);
			vi.setSystemTime(released);
			release.release();
			await sent;
			await run;
			if (route === "immediate" || route === "nextTurn") await h.session.prompt("flush");
			const entry = turns(h).find((entry) => entry.type === "custom_message");
			expect(receipt(entry)).toMatchObject({ receivedAt: admitted, channel: "terminal" });
			expect(Object.keys(receipt(entry)!)).toEqual(["v", "turnId", "receivedAt", "channel"]);
			expect(SessionManager.open(h.session.sessionFile!).getEntry(entry!.id)).toEqual(entry);
		},
	);
	it("gives repeated raw same-object emissions fresh first-observation receipts", async () => {
		const h = await createHarness({ persistSession: true });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const message = { role: "user" as const, content: "replayed", timestamp: 1 };
		await h.session.agent.prompt(message);
		await h.session.agent.prompt(message);
		const records = turns(h).map(receipt);
		expect(records).toHaveLength(2);
		expect(records.every((record) => record?.channel === "terminal")).toBe(true);
		expect(records[0]!.turnId).not.toBe(records[1]!.turnId);
		expect(records.every((record) => record!.receivedAt !== new Date(1).toISOString())).toBe(true);
	});
});
