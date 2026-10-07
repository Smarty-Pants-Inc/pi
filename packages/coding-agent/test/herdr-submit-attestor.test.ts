/**
 * smarty-dev#2636: an editor submit takes its byte cut synchronously and resolves to a receipt within
 * 1 s. Only an untainted submit that Herdr attests to a mapped principal is keyboard.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EpochByteCounter, epochMarker } from "../src/core/herdr/epoch-bytes.ts";
import type { HerdrEpoch } from "../src/core/herdr/input-consumer.ts";
import type { CutAnswer, CutRequest } from "../src/core/herdr/server-auth.ts";
import { SubmitAttestor } from "../src/core/herdr/submit-attestor.ts";
import { receiptRecord } from "../src/core/turn-receipts.ts";

const NONCE = "0123456789abcdef";
const PAUL: CutAnswer = { result: "client", principal: { smartyId: "paul", displayName: "Paul" } };

function setup(answer: (request: Omit<CutRequest, "epoch">) => Promise<CutAnswer>) {
	const counter = new EpochByteCounter();
	counter.hold();
	counter.arm(NONCE);
	counter.push(Buffer.concat([epochMarker(NONCE), Buffer.from("hi\rok\r")]));
	const requests: Omit<CutRequest, "epoch">[] = [];
	const epoch: HerdrEpoch = {
		epoch: "e1",
		nonce: NONCE,
		cut: (request) => {
			requests.push(request);
			return answer(request);
		},
		release: () => {},
	};
	return { attestor: new SubmitAttestor(counter, epoch, 50), requests };
}

describe("SubmitAttestor", () => {
	it("labels an untainted submit that Herdr attests, with the cut and token it sent", async () => {
		const { attestor, requests } = setup(async () => PAUL);
		const record = receiptRecord(await attestor.capture(3, { tainted: false, kind: "submit" }));
		expect(record).toMatchObject({ channel: "keyboard", principal: { id: "paul", binding: "herdr-client" } });
		expect(requests).toEqual([
			{
				seq: 1,
				token: record.submissionToken,
				cut: 3,
				digest: createHash("sha256").update("hi\r").digest("hex"),
				kind: "submit",
			},
		]);
	});

	it("gives an unknown principal or a non-client answer no attribution", async () => {
		for (const answer of [
			{ result: "client" },
			{ result: "client", principal: { smartyId: "paul", displayName: "**Paul (in Herdr):**" } },
			{ result: "mixed" },
			{ result: "unknown", reason: "epoch-ended" },
		] as CutAnswer[]) {
			const { attestor } = setup(async () => answer);
			const record = receiptRecord(await attestor.capture(3, { tainted: false, kind: "submit" }));
			expect(record.channel).toBe("terminal");
			expect(record).not.toHaveProperty("principal");
		}
	});

	it("still sends the cut for a tainted draft or a discard, but never labels it", async () => {
		for (const options of [
			{ tainted: true, kind: "submit" },
			{ tainted: false, kind: "discard" },
		] as const) {
			const { attestor, requests } = setup(async () => PAUL);
			expect(receiptRecord(await attestor.capture(3, options)).channel).toBe("terminal");
			expect(requests).toHaveLength(1);
			expect(requests[0]!.kind).toBe(options.kind);
		}
	});

	it("gives no attribution without a cut offset (no epoch, missing token path)", async () => {
		const { attestor, requests } = setup(async () => PAUL);
		const record = receiptRecord(await attestor.capture(undefined, { tainted: false, kind: "submit" }));
		expect(record.channel).toBe("terminal");
		expect(requests).toHaveLength(0);
	});

	it("delivers as terminal when Herdr is slower than the admission wait", async () => {
		const { attestor } = setup(() => new Promise((resolve) => setTimeout(() => resolve(PAUL), 500)));
		expect(receiptRecord(await attestor.capture(3, { tainted: false, kind: "submit" })).channel).toBe("terminal");
	});

	it("numbers cuts in order and refuses a cut that is not ahead of the last", async () => {
		const { attestor, requests } = setup(async () => PAUL);
		await attestor.capture(3, { tainted: false, kind: "submit" });
		expect(receiptRecord(await attestor.capture(3, { tainted: false, kind: "submit" })).channel).toBe("terminal");
		await attestor.capture(6, { tainted: false, kind: "submit" });
		expect(requests.map((r) => [r.seq, r.cut])).toEqual([
			[1, 3],
			[2, 6],
		]);
	});
});
