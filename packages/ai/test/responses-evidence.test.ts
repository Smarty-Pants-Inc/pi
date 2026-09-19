import { describe, expect, it } from "vitest";
import {
	observeResponsesEvidence,
	type ResponsesEvidence,
	readResponsesUsage,
	withResponsesEvidence,
} from "../src/api/responses-evidence.ts";

// Synthetic decoded events through the production observer, NOT native/provider proof.
const response = (status = "completed", usage: unknown = { input_tokens: 7, output_tokens: 3, total_tokens: 10 }) => ({
	id: "resp_synthetic",
	model: "synthetic-model",
	status,
	usage,
});
async function* events(values: Array<{ type: string; response?: unknown }>) {
	yield* values;
}

async function collect(values: Array<{ type: string; response?: unknown }>) {
	const http = new Response();
	const receipts: Readonly<ResponsesEvidence>[] = [];
	observeResponsesEvidence(http, "synthetic-model", (receipt) => receipts.push(receipt));
	for await (const _event of withResponsesEvidence(http, events(values))) {
		/* Consume decoded events. */
	}
	return receipts;
}

describe("Responses native-event accounting", () => {
	it("preserves actual raw totals without fabricating optional counters or cost", async () => {
		const receipts = await collect([{ type: "response.completed", response: response() }]);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toEqual({
			responseId: "resp_synthetic",
			terminal: "completed",
			streamEnded: true,
			conflict: false,
			usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedInputTokens: null, reasoningTokens: null },
		});
		expect(Object.isFrozen(receipts[0])).toBe(true);
		expect(Object.isFrozen(receipts[0]?.usage)).toBe(true);
	});

	it.each([
		undefined,
		{},
		{ input_tokens: 0 },
		{ input_tokens: 1, output_tokens: 2, total_tokens: 4 },
		{ input_tokens: -1, output_tokens: 2, total_tokens: 1 },
		{ input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
	])("keeps absent or invalid raw usage unknown (%j)", (value) => {
		expect(readResponsesUsage(value)).toBeNull();
	});

	it("reconciles identical terminal duplicates once and refuses conflicting completion", async () => {
		const one = { type: "response.completed", response: response() };
		expect((await collect([one, one]))[0]?.terminal).toBe("completed");
		const conflict = await collect([one, { type: "response.failed", response: response("failed") }]);
		expect(conflict[0]).toMatchObject({ terminal: null, usage: null, conflict: true });
	});

	it("does not accept a changed response identity or model", async () => {
		const created = { type: "response.created", response: response("in_progress") };
		for (const patch of [{ id: "foreign" }, { model: "foreign" }]) {
			expect(
				(await collect([created, { type: "response.completed", response: { ...response(), ...patch } }]))[0],
			).toMatchObject({ terminal: null, usage: null, conflict: true });
		}
	});

	it("distinguishes provider failure evidence from parser interruption and physical retirement", async () => {
		const http = new Response();
		let receipt: Readonly<ResponsesEvidence> | undefined;
		observeResponsesEvidence(http, "synthetic-model", (value) => {
			receipt = value;
		});
		for await (const _event of withResponsesEvidence(
			http,
			events([{ type: "response.failed", response: response("failed") }]),
		))
			break;
		expect(receipt).toMatchObject({ terminal: "failed", streamEnded: false });
		expect(receipt).not.toHaveProperty("retired");
	});

	it("retains unknown after disconnect and does not observe a cloned Response", async () => {
		const http = new Response();
		const receipts: Readonly<ResponsesEvidence>[] = [];
		observeResponsesEvidence(http, "synthetic-model", (receipt) => receipts.push(receipt));
		for await (const _event of withResponsesEvidence(
			http.clone(),
			events([{ type: "response.completed", response: response() }]),
		)) {
			/* Foreign. */
		}
		expect(receipts).toEqual([]);
		async function* broken() {
			yield { type: "response.created", response: response("in_progress") };
			throw new Error("disconnect");
		}
		await expect(
			(async () => {
				for await (const _event of withResponsesEvidence(http, broken())) {
					/* Drain. */
				}
			})(),
		).rejects.toThrow("disconnect");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({ terminal: null, usage: null, streamEnded: false });
		expect(() => observeResponsesEvidence(http, "synthetic-model", () => {})).toThrow("BINDING");
	});
});
