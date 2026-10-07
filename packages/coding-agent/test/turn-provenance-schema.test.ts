import { describe, expect, expectTypeOf, it } from "vitest";
import {
	getTurnProvenance,
	TURN_PROVENANCE_VERSION,
	type TurnChannel,
	type TurnFabricVia,
	type TurnPrincipal,
	type TurnProvenance,
	type TurnSender,
	type TurnSenderKind,
} from "../src/core/turn-provenance.ts";

const receipt = {
	v: 1,
	turnId: "01958ef4-4452-7ba8-a55d-95b20b594b74",
	receivedAt: "2026-10-03T12:34:56.789Z",
	channel: "terminal",
} as const;
const entry = (provenance: unknown) => ({ type: "message", message: { role: "user" }, provenance });

// smarty-dev#3482/#2636: stored schema validity is not runtime identity authentication.
describe("turn provenance v1 schema", () => {
	it("exports the agreed version and channel-bound types", () => {
		expect(TURN_PROVENANCE_VERSION).toBe(1);
		expectTypeOf<TurnChannel>().toEqualTypeOf<"terminal" | "keyboard" | "voice" | "fabric">();
		expectTypeOf<TurnPrincipal>().toEqualTypeOf<{ id: string; binding: "herdr-client" | "voice-call" }>();
		expectTypeOf<TurnSenderKind>().toEqualTypeOf<"main" | "actor" | "agent" | "remote">();
		expectTypeOf<TurnFabricVia>().toEqualTypeOf<"steer" | "followUp" | "actor" | "replay">();
		expectTypeOf<TurnSender>().toEqualTypeOf<{
			id: string;
			kind: TurnSenderKind;
			name?: string;
			verified: "mesh" | "bridge";
		}>();
		expectTypeOf<ReturnType<typeof getTurnProvenance>>().toEqualTypeOf<TurnProvenance | undefined>();
		expectTypeOf<TurnProvenance["v"]>().toEqualTypeOf<1>();
		expectTypeOf<TurnProvenance["submissionToken"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<Extract<TurnProvenance, { channel: "terminal" }>["principal"]>().toEqualTypeOf<undefined>();
		expectTypeOf<Extract<TurnProvenance, { channel: "terminal" }>["sender" | "via"]>().toEqualTypeOf<undefined>();
		expectTypeOf<
			Extract<TurnProvenance, { channel: "keyboard" | "voice" }>["sender" | "via"]
		>().toEqualTypeOf<undefined>();
		expectTypeOf<Extract<TurnProvenance, { channel: "fabric" }>["principal"]>().toEqualTypeOf<undefined>();
		expectTypeOf<
			Extract<TurnProvenance, { channel: "keyboard" }>["principal"]["binding"]
		>().toEqualTypeOf<"herdr-client">();
		expectTypeOf<
			Extract<TurnProvenance, { channel: "voice" }>["principal"]["binding"]
		>().toEqualTypeOf<"voice-call">();
		expectTypeOf<Extract<TurnProvenance, { channel: "fabric" }>["sender"]>().toEqualTypeOf<TurnSender>();
	});

	it.each([
		{ type: "message", message: { role: "user" }, provenance: receipt },
		{ type: "message", message: { role: "custom" }, provenance: receipt },
		{ type: "custom_message", provenance: receipt },
	])("reads entry-level receipts from eligible entries: %j", (value) => {
		expect(getTurnProvenance(value)).toStrictEqual(receipt);
	});

	it.each([
		undefined,
		null,
		true,
		0,
		"entry",
		[],
		{},
		{ type: "message" },
		{ type: "message", message: null, provenance: receipt },
		{ type: "message", message: [], provenance: receipt },
		...["assistant", "system", "toolResult", "bashExecution", "hookMessage", "USER", undefined].map((role) => ({
			type: "message",
			message: { role },
			provenance: receipt,
		})),
		...["session", "custom", "compaction", "branch_summary", "context_edit", "label", "usage", "unknown"].map(
			(type) => ({
				type,
				message: { role: "user" },
				provenance: receipt,
			}),
		),
		{ type: "message", message: { role: "user", provenance: receipt } },
		{ type: "custom_message", details: { provenance: receipt } },
		{ type: "message", message: { role: "user", content: JSON.stringify(receipt) } },
	])("returns UNKNOWN for absent metadata or ineligible entries: %j", (value) => {
		expect(getTurnProvenance(value)).toBeUndefined();
	});

	it.each([
		undefined,
		null,
		[],
		"receipt",
		1,
		{},
		{ ...receipt, v: undefined },
		{ ...receipt, v: 0 },
		{ ...receipt, v: 2 },
		{ ...receipt, v: "1" },
		{ ...receipt, channel: "unknown" },
	])("returns UNKNOWN for missing/unknown version or channel: %j", (value) => {
		expect(getTurnProvenance(entry(value))).toBeUndefined();
	});

	it.each([
		"01958ef444527ba8a55d95b20b594b74",
		"01958ef4_4452_7ba8_a55d_95b20b594b74",
		"01958ef4-4452-7ba8-a55d-95b20b594b7",
		"01958ef4-4452-7ba8-a55d-95b20b594b744",
		"01958ef4-4452-7ba8-a55d-95b20b594b7g",
		"01958ef4-4452-0ba8-a55d-95b20b594b74",
		"01958ef4-4452-7ba8-755d-95b20b594b74",
		` ${receipt.turnId}`,
		`${receipt.turnId}\n`,
		null,
		undefined,
		42,
		"",
	])("rejects malformed harness UUID: %j", (turnId) => {
		expect(getTurnProvenance(entry({ ...receipt, turnId }))).toBeUndefined();
	});

	it.each([receipt.turnId, receipt.turnId.toUpperCase(), "550e8400-e29b-41d4-a716-446655440000"])(
		"accepts complete hyphenated UUID positive controls: %s",
		(turnId) => {
			expect(getTurnProvenance(entry({ ...receipt, turnId }))?.turnId).toBe(turnId);
		},
	);

	it.each([
		"2026-02-30T12:34:56.789Z",
		"2025-02-29T12:34:56.789Z",
		"2026-04-31T12:34:56.789Z",
		"2026-13-03T12:34:56.789Z",
		"2026-10-03T24:00:00.000Z",
		"2026-10-03T12:34:60.789Z",
		"2026-10-03T12:34:56Z",
		"2026-10-03T12:34:56.78Z",
		"2026-10-03T12:34:56.7890Z",
		"2026-10-03T12:34:56.789+00:00",
		"2026-10-03T12:34:56.789",
		"2026-10-03",
		"2026-10-03t12:34:56.789z",
		"+012345-10-03T12:34:56.789Z",
		"-000001-10-03T12:34:56.789Z",
		"invalid",
		` ${receipt.receivedAt}`,
		null,
		undefined,
		0,
	])("rejects impossible or noncanonical UTC timestamp: %j", (receivedAt) => {
		expect(getTurnProvenance(entry({ ...receipt, receivedAt }))).toBeUndefined();
	});

	it.each([receipt.receivedAt, "2024-02-29T00:00:00.000Z", "2000-02-29T23:59:59.999Z"])(
		"accepts canonical timestamp positive controls: %s",
		(receivedAt) => {
			expect(getTurnProvenance(entry({ ...receipt, receivedAt }))?.receivedAt).toBe(receivedAt);
		},
	);
});
