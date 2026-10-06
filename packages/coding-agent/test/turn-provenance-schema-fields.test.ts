import { describe, expect, it } from "vitest";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";

const receipt = {
	v: 1,
	turnId: "550e8400-e29b-41d4-a716-446655440000",
	receivedAt: "2026-10-03T12:34:56.789Z",
	channel: "terminal",
};
const principal = { id: "paul", binding: "herdr-client" };
const sender = { id: "session:worker", kind: "agent", verified: "mesh" };
const entry = (provenance: unknown) => ({ type: "custom_message", provenance });

// smarty-dev#3482/#2636: reject malformed bindings and every cross-channel identity combination.
describe("turn provenance channel fields", () => {
	it.each(["keyboard", "voice"])("reads a correctly bound %s principal", (channel) => {
		const value = {
			...receipt,
			channel,
			principal: { id: "paul", binding: channel === "keyboard" ? "herdr-client" : "voice-call" },
		};
		expect(getTurnProvenance(entry(value))).toStrictEqual(value);
	});

	it.each(
		["main", "actor", "agent", "remote"].flatMap((kind) =>
			["mesh", "bridge"].flatMap((verified) =>
				[undefined, "steer", "followUp", "actor", "replay"].map((via) => ({
					...receipt,
					channel: "fabric",
					sender: { ...sender, kind, verified, name: "Worker" },
					...(via === undefined ? {} : { via }),
				})),
			),
		),
	)("reads every supported fabric kind/verification/via combination: %j", (value) => {
		expect(getTurnProvenance(entry(value))).toStrictEqual(value);
	});

	it.each([
		{ ...receipt, principal },
		{ ...receipt, sender },
		{ ...receipt, via: "steer" },
		{ ...receipt, principal: undefined },
		{ ...receipt, sender: null },
		{ ...receipt, via: undefined },
		{ ...receipt, channel: "keyboard" },
		{ ...receipt, channel: "voice" },
		{ ...receipt, channel: "fabric" },
		{ ...receipt, channel: "keyboard", principal: { ...principal, binding: "voice-call" } },
		{ ...receipt, channel: "voice", principal },
		{ ...receipt, channel: "keyboard", principal, sender },
		{ ...receipt, channel: "keyboard", principal, via: "steer" },
		{ ...receipt, channel: "voice", principal: { ...principal, binding: "voice-call" }, sender },
		{ ...receipt, channel: "voice", principal: { ...principal, binding: "voice-call" }, via: "replay" },
		{ ...receipt, channel: "fabric", sender, principal },
		{ ...receipt, channel: "fabric", sender, principal: undefined },
	])("returns UNKNOWN for an invalid channel combination: %j", (value) => {
		expect(getTurnProvenance(entry(value))).toBeUndefined();
	});

	it.each([
		null,
		[],
		"paul",
		{},
		{ id: "paul" },
		{ binding: "herdr-client" },
		{ ...principal, binding: "unknown" },
		{ ...principal, binding: undefined },
	])("rejects malformed principal: %j", (value) => {
		expect(getTurnProvenance(entry({ ...receipt, channel: "keyboard", principal: value }))).toBeUndefined();
	});

	it.each([
		null,
		[],
		"worker",
		{},
		{ id: "worker" },
		{ ...sender, id: undefined },
		{ ...sender, kind: undefined },
		{ ...sender, kind: "user" },
		{ ...sender, kind: "AGENT" },
		{ ...sender, verified: undefined },
		{ ...sender, verified: "signature" },
		{ ...sender, verified: true },
	])("rejects malformed sender: %j", (value) => {
		expect(getTurnProvenance(entry({ ...receipt, channel: "fabric", sender: value }))).toBeUndefined();
	});

	it.each([null, undefined, "followup", "unknown", 1, true])("rejects invalid fabric via: %j", (via) => {
		expect(getTurnProvenance(entry({ ...receipt, channel: "fabric", sender, via }))).toBeUndefined();
	});

	it.each(
		["principal.id", "sender.id", "sender.name", "submissionToken"].flatMap((field) =>
			["", " ", "\t\n", "x".repeat(201), null, undefined, 0, true, [], {}].map((value) => ({ field, value })),
		),
	)("rejects an invalid bounded field: $field = $value", ({ field, value }) => {
		const provenance =
			field === "principal.id"
				? { ...receipt, channel: "keyboard", principal: { ...principal, id: value } }
				: field.startsWith("sender.")
					? { ...receipt, channel: "fabric", sender: { ...sender, [field.slice(7)]: value } }
					: { ...receipt, submissionToken: value };
		expect(getTurnProvenance(entry(provenance))).toBeUndefined();
	});

	it.each(["p", "x".repeat(200), " opaque correlation "])("accepts bounded string positive controls: %j", (value) => {
		const keyboard = {
			...receipt,
			channel: "keyboard",
			principal: { ...principal, id: value },
			submissionToken: value,
		};
		const fabric = { ...receipt, channel: "fabric", sender: { ...sender, id: value, name: value } };
		expect(getTurnProvenance(entry(keyboard))).toStrictEqual(keyboard);
		expect(getTurnProvenance(entry(fabric))).toStrictEqual(fabric);
	});

	it("does not turn reserved submission correlation into identity", () => {
		const value = { ...receipt, submissionToken: "paul:herdr-client:voice-call:mesh" };
		expect(getTurnProvenance(entry(value))).toStrictEqual(value);
		expect(getTurnProvenance(entry(value))?.principal).toBeUndefined();
		expect(getTurnProvenance(entry(value))?.sender).toBeUndefined();
	});
});
