import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { outsideFields, outsideRef } from "./outside-final-data.ts";
import { createOperationalOutsideFinal, type OriginalOutsideFinalSelection } from "./outside-final.ts";

/** Existing Resource LOG_LIMIT. This is a ceiling, not a second allocation.
 * The original parent must debit BOTH pipe directions to its SAME remaining log
 * ledger while its sole reader continues charging original child output. */
const ORIGINAL_LOG_LIMIT = 16 * 1024 * 1024;

/** Optional source-level Python/JS bridge for the selected original root holder.
 * It launches nothing and selects no executable, package, observer budget or
 * service. The parent must independently admit the compiled entry/runtime and
 * count all pipe bytes against the original ledger; this is not that admission.
 *
 * Bind arguments come from the original parent, never child stdout. One process
 * retains one receiver through staged -> actual final -> close. Request lines:
 * {operation:"staged",offer:<existing Sense DATA pointer>}
 * {operation:"final",refs:{call:<actual Ref>,returned:<actual Ref>}}
 * {operation:"close"}
 *
 * Responses contain detached DATA and original-byte inventory deltas. These are
 * transient private pipe messages, not a new persisted final result. A delivered
 * "bound" reply means only that this reader holds its original namespace handle;
 * no consumer acknowledgment makes Resource's actual final return true. Missing,
 * oversized or partial transport fails, never retries or replenishes capacity.
 */
export async function serveOperationalOutsideFinal(
	selection: OriginalOutsideFinalSelection,
	io: { input: Readable; output: Writable; remainingLogBytes: number },
): Promise<void> {
	assert(
		Number.isSafeInteger(io.remainingLogBytes) &&
			io.remainingLogBytes > 0 &&
			io.remainingLogBytes <= ORIGINAL_LOG_LIMIT,
		"OPS_OUTSIDE_ORIGINAL_LOG_REMAINDER_REQUIRED",
	);
	let remaining = io.remainingLogBytes,
		pending = Buffer.alloc(0),
		ended = false;
	const receiver = createOperationalOutsideFinal(selection),
		delivered = new Map<string, string>();
	const charge = (size: number) => {
		assert(size <= remaining, "OPS_OUTSIDE_ORIGINAL_LOG_EXHAUSTED");
		remaining -= size;
	};
	const send = async (operation: string, data?: unknown) => {
		const records: { raw: { path: string; sha256: string }; base64: string }[] = [];
		for (const [path, body] of receiver.retained) {
			const digest = createHash("sha256").update(body).digest("hex"),
				previous = delivered.get(path);
			assert(previous === undefined || previous === digest, "OPS_OUTSIDE_PIPE_REBOUND");
			if (previous === undefined)
				records.push({ raw: { path, sha256: digest }, base64: Buffer.from(body).toString("base64") });
		}
		const bytes = Buffer.from(JSON.stringify({ operation, ...(data === undefined ? {} : { data }), records }) + "\n");
		charge(bytes.length);
		await new Promise<void>((resolve, reject) => {
			io.output.write(bytes, (error) => (error ? reject(error) : resolve()));
		});
		for (const record of records) delivered.set(record.raw.path, record.raw.sha256);
	};
	let failure: { cause: unknown } | undefined;
	const outputFailed = (cause: unknown) => {
		failure ??= { cause };
		// Stop waiting for another request after the response transport fails.
		// Resource still owns child cancellation and the original cleanup deadline.
		io.input.destroy();
	};
	io.output.on("error", outputFailed);
	try {
		await send("bound", receiver.original);
		for await (const chunk of io.input as AsyncIterable<unknown>) {
			if (failure) throw failure.cause;
			assert(chunk instanceof Uint8Array && !ended, "OPS_OUTSIDE_PIPE_AFTER_CLOSE");
			charge(chunk.byteLength);
			pending = Buffer.concat([pending, chunk]);
			for (;;) {
				if (failure) throw failure.cause;
				const end = pending.indexOf(10);
				if (end < 0) break;
				const line = pending.subarray(0, end);
				pending = pending.subarray(end + 1);
				assert(!ended && line.length > 0, "OPS_OUTSIDE_PIPE_EXTRA_MESSAGE");
				const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
				assert(value && typeof value === "object" && "operation" in value, "OPS_OUTSIDE_PIPE_OPERATION");
				if (value.operation === "staged") {
					outsideFields(value, "operation offer");
					await send("staged", receiver.receiveStaged(value.offer));
				} else if (value.operation === "final") {
					outsideFields(value, "operation refs");
					outsideFields(value.refs, "call returned");
					outsideRef(value.refs.call);
					outsideRef(value.refs.returned);
					await send("final", receiver.receiveFinal({ call: value.refs.call, returned: value.refs.returned }));
				} else {
					outsideFields(value, "operation");
					assert(value.operation === "close", "OPS_OUTSIDE_PIPE_OPERATION");
					receiver.close();
					ended = true;
					await send("closed");
				}
			}
		}
		assert(ended && pending.length === 0, "OPS_OUTSIDE_PIPE_PARTIAL_OR_MISSING_CLOSE");
	} catch (cause) {
		failure ??= { cause };
	}
	try {
		try {
			receiver.close();
		} catch (cause) {
			if (failure)
				throw new AggregateError([failure.cause, cause], "OPS_OUTSIDE_PIPE_CLOSE_UNKNOWN", {
					cause: failure.cause,
				});
			throw cause;
		}
		if (failure) throw failure.cause;
	} finally {
		io.output.off("error", outputFailed);
	}
}
